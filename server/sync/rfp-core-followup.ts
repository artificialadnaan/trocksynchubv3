/**
 * RFP Phase 2, S1a: the follow-ups of a created Core bid (E4 crm_link, E5 core_confirm, N1 crm_notice).
 * S1a RED: exported stubs only, no behaviour (nothing is drained or sent). GREEN implements them.
 */
import type { RfpCoreDrainDeps } from "./rfp-core-sender";

export interface RfpCoreFollowupDrainResult {
  processed: number;
  sent: number;
  retried: number;
  dead: number;
  failed: number;
  orphaned: number;
  linkRefused: number;
  skipped?: "dark" | "running" | "tables_missing" | "tables_inconclusive" | "unconfigured";
}

export function resetRfpCoreFollowupStateForTests(): void {}

export async function drainRfpCoreFollowupOutbox(_deps: RfpCoreDrainDeps = {}): Promise<RfpCoreFollowupDrainResult> {
  return { processed: 0, sent: 0, retried: 0, dead: 0, failed: 0, orphaned: 0, linkRefused: 0 };
}

export async function processRfpCoreFollowupOutbox(_deps: RfpCoreDrainDeps = {}): Promise<RfpCoreFollowupDrainResult> {
  return { processed: 0, sent: 0, retried: 0, dead: 0, failed: 0, orphaned: 0, linkRefused: 0 };
}
