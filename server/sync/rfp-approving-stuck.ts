/**
 * Alert `rfp_request_approving_stuck` (S0b-2b; runbook r5 §1; d9 Q7). A request is STUCK when its status is `approving` and
 * rfp_approval_approving.started_at is more than 30 minutes old: the process that claimed it most likely died mid-create, and
 * the Procore project may or may not exist. A person resolves it with scripts/rfp-resolve-approving.ts under an a4 GO.
 *
 * - One debounce key PER REQUEST (`rfp-approving-stuck:<id>`) on bidboard-crm-alert's state machine, re-alerting every 24 h
 *   while the row stays stuck.
 * - It CLEARS only when the row reaches a terminal status (approved / declined / held_cross_destination), never on an attempt.
 * - The payload carries the request id, source system, source deal id, project number and age. No names, no deal payload.
 *
 * S0b-2b RED: stub. Finds nothing, alerts nothing.
 */
import type { Querier } from "./bidboard-crm-alert";

export const RFP_APPROVING_STUCK_ALERT_CODE = "rfp_request_approving_stuck";
export const RFP_APPROVING_STUCK_AFTER_MINUTES = 30;
export const RFP_APPROVING_STUCK_REALERT_MINUTES = 24 * 60;
export const RFP_APPROVING_STUCK_KEY_PREFIX = "rfp-approving-stuck:";
export const RFP_APPROVING_TERMINAL_STATUSES = ["approved", "declined", "held_cross_destination"] as const;

export type StuckApprovingRequest = {
  requestId: number;
  sourceSystem: string;
  sourceDealId: string;
  projectNumber: string | null;
  /** Minutes since rfp_approval_approving.started_at; null when the request has no side-table row (age unknown). */
  ageMinutes: number | null;
};

export type StuckAlertSend = (msg: { to: string; subject: string; htmlBody: string; bypassGlobalCc?: boolean }) => Promise<{ success: boolean }>;

export type StuckSweepOptions = { db: Querier; now?: Date; recipient?: string; send?: StuckAlertSend };

/** `alerted` / `cleared`: the request ids whose stuck / cleared email was SENT by this sweep. */
export type StuckSweepResult = { stuck: StuckApprovingRequest[]; alerted: number[]; cleared: number[] };

export async function findStuckApprovingRequests(_db: Querier, _now: Date): Promise<StuckApprovingRequest[]> {
  return [];
}

export async function runRfpApprovingStuckSweep(_opts: StuckSweepOptions): Promise<StuckSweepResult> {
  return { stuck: [], alerted: [], cleared: [] };
}
