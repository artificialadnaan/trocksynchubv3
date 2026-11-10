/**
 * RFP Phase 2 (CONTRACT v2.2 §10): ONE per-deal advisory lock `rfp_create:<sourceDealId>` (xact-scoped) around the DECISION +
 * CLAIM on every create path, and the two destination FOOTPRINTS each path checks under it. A path about to create on one
 * destination that finds the OTHER destination's footprint holds instead (held_cross_destination + alert + F1).
 *
 * Paths: the create-from-rfp enqueue and the Procore worker's claim (bidboard-create-worker.ts), the HubSpot trigger
 * (hubspot-bidboard-trigger.ts), processRfpApproval (S0b-2) and the Core drain (S1). Each makes its own footprint visible
 * before (or in the same transaction as) its check, so two paths racing on one deal can't both proceed.
 */
import { sql } from "drizzle-orm";

type Executor = { execute: (q: any) => Promise<any> };

export const RFP_CREATE_LOCK_PREFIX = "rfp_create:";

/** Procore command statuses that mean a Procore project exists or may exist (d9 iv). A PENDING command is not one: the
 *  worker re-checks the Core footprint at claim, before Playwright. */
const PROCORE_COMMAND_FOOTPRINT = new Set(["processing", "reclaiming", "needs_manual", "done"]);

function rowsOf(res: any): any[] {
  return Array.isArray(res) ? res : (res?.rows ?? []);
}

export async function lockRfpCreateDeal(tx: Executor, sourceDealId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${RFP_CREATE_LOCK_PREFIX + sourceDealId}))`);
}

/**
 * The deal's Procore footprint (§10; d9 iii / iv), one reason per row: `command:<status>` / `command:recovered_project`,
 * `request:approved` / `request:override_approving` / `request:approving` (S0b-2a: the email path's create in progress, d9 Q5), `sync_mapping`. Empty ⇒ no Procore project exists or may exist.
 * Needs 0027 (the destination column): callers ask only once the preflight reads "present". A request / mapping table that
 * does not exist holds no footprint: both always exist in production; only a narrow test schema omits them.
 */
export async function readProcoreFootprint(tx: Executor, sourceSystem: string, sourceDealId: string): Promise<string[]> {
  const commands = rowsOf(await tx.execute(sql`
    SELECT id, status FROM bidboard_create_outbox
     WHERE source_system = ${sourceSystem} AND source_deal_id = ${sourceDealId} AND destination = 'procore'
       AND (status IN ('processing', 'reclaiming', 'needs_manual', 'done') OR (payload->>'__recoveredProjectId') IS NOT NULL)
     ORDER BY id
  `));
  const tables = rowsOf(await tx.execute(sql`
    SELECT to_regclass('public.rfp_approval_requests')::text AS req, to_regclass('public.sync_mappings')::text AS map
  `))[0] ?? {};
  const requests = !tables.req ? [] : rowsOf(await tx.execute(sql`
    SELECT id, status FROM rfp_approval_requests
     WHERE source_system = ${sourceSystem} AND source_deal_id = ${sourceDealId} AND status IN ('approved', 'override_approving', 'approving')
     ORDER BY id
  `));
  const mappings = !tables.map ? [] : rowsOf(await tx.execute(sql`
    SELECT id FROM sync_mappings
     WHERE source_system = ${sourceSystem} AND source_deal_id = ${sourceDealId} AND bidboard_project_id IS NOT NULL
     ORDER BY id
  `));
  return [
    ...commands.map((c) => (PROCORE_COMMAND_FOOTPRINT.has(c.status) ? `command:${c.status}` : "command:recovered_project")),
    ...requests.map((r) => `request:${r.status}`),
    ...mappings.map(() => "sync_mapping"),
  ];
}

/**
 * The deal's Core footprint (§10 + d9's qualifier), one `core:<status>` per row: every rfp_core_create_outbox row except
 * `refused` (a Core 409 made no bid), and except a `held_cross_destination` row that never sent an E2 (it can't have created
 * a bid; counting it would hold both sides). `dead` counts: a dead E2 may have created a bid. Empty when 0027 is absent.
 */
export async function readCoreFootprint(tx: Executor, sourceSystem: string, sourceDealId: string): Promise<string[]> {
  const present = rowsOf(await tx.execute(sql`SELECT to_regclass('public.rfp_core_create_outbox')::text AS tbl`))[0]?.tbl;
  if (!present) return [];
  const rows = rowsOf(await tx.execute(sql`
    SELECT status FROM rfp_core_create_outbox
     WHERE source_system = ${sourceSystem} AND source_deal_id = ${sourceDealId}
       AND status <> 'refused'
       AND (status <> 'held_cross_destination' OR e2_ever_sent)
     ORDER BY id
  `));
  return rows.map((r) => `core:${r.status}`);
}

/**
 * Every create command the deal has, whatever its status or destination, one `create_command:<destination>:<status>` per row
 * (S0b-2b: the resolve CLI's "no other create row" for `recreate`, runbook r5 §3B). Stricter than the Procore footprint on
 * purpose: even a pending or routed command means someone else is already creating this deal.
 */
export async function readDealCreateCommands(tx: Executor, sourceSystem: string, sourceDealId: string): Promise<string[]> {
  const rows = rowsOf(await tx.execute(sql`
    SELECT destination, status FROM bidboard_create_outbox
     WHERE source_system = ${sourceSystem} AND source_deal_id = ${sourceDealId}
     ORDER BY id
  `));
  return rows.map((r) => `create_command:${r.destination}:${r.status}`);
}

/**
 * S1a (the E2 sender, under the per-deal lock): the create COMMAND row a Core create row points at (`command_id`), FOR
 * UPDATE. The source of the E2 body (its stored E1 payload, refreshed by a re-arm) and of the operator re-drive check
 * (destination / status). A by-primary-key read of the Core row's OWN command, never a scan by status, so it can never
 * take a routed_core row for an unprocessed one (E-8 reader census).
 */
export async function readCreateCommandForUpdate(tx: Executor, commandId: number): Promise<any | undefined> {
  return rowsOf(await tx.execute(sql`
    SELECT id, source_system, source_deal_id, source_event_id, destination, status, approval_kind, payload
      FROM bidboard_create_outbox WHERE id = ${commandId} FOR UPDATE
  `))[0];
}

/**
 * S1a (the E4 / E5 / N1 follow-up drain): one Core create's identity, Core's bid id and its command's stored E1 payload
 * (the CRM office, and F1's input), joined by primary key. Same E-8 reasoning: no status scan of the command table.
 */
export async function readCoreCreateContext(db: Executor, createId: number): Promise<any | undefined> {
  return rowsOf(await db.execute(sql`
    SELECT c.id AS create_id, c.source_system, c.source_deal_id, c.source_event_id, c.core_bid_id, c.command_id,
           c.payload AS core_payload, b.payload AS command_payload
      FROM rfp_core_create_outbox c JOIN bidboard_create_outbox b ON b.id = c.command_id
     WHERE c.id = ${createId}
  `))[0];
}

/**
 * S1b (the one-deal operator re-drive, scripts/rfp-redrive-to-core.ts): the create COMMAND row of ONE approval by its
 * unique source_event_id, read-only, or FOR UPDATE inside the CLI's locked transaction. A by-key read, never a status scan
 * (E-8 reader census): the CLI itself requires the row to be procore-stamped and `done`.
 */
export async function readCreateCommandForEvent(tx: Executor, sourceEventId: string, forUpdate = false): Promise<any | undefined> {
  return rowsOf(await tx.execute(sql`
    SELECT id, source_system, source_deal_id, source_event_id, project_number, destination, status, approval_kind, payload
      FROM bidboard_create_outbox WHERE source_event_id = ${sourceEventId} ${forUpdate ? sql`FOR UPDATE` : sql``}
  `))[0];
}
