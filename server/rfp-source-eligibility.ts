/**
 * RFP SOURCE ELIGIBILITY — the approve gate's rule, in a module that never boots the server
 * =========================================================================================
 * Moved out of rfp-approval.ts (Codex P1 on SyncHub #114) so the stale-pending cleanup CLI can classify rows with the
 * SAME rule the approve gate applies, without importing rfp-approval's server-coupled graph (callback workers, the
 * Core outbox, Express via ./index). rfp-approval re-exports checkRfpApprovalSourceEligibility and
 * checkCrmDealEligibility for its existing importers. Fail-open throughout: only a definitive "gone" or a definitive
 * out-of-stage answer is ineligible.
 */
import crypto from 'crypto';
import { storage, type SourceSystem } from './storage';
import { getHubSpotClient } from './hubspot';
import { log } from './log';

export type SourceEligibilityResult = { exists: boolean; stage: string | null; checkFailed?: boolean };
export type SourceEligibility = { eligible: boolean; reason?: string; exists?: boolean; stage?: string | null; checkFailed?: boolean };

// ONE deadline for every eligibility check, CRM or HubSpot (Codex round 3 on SyncHub #114). The digest checks rows
// one after another, so a source that accepts a request and then stalls would otherwise hold the email forever. At
// the deadline the check FAILS OPEN, like every other failed check: the RFP stays listed / approvable.
const DEFAULT_ELIGIBILITY_TIMEOUT_MS = 10_000;
function eligibilityTimeoutMs(): number {
  const ms = Number(process.env.RFP_ELIGIBILITY_TIMEOUT_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_ELIGIBILITY_TIMEOUT_MS;
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

export function isCrmOpportunityStage(stage: string | null | undefined): boolean {
  return normalizeStageForEligibility(stage) === 'opportunity';
}

export function sourceIdentityForRequest(request: any): { sourceSystem: SourceSystem; sourceDealId: string; projectNumber: string } {
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
      // Closes the socket at the deadline; the outer deadline in checkRfpApprovalSourceEligibility covers the rest.
      signal: AbortSignal.timeout(eligibilityTimeoutMs()),
    });
    if (response.status === 404) return { exists: false, stage: null };
    if (response.status >= 500) {
      log(`[rfp-approval] CRM eligibility check returned ${response.status}; proceeding fail-open`, 'rfp');
      return { exists: true, stage: null, checkFailed: true };
    }
    // Only a definitive 404 means "gone". Any other unsuccessful answer (401, 429, ...) is a FAILED check, fail-open
    // like the 5xx above (Codex P1 on SyncHub #114): a misconfigured secret or a rate limit must never cancel, or hide
    // from the digest, an RFP whose deal is still open.
    if (!response.ok) {
      log(`[rfp-approval] CRM eligibility check returned ${response.status}; proceeding fail-open`, 'rfp');
      return { exists: true, stage: null, checkFailed: true };
    }
    // A 2xx with no usable stage (empty body, malformed JSON, no stage field) answers nothing: a FAILED check,
    // fail-open, never "no longer in Opportunity" (Codex round 3 on SyncHub #114).
    const body = await response.json().catch(() => null);
    const stage = typeof body?.stage === 'string' && body.stage.trim() !== '' ? body.stage : null;
    if (stage === null) {
      log('[rfp-approval] CRM eligibility check answered without a stage; proceeding fail-open', 'rfp');
      return { exists: true, stage: null, checkFailed: true };
    }
    return { exists: true, stage };
  } catch (error: any) {
    log(`[rfp-approval] CRM eligibility check failed (${error?.message || error}); proceeding fail-open`, 'rfp');
    return { exists: true, stage: null, checkFailed: true };
  }
}

export async function checkRfpApprovalSourceEligibility(request: any): Promise<SourceEligibility> {
  const ms = eligibilityTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<SourceEligibility>((resolve) => {
    timer = setTimeout(() => {
      log(`[rfp-approval] source eligibility check timed out after ${ms} ms; proceeding fail-open`, 'rfp');
      resolve({ eligible: true, exists: true, stage: null, checkFailed: true });
    }, ms);
  });
  try {
    return await Promise.race([checkSourceEligibilityUnbounded(request), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function checkSourceEligibilityUnbounded(request: any): Promise<SourceEligibility> {
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
    // ONLY the two properties the rule reads (Codex P1 on SyncHub #114): no associations, and none of the
    // company / contact / attachment calls fetchFullDealFromHubSpot makes, so a 100-row preview stays cheap.
    const deal = await (await getHubSpotClient()).crm.deals.basicApi.getById(identity.sourceDealId, ['dealstage', 'pipeline']);
    const props = (deal?.properties || {}) as Record<string, any>;
    const stage = props.dealstage || null;
    const pipeline = props.pipeline || null;
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
