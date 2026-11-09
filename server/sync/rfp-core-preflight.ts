/**
 * Boot / routing preflight for the RFP Phase 2 tables (CONTRACT v2.2 §10). SyncHub migrations are hand-applied (Dockerfile:69),
 * so a deploy can land before 0027 runs. With ROUTE = core and a missing table the command is HELD with a loud alert,
 * never silently created on Procore (the service-rfp preflight pattern, service-rfp-core-outbox.ts:966).
 */
export type RfpCoreTablesState = "present" | "missing" | "inconclusive";

export async function preflightRfpCoreTables(_db?: { execute: (q: any) => Promise<any> }): Promise<RfpCoreTablesState> {
  return "present"; // RED STUB (S0a): replaced by to_regclass over the 0027 tables
}
