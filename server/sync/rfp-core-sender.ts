/**
 * RFP Phase 2, S1a: the E2 sender (CONTRACT v2.4 §5 / §10).
 * S1a RED: exported stubs only, no behaviour (nothing is drained or sent). GREEN implements them.
 */
import type { FetchLike } from "./rfp-core-http";

export interface RfpCoreDrainDeps {
  fetchImpl?: FetchLike;
  now?: () => Date;
  limit?: number;
}

export interface RfpCoreCreateDrainResult {
  processed: number;
  sent: number;
  refused: number;
  held: number;
  failed: number;
  retried: number;
  dead: number;
  skipped?: "dark" | "running" | "tables_missing" | "tables_inconclusive" | "unconfigured";
}

export function resetRfpCoreSenderStateForTests(): void {}

export async function drainRfpCoreCreateOutbox(_deps: RfpCoreDrainDeps = {}): Promise<RfpCoreCreateDrainResult> {
  return { processed: 0, sent: 0, refused: 0, held: 0, failed: 0, retried: 0, dead: 0 };
}

export async function processRfpCoreCreateOutbox(_deps: RfpCoreDrainDeps = {}): Promise<RfpCoreCreateDrainResult> {
  return { processed: 0, sent: 0, refused: 0, held: 0, failed: 0, retried: 0, dead: 0 };
}
