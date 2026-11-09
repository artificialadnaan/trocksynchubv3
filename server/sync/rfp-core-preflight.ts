/**
 * Routing preflight for the RFP Phase 2 schema (CONTRACT v2.2 §10). SyncHub migrations are hand-applied (Dockerfile:69),
 * so this code can be live before 0027 is. The enqueue asks on every create:
 *   - present  ⇒ the Phase 2 path (stamp, Core outbox);
 *   - missing / inconclusive with ROUTE procore ⇒ today's enqueue, byte-identical (a dark deploy can't break Procore);
 *   - missing / inconclusive with ROUTE core ⇒ HOLD: refuse + a loud alert, never a Procore fallback.
 * The same idea as the service-rfp preflight (service-rfp-core-outbox.ts:966), applied per create instead of once at boot.
 *
 * Probe = both 0027 tables. 0027 runs its statements in file order and adds the command-row stamp columns FIRST, so both
 * tables existing implies the stamp columns exist too (a partially applied 0027 that stopped before the tables reads
 * "missing", which fails closed for core and falls back to today's SQL for procore).
 */
import { sql } from "drizzle-orm";

export type RfpCoreTablesState = "present" | "missing" | "inconclusive";

type Executor = { execute: (q: any) => Promise<any> };

async function defaultDb(): Promise<Executor> {
  return (await import("../db")).db as unknown as Executor;
}

/**
 * The strict probe (S0b-2a, d9's hardening): "missing" ONLY on a successful NULL; a query that ERRORS throws its real error
 * (fail closed). The core route, the Procore claim (P2) and processRfpApproval (P3) use this one.
 */
export async function preflightRfpCoreTablesOrThrow(db?: Executor): Promise<"present" | "missing"> {
  const exec = db ?? (await defaultDb());
  const res = await exec.execute(sql`
    SELECT to_regclass('public.rfp_core_create_outbox')::text AS create_tbl,
           to_regclass('public.rfp_core_followup_outbox')::text AS followup_tbl
  `);
  const row = (Array.isArray(res) ? res : (res as any).rows ?? [])[0] ?? {};
  return row.create_tbl && row.followup_tbl ? "present" : "missing";
}

/** The lenient probe: an error reads "inconclusive". ROUTE procore (setting unset) keeps today's enqueue on it. */
export async function preflightRfpCoreTables(db?: Executor): Promise<RfpCoreTablesState> {
  try {
    return await preflightRfpCoreTablesOrThrow(db);
  } catch {
    return "inconclusive";
  }
}
