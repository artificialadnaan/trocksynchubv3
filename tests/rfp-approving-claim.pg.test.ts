import { readFileSync } from "fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";

// CONTRACT v2.2 §10, S0b-2a (path P3, processRfpApproval's email + override paths): the per-deal lock + a re-read of the
// request + the Core footprint + the claim, in ONE SHORT transaction right before the Playwright create (d9 Q2), and the
// create-in-progress footprint it leaves: the request row `approving` plus rfp_approval_approving (started_at; submit_at
// committed before createBidBoardProject starts: runbook r5). A Core footprint ⇒ held_cross_destination + F1; the request
// moved on ⇒ not claimable; 0027 absent ⇒ "legacy" (today's path, never an error); an ERRORED probe ⇒ fail closed.
// readProcoreFootprint counts `approving` (d9 Q5). Races run on separate sessions.
// REAL postgres (the runner's throwaway postgres:18, DATABASE_URL), one fresh database per run (plus one WITHOUT 0027 for the
// legacy guard). LIVE=1 without DATABASE_URL FAILS here; it never skips. The environment's DATABASE_URL points at an
// unroutable sentinel, so an un-mocked db import fails loudly instead of reading another database. Synthetic data only (I7).
const LIVE = process.env.LIVE === "1";
const BASE_URL = process.env.DATABASE_URL;
if (LIVE && !BASE_URL) throw new Error("LIVE=1 needs DATABASE_URL (a real postgres): refusing to skip the S0b-2a claim tests");
const SENTINEL_DATABASE_URL = "postgres://s0b2-real-db-must-not-be-used.invalid:5432/sentinel";
process.env.DATABASE_URL = SENTINEL_DATABASE_URL;

const dbHolder = vi.hoisted(() => ({ db: null as any, pool: null as any }));
const alertMock = vi.hoisted(() => vi.fn(async (_code: string, _detail: Record<string, unknown>) => {}));
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));
vi.mock("../server/db.ts", () => ({ get db() { return dbHolder.db; }, get pool() { return dbHolder.pool; } }));
vi.mock("../server/playwright/bidboard.ts", () => ({ createBidBoardProjectFromDeal: vi.fn() }));
vi.mock("../server/rfp-approval.ts", () => ({
  checkRfpApprovalSourceEligibility: vi.fn(async () => ({ eligible: true })),
  buildSourceDealUrl: vi.fn(() => null),
  normalizedDealData: vi.fn(() => ({})),
}));
vi.mock("../server/sync/bidboard-callback-worker.ts", () => ({
  buildBidBoardCreatedCallbackTargetUrl: () => "https://crm.example.test/api/internal/bid-board-created",
}));
vi.mock("../server/storage.ts", () => ({ storage: { getAutomationConfig: vi.fn(async () => ({ value: { companyId: "42" } })) } }));
vi.mock("../server/sync/rfp-core-alert.ts", () => ({ raiseRfpCoreAlert: alertMock }));

const { enqueueBidboardCreateCommand, processBidboardCreateOutbox } = await import("../server/sync/bidboard-create-worker.ts");
const { readProcoreFootprint } = await import("../server/sync/rfp-create-lock.ts");
const { preflightRfpCoreTables } = await import("../server/sync/rfp-core-preflight.ts");
const { claimRfpRequestForCreate, markRfpApprovingSubmitted, readApprovingFacts } = await import("../server/sync/rfp-approving.ts");
const { findStuckApprovingRequests } = await import("../server/sync/rfp-approving-stuck.ts");

const migration = (file: string) => readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");
const BASE_DDL = `
  CREATE TABLE bidboard_callback_outbox (
    id serial PRIMARY KEY, source_system text NOT NULL, source_deal_id text NOT NULL,
    rfp_approval_request_id integer NOT NULL, payload jsonb NOT NULL, target_url text NOT NULL,
    status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX idx_bidboard_callback_outbox_rfp_request ON bidboard_callback_outbox(rfp_approval_request_id);
  CREATE TABLE sync_mappings (
    id serial PRIMARY KEY, source_system text NOT NULL DEFAULT 'hubspot', source_deal_id text NOT NULL, bidboard_project_id text
  );
  CREATE TABLE rfp_approval_requests (
    id serial PRIMARY KEY, source_system text NOT NULL DEFAULT 'hubspot', source_deal_id text NOT NULL, source_event_id text,
    project_number text, hubspot_deal_id text, token text NOT NULL, token_expires_at timestamp,
    status text NOT NULL DEFAULT 'pending', deal_data jsonb NOT NULL, edited_fields jsonb, approved_attachments jsonb,
    approved_by text, approved_at timestamp, declined_by text, declined_at timestamp, bidboard_project_id text,
    created_at timestamp DEFAULT now(),
    CONSTRAINT rfp_approval_requests_token_unique UNIQUE (token)
  );
`;

let admin: pg.Client;
let pool: pg.Pool;
let pool27less: pg.Pool;
const DB_NAME = `s0b2_claim_${process.pid}_${Date.now()}`;
const DB_NAME_27LESS = `${DB_NAME}_no27`;
const sql = (text: string, params: unknown[] = []) => pool.query(text, params);
const dbUrl = (name: string) => {
  const url = new URL(BASE_URL!);
  url.pathname = `/${name}`;
  return url.toString();
};

/** Teardown: pool.end() can resolve before the server has closed its sessions; DROP … WITH (FORCE) would then kill them and the
 *  late 57P01 surfaces as an unhandled error. Wait (bounded) until the database has no sessions first. */
async function waitNoSessions(name: string) {
  for (let i = 0; i < 100; i++) {
    const n = Number((await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1`, [name])).rows[0].n);
    if (n === 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}
beforeAll(async () => {
  if (!BASE_URL) return;
  admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.query(`CREATE DATABASE ${DB_NAME_27LESS}`);
  pool = new pg.Pool({ connectionString: dbUrl(DB_NAME), max: 8 });
  pool.on("error", () => {});
  pool27less = new pg.Pool({ connectionString: dbUrl(DB_NAME_27LESS), max: 2 });
  pool27less.on("error", () => {});
  for (const p of [pool, pool27less]) {
    await p.query(BASE_DDL);
    await p.query(migration("0021_extend_pending_unique_indexes_to_override_approving.sql"));
    await p.query(migration("0023_create_bidboard_create_outbox.sql"));
  }
  await sql(migration("0027_rfp_core_routing.sql"));
  dbHolder.pool = pool;
  dbHolder.db = drizzle(pool);
}, 60000);
afterAll(async () => {
  process.env.DATABASE_URL = BASE_URL; // the sentinel must not outlive this file in a reused worker
  if (!BASE_URL) return;
  await pool?.end();
  await pool27less?.end();
  if (admin) await waitNoSessions(DB_NAME);
  await admin?.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  if (admin) await waitNoSessions(DB_NAME_27LESS);
  await admin?.query(`DROP DATABASE IF EXISTS ${DB_NAME_27LESS} WITH (FORCE)`);
  await admin?.end();
});
beforeEach(async () => {
  if (!BASE_URL) return;
  await sql(`TRUNCATE rfp_core_followup_outbox, rfp_core_create_outbox, bidboard_create_outbox, bidboard_callback_outbox,
                      sync_mappings, rfp_approval_approving, rfp_approval_requests RESTART IDENTITY CASCADE`);
  alertMock.mockReset();
  delete process.env.RFP_NONSERVICE_DESTINATION;
  process.env.RFP_CORE_OFFICES = "dallas"; // c6 rule (f): the E1 office (dallas) is listed
});

const DEAL = "00000000-0000-4000-8000-0000000000f1";
const VOTE_KEY = "crm:rfp-vote:approved:round-3";
const HOLD = {
  targetUrl: "https://crm.example.test/api/internal/bid-board-created",
  payload: { status: "failed", error: "cross_destination_hold", sourceDealId: DEAL },
};
function e1(o: Record<string, any> = {}) {
  return {
    sourceSystem: "trock_crm", sourceDealId: DEAL, sourceEventId: VOTE_KEY, decision: "approved",
    approvalKind: "vote", office: "dallas",
    approval: { roundEventId: "round-3", approvals: 2, rejections: 0, invitedVoterCount: 3, decidedAt: "2026-11-01T15:00:00.000Z" },
    deal: {
      name: "Synthetic Deal", projectNumber: "DFW-2-54321-cd", projectType: "2", amount: 1000, estimator: "Pat Example",
      companyId: "00000000-0000-4000-8000-0000000000c1", companyName: "Synthetic Co", contactName: "Sam Synthetic",
      clientEmail: "sam@example.test", clientPhone: null, propertyId: null,
      address: { street: "1 Example St", city: "Dallas", state: "TX", zip: "75001", country: "US" },
      description: null, dueDate: null, workflowRoute: "normal",
    },
    attachments: [],
    ...o,
  } as any;
}
let tokenSeq = 0;
async function insertRequest(status: string, o: { deal?: string; projectNumber?: string | null; p?: pg.Pool } = {}) {
  const r = await (o.p ?? pool).query(
    `INSERT INTO rfp_approval_requests (source_system, source_deal_id, project_number, token, status, deal_data)
     VALUES ('trock_crm', $1, $2, $3, $4, '{}'::jsonb) RETURNING id`,
    [o.deal ?? DEAL, o.projectNumber === undefined ? "DFW-2-54321-cd" : o.projectNumber, `synthetic-token-${++tokenSeq}`, status],
  );
  return r.rows[0].id as number;
}
async function insertCore(key: string, status: string, o: { e2EverSent?: boolean } = {}) {
  const cmd = await sql(
    `INSERT INTO bidboard_create_outbox (source_system, source_deal_id, source_event_id, project_number, payload, status, destination)
     VALUES ('trock_crm', $1, $2, 'DFW-2-54321-cd', $3::jsonb, 'routed_core', 'core') RETURNING id`,
    [DEAL, key, JSON.stringify(e1({ sourceEventId: key }))],
  );
  await sql(
    `INSERT INTO rfp_core_create_outbox (command_id, source_system, source_deal_id, source_event_id, project_number, status, e2_ever_sent)
     VALUES ($1, 'trock_crm', $2, $3, 'DFW-2-54321-cd', $4, $5)`,
    [cmd.rows[0].id, DEAL, key, status, o.e2EverSent ?? false],
  );
}
const claim = (requestId: number, force: boolean, db: any = dbHolder.db) =>
  claimRfpRequestForCreate({ requestId, sourceSystem: "trock_crm", sourceDealId: DEAL, force, holdCallback: HOLD }, db);
const requestStatus = async (id: number) => (await sql(`SELECT status FROM rfp_approval_requests WHERE id = $1`, [id])).rows[0]?.status;
const approvingRow = async (id: number) =>
  (await sql(`SELECT started_at, submit_at, now() - started_at < interval '1 minute' AS fresh FROM rfp_approval_approving WHERE request_id = $1`, [id])).rows[0];
const coreStatus = async (key: string) => (await sql(`SELECT status FROM rfp_core_create_outbox WHERE source_event_id = $1`, [key])).rows[0]?.status;
const holdCallbacks = async (id: number) =>
  (await sql(`SELECT payload->>'error' AS error FROM bidboard_callback_outbox WHERE rfp_approval_request_id = $1`, [id])).rows.map((r) => r.error);
const f1Errors = async () =>
  (await sql(`SELECT payload->>'error' AS error FROM bidboard_callback_outbox WHERE payload->>'status' = 'failed' ORDER BY id`)).rows.map((r) => r.error);
async function until(cond: () => Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}
const lockWaiters = async () =>
  Number((await sql(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
     AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)).rows[0].n);

describe.skipIf(!BASE_URL)("claimRfpRequestForCreate: the email path (V3)", () => {
  it("a pending request with no Core footprint ⇒ claimed: the row is approving, started_at is set, submit_at is NULL", async () => {
    const id = await insertRequest("pending");
    expect(await claim(id, false)).toEqual({ outcome: "claimed" });
    expect(await requestStatus(id)).toBe("approving");
    const side = await approvingRow(id);
    expect(side?.fresh).toBe(true);
    expect(side?.submit_at).toBeNull();
  });
  it("a request that is no longer pending ⇒ not claimable with its status; the row and the side table are unchanged", async () => {
    for (const status of ["approved", "declined", "approving", "override_approving", "held_cross_destination"]) {
      await sql(`TRUNCATE rfp_approval_approving, rfp_approval_requests RESTART IDENTITY CASCADE`);
      const id = await insertRequest(status);
      expect(await claim(id, false), status).toEqual({ outcome: "not_claimable", status });
      expect(await requestStatus(id), status).toBe(status);
      expect(await approvingRow(id), status).toBeUndefined();
    }
  });
  it("a Core footprint for the deal ⇒ held_cross_destination: the request is held, its F1 is written, the Core row is untouched", async () => {
    await insertCore("core-key-1", "pending");
    const id = await insertRequest("pending");
    expect(await claim(id, false)).toEqual({ outcome: "held_cross_destination", footprint: ["core:pending"] });
    expect(await requestStatus(id)).toBe("held_cross_destination");
    expect(await holdCallbacks(id)).toEqual(["cross_destination_hold"]);
    expect(await coreStatus("core-key-1")).toBe("pending");
    expect(await approvingRow(id)).toBeUndefined();
  });
  it("(d9 c) a held Core row that never sent an E2 is no footprint ⇒ the email claim proceeds", async () => {
    await insertCore("core-key-1", "held_cross_destination", { e2EverSent: false });
    const id = await insertRequest("pending");
    expect(await claim(id, false)).toEqual({ outcome: "claimed" });
    expect(await requestStatus(id)).toBe("approving");
  });
  it("markRfpApprovingSubmitted commits submit_at: another session reads it as soon as the call returns", async () => {
    const id = await insertRequest("pending");
    expect(await claim(id, false)).toEqual({ outcome: "claimed" });
    await markRfpApprovingSubmitted(id, dbHolder.db);
    const other = await pool.connect();
    try {
      const r = await other.query(`SELECT submit_at IS NOT NULL AS set FROM rfp_approval_approving WHERE request_id = $1`, [id]);
      expect(r.rows[0]?.set).toBe(true);
    } finally {
      other.release();
    }
  });
});

describe.skipIf(!BASE_URL)("claimRfpRequestForCreate: the override path (force; V2 / V4)", () => {
  it("an override_approving request with no Core footprint ⇒ claimed; the status stays override_approving and started_at is recorded", async () => {
    const id = await insertRequest("override_approving");
    expect(await claim(id, true)).toEqual({ outcome: "claimed" });
    expect(await requestStatus(id)).toBe("override_approving");
    expect((await approvingRow(id))?.fresh).toBe(true);
  });
  it("a request no longer in override_approving ⇒ not claimable with its status", async () => {
    for (const status of ["pending", "declined", "approved"]) {
      await sql(`TRUNCATE rfp_approval_approving, rfp_approval_requests RESTART IDENTITY CASCADE`);
      const id = await insertRequest(status);
      expect(await claim(id, true), status).toEqual({ outcome: "not_claimable", status });
      expect(await requestStatus(id), status).toBe(status);
    }
  });
  it("a Core footprint ⇒ the override is held_cross_destination with its F1", async () => {
    await insertCore("core-key-1", "sent", { e2EverSent: true });
    const id = await insertRequest("override_approving");
    expect(await claim(id, true)).toEqual({ outcome: "held_cross_destination", footprint: ["core:sent"] });
    expect(await requestStatus(id)).toBe("held_cross_destination");
    expect(await holdCallbacks(id)).toEqual(["cross_destination_hold"]);
  });
});

describe.skipIf(!BASE_URL)("claimRfpRequestForCreate: preflight", () => {
  it("0027 absent ⇒ legacy (today's path), never an error; the request row is unchanged (d9 green test)", async () => {
    const id = await insertRequest("pending", { p: pool27less });
    expect(await claim(id, false, drizzle(pool27less))).toEqual({ outcome: "legacy" });
    expect((await pool27less.query(`SELECT status FROM rfp_approval_requests WHERE id = $1`, [id])).rows[0].status).toBe("pending");
  });
  it("a preflight query that ERRORS ⇒ the claim rejects naming the error (fail closed), never legacy; the row stays pending", async () => {
    const id = await insertRequest("pending");
    const failing = {
      execute: async (q: any) => {
        const text = new PgDialect().sqlToQuery(q).sql;
        if (/to_regclass/.test(text)) throw new Error("synthetic preflight failure");
        return dbHolder.db.execute(q);
      },
      transaction: (fn: any) => dbHolder.db.transaction(fn),
    };
    await expect(claim(id, false, failing)).rejects.toThrow(/synthetic preflight failure/);
    expect(await requestStatus(id)).toBe("pending");
  });
  it("the preflight's answer does not depend on the session's search_path (guard)", async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO pg_catalog`);
      expect(await preflightRfpCoreTables(drizzle(client) as any)).toBe("present");
    } finally {
      await client.query(`RESET search_path`);
      client.release();
    }
  });
});

/** The real db, except that the 0027 preflight's query ERRORS (a transient DB failure, not an absent table). */
function preflightErroringDb() {
  return new Proxy(dbHolder.db, {
    get(target: any, prop) {
      if (prop === "execute") {
        return async (q: any) => {
          if (/to_regclass\('public\.rfp_core_create_outbox'\)/.test(new PgDialect().sqlToQuery(q).sql)) throw new Error("synthetic preflight failure");
          return target.execute(q);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
const alertCodes = () => alertMock.mock.calls.map((c) => c[0]);

describe.skipIf(!BASE_URL)("an ERRORED preflight on the other create paths (d9 hardening: 'missing' only on a successful NULL)", () => {
  it("P1 enqueue, ROUTE core: the enqueue rejects naming the real error; alert core_preflight_error, never core_tables_missing; no row", async () => {
    process.env.RFP_NONSERVICE_DESTINATION = "core";
    const real = dbHolder.db;
    dbHolder.db = preflightErroringDb();
    try {
      await expect(enqueueBidboardCreateCommand(e1())).rejects.toThrow(/synthetic preflight failure/);
    } finally {
      dbHolder.db = real;
    }
    expect(alertCodes()).toContain("core_preflight_error");
    expect(alertCodes()).not.toContain("core_tables_missing");
    expect((await sql(`SELECT count(*)::int AS n FROM bidboard_create_outbox`)).rows[0].n).toBe(0);
  });
  it("P1 enqueue, ROUTE procore (setting unset): today's enqueue, unchanged (guard)", async () => {
    const real = dbHolder.db;
    dbHolder.db = preflightErroringDb();
    try {
      await enqueueBidboardCreateCommand(e1({ approvalKind: "override", approval: undefined, sourceEventId: "crm:rfp-override:approved:9" }));
    } finally {
      dbHolder.db = real;
    }
    expect((await sql(`SELECT status FROM bidboard_create_outbox WHERE source_event_id = 'crm:rfp-override:approved:9'`)).rows[0]?.status).toBe("pending");
  });
  it("P2 worker: an errored preflight at the drain ⇒ no Playwright; the pending row is not claimed (retried next tick)", async () => {
    await enqueueBidboardCreateCommand(e1({ approvalKind: "override", approval: undefined, sourceEventId: "crm:rfp-override:approved:9" }));
    const perform = vi.fn(async () => "created" as const);
    const real = dbHolder.db;
    dbHolder.db = preflightErroringDb();
    try {
      await processBidboardCreateOutbox({ performImpl: perform as any }).catch(() => undefined);
    } finally {
      dbHolder.db = real;
    }
    expect(perform).not.toHaveBeenCalled();
    expect((await sql(`SELECT status FROM bidboard_create_outbox WHERE source_event_id = 'crm:rfp-override:approved:9'`)).rows[0]?.status).toBe("pending");
  });
});

describe.skipIf(!BASE_URL)("the create-in-progress footprint (d9 Q5 / Q6)", () => {
  it("an approving request is a Procore footprint: readProcoreFootprint reports request:approving", async () => {
    await insertRequest("approving");
    const footprint = await dbHolder.db.transaction((tx: any) => readProcoreFootprint(tx, "trock_crm", DEAL));
    expect(footprint).toContain("request:approving");
  });
  it("0027's wider indexes refuse a second live request for the deal or the project number while one is approving (guard)", async () => {
    await insertRequest("approving");
    await expect(insertRequest("pending", { projectNumber: "DFW-2-99999-zz" })).rejects.toThrow(/idx_rfp_approval_live_source_deal/);
    await expect(insertRequest("pending", { deal: "00000000-0000-4000-8000-0000000000f9" })).rejects.toThrow(/idx_rfp_approval_live_project_number/);
  });
});

describe.skipIf(!BASE_URL)("races on one deal (real PG, separate sessions)", () => {
  it("the email claims first, then a Core vote ⇒ the vote's Core row is held_cross_destination + F1; the request stays approving", async () => {
    const id = await insertRequest("pending");
    await claim(id, false);
    process.env.RFP_NONSERVICE_DESTINATION = "core";
    await enqueueBidboardCreateCommand(e1());
    expect(await requestStatus(id)).toBe("approving");
    expect(await coreStatus(VOTE_KEY)).toBe("held_cross_destination");
    expect(await f1Errors()).toEqual(["cross_destination_hold"]);
  });
  it("a Core vote first, then the email ⇒ the email is held_cross_destination + F1; the Core row stays pending", async () => {
    const id = await insertRequest("pending");
    process.env.RFP_NONSERVICE_DESTINATION = "core";
    await enqueueBidboardCreateCommand(e1());
    expect(await claim(id, false)).toEqual({ outcome: "held_cross_destination", footprint: ["core:pending"] });
    expect(await coreStatus(VOTE_KEY)).toBe("pending");
    expect(await holdCallbacks(id)).toEqual(["cross_destination_hold"]);
  });
  for (const [label, status, force] of [["an email claim", "pending", false], ["an override claim", "override_approving", true]] as const) {
    it(`${label} and a Core vote released together from a held deal lock ⇒ exactly one destination proceeds, the other is held`, async () => {
      const id = await insertRequest(status);
      process.env.RFP_NONSERVICE_DESTINATION = "core";
      const holder = await pool.connect();
      const ops: Promise<unknown>[] = [];
      let bothWaited = false;
      try {
        await holder.query("BEGIN");
        await holder.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`rfp_create:${DEAL}`]);
        ops.push(claim(id, force), enqueueBidboardCreateCommand(e1()));
        bothWaited = await until(async () => (await lockWaiters()) >= 2, 3000);
      } finally {
        await holder.query("COMMIT");
        holder.release();
        await Promise.allSettled(ops);
      }
      expect(bothWaited, "both paths must wait on rfp_create:<deal>").toBe(true);
      const proceeded = status === "pending" ? "approving" : "override_approving";
      const outcome = { request: await requestStatus(id), core: await coreStatus(VOTE_KEY) };
      expect([
        { request: proceeded, core: "held_cross_destination" },
        { request: "held_cross_destination", core: "pending" },
      ]).toContainEqual(outcome);
    });
  }
  it("two concurrent email claims of one request ⇒ exactly one is claimed, the other is not claimable (approving)", async () => {
    const id = await insertRequest("pending");
    const outcomes = await Promise.all([claim(id, false), claim(id, false)]);
    expect(outcomes).toContainEqual({ outcome: "claimed" });
    expect(outcomes).toContainEqual({ outcome: "not_claimable", status: "approving" });
  });
  it("(d9 a) a vote held behind an override's override_approving leaves no Core footprint, so the override's claim proceeds", async () => {
    const id = await insertRequest("override_approving");
    process.env.RFP_NONSERVICE_DESTINATION = "core";
    await enqueueBidboardCreateCommand(e1());
    expect(await coreStatus(VOTE_KEY)).toBe("held_cross_destination");
    expect(await claim(id, true)).toEqual({ outcome: "claimed" });
    expect(await requestStatus(id)).toBe("override_approving");
  });
});

describe.skipIf(!BASE_URL)("the approving clock is UTC in ANY session time zone (CodeRabbit 4529556652; code-only, 0027 unchanged)", () => {
  it("a claim + submit in an America/Chicago session read back as the TRUE instants (started / hubspot-done / submit within a minute of now); age 0, not older than 30 minutes; a claim 31 minutes old is stuck", async () => {
    const chicago = new pg.Pool({ connectionString: dbUrl(DB_NAME), max: 2, options: "-c TimeZone=America/Chicago" });
    chicago.on("error", () => {});
    try {
      expect((await chicago.query("SHOW TimeZone")).rows[0].TimeZone).toBe("America/Chicago"); // positive control: the session is not UTC
      const db = drizzle(chicago);
      const recorded = { approvedBy: "approver@example.test", editedFields: {}, approvedAttachments: { override: null }, force: false, hubspotDoneAt: new Date() };
      const id = await insertRequest("pending");
      const before = Date.now() - 60_000;
      expect(await claimRfpRequestForCreate({ requestId: id, sourceSystem: "trock_crm", sourceDealId: DEAL, force: false, holdCallback: HOLD, recorded }, db))
        .toMatchObject({ outcome: "claimed" });
      await markRfpApprovingSubmitted(id, db);
      const after = Date.now() + 60_000;
      const facts = (await readApprovingFacts(id, db))!;
      expect(facts.startedAtMs).toBeGreaterThanOrEqual(before);
      expect(facts.startedAtMs).toBeLessThanOrEqual(after);
      expect(facts.recorded?.hubspotDoneAt?.getTime()).toBeGreaterThanOrEqual(before);
      expect(facts.recorded?.hubspotDoneAt?.getTime()).toBeLessThanOrEqual(after);
      expect(Date.parse(`${facts.submitAt}Z`)).toBeGreaterThanOrEqual(before); // submit_at is shown as a UTC wall clock
      expect(Date.parse(`${facts.submitAt}Z`)).toBeLessThanOrEqual(after);
      expect(facts.ageMinutes).toBe(0);
      expect(facts.olderThan30).toBe(false);
      expect((await findStuckApprovingRequests(chicago, new Date())).map((r) => r.requestId)).not.toContain(id);
      await sql(`UPDATE rfp_approval_approving SET started_at = started_at - interval '31 minutes' WHERE request_id = $1`, [id]);
      const stuck = (await findStuckApprovingRequests(chicago, new Date())).find((r) => r.requestId === id);
      expect(stuck?.ageMinutes).toBe(31);
      expect((await readApprovingFacts(id, db))!.olderThan30).toBe(true);
    } finally {
      await chicago.end();
    }
  });
});
