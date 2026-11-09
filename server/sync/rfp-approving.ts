/**
 * RFP Phase 2 (CONTRACT v2.2 §10, S0b-2a; runbook STUCK-APPROVING r3/r4; d9 rulings in lanes/rfp-routing/QUESTIONS-ee.md):
 * processRfpApproval's (path P3) DECISION + CLAIM, taken in ONE SHORT transaction right before the Playwright create:
 * the per-deal lock, a re-read of the request row, the Core footprint, then either the claim or a hold.
 *   - email (V3): pending → `approving` (+ rfp_approval_approving.started_at), the create-in-progress footprint;
 *   - override (force; V2 / V4): the route already claimed `override_approving`; the row must still be in it;
 *   - a Core footprint ⇒ `held_cross_destination` + the hold callback (F1), the caller raises the alert;
 *   - the request moved on (a double click, a decline, a reset) ⇒ not claimable, no create;
 *   - 0027 absent ⇒ "legacy": today's path, unchanged (no Core footprint can exist without 0027).
 * markRfpApprovingSubmitted commits rfp_approval_approving.submit_at before createBidBoardProject starts: the positive
 * evidence the stuck-approving runbook needs (NULL ⇒ the create never started).
 *
 * S0b-2a RED: signature stub. The claim never claims and the submit mark writes nothing.
 */
type Executor = { execute: (q: any) => Promise<any>; transaction?: (fn: (tx: any) => Promise<any>) => Promise<any> };

export const RFP_APPROVING_STATUS = "approving";

export type RfpCreateClaimInput = {
  requestId: number;
  sourceSystem: string;
  sourceDealId: string;
  force: boolean;
  /** The F1 written in the hold's own transaction (trock_crm requests only; a HubSpot request has no CRM callback). */
  holdCallback?: { targetUrl: string; payload: Record<string, unknown> } | null;
};

export type RfpCreateClaim =
  | { outcome: "legacy" }
  | { outcome: "claimed" }
  | { outcome: "not_claimable"; status: string }
  | { outcome: "held_cross_destination"; footprint: string[] };

export async function claimRfpRequestForCreate(_input: RfpCreateClaimInput, _db?: Executor): Promise<RfpCreateClaim> {
  return { outcome: "legacy" };
}

export async function markRfpApprovingSubmitted(_requestId: number, _db?: Executor): Promise<void> {}

/** For the reset route's rfp_request_override_reset alert: may the override being reset already have created a project? */
export async function describeOverrideResetFootprint(
  _sourceSystem: string, _sourceDealId: string, _db?: Executor,
): Promise<{ syncMapping: boolean; createCommand: boolean }> {
  return { syncMapping: false, createCommand: false };
}
