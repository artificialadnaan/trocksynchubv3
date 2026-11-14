import crypto, { randomUUID } from 'crypto';
import fs from 'fs/promises';
import { fetchWithTimeout } from './lib/fetch-with-timeout';
import path from 'path';
import { isUniqueViolation, storage, type SourceSystem } from './storage';
import { getHubSpotClient, getAccessToken, updateHubSpotDeal, updateHubSpotDealStage, getDealOwnerInfo } from './hubspot';
import { parseProjectTypeFromNumber, replaceProjectTypeInNumber, resolveEffectiveRfpProjectType } from './constants';
// Re-exported so the approve/decline routes and tests keep importing the canonical-type resolver from
// here (its long-standing import site). The function itself lives in the dependency-free constants
// module so the PURE pendingRfpDigest builder can share it without pulling in this DB-coupled module.
export { resolveEffectiveRfpProjectType };
import { resolveHubspotStageId } from './procore-hubspot-sync';
import { sendEmail, renderTemplate } from './email-service';
// Namespace-access GLOBAL_CC_RECIPIENTS (see getRfpAdminApprovers) rather than a named import: a
// partial email-service mock in a test that omits it then resolves to undefined (handled by `|| []`)
// instead of every such mock having to re-export it.
import * as emailService from './email-service';
import { log } from './log';
import {
  checkCrmDealEligibility,
  checkRfpApprovalSourceEligibility,
  sourceIdentityForRequest,
} from './rfp-source-eligibility';
// Re-exported: the approve/decline routes, the digest scheduler and tests import them from here.
export { checkCrmDealEligibility, checkRfpApprovalSourceEligibility };
import {
  buildBidBoardCreatedCallbackTargetUrl,
  buildRfpDeclinedCallbackTargetUrl,
  type BidBoardCreatedCallbackPayload,
  type RfpDeclinedCallbackPayload,
} from './sync/bidboard-callback-worker';
import { handOffServiceRfpApprovalToCore } from './sync/service-rfp-core-outbox';
import { RFP_OVERRIDE_APPROVING_STATUS } from '@shared/schema';
import { RFP_APPROVING_STATUS } from './sync/rfp-approving';
import { PROCORE_CREATE_RETIRED_ERROR } from './sync/procore-create-retired';
import { enqueueRfpApprovedCallbackIfCoreConfirmed } from './sync/rfp-approved-callback';

const RFP_ADMIN_EMAIL = 'adnaan.iqbal@gmail.com';
const DEFAULT_HUBSPOT_PORTAL_ID = '45644695';
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A non-service RFP approved by link has no T-Rock Core route, and Procore project creation is retired (owner 2026-11-13). */
const NO_CORE_ROUTE_ERROR =
  'Approved, but no project record was created: a non-service RFP approved by link has no T-Rock Core route, and Procore project creation is retired. Create the job in T-Rock Core.';

export interface NormalizedRfpRequestInput {
  sourceSystem: 'hubspot' | 'trock_crm';
  sourceDealId: string;
  sourceEventId: string;
  deal: {
    name: string;
    projectNumber: string;
    projectType: string;
    amount: number | null;
    estimator: string | null;
    /** Deal owner / rep — the "Requested by" person (CRM-sourced; HubSpot resolves its own). */
    ownerName?: string | null;
    ownerEmail?: string | null;
    /** Which CRM field ownerEmail came from (CRM resolveDealOwner); TROCK Core seats only "assigned_rep". */
    ownerSource?: 'assigned_rep' | 'hubspot' | 'creator' | null;
    /**
     * `deals.company_id` / `deals.property_id` in the CRM — the customer and the job site as uuids.
     * They are what lets TROCK Core resolve both BY ID; matching them by name is unsafe in the other
     * direction, because `street` falls back to `project_location`, which holds the office designator,
     * so an address-less deal would create a property literally named "DFW".
     *
     * Optional + nullable: absent on any body predating the CRM change, and null on a deal with no
     * company or property. Their absence is a terminal, ALERTING skip of the Core handoff — never a
     * crash, and never a guess.
     */
    companyId?: string | null;
    propertyId?: string | null;
    /** The CRM property's name: what TROCK Core names the job site (absent on bodies predating the CRM field). */
    propertyName?: string | null;
    /**
     * The CRM company's bill address (absent on bodies predating the CRM flag). Stored as sent; the Core handoff puts it
     * on its body only when it meets Core's rules (service-rfp-core-outbox.ts wireCompanyBillAddress).
     */
    companyBillAddress?: { address?: string | null; city?: string | null; state?: string | null; zip?: string | null } | null;
    companyName: string | null;
    contactName: string | null;
    clientEmail: string | null;
    clientPhone: string | null;
    address: {
      street: string | null;
      city: string | null;
      state: string | null;
      zip: string | null;
      country: string | null;
    } | null;
    description: string | null;
    /**
     * The CRM's rendered activity log (calls, notes, site visits…), posted as a NOTE on the Bid Board
     * project. Optional + nullable: a soft display extra, absent on any body that predates the field.
     */
    crmActivityLog?: string | null;
    dueDate: string | null;
    workflowRoute: string | null;
  };
  attachments: Array<{ name: string; url: string; contentType: string | null }>;
}

export type CreateRfpApprovalRequestResult =
  | { success: true; requestId: number; token: string; status: string; idempotent?: boolean }
  | {
      success: false;
      statusCode: 409;
      code: 'pending_collision' | 'approved_collision';
      message: string;
      projectNumber: string;
      conflict: {
        requestId: number;
        token: string;
        status: string;
        sourceSystem: string;
        sourceDealId: string;
        bidboardProjectId?: string | null;
      };
    }
  | {
      success: false;
      statusCode: 409;
      error: 'RFP already in flight';
      message: string;
      conflict: {
        requestId: number;
        sourceSystem: string;
        sourceDealId: string;
        status: string;
      };
    }
  // F-181: `fault` marks a caught exception (a HubSpot / DB / template read failure), never a refusal; the CRM route does not surface it.
  | { success: false; statusCode?: number; error: string; fault?: true };


export async function buildSourceDealUrl(sourceSystem: SourceSystem, sourceDealId: string): Promise<string | null> {
  if (sourceSystem === 'hubspot') {
    const hubspotConfig = await storage.getAutomationConfig('hubspot_config');
    const portalId = (hubspotConfig?.value as any)?.portalId?.trim() || DEFAULT_HUBSPOT_PORTAL_ID;
    return `https://app-na2.hubspot.com/contacts/${portalId}/record/0-3/${sourceDealId}?eschref=%2Fcontacts%2F${portalId}%2Fobjects%2F0-3%2Fviews%2Fall%2Flist%3Fquery%3Drfp`;
  }

  if (sourceSystem === 'trock_crm') {
    const baseUrl = process.env.TROCK_CRM_BASE_URL?.replace(/\/+$/, '');
    return baseUrl ? `${baseUrl}/deals/${encodeURIComponent(sourceDealId)}` : null;
  }

  return null;
}


function buildRfpAuditDetails(request: any, outcome: string, approverEmail?: string, failureReason?: string) {
  const identity = sourceIdentityForRequest(request);
  return {
    approverEmail: approverEmail || null,
    sourceSystem: identity.sourceSystem,
    sourceDealId: identity.sourceDealId,
    projectNumber: identity.projectNumber,
    requestId: request.id,
    tokenId: request.token,
    outcome,
    failureReason: failureReason || null,
  };
}

async function auditRfpApprovalAttempt(request: any, outcome: string, approverEmail?: string, failureReason?: string): Promise<void> {
  const identity = sourceIdentityForRequest(request);
  await storage.createAuditLog({
    action: 'rfp_approval_attempt',
    entityType: 'deal',
    entityId: identity.sourceDealId,
    source: 'rfp-approval',
    status: outcome === 'approved' ? 'success' : 'failed',
    details: buildRfpAuditDetails(request, outcome, approverEmail, failureReason),
  });
}

async function auditRfpDeclineAttempt(request: any, outcome: string, declinerEmail?: string, failureReason?: string): Promise<void> {
  const identity = sourceIdentityForRequest(request);
  await storage.createAuditLog({
    action: 'rfp_decline_attempt',
    entityType: 'deal',
    entityId: identity.sourceDealId,
    source: 'rfp-approval',
    status: outcome === 'declined' ? 'success' : 'failed',
    details: buildRfpAuditDetails(request, outcome, declinerEmail, failureReason),
  });
}

async function buildBidBoardCreatedCallbackData(input: {
  request: any;
  sourceDealId: string;
  bidboardProjectId?: string | null;
  projectNumber: string;
}): Promise<any | null> {
  if ((input.request.sourceSystem || 'hubspot') !== 'trock_crm' || !input.bidboardProjectId) {
    return null;
  }

  const targetUrl = buildBidBoardCreatedCallbackTargetUrl();
  if (!targetUrl) {
    log(`[rfp-approval] TROCK_CRM_BASE_URL not configured; cannot enqueue BidBoard callback for RFP request ${input.request.id}`, 'rfp');
    return null;
  }

  const getAutomationConfig = (storage as any).getAutomationConfig;
  const config =
    typeof getAutomationConfig === 'function'
      ? await getAutomationConfig.call(storage, 'procore_config')
      : null;
  const procoreCompanyId = String((config?.value as any)?.companyId || process.env.PROCORE_COMPANY_ID || '').trim();
  if (!procoreCompanyId) {
    log(`[rfp-approval] Procore company ID not configured; cannot enqueue BidBoard callback for RFP request ${input.request.id}`, 'rfp');
    return null;
  }

  const payload: BidBoardCreatedCallbackPayload = {
    status: 'created',
    sourceDealId: input.sourceDealId,
    rfpApprovalRequestId: input.request.id,
    bidboardProjectId: input.bidboardProjectId,
    projectNumber: input.projectNumber,
    procoreCompanyId,
    createdAt: new Date().toISOString(),
  };

  return {
    sourceSystem: 'trock_crm',
    sourceDealId: input.sourceDealId,
    rfpApprovalRequestId: input.request.id,
    payload,
    targetUrl,
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 5,
    nextAttemptAt: new Date(),
  };
}

/**
 * Build a 'failed' Bid Board callback for the OVERRIDE-approve path: when the authoritative
 * Playwright project creation fails, the request is left re-tryable (NOT marked approved) and
 * the CRM is notified via the same outbox + worker + HMAC, to the same /api/internal/bid-board-created
 * URL. Unlike the 'created' builder, procoreCompanyId is best-effort (the CRM only needs the
 * request id + error to surface the failure), so this never returns null for a missing company id.
 */
async function buildBidBoardFailedCallbackData(input: {
  request: any;
  sourceDealId: string;
  projectNumber?: string;
  error?: string;
}): Promise<any | null> {
  if ((input.request.sourceSystem || 'hubspot') !== 'trock_crm') {
    return null;
  }

  const targetUrl = buildBidBoardCreatedCallbackTargetUrl();
  if (!targetUrl) {
    log(`[rfp-approval] TROCK_CRM_BASE_URL not configured; cannot enqueue BidBoard failure callback for RFP request ${input.request.id}`, 'rfp');
    return null;
  }

  const getAutomationConfig = (storage as any).getAutomationConfig;
  const config =
    typeof getAutomationConfig === 'function'
      ? await getAutomationConfig.call(storage, 'procore_config')
      : null;
  const procoreCompanyId = String((config?.value as any)?.companyId || process.env.PROCORE_COMPANY_ID || '').trim() || undefined;

  const payload: BidBoardCreatedCallbackPayload = {
    status: 'failed',
    sourceDealId: input.sourceDealId,
    rfpApprovalRequestId: input.request.id,
    projectNumber: input.projectNumber,
    procoreCompanyId,
    error: input.error || 'BidBoard project creation failed',
    createdAt: new Date().toISOString(),
  };

  return {
    sourceSystem: 'trock_crm',
    sourceDealId: input.sourceDealId,
    rfpApprovalRequestId: input.request.id,
    payload,
    targetUrl,
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 5,
    nextAttemptAt: new Date(),
  };
}

function buildRfpDeclinedCallbackData(input: {
  request: any;
  sourceDealId: string;
  declinedAt: Date;
  denialReason?: string | null;
}): any | null {
  if ((input.request.sourceSystem || 'hubspot') !== 'trock_crm') {
    return null;
  }

  const targetUrl = buildRfpDeclinedCallbackTargetUrl();
  if (!targetUrl) {
    log(`[rfp-approval] TROCK_CRM_BASE_URL not configured; cannot enqueue RFP decline callback for RFP request ${input.request.id}`, 'rfp');
    return null;
  }

  const payload: RfpDeclinedCallbackPayload = {
    sourceDealId: input.sourceDealId,
    rfpApprovalRequestId: input.request.id,
    declinedAt: input.declinedAt.toISOString(),
  };
  if (input.denialReason?.trim()) {
    payload.denialReason = input.denialReason.trim();
  }

  return {
    sourceSystem: 'trock_crm',
    sourceDealId: input.sourceDealId,
    rfpApprovalRequestId: input.request.id,
    payload,
    targetUrl,
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 5,
    nextAttemptAt: new Date(),
  };
}

export function isRfpApprovalRequestExpired(request: { tokenExpiresAt?: Date | string | null }): boolean {
  // Legacy rows created before Phase 3 have no tokenExpiresAt and remain valid.
  return !!request.tokenExpiresAt && new Date() > new Date(request.tokenExpiresAt);
}

export function buildExpiredRfpMessage(request: { createdAt?: Date | string | null; tokenExpiresAt?: Date | string | null }): string {
  const sentAt = request.createdAt ? new Date(request.createdAt).toLocaleString('en-US', { timeZone: 'America/Chicago' }) : 'an unknown date';
  const expiredAt = request.tokenExpiresAt ? new Date(request.tokenExpiresAt).toLocaleString('en-US', { timeZone: 'America/Chicago' }) : 'an unknown date';
  return `This RFP review link has expired. The deal was sent on ${sentAt} and the link expired on ${expiredAt}. Contact the sender if you still need to review this request.`;
}



export async function cancelIneligibleRfpApproval(request: any, approverEmail: string, reason: string): Promise<{ success: false; error: string; statusCode: 409; message: string }> {
  const identity = sourceIdentityForRequest(request);
  const message = `RFP approval cancelled because the source ${identity.sourceSystem} deal ${identity.sourceDealId} is no longer eligible. ${reason}`;

  await storage.updateRfpApprovalRequest(request.id, {
    status: 'cancelled_source_ineligible',
  });

  await sendEmail({
    to: approverEmail,
    subject: 'RFP approval cancelled — source deal no longer eligible',
    htmlBody: `<p>${message}</p><p>Project number: ${identity.projectNumber || 'N/A'}</p>`,
    fromName: 'T-Rock Sync Hub',
  });

  await auditRfpApprovalAttempt(request, 'cancelled_source_ineligible', approverEmail, reason);
  return { success: false, error: 'source_ineligible', statusCode: 409, message };
}

interface RfpStatusStep { name: string; success: boolean; detail: string }

async function sendRfpApprovalStatusEmail(params: {
  dealName: string;
  hubspotDealId: string;
  projectNumber: string;
  approverEmail: string;
  bidboardProjectId?: string;
  bidboardFailed: boolean;
  steps: RfpStatusStep[];
}): Promise<void> {
  try {
    const allSuccess = params.steps.every(s => s.success);
    const statusLabel = allSuccess ? 'All Steps Successful' : 'Partial Failure';
    const statusColor = allSuccess ? '#166534' : '#991b1b';
    const statusBg = allSuccess ? '#f0fdf4' : '#fef2f2';
    const statusBorder = allSuccess ? '#bbf7d0' : '#fecaca';

    const stepsHtml = params.steps.map(s =>
      `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-family:Arial,sans-serif;font-size:14px;color:#1e293b;">${s.name}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-family:Arial,sans-serif;font-size:13px;color:${s.success ? '#166534' : '#991b1b'};font-weight:600;">${s.success ? 'OK' : 'FAILED'}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-family:Arial,sans-serif;font-size:13px;color:#64748b;">${s.detail}</td>
      </tr>`
    ).join('');

    const htmlBody = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#1a1a2e;padding:16px 24px;border-radius:8px 8px 0 0;">
        <span style="font-size:20px;font-weight:700;color:#fff;">T-ROCK</span>
        <span style="font-size:20px;font-weight:300;color:#d11921;"> GC</span>
        <span style="font-size:14px;color:#94a3b8;margin-left:12px;">RFP Approval Status</span>
      </div>
      <div style="background:${statusBg};border:1px solid ${statusBorder};padding:12px 24px;color:${statusColor};font-weight:600;font-size:15px;">
        ${statusLabel}
      </div>
      <div style="padding:20px 24px;border:1px solid #e2e8f0;border-top:none;">
        <table style="width:100%;margin-bottom:16px;">
          <tr><td style="color:#64748b;font-size:13px;padding:4px 0;">Deal</td><td style="font-size:14px;font-weight:600;padding:4px 0;">${params.dealName}</td></tr>
          <tr><td style="color:#64748b;font-size:13px;padding:4px 0;">Project #</td><td style="font-size:14px;padding:4px 0;">${params.projectNumber || 'N/A'}</td></tr>
          <tr><td style="color:#64748b;font-size:13px;padding:4px 0;">HubSpot Deal</td><td style="font-size:14px;padding:4px 0;">${params.hubspotDealId}</td></tr>
          <tr><td style="color:#64748b;font-size:13px;padding:4px 0;">Approved By</td><td style="font-size:14px;padding:4px 0;">${params.approverEmail}</td></tr>
          <tr><td style="color:#64748b;font-size:13px;padding:4px 0;">BidBoard ID</td><td style="font-size:14px;padding:4px 0;">${params.bidboardProjectId || 'Not created'}</td></tr>
        </table>
        <table style="width:100%;border:1px solid #e2e8f0;border-radius:6px;border-collapse:collapse;">
          <tr style="background:#f8fafc;">
            <th style="padding:8px 12px;text-align:left;font-size:13px;color:#64748b;border-bottom:1px solid #e2e8f0;">Step</th>
            <th style="padding:8px 12px;text-align:left;font-size:13px;color:#64748b;border-bottom:1px solid #e2e8f0;">Status</th>
            <th style="padding:8px 12px;text-align:left;font-size:13px;color:#64748b;border-bottom:1px solid #e2e8f0;">Detail</th>
          </tr>
          ${stepsHtml}
        </table>
      </div>
      <div style="padding:12px 24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;text-align:center;">
        <span style="font-size:11px;color:#94a3b8;">Sent by T-Rock Sync Hub at ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })} CST</span>
      </div>
    </div>`;

    await sendEmail({
      to: RFP_ADMIN_EMAIL,
      subject: `RFP ${allSuccess ? 'Approved' : 'Partial Failure'}: ${params.dealName} (${params.projectNumber || 'no number'})`,
      htmlBody,
      fromName: 'T-Rock Sync Hub',
    });
    log(`[rfp-approval] Status email sent to ${RFP_ADMIN_EMAIL} for deal ${params.hubspotDealId}`, 'rfp');
  } catch (emailErr: any) {
    console.error(`[rfp-approval] Failed to send status email: ${emailErr.message}`);
  }
}

/** Upload a file to HubSpot Files API and associate it with a deal. */
async function uploadFileToHubSpotAndAttachToDeal(
  localPath: string,
  fileName: string,
  dealId: string
): Promise<void> {
  const token = await getAccessToken();
  const base = 'https://api.hubapi.com';
  const fileBuffer = await fs.readFile(localPath);

  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer]), fileName);
  formData.append('options', JSON.stringify({ access: 'PRIVATE' }));
  formData.append('folderPath', '/rfp-attachments');

  const uploadRes = await fetchWithTimeout(`${base}/files/v3/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    throw new Error(`HubSpot file upload failed: ${uploadRes.status} ${errText}`);
  }
  const uploadJson = (await uploadRes.json()) as { id?: string };
  const fileId = String(uploadJson.id ?? '');
  if (!fileId) throw new Error('HubSpot file upload did not return file id');

  // Associate file with deal: from deal → to file. Use "deals" and "files" object types.
  // (0-4 was incorrectly interpreted as engagement; "files" is the correct type.)
  try {
    const client = await getHubSpotClient();
    await client.crm.associations.v4.basicApi.create(
      'deals',
      dealId,
      'files',
      fileId,
      [{ associationCategory: 'HUBSPOT_DEFINED' as any, associationTypeId: 3 }]
    );
    log(`[rfp-approval] Associated file ${fileId} with deal ${dealId}`, 'rfp');
  } catch (assocErr: any) {
    const msg = assocErr?.message || String(assocErr);
    // Downgrade to warning when HubSpot returns invalid contact (e.g. deal has stale contact ref); file-deal link still works
    if (/CONTACT.*not valid|not valid.*CONTACT/i.test(msg)) {
      console.warn(`[rfp-approval] File-deal association skipped (invalid contact): ${msg}`);
    } else {
      log(`[rfp-approval] HubSpot file-deal association failed: ${msg}`, 'rfp');
    }
    // Non-fatal — file was uploaded successfully, association is best-effort
  }
}

const RFP_APPROVER_CACHE_TTL_MS = 60_000;
const rfpApproverCache = new Map<string, { timestamp: number; recipients: string[] }>();

/**
 * Hardcoded routing used ONLY when rfp_approver_config has no matching active row — the legit
 * intended fallback. (A config READ ERROR is a different, untrustworthy case; see
 * selectConfiguredRfpRecipients + isAuthorizedRfpApprover.)
 */
function hardcodedRfpSafetyNetRecipients(type: string): string[] {
  if (type === '4') {
    // Project type 4 (service): Kason + Andrew, the owner's service approvers (2026-10-01; migration 0026). Kept equal
    // to the configured row so a config-read failure never emails people the live check would then refuse.
    return ['kreeder@trockgc.com', 'agreen@trockgc.com'];
  }
  // All other project types: Sidney + James + Tim (non-service routing — kept in sync with main's #45 change)
  return ['sgibson@trockgc.com', 'jhelms@trockgc.com', 'tmitchell@trockgc.com'];
}

/**
 * Read rfp_approver_config and select the best-matching active row's approver emails, or return
 * null when NO active row matches (the legit "fall back to the hardcoded safety net" case).
 *
 * IMPORTANT: read errors are NOT swallowed here — they PROPAGATE so the authorization path
 * (isAuthorizedRfpApprover) can fail closed. The non-security notification path
 * (getRfpReviewRecipients) keeps catching them and using the safety net.
 */
async function selectConfiguredRfpRecipients(type: string, source: string): Promise<string[] | null> {
  // TODO: Build an admin settings UI; for now rfp_approver_config is edited via SQL.
  const configs = await storage.getRfpApproverConfigs(type, source);
  const exactSource = configs.find((config) => config.projectType === type && config.sourceSystem === source);
  const exactProjectType = configs.find((config) => config.projectType === type && config.sourceSystem === null);
  const defaultConfig = configs.find((config) => config.projectType === '*' && config.sourceSystem === null);
  const selected = exactSource ?? exactProjectType ?? defaultConfig;
  return selected?.approverEmails?.length ? selected.approverEmails : null;
}

export async function getRfpReviewRecipients(projectType: string | null | undefined, sourceSystem: string | null | undefined = 'hubspot'): Promise<string[]> {
  const type = String(projectType || '').trim();
  const source = String(sourceSystem || 'hubspot').trim();
  const cacheKey = `${type || '*'}:${source}`;
  const cached = rfpApproverCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < RFP_APPROVER_CACHE_TTL_MS) {
    return cached.recipients;
  }

  try {
    const configured = await selectConfiguredRfpRecipients(type, source);
    if (configured?.length) {
      rfpApproverCache.set(cacheKey, { timestamp: Date.now(), recipients: configured });
      return configured;
    }
  } catch (error: any) {
    // Notification routing is NOT a security decision — keep delivering to the safety net on a
    // config read error so review emails still go out. (The authz gate fails closed instead.)
    console.warn(`[rfp-approval] Failed to load RFP approver config, using hardcoded safety net: ${error?.message || error}`);
  }

  // Safety net: preserve the original hardcoded routing if DB config is missing or invalid.
  console.warn(`[rfp-approval] No active RFP approver config for projectType=${type || '*'}, sourceSystem=${source}; using hardcoded safety net`);
  const fallbackRecipients = hardcodedRfpSafetyNetRecipients(type);
  rfpApproverCache.set(cacheKey, { timestamp: Date.now(), recipients: fallbackRecipients });
  return fallbackRecipients;
}

const normalizeApproverEmail = (email: string | null | undefined): string =>
  String(email || '').trim().toLowerCase();

/**
 * Admin / always-CC approvers who legitimately receive EVERY RFP review email (they are CC'd on all
 * outgoing mail via the email layer's GLOBAL_CC list) plus the RFP admin address. These people are
 * NOT stored in rfp_approver_config but may approve/decline any RFP regardless of its project-type
 * routing — so the authz check must exempt them. Single-sourced from email-service to avoid drift.
 */
function getRfpAdminApprovers(): string[] {
  return [RFP_ADMIN_EMAIL, ...(emailService.GLOBAL_CC_RECIPIENTS || [])];
}

/**
 * Authorization gate for the PUBLIC RFP review-link approve/decline actions. Resolves the authorized
 * approver set from the SAME rfp_approver_config source the routing/notification uses, UNION the
 * admin/global-CC allowlist who are CC'd on every review email. Comparison is case-insensitive and
 * trimmed.
 *
 * SECURITY — FAILS CLOSED on a config READ ERROR. Unlike getRfpReviewRecipients (a notification
 * routing helper that swallows DB errors and falls back to the hardcoded safety net), this gate
 * distinguishes the two cases:
 *   - NO matching active config row  → legit intended fallback to the hardcoded safety net (allow).
 *   - the config READ THREW (DB unreadable) → we cannot trust the safety net to reflect the live
 *     authorized set, so DENY (return false). The route then returns a clean 403, never an approval.
 * The admin / always-CC allowlist is config-INDEPENDENT (sourced from email-service, not the DB), so
 * it still authorizes even when the config cannot be read.
 *
 * NOTE: this intentionally does NOT gate the HMAC-secured override-approve path
 * (processRfpApproval `force: true`, /api/rfp-requests/:id/override-approve), which is authenticated
 * server-to-server and may legitimately carry a director's email outside any config row.
 */
export async function isAuthorizedRfpApprover(
  approverEmail: string | null | undefined,
  projectType: string | null | undefined,
  sourceSystem: string | null | undefined = 'hubspot',
): Promise<boolean> {
  const candidate = normalizeApproverEmail(approverEmail);
  if (!candidate) return false;

  // The admin / always-CC allowlist does not depend on the DB config, so check it first — these
  // directors remain authorized even if rfp_approver_config is temporarily unreadable.
  const adminApprovers = getRfpAdminApprovers().map(normalizeApproverEmail).filter(Boolean);
  if (adminApprovers.includes(candidate)) return true;

  const type = String(projectType || '').trim();
  const source = String(sourceSystem || 'hubspot').trim();
  let configuredRecipients: string[];
  try {
    const configured = await selectConfiguredRfpRecipients(type, source);
    // A missing config row is the legit fallback; a thrown read is handled by the catch below.
    configuredRecipients = configured?.length ? configured : hardcodedRfpSafetyNetRecipients(type);
  } catch (error: any) {
    // PII: do NOT log the candidate approver email here — who attempted is captured in the audit
    // record (auditRouteAttempt logs approverEmail). Keep only the failure + routing context.
    console.warn(`[rfp-approval] RFP approver config read failed during authorization; denying (projectType=${type || 'none'}, sourceSystem=${source}): ${error?.message || error}`);
    return false;
  }

  const authorized = new Set(configuredRecipients.map(normalizeApproverEmail).filter(Boolean));
  return authorized.has(candidate);
}

const RFP_DEAL_PROPERTIES = [
  'dealname', 'amount', 'dealstage', 'pipeline', 'closedate',
  'bid_due_date', 'due_date', 'proposal_due_date',
  'hubspot_owner_id', 'project_types', 'project_number',
  'project_location', 'city', 'state', 'zip', 'country',
  'description', 'project_description', 'project_description_briefly_describe_the_project',
  'project_description__briefly_describe_the_project_',
  'address', 'project_location', 'company_name', 'client_email', 'client_phone', 'estimator', 'notes',
  'attachments', 'deal_attachments',
];

export function resolveRfpDescription(props: Record<string, any> | null | undefined): string {
  if (!props) return '';

  const direct =
    props.project_description__briefly_describe_the_project_
    || props.project_description_briefly_describe_the_project
    || props.project_description
    || props.description
    || props.hs_project_description
    || props.hs_description;

  if (direct) return String(direct).trim();

  const matchingKey = Object.keys(props).find((key) => key.toLowerCase().includes('description'));
  if (matchingKey && props[matchingKey]) {
    return String(props[matchingKey]).trim();
  }

  return props.notes ? String(props.notes).trim() : '';
}

export async function fetchFullDealFromHubSpot(dealId: string): Promise<Record<string, any>> {
  const client = await getHubSpotClient();
  const deal = await client.crm.deals.basicApi.getById(
    dealId,
    RFP_DEAL_PROPERTIES,
    undefined,
    ['companies', 'contacts']
  );

  const props = deal.properties || {};
  let descriptionFromProps = resolveRfpDescription(props);
  if (!descriptionFromProps) {
    try {
      const cached = await storage.getHubspotDealByHubspotId(dealId);
      const cp = (cached?.properties || {}) as Record<string, any>;
      descriptionFromProps = resolveRfpDescription(cp);
    } catch (e) { console.error('[rfp-approval] Failed to load cached deal description:', (e as Error).message); }
  }
  let companyName = props.company_name || '';
  let contactEmail = props.client_email || '';
  let contactPhone = props.client_phone || '';

  const associations = (deal as any).associations || {};
  const companyIds = associations.companies?.results?.map((a: any) => String(a.id)) || [];
  const contactIds = associations.contacts?.results?.map((a: any) => String(a.id)) || [];

  if (companyIds.length > 0 && !companyName) {
    try {
      const company = await client.crm.companies.basicApi.getById(companyIds[0], ['name', 'phone', 'address', 'city', 'state', 'zip']);
      const cProps = company.properties || {};
      companyName = companyName || cProps.name || '';
      if (!props.address) props.address = cProps.address || '';
      if (!props.city) props.city = cProps.city || '';
      if (!props.state) props.state = cProps.state || '';
      if (!props.zip) props.zip = cProps.zip || '';
    } catch (e: any) {
      console.warn(`[rfp-approval] Failed to fetch company ${companyIds[0]}:`, e.message);
    }
  }

  if (contactIds.length > 0 && (!contactEmail || !contactPhone)) {
    try {
      const contact = await client.crm.contacts.basicApi.getById(contactIds[0], ['email', 'phone', 'firstname', 'lastname']);
      const ctProps = contact.properties || {};
      contactEmail = contactEmail || ctProps.email || '';
      contactPhone = contactPhone || ctProps.phone || '';
      if (!props.contact_name) props.contact_name = `${ctProps.firstname || ''} ${ctProps.lastname || ''}`.trim();
    } catch (e: any) {
      console.warn(`[rfp-approval] Failed to fetch contact ${contactIds[0]}:`, e.message);
    }
  }

  return {
    hubspotDealId: dealId,
    dealname: props.dealname || '',
    amount: props.amount || '',
    project_types: props.project_types || '',
    project_number: props.project_number || '',
    project_location: props.project_location || '',
    address: props.address || props.project_location || '',
    city: props.city || '',
    state: props.state || '',
    zip: props.zip || '',
    country: props.country || '',
    description: descriptionFromProps,
    notes: props.notes || '',
    closedate: props.closedate || '',
    bid_due_date: props.bid_due_date || props.due_date || '',
    proposal_due_date: props.proposal_due_date || '',
    project_description__briefly_describe_the_project_: props.project_description__briefly_describe_the_project_ || '',
    estimator: props.estimator || '',
    company_name: companyName,
    client_email: contactEmail,
    client_phone: contactPhone,
    contact_name: props.contact_name || '',
    hubspot_owner_id: props.hubspot_owner_id || '',
    pipeline: props.pipeline || '',
    dealstage: props.dealstage || '',
    attachments: await fetchDealAttachments(dealId, props),
  };
}

async function fetchDealAttachmentsFromFiles(dealId: string): Promise<Array<{ name: string; url: string; type?: string; size?: number }>> {
  const list: Array<{ name: string; url: string; type?: string; size?: number }> = [];
  try {
    const token = await getAccessToken();
    const base = 'https://api.hubapi.com';
    const headers = { Authorization: `Bearer ${token}` };
    const assocRes = await fetchWithTimeout(`${base}/crm/v4/objects/deal/${dealId}/associations/files`, { headers });
    if (!assocRes.ok) return list;
    const assoc = (await assocRes.json()) as { results?: Array<{ id?: string; type?: string }> };
    const fileIds = (assoc.results || []).map((r) => r.id).filter(Boolean) as string[];
    for (const fileId of fileIds) {
      try {
        const fileRes = await fetchWithTimeout(`${base}/files/v3/files/${fileId}`, { headers });
        if (!fileRes.ok) continue;
        const file = (await fileRes.json()) as { url?: string; defaultHostingUrl?: string; name?: string; extension?: string; size?: number };
        const url = file.url || file.defaultHostingUrl;
        if (url) {
          list.push({
            name: file.name || `file-${fileId}${file.extension ? '.' + file.extension : ''}`,
            url,
            size: file.size,
          });
        }
      } catch (e) { console.error('[rfp-approval] Failed to fetch individual file attachment:', (e as Error).message); }
    }
  } catch (e: any) {
    log(`[rfp-approval] Failed to fetch deal attachments from files: ${e.message}`, 'rfp');
  }
  return list;
}

async function fetchDealAttachmentsFromEngagements(dealId: string): Promise<Array<{ name: string; url: string; type?: string; size?: number }>> {
  const list: Array<{ name: string; url: string; type?: string; size?: number }> = [];
  try {
    const token = await getAccessToken();
    const base = 'https://api.hubapi.com';
    const headers = { Authorization: `Bearer ${token}` };
    // Get all engagement associations for the deal
    const assocRes = await fetchWithTimeout(`${base}/crm/v4/objects/deal/${dealId}/associations/emails`, { headers });
    if (assocRes.ok) {
      const assoc = (await assocRes.json()) as { results?: Array<{ id?: string; toObjectId?: string }> };
      const engagementIds = (assoc.results || []).map((r) => r.id || r.toObjectId).filter(Boolean) as string[];
      for (const engId of engagementIds.slice(0, 10)) { // Limit to 10 most recent
        try {
          const engRes = await fetchWithTimeout(`${base}/crm/v3/objects/emails/${engId}?properties=hs_attachment_ids`, { headers });
          if (!engRes.ok) continue;
          const eng = (await engRes.json()) as { properties?: { hs_attachment_ids?: string } };
          const idsStr = eng.properties?.hs_attachment_ids || '';
          const ids = idsStr.split(';').map((s) => s.trim()).filter(Boolean);
          for (const fileId of ids) {
            try {
              const fileRes = await fetchWithTimeout(`${base}/files/v3/files/${fileId}`, { headers });
              if (!fileRes.ok) continue;
              const file = (await fileRes.json()) as { url?: string; defaultHostingUrl?: string; name?: string; extension?: string; size?: number };
              const url = file.url || file.defaultHostingUrl;
              if (url) list.push({ name: file.name || `file-${fileId}`, url, size: file.size });
            } catch (e) { console.error('[rfp-approval] Failed to fetch engagement file attachment:', (e as Error).message); }
          }
        } catch (e) { console.error('[rfp-approval] Failed to fetch engagement attachments:', (e as Error).message); }
      }
    }
  } catch (e: any) {
    log(`[rfp-approval] Failed to fetch deal attachments from engagements: ${e.message}`, 'rfp');
  }
  return list;
}

async function fetchDealAttachments(dealId: string, props: Record<string, any>): Promise<Array<{ name: string; url: string; type?: string; size?: number }>> {
  const fromProps = fetchAttachmentsFromProps(props);
  const fromNotes = await fetchDealAttachmentsFromNotes(dealId);
  const fromFiles = await fetchDealAttachmentsFromFiles(dealId);
  const fromEngagements = await fetchDealAttachmentsFromEngagements(dealId);
  log(`[rfp-approval] Attachment sources for deal ${dealId}: props=${fromProps.length}, notes=${fromNotes.length}, files=${fromFiles.length}, engagements=${fromEngagements.length}`, 'rfp');
  const seen = new Set<string>();
  const list: Array<{ name: string; url: string; type?: string; size?: number }> = [];
  for (const a of [...fromProps, ...fromNotes, ...fromFiles, ...fromEngagements]) {
    const key = `${a.url}|${a.name}`;
    if (!seen.has(key)) { seen.add(key); list.push(a); }
  }
  log(`[rfp-approval] Total unique attachments for deal ${dealId}: ${list.length}`, 'rfp');
  return list;
}

async function fetchDealAttachmentsFromNotes(dealId: string): Promise<Array<{ name: string; url: string; type?: string; size?: number }>> {
  const list: Array<{ name: string; url: string; type?: string; size?: number }> = [];
  try {
    const token = await getAccessToken();
    const base = 'https://api.hubapi.com';
    const headers = { Authorization: `Bearer ${token}` };
    const assocRes = await fetchWithTimeout(`${base}/crm/v4/objects/deal/${dealId}/associations/notes`, { headers });
    if (!assocRes.ok) return list;
    const assoc = (await assocRes.json()) as { results?: Array<{ id?: string; toObjectId?: string } | string> };
    const noteIds = (assoc.results || []).map((r) => (typeof r === 'string' ? r : r?.id || r?.toObjectId)).filter(Boolean) as string[];
    for (const noteId of noteIds) {
      const noteRes = await fetchWithTimeout(`${base}/crm/v3/objects/notes/${noteId}?properties=hs_attachment_ids`, { headers });
      if (!noteRes.ok) continue;
      const note = (await noteRes.json()) as { properties?: { hs_attachment_ids?: string } };
      const idsStr = note.properties?.hs_attachment_ids || '';
      const ids = idsStr.split(';').map((s) => s.trim()).filter(Boolean);
      for (const fileId of ids) {
        try {
          const fileRes = await fetchWithTimeout(`${base}/files/v3/files/${fileId}`, { headers });
          if (!fileRes.ok) continue;
          const file = (await fileRes.json()) as { url?: string; defaultHostingUrl?: string; name?: string; extension?: string; size?: number };
          const url = file.url || file.defaultHostingUrl;
          if (url) {
            list.push({
              name: file.name || `file-${fileId}${file.extension ? '.' + file.extension : ''}`,
              url,
              size: file.size,
            });
          }
        } catch (e) { console.error('[rfp-approval] Failed to fetch note file attachment:', (e as Error).message); }
      }
    }
  } catch (e: any) {
    log(`[rfp-approval] Failed to fetch deal attachments from notes: ${e.message}`, 'rfp');
  }
  return list;
}

function fetchAttachmentsFromProps(props: Record<string, any>): Array<{ name: string; url: string; type?: string; size?: number }> {
  const list: Array<{ name: string; url: string; type?: string; size?: number }> = [];
  const raw = props.attachments || props.deal_attachments;
  if (Array.isArray(raw)) {
    for (const a of raw) {
      if (a && (a.url || a.fileUrl)) {
        list.push({
          name: a.name || a.fileName || 'attachment',
          url: a.url || a.fileUrl,
          type: a.type || a.mimeType,
          size: a.size,
        });
      }
    }
  } else if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const a of parsed) {
          if (a && (a.url || a.fileUrl)) {
            list.push({
              name: a.name || a.fileName || 'attachment',
              url: a.url || a.fileUrl,
              type: a.type || a.mimeType,
              size: a.size,
            });
          }
        }
      }
    } catch (e) { console.error('[rfp-approval] Failed to parse attachments from deal props:', (e as Error).message); }
  }
  return list;
}

// Exported for the create-from-rfp ADOPT handoff (bidboard-create-worker), which records an approval row and tells
// TROCK Core about it — both must carry exactly the deal_data shape an ordinary approval stores.
export function normalizedDealData(input: NormalizedRfpRequestInput, ownerInfo: { ownerName?: string; ownerEmail?: string }, sourceDealUrl: string | null): Record<string, any> {
  return {
    sourceSystem: input.sourceSystem,
    sourceDealId: input.sourceDealId,
    sourceDealUrl,
    hubspotDealId: input.sourceSystem === 'hubspot' ? input.sourceDealId : null,
    hubspotDealUrl: input.sourceSystem === 'hubspot' ? sourceDealUrl : null,
    dealname: input.deal.name,
    amount: input.deal.amount ?? '',
    project_types: input.deal.projectType,
    project_number: input.deal.projectNumber,
    project_location: input.deal.address?.street || '',
    address: input.deal.address?.street || '',
    city: input.deal.address?.city || '',
    state: input.deal.address?.state || '',
    zip: input.deal.address?.zip || '',
    country: input.deal.address?.country || '',
    description: input.deal.description || '',
    notes: input.deal.description || '',
    // The CRM activity log, carried through to the Bid Board create as a NOTE on the project. Kept in
    // its own key: `description`/`notes` above still feed Procore's Project Description, and the
    // activity log must not leak into that field. Also note resolveRfpDescription's "any key containing
    // 'description'" fallback — 'crm_activity_log' deliberately doesn't match it, so the review email's
    // Description row can never pick this up.
    crm_activity_log: input.deal.crmActivityLog || '',
    // The CRM's customer/job-site uuids, persisted so the Core handoff at approval time can resolve
    // both by id. Null (not '') when absent: '' would read as "known to be empty" downstream, where
    // these must read as "not supplied" and take the terminal-skip path.
    crm_company_id: input.deal.companyId || null,
    crm_property_id: input.deal.propertyId || null,
    // The job site's NAME for the Core handoff (null when the CRM sent none: the handoff falls back to the street).
    crm_property_name: input.deal.propertyName || null,
    // The CRM company's bill address for the Core handoff, as sent (null when the CRM sent none).
    crm_company_bill_address: input.deal.companyBillAddress ?? null,
    bid_due_date: input.deal.dueDate || '',
    due_date: input.deal.dueDate || '',
    workflowRoute: input.deal.workflowRoute || '',
    estimator: input.deal.estimator || '',
    company_name: input.deal.companyName || '',
    client_email: input.deal.clientEmail || '',
    client_phone: input.deal.clientPhone || '',
    contact_name: input.deal.contactName || '',
    ownerName: ownerInfo.ownerName || '',
    ownerEmail: ownerInfo.ownerEmail || '',
    // Only a trock_crm body names its owner's source; a HubSpot-sourced owner never seats a Core card.
    ownerSource: input.sourceSystem === 'trock_crm' ? input.deal.ownerSource ?? null : null,
    attachments: input.attachments.map((attachment) => ({
      name: attachment.name,
      url: attachment.url,
      type: attachment.contentType || undefined,
    })),
  };
}

type PreparedRfpReviewEmails = { recipients: string[]; subject: string; htmlBody: string };

/**
 * F-181: every read the review email needs (the template, the recipients) and its render, run BEFORE the request is inserted.
 * A fault here leaves no row, so a retry / webhook replay creates the request and sends once; after the insert only the
 * per-recipient sends (each in its own try) and the audit write remain, and both come after the email went out.
 */
async function prepareRfpReviewEmails(params: {
  token: string;
  input: NormalizedRfpRequestInput;
  dealData: Record<string, any>;
  ownerName: string;
  sourceDealUrl: string | null;
}): Promise<PreparedRfpReviewEmails> {
  const template = await storage.getEmailTemplate('rfp_review');
  if (!template || !template.enabled) {
    log('[rfp-approval] RFP review email template is disabled', 'rfp');
    return { recipients: [], subject: '', htmlBody: '' };
  }

  const appUrl = process.env.APP_URL || 'http://localhost:5000';
  const reviewUrl = `${appUrl}/rfp-review/${params.token}`;
  const sourceLabel = params.input.sourceSystem === 'hubspot' ? 'HubSpot' : 'T Rock CRM';

  const esc = (s: any) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const attachments = (params.dealData.attachments || []) as Array<{ name: string; url?: string }>;
  const attachmentListHtml = attachments.length > 0
    ? attachments.map(a => `<a href="${(a.url || '#').replace(/"/g, '&quot;')}" style="color:#d11921;text-decoration:underline;font-family:Arial,Helvetica,sans-serif;">${esc(a.name || 'Attachment')}</a>`).join('<br>')
    : '<span style="color:#94a3b8;">None</span>';

  const dealName = esc(params.dealData.dealname || 'Unknown Deal');
  const projectNumber = esc(params.dealData.project_number || 'N/A');
  const projectType = esc(params.dealData.project_types || 'N/A');
  const amount = params.dealData.amount ? `$${Number(params.dealData.amount).toLocaleString('en-US')}` : 'N/A';
  const companyName = esc(params.dealData.company_name || 'N/A');
  const location = esc([params.dealData.address, params.dealData.city, params.dealData.state, params.dealData.zip].filter(Boolean).join(', ') || 'N/A');
  const description = esc(resolveRfpDescription(params.dealData) || 'N/A');
  const estimator = esc(params.dealData.estimator || 'N/A');
  // Fall back to the owner email when only an email was resolved (e.g. the CRM's hubspot_owner_email
  // fallback supplies an email but no name) so "Deal Owner" shows the requester instead of N/A.
  const ownerName = esc(params.ownerName || params.dealData.ownerEmail || 'N/A');

  const row = (label: string, value: string, isHtml = false) =>
    `<tr>
      <td style="padding:10px 16px;border-bottom:1px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;width:160px;vertical-align:top;">${label}</td>
      <td style="padding:10px 16px;border-bottom:1px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1e293b;vertical-align:top;">${isHtml ? value : value}</td>
    </tr>`;

  const sourceButtonHtml = params.sourceDealUrl
    ? `<td style="width:12px;">&nbsp;</td>
       <td style="border-radius:6px;border:2px solid #e2e8f0;" align="center">
         <a href="${params.sourceDealUrl.replace(/"/g, '&quot;')}" target="_blank" style="display:inline-block;padding:10px 24px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#64748b;text-decoration:none;border-radius:6px;">View in ${sourceLabel}</a>
       </td>`
    : '';

  const subject = `Review Required: ${params.dealData.dealname || 'New RFP'}`;
  const htmlBody = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <!--[if mso]><style>table{border-collapse:collapse;}td{font-family:Arial,Helvetica,sans-serif;}</style><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f1f5f9;">
    <tr><td align="center" style="padding:24px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0;">
        <!-- Header -->
        <tr>
          <td style="background:#1a1a2e;padding:28px 32px;text-align:center;">
            <!--[if mso]><v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false" style="width:600px;height:60px;"><v:fill type="solid" color="#1a1a2e"/><v:textbox inset="0,0,0,0" style="mso-fit-shape-to-text:true"><center><![endif]-->
            <span style="font-family:Arial,Helvetica,sans-serif;font-size:26px;font-weight:700;color:#ffffff;letter-spacing:1px;">T-ROCK</span>
            <span style="font-family:Arial,Helvetica,sans-serif;font-size:26px;font-weight:300;color:#d11921;letter-spacing:1px;"> GC</span>
            <!--[if mso]></center></v:textbox></v:rect><![endif]-->
          </td>
        </tr>
        <!-- Red accent bar -->
        <tr><td style="background:#d11921;height:4px;font-size:1px;line-height:1px;">&nbsp;</td></tr>
        <!-- Title -->
        <tr>
          <td style="padding:28px 32px 8px 32px;">
            <h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:700;color:#1a1a2e;">New RFP Review Required</h1>
            <p style="margin:8px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#64748b;line-height:1.5;">A new deal requires your review and approval before a BidBoard project is created.</p>
          </td>
        </tr>
        <!-- Deal name banner -->
        <tr>
          <td style="padding:8px 32px 20px 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fef2f2;border-left:4px solid #d11921;border-radius:4px;">
              <tr><td style="padding:14px 18px;font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:700;color:#1a1a2e;">${dealName}</td></tr>
            </table>
          </td>
        </tr>
        <!-- Details table -->
        <tr>
          <td style="padding:0 32px 24px 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e2e8f0;border-radius:6px;overflow:hidden;">
              ${row('Project Type', projectType)}
              ${row('Project Number', projectNumber)}
              ${row('Amount', amount)}
              ${row('Company', companyName)}
              ${row('Location', location)}
              ${row('Estimator', estimator)}
              ${row('Deal Owner', ownerName)}
              ${row('Description', description)}
              ${row('Attachments', attachmentListHtml, true)}
            </table>
          </td>
        </tr>
        <!-- CTA Buttons -->
        <tr>
          <td style="padding:0 32px 12px 32px;" align="center">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="border-radius:6px;background:#d11921;" align="center">
                  <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${reviewUrl}" style="height:44px;v-text-anchor:middle;width:220px;" arcsize="14%" strokecolor="#d11921" fillcolor="#d11921"><center style="color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;"><![endif]-->
                  <a href="${reviewUrl}" target="_blank" style="display:inline-block;padding:12px 32px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:6px;background:#d11921;">Review &amp; Approve</a>
                  <!--[if mso]></center></v:roundrect><![endif]-->
                </td>
                ${sourceButtonHtml}
              </tr>
            </table>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="padding:20px 32px;border-top:1px solid #e2e8f0;">
            <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#94a3b8;text-align:center;">Sent by T-Rock Sync Hub &bull; This is an automated notification</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  // Route by the CANONICAL type the approval will actually create (the same single source the
  // approve/decline gates authorize against), NOT the raw routed project_types — so a row with
  // project_types '2' but project_number 'DFW-4-...' notifies the SERVICE approvers who can act on
  // it, instead of stranding it with non-service approvers the gate would later 403. No editedFields
  // at send time → this resolves parseProjectTypeFromNumber(project_number) ?? project_types ?? '2',
  // a NO-OP for consistent rows (project_types already equals the number's type digit).
  const effectiveProjectType = resolveEffectiveRfpProjectType(params.dealData);
  const rfpRecipients = await getRfpReviewRecipients(effectiveProjectType, params.input.sourceSystem);
  console.log(`[rfp-approval] Project type: ${effectiveProjectType || 'none'}, recipients: ${rfpRecipients.join(', ')}`);
  return { recipients: rfpRecipients, subject, htmlBody };
}

async function sendRfpReviewEmails(
  prepared: PreparedRfpReviewEmails,
  params: { token: string; input: NormalizedRfpRequestInput },
): Promise<string[]> {
  const { recipients: rfpRecipients, subject, htmlBody } = prepared;
  for (const recipient of rfpRecipients) {
    try {
      const result = await sendEmail({
        to: recipient,
        subject,
        htmlBody,
        fromName: 'T-Rock Sync Hub',
      });

      const metadata = params.input.sourceSystem === 'hubspot'
        ? { hubspotDealId: params.input.sourceDealId, token: params.token }
        : { sourceSystem: params.input.sourceSystem, sourceDealId: params.input.sourceDealId, sourceEventId: params.input.sourceEventId, token: params.token };

      await storage.createEmailSendLog({
        templateKey: 'rfp_review',
        recipientEmail: recipient,
        recipientName: null,
        subject,
        dedupeKey: `rfp_review:${params.input.sourceDealId}:${recipient}:${params.token}`,
        status: result.success ? 'sent' : 'failed',
        errorMessage: result.error || null,
        metadata,
        sentAt: new Date(),
      });

      log(`[rfp-approval] Email ${result.success ? 'sent' : 'failed'} to ${recipient} for ${params.input.sourceSystem} deal ${params.input.sourceDealId}`, 'rfp');
    } catch (emailErr: any) {
      console.error(`[rfp-approval] Failed to send email to ${recipient}:`, emailErr.message);
    }
  }

  return rfpRecipients;
}

function buildConflictResult(code: 'pending_collision' | 'approved_collision', projectNumber: string, request: any): CreateRfpApprovalRequestResult {
  const message = code === 'pending_collision'
    ? `RFP already in flight for project_number=${projectNumber} from source=${request.sourceSystem}`
    : `Bid Board project already created for this project_number`;

  return {
    success: false,
    statusCode: 409,
    code,
    message,
    projectNumber,
    conflict: {
      requestId: request.id,
      token: request.token,
      status: request.status,
      sourceSystem: request.sourceSystem,
      sourceDealId: request.sourceDealId,
      bidboardProjectId: request.bidboardProjectId,
    },
  };
}

function buildSourceDealPendingConflictResult(sourceSystem: string, sourceDealId: string, request: any): CreateRfpApprovalRequestResult {
  return {
    success: false,
    statusCode: 409,
    error: 'RFP already in flight',
    message: `Pending RFP already exists for ${sourceSystem} deal ${sourceDealId}`,
    conflict: {
      requestId: request.id,
      sourceSystem: request.sourceSystem,
      sourceDealId: request.sourceDealId,
      status: request.status,
    },
  };
}

/**
 * REQ 939 (2026-11-13): a pending request whose review link has EXPIRED is dead (approve and decline both refuse it, and the
 * digest drops it), yet its 'pending' status refused every re-send for the same project number or source deal: the
 * collision check below and the idx_rfp_approval_pending_* indexes. A new request now supersedes it (pending → expired). The
 * expiry test here only skips a pointless write; the conditional UPDATE in storage is the authority (still pending AND still
 * expired at write time). A live pending request, and a legacy one with no expiry, still collide exactly as before.
 */
async function supersedeExpiredPendingRequests(input: NormalizedRfpRequestInput): Promise<void> {
  const byProjectNumber = await storage.getRfpApprovalRequestByProjectNumberAndStatus(input.deal.projectNumber, 'pending');
  const bySourceDeal = await storage.getRfpApprovalRequestBySourceDealAndStatus(input.sourceSystem, input.sourceDealId, 'pending');
  for (const request of [byProjectNumber, bySourceDeal]) {
    if (!request || !isRfpApprovalRequestExpired(request)) continue;
    const superseded = await storage.supersedeExpiredPendingRfpApprovalRequest(request.id);
    if (superseded) {
      log(`[rfp-approval] Request ${request.id} (link expired) superseded by a new request for ${input.sourceSystem} deal ${input.sourceDealId}`, 'rfp');
    }
  }
}

export async function createRfpApprovalRequestFromNormalizedInput(
  input: NormalizedRfpRequestInput
): Promise<CreateRfpApprovalRequestResult> {
  try {
    const existingEvent = await storage.getRfpApprovalRequestBySourceEventId(input.sourceSystem, input.sourceEventId);
    if (existingEvent) {
      return {
        success: true,
        requestId: existingEvent.id,
        token: existingEvent.token,
        status: existingEvent.status,
        idempotent: true,
      };
    }

    await supersedeExpiredPendingRequests(input);

    const pendingConflict = await storage.getRfpApprovalRequestByProjectNumberAndStatus(input.deal.projectNumber, 'pending');
    if (pendingConflict) {
      return buildConflictResult('pending_collision', input.deal.projectNumber, pendingConflict);
    }

    const approvedConflict = await storage.getRfpApprovalRequestByProjectNumberAndStatus(input.deal.projectNumber, 'approved');
    if (approvedConflict) {
      return buildConflictResult('approved_collision', input.deal.projectNumber, approvedConflict);
    }

    // An override-approve is mid-flight for this project number (claimed declined → override_approving
    // and creating a BidBoard project right now). Treat it as in-flight so a re-bid webhook can't
    // insert a second approvable request that would create a duplicate project.
    const overrideConflict = await storage.getRfpApprovalRequestByProjectNumberAndStatus(input.deal.projectNumber, RFP_OVERRIDE_APPROVING_STATUS);
    if (overrideConflict) {
      return buildConflictResult('pending_collision', input.deal.projectNumber, overrideConflict);
    }

    // Also guard by source deal: a re-bid carrying a REVISED project number would slip past the
    // project-number check above, and the DB source-deal uniqueness is partial to status='pending',
    // so it doesn't cover an in-flight override. Block it explicitly.
    const overrideSourceConflict = await storage.getRfpApprovalRequestBySourceDealAndStatus(input.sourceSystem, input.sourceDealId, RFP_OVERRIDE_APPROVING_STATUS);
    if (overrideSourceConflict) {
      return buildSourceDealPendingConflictResult(input.sourceSystem, input.sourceDealId, overrideSourceConflict);
    }

    // S0b-2a (d9 Q6): an `approving` request (the email path creating a Bid Board project right now) is in flight exactly like
    // override_approving, by project number and by source deal.
    const approvingConflict = await storage.getRfpApprovalRequestByProjectNumberAndStatus(input.deal.projectNumber, RFP_APPROVING_STATUS);
    if (approvingConflict) {
      return buildConflictResult('pending_collision', input.deal.projectNumber, approvingConflict);
    }
    const approvingSourceConflict = await storage.getRfpApprovalRequestBySourceDealAndStatus(input.sourceSystem, input.sourceDealId, RFP_APPROVING_STATUS);
    if (approvingSourceConflict) {
      return buildSourceDealPendingConflictResult(input.sourceSystem, input.sourceDealId, approvingSourceConflict);
    }

    const token = randomUUID();
    const sourceDealUrl = await buildSourceDealUrl(input.sourceSystem, input.sourceDealId);
    // HubSpot resolves the owner via its own API; trock_crm sends the resolved owner (assigned_rep
    // → name/email, with fallbacks) in the request payload. Previously the trock_crm branch was an
    // empty stub, which left "Requested by" blank on every CRM-sourced RFP.
    const rawOwnerInfo = input.sourceSystem === 'hubspot'
      ? await getDealOwnerInfo(input.sourceDealId)
      : { ownerName: input.deal.ownerName ?? '', ownerEmail: input.deal.ownerEmail ?? '' };
    const ownerInfo = {
      ownerName: rawOwnerInfo.ownerName || '',
      ownerEmail: rawOwnerInfo.ownerEmail || '',
    };
    const dealData = normalizedDealData(input, ownerInfo, sourceDealUrl);
    const reviewEmails = await prepareRfpReviewEmails({
      token,
      input,
      dealData,
      ownerName: ownerInfo.ownerName || '',
      sourceDealUrl,
    });

    let created;
    try {
      created = await storage.createRfpApprovalRequest({
        sourceSystem: input.sourceSystem,
        sourceDealId: input.sourceDealId,
        sourceEventId: input.sourceEventId,
        projectNumber: input.deal.projectNumber,
        // hubspot_deal_id is dual-written only during the HubSpot migration window.
        hubspotDealId: input.sourceSystem === 'hubspot' ? input.sourceDealId : null,
        token,
        tokenExpiresAt: new Date(Date.now() + TOKEN_TTL_MS),
        status: 'pending',
        dealData,
      });
    } catch (error) {
      if (isUniqueViolation(error, 'idx_rfp_approval_pending_project_number') || isUniqueViolation(error, 'idx_rfp_approval_live_project_number')) {
        // Since migration 0021 these indexes also cover 'override_approving', so a race-insert can
        // conflict with an in-flight override row — re-query both statuses so it surfaces as a
        // clean conflict, not a thrown 500.
        const conflict = (await storage.getRfpApprovalRequestByProjectNumberAndStatus(input.deal.projectNumber, 'pending'))
          ?? (await storage.getRfpApprovalRequestByProjectNumberAndStatus(input.deal.projectNumber, RFP_OVERRIDE_APPROVING_STATUS))
          ?? (await storage.getRfpApprovalRequestByProjectNumberAndStatus(input.deal.projectNumber, RFP_APPROVING_STATUS));
        if (conflict) {
          return buildConflictResult('pending_collision', input.deal.projectNumber, conflict);
        }
      }
      if (isUniqueViolation(error, 'idx_rfp_approval_pending_source_deal') || isUniqueViolation(error, 'idx_rfp_approval_live_source_deal')) {
        const conflict = (await storage.getRfpApprovalRequestBySourceDealId(input.sourceSystem, input.sourceDealId))
          ?? (await storage.getRfpApprovalRequestBySourceDealAndStatus(input.sourceSystem, input.sourceDealId, RFP_OVERRIDE_APPROVING_STATUS))
          ?? (await storage.getRfpApprovalRequestBySourceDealAndStatus(input.sourceSystem, input.sourceDealId, RFP_APPROVING_STATUS));
        if (conflict && (conflict.status === 'pending' || conflict.status === RFP_OVERRIDE_APPROVING_STATUS || conflict.status === RFP_APPROVING_STATUS)) {
          return buildSourceDealPendingConflictResult(input.sourceSystem, input.sourceDealId, conflict);
        }
      }
      throw error;
    }

    const rfpRecipients = await sendRfpReviewEmails(reviewEmails, { token, input });

    await storage.createAuditLog({
      action: 'rfp_approval_request_created',
      entityType: 'deal',
      entityId: input.sourceDealId,
      source: 'rfp-approval',
      status: 'success',
      details: {
        token,
        recipients: rfpRecipients,
        dealName: dealData.dealname,
        sourceSystem: input.sourceSystem,
        sourceDealId: input.sourceDealId,
        projectNumber: input.deal.projectNumber,
      },
    });

    return { success: true, requestId: created.id, token, status: created.status };
  } catch (e: any) {
    console.error(`[rfp-approval] Error creating normalized approval request for ${input.sourceSystem} deal ${input.sourceDealId}:`, e.message);
    return { success: false, error: e.message, fault: true };
  }
}

export async function buildNormalizedRfpRequestFromHubSpotDeal(
  hubspotDealId: string,
  event?: { eventId?: string | number | null; occurredAt?: number | string | null }
): Promise<NormalizedRfpRequestInput> {
  const dealData = await fetchFullDealFromHubSpot(hubspotDealId);
  const sourceEventId = event?.eventId
    ? `hubspot:event:${event.eventId}`
    : `hubspot:dealstage:rfp:${hubspotDealId}:${event?.occurredAt || Date.now()}`;

  return {
    sourceSystem: 'hubspot',
    sourceDealId: hubspotDealId,
    sourceEventId,
    deal: {
      name: String(dealData.dealname || ''),
      projectNumber: String(dealData.project_number || ''),
      projectType: String(dealData.project_types || ''),
      amount: dealData.amount === null || dealData.amount === undefined || dealData.amount === '' ? null : Number(dealData.amount),
      estimator: dealData.estimator || null,
      companyName: dealData.company_name || null,
      contactName: dealData.contact_name || null,
      clientEmail: dealData.client_email || null,
      clientPhone: dealData.client_phone || null,
      address: {
        street: dealData.address || dealData.project_location || null,
        city: dealData.city || null,
        state: dealData.state || null,
        zip: dealData.zip || null,
        country: dealData.country || null,
      },
      description: resolveRfpDescription(dealData) || null,
      dueDate: dealData.bid_due_date || dealData.due_date || dealData.closedate || null,
      workflowRoute: dealData.workflowRoute || null,
    },
    attachments: ((dealData.attachments || []) as Array<{ name?: string; url?: string; type?: string }>)
      .filter((attachment) => attachment.url)
      .map((attachment) => ({
        name: attachment.name || 'Attachment',
        url: attachment.url!,
        contentType: attachment.type || null,
      })),
  };
}

export async function createRfpApprovalRequest(
  hubspotDealId: string
): Promise<{ success: boolean; token?: string; error?: string; fault?: true }> {
  try {
    // S0b-2a: an `approving` request (mid-create) blocks a new one exactly like a pending one.
    const existing = (await storage.getRfpApprovalRequestByDealId(hubspotDealId))
      ?? (await storage.getRfpApprovalRequestBySourceDealAndStatus('hubspot', hubspotDealId, RFP_APPROVING_STATUS));
    if (existing) {
      log(`[rfp-approval] ${existing.status === RFP_APPROVING_STATUS ? 'An approving' : 'Pending'} approval already exists for deal ${hubspotDealId}, skipping`, 'rfp');
      return { success: true, token: existing.token };
    }

    const input = await buildNormalizedRfpRequestFromHubSpotDeal(hubspotDealId);
    const result = await createRfpApprovalRequestFromNormalizedInput(input);
    if (result.success) {
      return { success: true, token: result.token };
    }
    // F-181: a fault (not a refusal) is passed through, so the HubSpot webhook marks it failed and replayable.
    if ('fault' in result && result.fault) return { success: false, error: result.error, fault: true };
    return { success: false, error: 'error' in result ? result.error : result.message };
  } catch (e: any) {
    console.error(`[rfp-approval] Error creating approval request for deal ${hubspotDealId}:`, e.message);
    return { success: false, error: e.message, fault: true };
  }
}

export interface RfpApprovalAttachmentOptions {
  attachmentsOverride: Array<{ name: string; url?: string; _new?: boolean }>;
  newFiles: Array<{ buffer: Buffer; originalname: string; mimetype?: string; size?: number }>;
}

export async function processRfpApproval(
  token: string,
  editedFields: Record<string, string>,
  approverEmail: string,
  options?: { attachmentsOverride?: RfpApprovalAttachmentOptions['attachmentsOverride']; newFiles?: RfpApprovalAttachmentOptions['newFiles']; force?: boolean },
  /** S0b-2b, recreateApprovingRequest only: replay the CREATE STEP of this stuck `approving` request with its recorded inputs.
   *  Every pre-create HubSpot / Core step is skipped (they already ran: hubspot_done_at), and the claim is the locked re-claim. */
  resume?: { requestId: number },
): Promise<{ success: boolean; error?: string; bidboardProjectId?: string; statusCode?: number; message?: string }> {
  // `force` is the authoritative override-approve path (reviewer re-approves a declined RFP
  // from the CRM). It relaxes the pending-only and expiry guards — the action is authenticated
  // server-to-server via HMAC, not via the (possibly stale) email token — but on a Playwright
  // failure it leaves the request re-tryable instead of marking it approved (see below).
  const force = options?.force === true;
  try {
    const request = await storage.getRfpApprovalRequestByToken(token);
    if (!request) return { success: false, error: 'Approval request not found' };
    if (resume) {
      if (request.id !== resume.requestId || request.status !== 'approving' || request.bidboardProjectId) {
        return { success: false, error: `Recreate refused: request ${request.id} is ${request.status}${request.bidboardProjectId ? `, BidBoard ${request.bidboardProjectId}` : ''}` };
      }
    } else if (request.status !== 'pending' && !force) return { success: false, error: `Request already ${request.status}` };
    // Force (override) path: the claim guaranteed no project at claim time, but the row could have
    // been resolved between the 202 response and this re-read (e.g. a reviewer approved it manually).
    // If it now carries a project id or reached a terminal state, abort rather than double-create.
    if (force && (request.bidboardProjectId || request.status === 'approved' || request.status === 'cancelled_source_ineligible')) {
      return {
        success: false,
        error: `Override aborted: request ${request.id} was already resolved (status=${request.status}${request.bidboardProjectId ? `, BidBoard ${request.bidboardProjectId}` : ''}).`,
      };
    }
    if (!force && !resume && isRfpApprovalRequestExpired(request)) {
      await auditRfpApprovalAttempt(request, 'expired', approverEmail, 'Token expired');
      return {
        success: false,
        error: 'expired',
        statusCode: 410,
        message: buildExpiredRfpMessage(request),
      };
    }

    const dealData = request.dealData as Record<string, any>;
    const identity = sourceIdentityForRequest(request);
    await auditRfpApprovalAttempt(request, 'attempted', approverEmail);

    const eligibility = await checkRfpApprovalSourceEligibility(request);
    if (!eligibility.eligible) {
      // A replay writes nothing on an ineligible deal: STOP and escalate (runbook r5 §3C), never a cancel.
      if (resume) return { success: false, error: `Recreate refused: the source deal is no longer eligible (${eligibility.reason || 'ineligible'})` };
      return cancelIneligibleRfpApproval(request, approverEmail, eligibility.reason || 'Source deal is no longer eligible');
    }

    const sourceDealId = identity.sourceDealId;
    const hubspotDealId = request.sourceSystem === 'hubspot' ? sourceDealId : null;

    // Check if project type changed — update project number and HubSpot immediately.
    // The canonical type digit (service vs non-service) is resolved via the shared helper so this
    // processor and the approve-route authz gate pick the SAME type — no drift. See
    // resolveEffectiveRfpProjectType; the inline branch below only rewrites the project NUMBER when the
    // routing group changed (the type digit itself is already finalProjectTypeDigit).
    const submittedProjectType = editedFields.project_types;
    const currentProjectNumber = (dealData.project_number ?? '') as string;
    const currentTypeDigit = parseProjectTypeFromNumber(currentProjectNumber) ?? dealData.project_types ?? '';

    let finalProjectNumber = currentProjectNumber;
    const finalProjectTypeDigit = resolveEffectiveRfpProjectType(dealData, editedFields) || '2';
    // S0b-2b (d9 QA (b)): did EVERY pre-create HubSpot step report success? Recorded with the claim (hubspot_done_at); the
    // resolve CLI's recreate replays the create step only, so it refuses unless these steps are known to have finished.
    let preCreateStepsOk = true;

    if (submittedProjectType && submittedProjectType !== currentTypeDigit) {
      const updatedProjectNumber = replaceProjectTypeInNumber(currentProjectNumber, submittedProjectType);
      finalProjectNumber = updatedProjectNumber;

      try {
        if (hubspotDealId && !resume) {
          const numberUpdate = await updateHubSpotDeal(hubspotDealId, {
            project_number: updatedProjectNumber,
            project_types: submittedProjectType,
          });
          if (numberUpdate && (numberUpdate as any).success === false) preCreateStepsOk = false;
        }
        log(`[rfp-approval] Updated project number: ${currentProjectNumber} → ${updatedProjectNumber}`, 'rfp');
      } catch (err: any) {
        preCreateStepsOk = false;
        log(`[rfp-approval] Warning: Failed to update project number in HubSpot: ${err.message}`, 'rfp');
        // Non-fatal — continue with BidBoard creation
      }
    }

    const changedFields: Record<string, string> = {};
    for (const [key, value] of Object.entries(editedFields)) {
      if (value !== undefined && value !== dealData[key]) {
        changedFields[key] = value;
      }
    }

    if (Object.keys(changedFields).length > 0) {
      const hubspotUpdateProps: Record<string, string> = {};
      const ALLOWED_HUBSPOT_KEYS = ['dealname', 'amount', 'project_types', 'project_number', 'project_location',
        'address', 'city', 'state', 'zip', 'country', 'description', 'estimator',
        'notes', 'due_date', 'client_email', 'client_phone', 'company_name'];
      for (const [key, value] of Object.entries(changedFields)) {
        if (ALLOWED_HUBSPOT_KEYS.includes(key)) {
          hubspotUpdateProps[key] = value;
        }
      }
      // Sync custom HubSpot properties when form fields change
      if (changedFields.description !== undefined) {
        hubspotUpdateProps.project_description__briefly_describe_the_project_ = changedFields.description;
      }
      // bid_due_date: map to closedate (HubSpot native) and proposal_due_date (custom)
      if (changedFields.bid_due_date !== undefined) {
        const dateStr = changedFields.bid_due_date;
        if (dateStr && /^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
          const date = new Date(dateStr);
          hubspotUpdateProps.closedate = date.getTime().toString();
          hubspotUpdateProps.proposal_due_date = date.getTime().toString();
        }
      }

      if (Object.keys(hubspotUpdateProps).length > 0) {
        if (hubspotDealId && !resume) {
          const updateResult = await updateHubSpotDeal(hubspotDealId, hubspotUpdateProps);
          if (!updateResult.success) {
            preCreateStepsOk = false;
            console.error(`[rfp-approval] Failed to update HubSpot deal: ${updateResult.message}`);
          }
          log(`[rfp-approval] Updated HubSpot deal ${hubspotDealId} with ${Object.keys(hubspotUpdateProps).length} changed fields`, 'rfp');
        }
      }
    }

    const isService = String(finalProjectTypeDigit) === '4';
    const targetStageName = isService ? 'Service - Estimating' : 'Estimating';

    if (hubspotDealId && !resume) {
      const resolvedStage = await resolveHubspotStageId(targetStageName);
      if (resolvedStage) {
        const stageUpdate = await updateHubSpotDealStage(hubspotDealId, resolvedStage.stageId);
        if (stageUpdate && (stageUpdate as any).success === false) preCreateStepsOk = false;
        log(`[rfp-approval] Deal ${hubspotDealId} moved to stage "${resolvedStage.stageName}" (type=${finalProjectTypeDigit})`, 'rfp');
      } else {
        const altName = isService ? 'Service – Estimating' : 'Estimating';
        const altStage = await resolveHubspotStageId(altName);
        if (altStage) {
          const altStageUpdate = await updateHubSpotDealStage(hubspotDealId, altStage.stageId);
          if (altStageUpdate && (altStageUpdate as any).success === false) preCreateStepsOk = false;
          log(`[rfp-approval] Deal ${hubspotDealId} moved to stage "${altStage.stageName}" (alt match)`, 'rfp');
        } else {
          preCreateStepsOk = false;
          console.error(`[rfp-approval] Could not resolve HubSpot stage for "${targetStageName}"`);
        }
      }
    }

    // Refresh local deal cache so BidBoard creation picks up any edits
    if (hubspotDealId && !resume) {
      try {
        const { syncSingleHubSpotDeal } = await import('./hubspot');
        await syncSingleHubSpotDeal(hubspotDealId);
        log(`[rfp-approval] Local deal cache refreshed for ${hubspotDealId}`, 'rfp');
      } catch (syncErr: any) {
        preCreateStepsOk = false;
        console.error(`[rfp-approval] Failed to refresh deal cache: ${syncErr.message}`);
      }
    }

    // HOISTED out of the createBidBoardProjectFromDeal call arguments below. It is the one resolved
    // view of this approval's field values, and BOTH the TROCK Core payload and the Procore Playwright
    // create are built from it — built inline, the two systems could be told different things about a
    // single approval and nothing would notice.
    const editedFieldsOverride: Record<string, string> = {
      // The CRM activity log travels here rather than via normalizedDealData, which is passed
      // ONLY for trock_crm — a hubspot-sourced request that carried crmActivityLog would
      // otherwise be persisted in deal_data and then silently dropped before the create, so the
      // field would be "accepted but unused" on that path. editedFieldsOverride is passed for
      // BOTH source systems, so routing it through here keeps accepted == used everywhere.
      // (In practice only the CRM sends the field today; this removes the divergence rather than
      // documenting it.)
      ...(dealData.crm_activity_log ? { crm_activity_log: String(dealData.crm_activity_log) } : {}),
      // Enriched dealData fields as fallbacks (description, company, contact, address from HubSpot API associations)
      ...(dealData.description ? { description: String(dealData.description) } : {}),
      ...(dealData.company_name ? { company_name: String(dealData.company_name) } : {}),
      ...(dealData.contact_name ? { contact_name: String(dealData.contact_name) } : {}),
      ...(dealData.address ? { address: String(dealData.address) } : {}),
      ...(dealData.city ? { city: String(dealData.city) } : {}),
      ...(dealData.state ? { state: String(dealData.state) } : {}),
      ...(dealData.zip ? { zip: String(dealData.zip) } : {}),
      // User-edited fields override the enriched fallbacks
      ...editedFields,
      project_types: finalProjectTypeDigit,
    };

    // PROCORE PROJECT CREATION IS RETIRED (owner 2026-11-13, b0cb0c4f; a4 afa14cfd). The approval no longer claims, creates
    // or waits on a Procore Bid Board project:
    //   - a SERVICE RFP's job is the Core card handed off below; the CRM is told the RFP is approved once Core confirms that
    //     card (rfp-approved-callback.ts: here, when Core already has, or in markSent when it answers later);
    //   - a NON-service RFP approved here has no Core destination on this path (Core's Bid Board takes CRM-vote approvals
    //     only, rfp-destination.ts rule (c)), so a CRM request gets a FAILED callback that says so: visible and actionable
    //     in the CRM, never a silent 'approved';
    //   - a resolver replay (resume) of a request stuck `approving` has nothing left to create.
    if (resume) return { success: false, error: PROCORE_CREATE_RETIRED_ERROR };

    // Files added at approval used to ride the Procore create (and its HubSpot copy); nothing stores them now, so they are
    // named on the request and in the status email rather than silently dropped.
    const newFileNames = (options?.newFiles || []).map((f) => f.originalname || 'attachment');
    const approvedAttachmentsForStorage = [
      ...(options?.attachmentsOverride || []).filter((a) => !a._new && a.url).map((a) => ({ name: a.name || 'attachment', url: a.url, _new: false })),
      ...newFileNames.map((name) => ({ name, _new: true, notStored: true })),
    ];
    if (newFileNames.length > 0) {
      log(`[rfp-approval] Request ${request.id}: ${newFileNames.length} file(s) added at approval were not stored (Procore creation retired)`, 'rfp');
    }

    const approvedAt = new Date();
    // Written only while the row still has the status read above (pending; the override's claimed status), so a concurrent
    // decline or a second approval of the same link makes this a no-op instead of a second approval.
    const approved = await storage.updateRfpApprovalRequest(request.id, {
      status: 'approved',
      editedFields: changedFields,
      approvedAttachments: approvedAttachmentsForStorage,
      approvedBy: approverEmail,
      approvedAt,
      bidboardProjectId: null,
      // Override-approve clears the prior decline so reporting can't show both an approved and a rejected decision.
      ...(force ? { declinedBy: null, declinedAt: null } : {}),
    }, { expectedStatus: request.status });
    if (!approved) {
      return { success: false, error: `Request ${request.id} changed while it was being approved`, statusCode: 409 };
    }

    // Tell TROCK Core about the service job: its card IS the job now that Procore project creation is retired. AFTER the
    // conditional approval above (CodeRabbit on #136, the decline race): a decline that won the row stops here with a 409, so
    // Core never gets a job for a declined RFP. FAIL-OPEN by construction: this never throws, and the approval stands whatever
    // it answers. A Core outage leaves a queued outbox row (retried, and visible on the health dashboard), and the CRM is told
    // 'approved' only once Core confirms the card. Only a skipped or refused handoff is branched on, below.
    let coreHandoff: { status: string } | undefined;
    if (isService && !resume) {
      coreHandoff = await handOffServiceRfpApprovalToCore({
        sourceSystem: identity.sourceSystem,
        sourceDealId,
        rfpRequestId: request.id,
        // The POST-rewrite number, so a type change made at approval time is the number Core records.
        projectNumber: finalProjectNumber,
        dealData,
        editedFieldsOverride,
      });
    }

    let crmStep: RfpStatusStep;
    if (isService && coreHandoff?.status === 'skipped') {
      // A SKIPPED handoff (Core ingress not provisioned, or the outbox insert itself threw) left no outbox row: no Core job,
      // nothing for the worker to retry, and no Core confirmation to tell the CRM. With Procore retired nothing else makes
      // the job, so the gap is raised and the email says so. The approval stands (the source deal has already moved); the
      // job reaches Core by a re-drive (CodeRabbit on #136; a4 e9effe02).
      const { raiseRfpCoreAlert } = await import('./sync/rfp-core-alert');
      await raiseRfpCoreAlert('service_handoff_skipped', {
        requestId: request.id, sourceSystem: identity.sourceSystem, sourceDealId, projectNumber: finalProjectNumber,
      });
      crmStep = { name: 'T-Rock Core service card', success: false, detail: 'NOT handed to Core: re-drive needed' };
    } else if (isService && (coreHandoff?.status === 'failed' || coreHandoff?.status === 'dead')) {
      // A REFUSED handoff (the payload failed Core's contract, a terminal Core refusal, or a delivery that gave up) has no card
      // for Core to confirm either. Its own delivery alert has already fired (reportDelivery, terminal), so this only keeps
      // the email from saying it reached Core (CodeRabbit on #136; a4 a4023987).
      crmStep = { name: 'T-Rock Core service card', success: false, detail: 'NOT handed to Core: Core refused the job — correct the deal, then re-drive' };
    } else if (isService) {
      let told = false;
      if (identity.sourceSystem === 'trock_crm') {
        try {
          told = await enqueueRfpApprovedCallbackIfCoreConfirmed(request.id);
        } catch (callbackErr: any) {
          // The approval stands; a callback lost here is found by the reconcile (approved, Core confirmed, no callback).
          log(`[rfp-approval] Request ${request.id}: the CRM approved callback could not be enqueued: ${callbackErr?.message || callbackErr}`, 'rfp');
        }
      }
      crmStep = {
        name: 'T-Rock Core service card',
        success: true,
        detail: told ? 'Core confirmed the card; the CRM is told the RFP is approved' : 'Handed to Core; the CRM is told when Core confirms the card',
      };
    } else {
      const failedCallback = await buildBidBoardFailedCallbackData({
        request,
        sourceDealId,
        projectNumber: finalProjectNumber,
        error: NO_CORE_ROUTE_ERROR,
      });
      if (failedCallback) {
        try {
          await storage.enqueueBidboardCallback(failedCallback);
        } catch (callbackErr: any) {
          // The approval stands; the CRM still shows the RFP pending, and its own queue surfaces it for a person.
          log(`[rfp-approval] Request ${request.id}: the CRM failed callback could not be enqueued: ${callbackErr?.message || callbackErr}`, 'rfp');
        }
      }
      crmStep = { name: 'T-Rock Core record', success: false, detail: NO_CORE_ROUTE_ERROR };
    }

    await storage.createAuditLog({
      action: 'rfp_approval_approved',
      entityType: 'deal',
      entityId: sourceDealId,
      source: 'rfp-approval',
      status: isService ? 'success' : 'failed',
      details: {
        token,
        approvedBy: approverEmail,
        changedFields,
        approvedAttachments: approvedAttachmentsForStorage,
        projectType: finalProjectTypeDigit,
        targetStage: targetStageName,
        procoreCreate: 'retired',
        ...buildRfpAuditDetails(request, 'approved', approverEmail),
      },
    });

    await sendRfpApprovalStatusEmail({
      dealName: (editedFields.dealname && String(editedFields.dealname).trim()) || dealData.dealname || 'Unknown Deal',
      hubspotDealId: hubspotDealId || sourceDealId,
      projectNumber: finalProjectNumber,
      approverEmail,
      bidboardFailed: false,
      steps: [
        { name: 'Source Deal Updated', success: true, detail: `Stage: ${hubspotDealId ? targetStageName : 'unchanged'}, Fields: ${Object.keys(changedFields).length} changed` },
        crmStep,
        ...(newFileNames.length > 0
          ? [{ name: 'Files added at approval', success: false, detail: `${newFileNames.length} file(s) were not stored: Procore project creation is retired` }]
          : []),
      ],
    });

    return { success: true };
  } catch (e: any) {
    console.error(`[rfp-approval] Error processing approval for token ${token}:`, e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Runbook r5 §3A (`found`), for scripts/rfp-resolve-approving.ts only: finalise a STUCK `approving` request against the ONE
 * Procore project the dry-run found, the way a successful create would (approved + bidboard_project_id, the sync mapping, the
 * CRM `created` callback through the existing outbox) and with NO Procore write. Only a row still `approving` is finalised.
 * The approver is the original approval's (recorded at the claim), else the resolver itself.
 */
export async function finaliseApprovingFound(
  requestId: number,
  bidboardProjectId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const { effectiveApprovingProjectNumber, readApprovingFacts, finaliseApprovingFoundRecord } = await import('./sync/rfp-approving');
    const facts = await readApprovingFacts(requestId);
    if (!facts) return { success: false, error: 'Approval request not found' };
    if (facts.status !== 'approving') return { success: false, error: `the request is ${facts.status}, not approving` };
    const request = { id: facts.requestId, sourceSystem: facts.sourceSystem };
    // The number the search found it under (the type-edit renumber included), for the mapping and the callback alike.
    const projectNumber = effectiveApprovingProjectNumber(facts) ?? '';
    const callbackData = await buildBidBoardCreatedCallbackData({
      request,
      sourceDealId: facts.sourceDealId,
      bidboardProjectId,
      projectNumber,
    });
    const approvedBy = facts.recorded?.approvedBy ?? 'rfp-resolve-approving';
    const result = await finaliseApprovingFoundRecord({
      requestId,
      sourceSystem: facts.sourceSystem,
      sourceDealId: facts.sourceDealId,
      bidboardProjectId,
      approvedBy,
      projectNumber: projectNumber || null,
      dealName: (facts.dealData.dealname as string | undefined) ?? null,
      callback: callbackData ? { targetUrl: callbackData.targetUrl, payload: callbackData.payload, maxAttempts: callbackData.maxAttempts } : null,
    });
    if (result.success) {
      await storage.createAuditLog({
        action: 'rfp_approval_approved',
        entityType: 'deal',
        entityId: facts.sourceDealId,
        source: 'rfp-approval',
        status: 'success',
        details: { rfpApprovalRequestId: requestId, bidboardProjectId, approvedBy, resolvedBy: 'rfp-resolve-approving', resolution: 'found' },
      });
    }
    return result;
  } catch (e: any) {
    return { success: false, error: e?.message ?? String(e) };
  }
}

/**
 * RETIRED with Procore project creation (owner 2026-11-13, b0cb0c4f): the resolver's `--resolution recreate` used to replay a stuck
 * request's Procore create. There is nothing left to create, so it refuses, writes nothing and calls no Procore path; a stuck
 * `approving` request is resolved `found` against an existing project, or its job is handed to Core by a person.
 */
export async function recreateApprovingRequest(
  _requestId: number,
): Promise<{ success: boolean; error?: string; bidboardProjectId?: string }> {
  return { success: false, error: PROCORE_CREATE_RETIRED_ERROR };
}

export async function processRfpDecline(
  token: string,
  declinerEmail: string
): Promise<{ success: boolean; error?: string; statusCode?: number }> {
  try {
    const request = await storage.getRfpApprovalRequestByToken(token);
    if (!request) return { success: false, error: 'Approval request not found' };
    const sourceDealId = request.sourceSystem === 'hubspot' ? request.hubspotDealId! : request.sourceDealId;
    if (request.status !== 'pending') return { success: false, error: `Request already ${request.status}` };
    if (isRfpApprovalRequestExpired(request)) {
      await auditRfpDeclineAttempt(request, 'expired', declinerEmail, 'Token expired');
      return { success: false, error: 'expired' };
    }

    await auditRfpDeclineAttempt(request, 'declined', declinerEmail);

    const declinedAt = new Date();
    const declineData = {
      status: 'declined',
      declinedBy: declinerEmail,
      declinedAt,
    };
    const callbackData = buildRfpDeclinedCallbackData({
      request,
      sourceDealId,
      declinedAt,
    });
    const declineWithCallback = (storage as any).declineRfpApprovalRequestWithOptionalCallback;
    if (typeof declineWithCallback === 'function') {
      const declined = await declineWithCallback.call(storage, request.id, declineData, callbackData);
      if (!declined) {
        // Lost the race to the email path's flip (or another resolution): the conditional decline updated nothing (d9 5b).
        const now = await storage.getRfpApprovalRequestByToken(token);
        return { success: false, error: `Request already ${now?.status ?? 'resolved'}`, statusCode: 409 };
      }
    } else {
      await storage.updateRfpApprovalRequest(request.id, declineData);
      if (callbackData && typeof (storage as any).enqueueBidboardCallback === 'function') {
        await (storage as any).enqueueBidboardCallback(callbackData);
      }
    }

    await storage.createAuditLog({
      action: 'rfp_approval_declined',
      entityType: 'deal',
      entityId: request.sourceSystem === 'hubspot' ? request.hubspotDealId! : request.sourceDealId,
      source: 'rfp-approval',
      status: 'success',
      details: { token, declinedBy: declinerEmail, ...buildRfpAuditDetails(request, 'declined', declinerEmail) },
    });

    log(`[rfp-approval] Deal ${sourceDealId} RFP declined by ${declinerEmail}`, 'rfp');
    return { success: true };
  } catch (e: any) {
    console.error(`[rfp-approval] Error processing decline for token ${token}:`, e.message);
    return { success: false, error: e.message };
  }
}
