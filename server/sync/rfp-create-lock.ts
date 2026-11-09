/**
 * RFP Phase 2 (CONTRACT v2.2 §10): ONE per-deal advisory lock `rfp_create:<sourceDealId>` (xact-scoped) around the DECISION +
 * CLAIM on every create path, and the two destination FOOTPRINTS each path checks under it.
 *
 * RED STUB (S0b-1): the signatures only. The lock does nothing and both footprints read as empty.
 */
type Executor = { execute: (q: any) => Promise<any> };

export const RFP_CREATE_LOCK_PREFIX = "rfp_create:";

export async function lockRfpCreateDeal(_tx: Executor, _sourceDealId: string): Promise<void> {}

export async function readProcoreFootprint(_tx: Executor, _sourceSystem: string, _sourceDealId: string): Promise<string[]> {
  return [];
}

export async function readCoreFootprint(_tx: Executor, _sourceSystem: string, _sourceDealId: string): Promise<string[]> {
  return [];
}
