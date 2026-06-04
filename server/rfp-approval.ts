import crypto, { randomUUID } from 'crypto';
import fs from 'fs/promises';
import { fetchWithTimeout } from './lib/fetch-with-timeout';
import path from 'path';
import { isUniqueViolation, storage, type SourceSystem } from './storage';
import { getHubSpotClient, getAccessToken, updateHubSpotDeal, updateHubSpotDealStage, getDealOwnerInfo } from './hubspot';
import { parseProjectTypeFromNumber, replaceProjectTypeInNumber } from './constants';
import { resolveHubspotStageId } from './procore-hubspot-sync';
import { sendEmail, renderTemplate } from './email-service';
import { log } from './index';
import {
  buildBidBoardCreatedCallbackTargetUrl,
  buildRfpDeclinedCallbackTargetUrl,
  type BidBoardCreatedCallbackPayload,
  type RfpDeclinedCallbackPayload,
} from './sync/bidboard-callback-worker';

const RFP_ADMIN_EMAIL = 'adnaan.iqbal@gmail.com';
const DEFAULT_HUBSPOT_PORTAL_ID = '45644695';
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
  | { success: false; statusCode?: number; error: string };

type SourceEligibilityResult = { exists: boolean; stage: string | null; checkFailed?: boolean };

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

function normalizeStageForEligibility(stage: string | null | undefined): string {
  return String(stage || '').trim().toLowerCase().replace(/[–—−]/g, '-');
}

function isHubSpotRfpEligibleStageLabel(stage: string | null | undefined): boolean {
  const normalized = normalizeStageForEligibility(stage);
  return normalized.includes('rfp') || normalized.includes('estimating') || normalized.includes('estimate in progress');
}

async function isHubSpotRfpEligibleStageId(
  stageId: string | null | undefined,
  pipelineId: string | null | undefined
): Promise<{ eligible: boolean; resolvedLabel: string | null }> {
  if (!stageId) return { eligible: false, resolvedLabel: null };

  const pipelines = await storage.getHubspotPipelines();
  for (const pipeline of pipelines) {
    const currentPipelineId = (pipeline as any).hubspotId ?? (pipeline as any).hubspot_id ?? null;
    if (pipelineId && currentPipelineId !== pipelineId) continue;

    const stage = (((pipeline as any).stages || []) as any[]).find((candidate) => candidate?.stageId === stageId);
    if (stage) {
      const label = stage.label || null;
      return {
        eligible: isHubSpotRfpEligibleStageLabel(label),
        resolvedLabel: label,
      };
    }
  }

  return {
    eligible: isHubSpotRfpEligibleStageLabel(stageId),
    resolvedLabel: null,
  };
}

function isCrmOpportunityStage(stage: string | null | undefined): boolean {
  return normalizeStageForEligibility(stage) === 'opportunity';
}

function sourceIdentityForRequest(request: any): { sourceSystem: SourceSystem; sourceDealId: string; projectNumber: string } {
  const dealData = (request.dealData || {}) as Record<string, any>;
  const sourceSystem = (request.sourceSystem || 'hubspot') as SourceSystem;
  return {
    sourceSystem,
    sourceDealId: sourceSystem === 'hubspot'
      ? (request.hubspotDealId || request.sourceDealId)
      : request.sourceDealId,
    projectNumber: request.projectNumber || dealData.project_number || '',
  };
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

export async function checkCrmDealEligibility(sourceDealId: string): Promise<SourceEligibilityResult> {
  const baseUrl = process.env.TROCK_CRM_BASE_URL?.replace(/\/+$/, '');
  const secret = process.env.RFP_REQUEST_SYNC_SECRET;
  if (!baseUrl || !secret) {
    log('[rfp-approval] CRM eligibility check not configured; proceeding fail-open', 'rfp');
    return { exists: true, stage: null, checkFailed: true };
  }

  const pathPart = '/api/internal/deals/eligibility-check';
  const rawBody = JSON.stringify({ sourceDealId });
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;

  try {
    // Phase 5 CRM endpoint: POST /api/internal/deals/eligibility-check.
    const response = await fetch(`${baseUrl}${pathPart}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-rfp-request-signature': signature,
      },
      body: rawBody,
    });
    if (response.status === 404) return { exists: false, stage: null };
    if (response.status >= 500) {
      log(`[rfp-approval] CRM eligibility check returned ${response.status}; proceeding fail-open`, 'rfp');
      return { exists: true, stage: null, checkFailed: true };
    }
    if (!response.ok) return { exists: false, stage: null };
    const body = await response.json().catch(() => ({}));
    return { exists: true, stage: body?.stage ? String(body.stage) : null };
  } catch (error: any) {
    log(`[rfp-approval] CRM eligibility check failed (${error?.message || error}); proceeding fail-open`, 'rfp');
    return { exists: true, stage: null, checkFailed: true };
  }
}

export async function checkRfpApprovalSourceEligibility(request: any): Promise<{
  eligible: boolean;
  reason?: string;
  exists?: boolean;
  stage?: string | null;
  checkFailed?: boolean;
}> {
  const identity = sourceIdentityForRequest(request);

  if (identity.sourceSystem === 'trock_crm') {
    const crm = await checkCrmDealEligibility(identity.sourceDealId);
    if (crm.checkFailed) return { eligible: true, exists: crm.exists, stage: crm.stage, checkFailed: true };
    if (!crm.exists) return { eligible: false, reason: 'Source CRM deal no longer exists', exists: false, stage: crm.stage };
    if (!isCrmOpportunityStage(crm.stage)) {
      return { eligible: false, reason: `Source CRM deal is no longer in Opportunity stage (current stage: ${crm.stage || 'unknown'})`, exists: true, stage: crm.stage };
    }
    return { eligible: true, exists: true, stage: crm.stage };
  }

  try {
    const fresh = await fetchFullDealFromHubSpot(identity.sourceDealId);
    const stage = fresh.dealstage || fresh.dealStage || null;
    const pipeline = fresh.pipeline || null;
    const { eligible, resolvedLabel } = await isHubSpotRfpEligibleStageId(stage, pipeline);
    if (!eligible) {
      const stageDisplay = resolvedLabel ? `${resolvedLabel} (${stage})` : `${stage || 'unknown'}`;
      return { eligible: false, reason: `Source HubSpot deal is no longer RFP/Estimating eligible (current stage: ${stageDisplay})`, exists: true, stage };
    }
    return { eligible: true, exists: true, stage };
  } catch (error: any) {
    const status = error?.statusCode || error?.status || error?.code;
    if (status === 404 || String(error?.message || '').includes('404')) {
      return { eligible: false, reason: 'Source HubSpot deal no longer exists', exists: false, stage: null };
    }
    log(`[rfp-approval] HubSpot eligibility check failed (${error?.message || error}); proceeding fail-open`, 'rfp');
    return { eligible: true, exists: true, stage: null, checkFailed: true };
  }
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

export async function getRfpReviewRecipients(projectType: string | null | undefined, sourceSystem: string | null | undefined = 'hubspot'): Promise<string[]> {
  const type = String(projectType || '').trim();
  const source = String(sourceSystem || 'hubspot').trim();
  const cacheKey = `${type || '*'}:${source}`;
  const cached = rfpApproverCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < RFP_APPROVER_CACHE_TTL_MS) {
    return cached.recipients;
  }

  try {
    // TODO: Build an admin settings UI; for now rfp_approver_config is edited via SQL.
    const configs = await storage.getRfpApproverConfigs(type, source);
    const exactSource = configs.find((config) => config.projectType === type && config.sourceSystem === source);
    const exactProjectType = configs.find((config) => config.projectType === type && config.sourceSystem === null);
    const defaultConfig = configs.find((config) => config.projectType === '*' && config.sourceSystem === null);
    const selected = exactSource ?? exactProjectType ?? defaultConfig;
    if (selected?.approverEmails?.length) {
      rfpApproverCache.set(cacheKey, { timestamp: Date.now(), recipients: selected.approverEmails });
      return selected.approverEmails;
    }
  } catch (error: any) {
    console.warn(`[rfp-approval] Failed to load RFP approver config, using hardcoded safety net: ${error?.message || error}`);
  }

  // Safety net: preserve the original hardcoded routing if DB config is missing or invalid.
  console.warn(`[rfp-approval] No active RFP approver config for projectType=${type || '*'}, sourceSystem=${source}; using hardcoded safety net`);
  let fallbackRecipients: string[];
  if (type === '4') {
    // Project type 4: James + Colby
    fallbackRecipients = ['jhelms@trockgc.com', 'cburling@trockgc.com'];
  } else {
    // All other project types: Sidney + James
    fallbackRecipients = ['sgibson@trockgc.com', 'jhelms@trockgc.com'];
  }
  rfpApproverCache.set(cacheKey, { timestamp: Date.now(), recipients: fallbackRecipients });
  return fallbackRecipients;
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

function normalizedDealData(input: NormalizedRfpRequestInput, ownerInfo: { ownerName?: string; ownerEmail?: string }, sourceDealUrl: string | null): Record<string, any> {
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
    attachments: input.attachments.map((attachment) => ({
      name: attachment.name,
      url: attachment.url,
      type: attachment.contentType || undefined,
    })),
  };
}

async function sendRfpReviewEmails(params: {
  requestId: number;
  token: string;
  input: NormalizedRfpRequestInput;
  dealData: Record<string, any>;
  ownerName: string;
  sourceDealUrl: string | null;
}): Promise<string[]> {
  const template = await storage.getEmailTemplate('rfp_review');
  if (!template || !template.enabled) {
    log('[rfp-approval] RFP review email template is disabled', 'rfp');
    return [];
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
  const ownerName = esc(params.ownerName || 'N/A');

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

  const rfpRecipients = await getRfpReviewRecipients(params.dealData.project_types, params.input.sourceSystem);
  console.log(`[rfp-approval] Project type: ${params.dealData.project_types || 'none'}, recipients: ${rfpRecipients.join(', ')}`);
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

    const pendingConflict = await storage.getRfpApprovalRequestByProjectNumberAndStatus(input.deal.projectNumber, 'pending');
    if (pendingConflict) {
      return buildConflictResult('pending_collision', input.deal.projectNumber, pendingConflict);
    }

    const approvedConflict = await storage.getRfpApprovalRequestByProjectNumberAndStatus(input.deal.projectNumber, 'approved');
    if (approvedConflict) {
      return buildConflictResult('approved_collision', input.deal.projectNumber, approvedConflict);
    }

    const token = randomUUID();
    const sourceDealUrl = await buildSourceDealUrl(input.sourceSystem, input.sourceDealId);
    const rawOwnerInfo = input.sourceSystem === 'hubspot'
      ? await getDealOwnerInfo(input.sourceDealId)
      : { ownerName: '', ownerEmail: '' };
    const ownerInfo = {
      ownerName: rawOwnerInfo.ownerName || '',
      ownerEmail: rawOwnerInfo.ownerEmail || '',
    };
    const dealData = normalizedDealData(input, ownerInfo, sourceDealUrl);

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
      if (isUniqueViolation(error, 'idx_rfp_approval_pending_project_number')) {
        const conflict = await storage.getRfpApprovalRequestByProjectNumberAndStatus(input.deal.projectNumber, 'pending');
        if (conflict) {
          return buildConflictResult('pending_collision', input.deal.projectNumber, conflict);
        }
      }
      if (isUniqueViolation(error, 'idx_rfp_approval_pending_source_deal')) {
        const conflict = await storage.getRfpApprovalRequestBySourceDealId(input.sourceSystem, input.sourceDealId);
        if (conflict && conflict.status === 'pending') {
          return buildSourceDealPendingConflictResult(input.sourceSystem, input.sourceDealId, conflict);
        }
      }
      throw error;
    }

    const rfpRecipients = await sendRfpReviewEmails({
      requestId: created.id,
      token,
      input,
      dealData,
      ownerName: ownerInfo.ownerName || '',
      sourceDealUrl,
    });

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
    return { success: false, error: e.message };
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
): Promise<{ success: boolean; token?: string; error?: string }> {
  try {
    const existing = await storage.getRfpApprovalRequestByDealId(hubspotDealId);
    if (existing) {
      log(`[rfp-approval] Pending approval already exists for deal ${hubspotDealId}, skipping`, 'rfp');
      return { success: true, token: existing.token };
    }

    const input = await buildNormalizedRfpRequestFromHubSpotDeal(hubspotDealId);
    const result = await createRfpApprovalRequestFromNormalizedInput(input);
    if (result.success) {
      return { success: true, token: result.token };
    }
    return { success: false, error: 'error' in result ? result.error : result.message };
  } catch (e: any) {
    console.error(`[rfp-approval] Error creating approval request for deal ${hubspotDealId}:`, e.message);
    return { success: false, error: e.message };
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
  options?: { attachmentsOverride?: RfpApprovalAttachmentOptions['attachmentsOverride']; newFiles?: RfpApprovalAttachmentOptions['newFiles']; force?: boolean }
): Promise<{ success: boolean; error?: string; bidboardProjectId?: string; statusCode?: number; message?: string }> {
  // `force` is the authoritative override-approve path (reviewer re-approves a declined RFP
  // from the CRM). It relaxes the pending-only and expiry guards — the action is authenticated
  // server-to-server via HMAC, not via the (possibly stale) email token — but on a Playwright
  // failure it leaves the request re-tryable instead of marking it approved (see below).
  const force = options?.force === true;
  try {
    const request = await storage.getRfpApprovalRequestByToken(token);
    if (!request) return { success: false, error: 'Approval request not found' };
    if (request.status !== 'pending' && !force) return { success: false, error: `Request already ${request.status}` };
    if (!force && isRfpApprovalRequestExpired(request)) {
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
      return cancelIneligibleRfpApproval(request, approverEmail, eligibility.reason || 'Source deal is no longer eligible');
    }

    const sourceDealId = identity.sourceDealId;
    const hubspotDealId = request.sourceSystem === 'hubspot' ? sourceDealId : null;

    // Check if project type changed — update project number and HubSpot immediately
    const submittedProjectType = editedFields.project_types;
    const currentProjectNumber = (dealData.project_number ?? '') as string;
    const currentTypeDigit = parseProjectTypeFromNumber(currentProjectNumber) ?? dealData.project_types ?? '';

    let finalProjectNumber = currentProjectNumber;
    let finalProjectTypeDigit = currentTypeDigit || submittedProjectType || dealData.project_types || '2';

    if (submittedProjectType && submittedProjectType !== currentTypeDigit) {
      const updatedProjectNumber = replaceProjectTypeInNumber(currentProjectNumber, submittedProjectType);
      finalProjectNumber = updatedProjectNumber;
      finalProjectTypeDigit = submittedProjectType;

      try {
        if (hubspotDealId) await updateHubSpotDeal(hubspotDealId, {
          project_number: updatedProjectNumber,
          project_types: submittedProjectType,
        });
        log(`[rfp-approval] Updated project number: ${currentProjectNumber} → ${updatedProjectNumber}`, 'rfp');
      } catch (err: any) {
        log(`[rfp-approval] Warning: Failed to update project number in HubSpot: ${err.message}`, 'rfp');
        // Non-fatal — continue with BidBoard creation
      }
    } else if (currentProjectNumber && !submittedProjectType && currentTypeDigit) {
      finalProjectTypeDigit = currentTypeDigit;
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
        if (hubspotDealId) {
          const updateResult = await updateHubSpotDeal(hubspotDealId, hubspotUpdateProps);
          if (!updateResult.success) {
            console.error(`[rfp-approval] Failed to update HubSpot deal: ${updateResult.message}`);
          }
          log(`[rfp-approval] Updated HubSpot deal ${hubspotDealId} with ${Object.keys(hubspotUpdateProps).length} changed fields`, 'rfp');
        }
      }
    }

    const isService = String(finalProjectTypeDigit) === '4';
    const targetStageName = isService ? 'Service - Estimating' : 'Estimating';

    if (hubspotDealId) {
      const resolvedStage = await resolveHubspotStageId(targetStageName);
      if (resolvedStage) {
        await updateHubSpotDealStage(hubspotDealId, resolvedStage.stageId);
        log(`[rfp-approval] Deal ${hubspotDealId} moved to stage "${resolvedStage.stageName}" (type=${finalProjectTypeDigit})`, 'rfp');
      } else {
        const altName = isService ? 'Service – Estimating' : 'Estimating';
        const altStage = await resolveHubspotStageId(altName);
        if (altStage) {
          await updateHubSpotDealStage(hubspotDealId, altStage.stageId);
          log(`[rfp-approval] Deal ${hubspotDealId} moved to stage "${altStage.stageName}" (alt match)`, 'rfp');
        } else {
          console.error(`[rfp-approval] Could not resolve HubSpot stage for "${targetStageName}"`);
        }
      }
    }

    // Refresh local deal cache so BidBoard creation picks up any edits
    if (hubspotDealId) {
      try {
        const { syncSingleHubSpotDeal } = await import('./hubspot');
        await syncSingleHubSpotDeal(hubspotDealId);
        log(`[rfp-approval] Local deal cache refreshed for ${hubspotDealId}`, 'rfp');
      } catch (syncErr: any) {
        console.error(`[rfp-approval] Failed to refresh deal cache: ${syncErr.message}`);
      }
    }

    const TEMP_DIR = process.env.TEMP_DIR || '.playwright-temp';
    const tempPaths: string[] = [];
    let attachmentsToSync: Array<{ name: string; url?: string; localPath?: string; type?: string; size?: number }> | undefined;
    if (options && Array.isArray(options.attachmentsOverride)) {
      attachmentsToSync = [];
      for (const a of options.attachmentsOverride) {
        if (a._new) continue;
        if (a.url) attachmentsToSync.push({ name: a.name || 'attachment', url: a.url });
      }
      for (let i = 0; i < (options.newFiles || []).length; i++) {
        const f = options.newFiles![i];
        await fs.mkdir(TEMP_DIR, { recursive: true });
        const tmpPath = path.join(TEMP_DIR, `rfp-new-${randomUUID()}-${(f.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_')}`);
        await fs.writeFile(tmpPath, f.buffer);
        tempPaths.push(tmpPath);
        attachmentsToSync.push({ name: f.originalname || 'attachment', localPath: tmpPath, type: f.mimetype, size: f.size });
      }
      if (tempPaths.length > 0) {
        log(`[rfp-approval] Stored ${tempPaths.length} new attachment(s) temporarily until BidBoard upload completes`, 'rfp');
      }
    }

    let bidboardProjectId: string | undefined;
    let bidboardFailed = false;
    let bidboardError: string | undefined;
    try {
      const { createBidBoardProjectFromDeal } = await import('./playwright/bidboard');
      const bidboardStage = isService ? 'Service – Estimating' : 'Estimate in Progress';
      const bbResult = await createBidBoardProjectFromDeal({
        sourceSystem: identity.sourceSystem,
        sourceDealId,
        bidboardStage,
        normalizedDealData: identity.sourceSystem === 'trock_crm' ? dealData : undefined,
        options: {
          syncDocuments: true,
          attachmentsOverride: attachmentsToSync,
          projectNumberOverride: finalProjectNumber || editedFields.project_number || (dealData.project_number as string) || undefined,
          editedFieldsOverride: {
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
          },
          proposalId: (editedFields.proposal_id || dealData.proposalId) as string | undefined,
        },
      });
      if (bbResult.success && bbResult.projectId) {
        bidboardProjectId = bbResult.projectId;
        log(`[rfp-approval] BidBoard project created: ${bidboardProjectId} for deal ${sourceDealId}`, 'rfp');

        // Upload _new attachments to HubSpot and associate with deal (BidBoard upload succeeded)
        const newAttachments = (attachmentsToSync || []).filter((a) => a.localPath);
        for (const att of newAttachments) {
          if (!att.localPath || !att.name) continue;
          try {
            if (hubspotDealId) {
              await uploadFileToHubSpotAndAttachToDeal(att.localPath, att.name, hubspotDealId);
              log(`[rfp-approval] Uploaded ${att.name} to HubSpot and attached to deal ${hubspotDealId}`, 'rfp');
            }
          } catch (hubErr: any) {
            console.error(`[rfp-approval] Failed to upload ${att.name} to HubSpot:`, hubErr.message);
          }
        }
      } else {
        bidboardFailed = true;
        bidboardError = bbResult.error;
        console.error(`[rfp-approval] Source updated successfully but BidBoard creation failed for deal ${sourceDealId}: ${bbResult.error}`);
      }
    } catch (bbErr: any) {
      bidboardFailed = true;
      bidboardError = bbErr?.message;
      console.error(`[rfp-approval] BidBoard creation error for deal ${sourceDealId}:`, bbErr.message);
    } finally {
      // Temp files are only deleted AFTER createBidBoardProjectFromDeal completes (including document sync).
      // This ensures attachments remain available until they have been uploaded to BidBoard.
      for (const p of tempPaths) {
        try { await fs.unlink(p); } catch { /* ignore */ }
      }
      if (tempPaths.length > 0) {
        log(`[rfp-approval] Cleaned up ${tempPaths.length} temporary attachment file(s)`, 'rfp');
      }
    }

    if (bidboardFailed && force && !bidboardProjectId) {
      // OVERRIDE path: the authoritative Playwright creation failed and no project was created.
      // Do NOT mark the request approved — leave it in its current (declined) state so a reviewer
      // can retry — and notify the CRM with a 'failed' callback through the same outbox + worker.
      const failureCallbackData = await buildBidBoardFailedCallbackData({
        request,
        sourceDealId,
        projectNumber: finalProjectNumber,
        error: bidboardError,
      });
      const upsertCallback = (storage as any).upsertBidboardCallback;
      if (failureCallbackData && typeof upsertCallback === 'function') {
        await upsertCallback.call(storage, failureCallbackData);
      }

      await storage.createAuditLog({
        action: 'rfp_override_approval_failed',
        entityType: 'deal',
        entityId: sourceDealId,
        source: 'rfp-approval',
        status: 'failure',
        details: {
          token,
          approvedBy: approverEmail,
          error: bidboardError || null,
          ...buildRfpAuditDetails(request, 'override_failed', approverEmail, bidboardError),
        },
      });

      await sendRfpApprovalStatusEmail({
        dealName: (editedFields.dealname && String(editedFields.dealname).trim()) || dealData.dealname || 'Unknown Deal',
        hubspotDealId: hubspotDealId || sourceDealId,
        projectNumber: finalProjectNumber,
        approverEmail,
        bidboardProjectId: undefined,
        bidboardFailed: true,
        steps: [
          { name: 'Override Approval', success: false, detail: `BidBoard creation failed; request left re-tryable. ${bidboardError || ''}`.trim() },
          { name: 'BidBoard Project Created', success: false, detail: 'Failed — project was not created' },
        ],
      });

      log(`[rfp-approval] Override-approve BidBoard creation failed for deal ${sourceDealId}; left re-tryable (status preserved): ${bidboardError || 'unknown error'}`, 'rfp');
      return {
        success: false,
        error: bidboardError || 'BidBoard project creation failed during override approval. The request remains re-tryable.',
      };
    }

    if (bidboardFailed) {
      // HubSpot was already updated (stage, fields). Mark as approved.
      await storage.updateRfpApprovalRequest(request.id, {
        status: 'approved',
        editedFields: changedFields,
        approvedBy: approverEmail,
        approvedAt: new Date(),
        bidboardProjectId: bidboardProjectId || null,
      });

      await sendRfpApprovalStatusEmail({
        dealName: (editedFields.dealname && String(editedFields.dealname).trim()) || dealData.dealname || 'Unknown Deal',
        hubspotDealId: hubspotDealId || sourceDealId,
        projectNumber: finalProjectNumber,
        approverEmail,
        bidboardProjectId,
        bidboardFailed: true,
        steps: [
          { name: 'Source Deal Updated', success: true, detail: `Stage: ${hubspotDealId ? targetStageName : 'unchanged'}, Fields: ${Object.keys(changedFields).length} changed` },
          { name: 'BidBoard Project Created', success: !!bidboardProjectId, detail: bidboardProjectId ? `ID: ${bidboardProjectId} (created but post-creation steps failed)` : 'Failed — project was not created' },
          { name: 'Sync Mapping', success: false, detail: 'Skipped due to BidBoard failure' },
          { name: 'Document Sync', success: false, detail: 'Skipped due to BidBoard failure' },
        ],
      });

      if (bidboardProjectId) {
        return { success: true, bidboardProjectId };
      }
      return {
        success: false,
        error: 'HubSpot updated but BidBoard project creation failed. Please check BidBoard manually.',
        bidboardProjectId,
      };
    }

    const approvedAttachmentsForStorage = (attachmentsToSync || []).map(a => ({
      name: a.name,
      url: a.url || undefined,
      _new: !!a.localPath,
    }));

    const approvalData = {
      status: 'approved',
      editedFields: changedFields,
      approvedAttachments: approvedAttachmentsForStorage,
      approvedBy: approverEmail,
      approvedAt: new Date(),
      bidboardProjectId: bidboardProjectId || null,
    };
    const callbackData = await buildBidBoardCreatedCallbackData({
      request,
      sourceDealId,
      bidboardProjectId,
      projectNumber: finalProjectNumber,
    });
    const approveWithCallback = (storage as any).approveRfpApprovalRequestWithOptionalCallback;
    if (typeof approveWithCallback === 'function') {
      // On the override path, upsert the callback so a fresh 'created' supersedes any stale
      // 'failed' callback row left by a prior failed attempt (the outbox is unique per request).
      await approveWithCallback.call(storage, request.id, approvalData, callbackData, { upsertCallback: force });
    } else {
      await storage.updateRfpApprovalRequest(request.id, approvalData);
      if (callbackData) {
        const enqueue = force ? (storage as any).upsertBidboardCallback : (storage as any).enqueueBidboardCallback;
        if (typeof enqueue === 'function') await enqueue.call(storage, callbackData);
      }
    }

    await storage.createAuditLog({
      action: 'rfp_approval_approved',
      entityType: 'deal',
      entityId: sourceDealId,
      source: 'rfp-approval',
      status: 'success',
      details: {
        token,
        approvedBy: approverEmail,
        changedFields,
        approvedAttachments: approvedAttachmentsForStorage,
        projectType: finalProjectTypeDigit,
        targetStage: targetStageName,
        bidboardProjectId,
        ...buildRfpAuditDetails(request, 'approved', approverEmail),
      },
    });

    // Send detailed status email to admin
    await sendRfpApprovalStatusEmail({
      dealName: (editedFields.dealname && String(editedFields.dealname).trim()) || dealData.dealname || 'Unknown Deal',
      hubspotDealId: hubspotDealId || sourceDealId,
      projectNumber: finalProjectNumber,
      approverEmail,
      bidboardProjectId,
      bidboardFailed: false,
      steps: [
        { name: 'Source Deal Updated', success: true, detail: `Stage: ${hubspotDealId ? targetStageName : 'unchanged'}, Fields: ${Object.keys(changedFields).length} changed` },
        { name: 'BidBoard Project Created', success: !!bidboardProjectId, detail: bidboardProjectId ? `ID: ${bidboardProjectId}` : 'Not created' },
        { name: 'Sync Mapping', success: !!bidboardProjectId, detail: bidboardProjectId ? `Deal ${sourceDealId} → BidBoard ${bidboardProjectId}` : 'Skipped' },
        { name: 'Document Sync', success: true, detail: `${(attachmentsToSync || []).length} attachment(s)` },
      ],
    });

    return { success: true, bidboardProjectId };
  } catch (e: any) {
    console.error(`[rfp-approval] Error processing approval for token ${token}:`, e.message);
    return { success: false, error: e.message };
  }
}

export async function processRfpDecline(
  token: string,
  declinerEmail: string
): Promise<{ success: boolean; error?: string }> {
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
      await declineWithCallback.call(storage, request.id, declineData, callbackData);
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
