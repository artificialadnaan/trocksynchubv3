import crypto from "crypto";
import { readFileSync } from "fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// S1a (CONTRACT v2.4 §5 / §10): the E2 sender on the REAL S0 enqueue + the real 0023 / 0027 migrations (PGlite), with a
// mocked Core. Dark and inert; one alert for a config / table gap; the request (signature, redirect, body from the command
// row's stored E1); every E3 branch and the schedule; the pre-send refusals; the Procore-footprint hold under the per-deal
// lock, incl. the operator re-drive skip (procore-done command + payload.operatorRedrive.go only; pending a4's final
// confirmation); retry idempotency after a lost response; the worker wiring. Synthetic data only (I7).
const dbHolder = vi.hoisted(() => ({ db: null as any, gets: 0 }));
const alertMock = vi.hoisted(() => vi.fn(async (_code: string, _detail: Record<string, unknown>) => {}));
const fetchDefault = vi.hoisted(() => vi.fn());
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));
vi.mock("../server/db.ts", () => ({ get db() { dbHolder.gets += 1; return dbHolder.db; }, get pool() { return undefined; } }));
vi.mock("../server/playwright/bidboard.ts", () => ({ createBidBoardProjectFromDeal: vi.fn() }));
vi.mock("../server/rfp-approval.ts", () => ({
  checkRfpApprovalSourceEligibility: vi.fn(async () => ({ eligible: true })),
  buildSourceDealUrl: vi.fn(() => null),
  normalizedDealData: vi.fn(() => ({})),
}));
vi.mock("../server/storage.ts", () => ({ storage: { getAutomationConfig: vi.fn(async () => ({ value: { companyId: "42" } })) } }));
vi.mock("../server/sync/rfp-core-alert.ts", () => ({ raiseRfpCoreAlert: alertMock }));
vi.mock("../server/lib/fetch-with-timeout.ts", () => ({ fetchWithTimeout: fetchDefault }));

const { enqueueBidboardCreateCommand } = await import("../server/sync/bidboard-create-worker.ts");
const { processRfpCoreCreateOutbox, resetRfpCoreSenderStateForTests } = await import("../server/sync/rfp-core-sender.ts");
const { resetRfpCoreFollowupStateForTests } = await import("../server/sync/rfp-core-followup.ts");
const { startRfpCoreWorkers, stopRfpCoreWorkers } = await import("../server/sync/rfp-core-worker.ts");

const DDL_0023 = readFileSync(new URL("../migrations/0023_create_bidboard_create_outbox.sql", import.meta.url), "utf8");
const DDL_0027 = readFileSync(new URL("../migrations/0027_rfp_core_routing.sql", import.meta.url), "utf8");
const BASE_DDL = `
  CREATE TABLE bidboard_callback_outbox (
    id serial PRIMARY KEY, source_system text NOT NULL, source_deal_id text NOT NULL,
    rfp_approval_request_id integer NOT NULL, payload jsonb NOT NULL, target_url text NOT NULL,
    status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE sync_mappings (
    id serial PRIMARY KEY, source_system text NOT NULL DEFAULT 'hubspot', source_deal_id text NOT NULL, bidboard_project_id text
  );
  CREATE TABLE rfp_approval_requests (
    id serial PRIMARY KEY, source_system text NOT NULL DEFAULT 'hubspot', source_deal_id text NOT NULL,
    status text NOT NULL DEFAULT 'pending', project_number text
  );
`;

const SECRET = "synthetic-rfp-bid-create-secret-0123456789";
const CRM_SECRET = "synthetic-crm-internal-secret";
const CORE_BASE = "https://core.example.test";
const CRM_BASE = "https://crm.example.test";
const E2_URL = `${CORE_BASE}/webhooks/crm/dallas/rfp-bid-create/v1`;
const E2_PATH = "/webhooks/crm/dallas/rfp-bid-create/v1";
const DEAL = "00000000-0000-4000-8000-0000000000a1";
const OTHER_DEAL = "00000000-0000-4000-8000-0000000000a2";
const COMPANY = "00000000-0000-4000-8000-0000000000c1";
const PROPERTY = "00000000-0000-4000-8000-0000000000f1";
const BID = "00000000-0000-4000-8000-0000000000b1";
const KEY = "crm:rfp-vote:approved:round-7";
const OLD_KEY = "crm:rfp-vote:approved:round-6";
const CREATED_AT = "2026-11-10T12:00:01.000Z";
const ENV_KEYS = ["RFP_NONSERVICE_DESTINATION", "RFP_BID_CREATE_INGRESS_SECRET_CURRENT", "CORE_INGRESS_BASE_URL", "TROCK_CRM_BASE_URL", "RFP_REQUEST_SYNC_SECRET"];
const savedEnv: Record<string, string | undefined> = {};

let pg: PGlite;
let mainDb: any;
beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  pg = new PGlite();
  await pg.exec(BASE_DDL);
  await pg.exec(DDL_0023); // also drops NOT NULL on bidboard_callback_outbox.rfp_approval_request_id
  await pg.exec(DDL_0027);
  mainDb = drizzle(pg);
  dbHolder.db = mainDb;
}, 30000);
afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await pg?.close?.();
});
beforeEach(async () => {
  dbHolder.db = mainDb;
  await pg.exec(`DELETE FROM rfp_core_followup_outbox; DELETE FROM rfp_core_create_outbox; DELETE FROM bidboard_create_outbox;
                 DELETE FROM bidboard_callback_outbox; DELETE FROM sync_mappings; DELETE FROM rfp_approval_requests;`);
  alertMock.mockReset();
  fetchDefault.mockReset();
  process.env.RFP_NONSERVICE_DESTINATION = "core";
  process.env.RFP_BID_CREATE_INGRESS_SECRET_CURRENT = SECRET;
  process.env.CORE_INGRESS_BASE_URL = CORE_BASE;
  process.env.TROCK_CRM_BASE_URL = CRM_BASE;
  process.env.RFP_REQUEST_SYNC_SECRET = CRM_SECRET;
  resetRfpCoreSenderStateForTests();
  resetRfpCoreFollowupStateForTests();
});
afterEach(() => stopRfpCoreWorkers());

function e1(o: Record<string, any> = {}, deal: Record<string, any> = {}): any {
  return {
    sourceSystem: "trock_crm", sourceDealId: DEAL, sourceEventId: KEY, decision: "approved",
    approvalKind: "vote", office: "dallas",
    approval: { roundEventId: "round-7", approvals: 2, rejections: 0, invitedVoterCount: 3, decidedAt: "2026-11-01T15:00:00.000Z" },
    attachmentsOmitted: 1,
    attachments: [{ name: "plans.pdf", url: "https://files.example.test/plans.pdf?sig=abc", contentType: "application/pdf" }],
    ...o,
    deal: {
      name: "Synthetic Tower Reroof", projectNumber: "DFW-2-12345-ab", projectType: "2", amount: 125000.5, estimator: "Pat Example",
      ownerName: "Riley Rep", ownerEmail: "riley.rep@example.test", ownerSource: "assigned_rep",
      companyId: COMPANY, companyName: "Synthetic Builders LLC",
      companyBillAddress: { address: "100 Sample Way", city: "Plano", state: "TX", zip: "75024" },
      propertyId: PROPERTY, propertyName: "Sample Plaza",
      contactName: "Sam Synthetic", clientEmail: "sam@example.test", clientPhone: "555-0100",
      address: { street: "1 Example St", city: "Dallas", state: "TX", zip: "75001", country: "US" },
      description: "Replace the roof membrane.", crmActivityLog: "Call: walked the site.",
      dueDate: "2026-11-20T17:00:00-06:00", workflowRoute: "normal", scopeTitle: "Roof replacement",
      ...deal,
    },
  };
}
const receipt = (result = "created", o: Record<string, unknown> = {}) => ({
  version: "trock.crm.rfp-bid-create.v1", result, coreBidId: BID, boardStage: { code: "in-progress", status: "invited" },
  createdAt: CREATED_AT, warnings: ["owner_not_found"], ...o,
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const coreReturning = (status: number, body: unknown) => vi.fn(async (_url: string, _init: any) => json(status, body));

const coreRows = async () =>
  (await pg.query<any>(`SELECT *, EXTRACT(EPOCH FROM (next_attempt_at - last_attempt_at))::int AS delay_s FROM rfp_core_create_outbox ORDER BY id`)).rows;
const followups = async () => (await pg.query<any>(`SELECT * FROM rfp_core_followup_outbox ORDER BY id`)).rows;
const cmdStatus = async (key = KEY) => (await pg.query<any>(`SELECT status FROM bidboard_create_outbox WHERE source_event_id = $1`, [key])).rows[0]?.status;
const f1Errors = async () =>
  (await pg.query<any>(`SELECT payload FROM bidboard_callback_outbox WHERE payload->>'status' = 'failed' ORDER BY id`)).rows.map((r) => r.payload.error);
const alertCodes = () => alertMock.mock.calls.map((c) => c[0]);
const makeDue = () => pg.exec(`UPDATE rfp_core_create_outbox SET next_attempt_at = NOW() - interval '1 second' WHERE status = 'pending'`);
const resetAll = async () => {
  await pg.exec(`DELETE FROM rfp_core_followup_outbox; DELETE FROM rfp_core_create_outbox; DELETE FROM bidboard_create_outbox;
                 DELETE FROM bidboard_callback_outbox; DELETE FROM sync_mappings;`);
  alertMock.mockReset();
  resetRfpCoreSenderStateForTests();
};
function framed(domain: string, path: string, body: string, key: string): string {
  const NUL = Buffer.from([0]);
  const pre = Buffer.concat([Buffer.from(domain), NUL, Buffer.from("POST"), NUL, Buffer.from(path), NUL, Buffer.from(body)]);
  return `sha256=${crypto.createHmac("sha256", key).update(pre).digest("hex")}`;
}
async function until(cond: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}
/** A procore create command for the deal (another key unless given), inserted directly. */
async function insertProcoreCommand(status: string, o: { key?: string; destination?: string } = {}) {
  const key = o.key ?? OLD_KEY;
  const r = await pg.query<any>(
    `INSERT INTO bidboard_create_outbox (source_system, source_deal_id, source_event_id, project_number, payload, status, destination, approval_kind)
     VALUES ('trock_crm', $1, $2, 'DFW-2-12345-ab', $3::jsonb, $4, $5, 'vote') RETURNING id`,
    [DEAL, key, JSON.stringify(e1({ sourceEventId: key })), status, o.destination ?? "procore"],
  );
  return r.rows[0].id as number;
}
/** A Core row pointing at an EXISTING command (the shape the future one-deal re-drive CLI writes). */
async function insertCoreRowFor(commandId: number, payload: unknown) {
  await pg.query(
    `INSERT INTO rfp_core_create_outbox (command_id, source_system, source_deal_id, source_event_id, project_number, payload, status)
     VALUES ($1, 'trock_crm', $2, $3, 'DFW-2-12345-ab', $4::jsonb, 'pending')`,
    [commandId, DEAL, KEY, payload === null ? null : JSON.stringify(payload)],
  );
}
const REDRIVE = { operatorRedrive: { reason: "operator_redrive", go: "GO-SYN-0001" } };

describe("dark and inert", () => {
  it("setting unset (or 'procore') ⇒ nothing sent and the database is not read; the same row is sent once the setting is core", async () => {
    await enqueueBidboardCreateCommand(e1());
    const fetchImpl = coreReturning(201, receipt());
    for (const setting of [undefined, "procore", "CORE"]) {
      if (setting === undefined) delete process.env.RFP_NONSERVICE_DESTINATION;
      else process.env.RFP_NONSERVICE_DESTINATION = setting;
      const gets = dbHolder.gets;
      await processRfpCoreCreateOutbox({ fetchImpl });
      expect(dbHolder.gets, String(setting)).toBe(gets);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await coreRows())[0]).toMatchObject({ status: "pending", attempt_count: 0 });
    process.env.RFP_NONSERVICE_DESTINATION = "core";
    await processRfpCoreCreateOutbox({ fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await coreRows())[0].status).toBe("sent");
  });
  it("a missing or short secret, an unset / http Core base URL or an unset CRM base URL ⇒ nothing sent, rows stay pending, ONE alert", async () => {
    const variants: Array<[string, () => void]> = [
      ["secret unset", () => { delete process.env.RFP_BID_CREATE_INGRESS_SECRET_CURRENT; }],
      ["secret 31 bytes", () => { process.env.RFP_BID_CREATE_INGRESS_SECRET_CURRENT = "s".repeat(31); }],
      ["Core base unset", () => { delete process.env.CORE_INGRESS_BASE_URL; }],
      ["Core base http", () => { process.env.CORE_INGRESS_BASE_URL = "http://core.example.test"; }],
      ["CRM base unset", () => { delete process.env.TROCK_CRM_BASE_URL; }],
    ];
    for (const [label, apply] of variants) {
      await resetAll();
      process.env.RFP_BID_CREATE_INGRESS_SECRET_CURRENT = SECRET;
      process.env.CORE_INGRESS_BASE_URL = CORE_BASE;
      process.env.TROCK_CRM_BASE_URL = CRM_BASE;
      await enqueueBidboardCreateCommand(e1());
      await enqueueBidboardCreateCommand(e1({ sourceDealId: OTHER_DEAL, sourceEventId: "crm:rfp-vote:approved:round-9" }));
      apply();
      const fetchImpl = coreReturning(201, receipt());
      await processRfpCoreCreateOutbox({ fetchImpl });
      await processRfpCoreCreateOutbox({ fetchImpl });
      expect(fetchImpl, label).not.toHaveBeenCalled();
      expect((await coreRows()).map((r) => [r.status, r.attempt_count]), label).toEqual([["pending", 0], ["pending", 0]]);
      expect(alertCodes(), label).toEqual(["rfp_core_unconfigured"]);
    }
    process.env.TROCK_CRM_BASE_URL = CRM_BASE;
    const fetchImpl = coreReturning(201, receipt());
    await processRfpCoreCreateOutbox({ fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("the 0027 tables missing with ROUTE core ⇒ HOLD + ONE alert, nothing sent, nothing falls back to Procore", async () => {
    await enqueueBidboardCreateCommand(e1());
    const bare = new PGlite();
    try {
      await bare.exec(BASE_DDL);
      await bare.exec(DDL_0023);
      await bare.query(
        `INSERT INTO bidboard_create_outbox (source_system, source_deal_id, source_event_id, project_number, payload, status)
         VALUES ('trock_crm', $1, $2, 'DFW-2-12345-ab', $3::jsonb, 'pending')`,
        [DEAL, KEY, JSON.stringify(e1())],
      );
      dbHolder.db = drizzle(bare);
      const fetchImpl = coreReturning(201, receipt());
      await processRfpCoreCreateOutbox({ fetchImpl });
      await processRfpCoreCreateOutbox({ fetchImpl });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(alertCodes()).toEqual(["core_tables_missing"]);
      expect((await bare.query<any>(`SELECT status, attempt_count FROM bidboard_create_outbox`)).rows).toEqual([{ status: "pending", attempt_count: 0 }]);
      dbHolder.db = mainDb;
      await processRfpCoreCreateOutbox({ fetchImpl });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      dbHolder.db = mainDb;
      await bare.close();
    }
  });
});

describe("the E2 request", () => {
  it("ONE POST to Core's rfp-bid-create path, x-trock-signature over domain ‖ POST ‖ path ‖ the exact bytes sent, redirect 'error'", async () => {
    await enqueueBidboardCreateCommand(e1());
    const fetchImpl = coreReturning(201, receipt());
    await processRfpCoreCreateOutbox({ fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(E2_URL);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-trock-signature")).toBe(framed("trock.crm.rfp-bid-create.v1", E2_PATH, init.body, SECRET));
  });
  it("the body is built from the command row's stored E1 payload (§5), occurredAt stamped at send time", async () => {
    await enqueueBidboardCreateCommand(e1());
    const fetchImpl = coreReturning(201, receipt());
    const now = new Date("2026-11-10T12:00:00.000Z");
    await processRfpCoreCreateOutbox({ fetchImpl, now: () => now });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body)).toEqual({
      version: "trock.crm.rfp-bid-create.v1", office: "dallas", occurredAt: "2026-11-10T12:00:00.000Z", sourceEventId: KEY,
      approvalKind: "vote",
      approval: { roundEventId: "round-7", approvals: 2, rejections: 0, invitedVoterCount: 3, decidedAt: "2026-11-01T15:00:00.000Z" },
      crmDealId: DEAL,
      deal: {
        name: "Synthetic Tower Reroof", projectNumber: "DFW-2-12345-ab", projectType: "2", amount: 125000.5, estimator: "Pat Example",
        estimatorEmail: null, ownerName: "Riley Rep", ownerEmail: "riley.rep@example.test", ownerSource: "assigned_rep",
        scopeTitle: "Roof replacement", description: "Replace the roof membrane.", dueDate: "2026-11-20T23:00:00.000Z", workflowRoute: "normal",
      },
      company: { id: COMPANY, name: "Synthetic Builders LLC", billAddress: { address: "100 Sample Way", city: "Plano", state: "TX", zip: "75024" } },
      property: { id: PROPERTY, name: "Sample Plaza", address: { street: "1 Example St", city: "Dallas", state: "TX", zip: "75001", country: "US" } },
      contact: { name: "Sam Synthetic", email: "sam@example.test", phone: "555-0100" },
      attachments: [{ name: "plans.pdf", url: "https://files.example.test/plans.pdf?sig=abc", contentType: "application/pdf" }],
      attachmentsOmitted: 1,
      crmActivityLog: "Call: walked the site.",
    });
  });
});

describe("E3 results (§10 classifier)", () => {
  it("201 created ⇒ sent, e2_ever_sent, core_bid_id / core_created_at / warnings stored, and ONE E4 crm_link follow-up", async () => {
    await enqueueBidboardCreateCommand(e1());
    await processRfpCoreCreateOutbox({ fetchImpl: coreReturning(201, receipt()) });
    const [row] = await coreRows();
    expect(row).toMatchObject({
      status: "sent", e2_ever_sent: true, core_bid_id: BID, warnings: ["owner_not_found"], last_status_code: 201, attempt_count: 1,
      refusal_reason: null, last_error: null,
    });
    expect(new Date(row.core_created_at).toISOString()).toBe(CREATED_AT);
    expect(row.sent_at).not.toBeNull();
    const fu = await followups();
    expect(fu.map((f) => [f.kind, f.notice_kind, f.status])).toEqual([["crm_link", "", "pending"]]);
    expect(fu[0].payload).toEqual({
      sourceSystem: "trock_crm", sourceDealId: DEAL, sourceEventId: KEY, approvalKind: "vote", office: "dallas", coreBidId: BID,
      coreCreatedAt: CREATED_AT, projectNumber: "DFW-2-12345-ab", warnings: ["owner_not_found"],
    });
    expect(await f1Errors()).toEqual([]);
  });
  it("200 replay and 200 updated ⇒ sent + the E4 follow-up", async () => {
    for (const result of ["replay", "updated"]) {
      await resetAll();
      await enqueueBidboardCreateCommand(e1());
      await processRfpCoreCreateOutbox({ fetchImpl: coreReturning(200, receipt(result)) });
      expect((await coreRows())[0], result).toMatchObject({ status: "sent", core_bid_id: BID, last_status_code: 200 });
      expect((await followups()).map((f) => f.kind), result).toEqual(["crm_link"]);
    }
  });
  it("409 ⇒ refused with Core's reason verbatim, F1 with the reason verbatim, an alert; no follow-up, not retried", async () => {
    await enqueueBidboardCreateCommand(e1());
    const fetchImpl = coreReturning(409, { error: "rfp_bid_create_conflict", reason: "property_archived" });
    await processRfpCoreCreateOutbox({ fetchImpl });
    expect((await coreRows())[0]).toMatchObject({ status: "refused", refusal_reason: "property_archived", last_status_code: 409 });
    expect(await f1Errors()).toEqual(["property_archived"]);
    expect(alertCodes()).toContain("core_create_refused");
    expect(await followups()).toEqual([]);
    await makeDue();
    await processRfpCoreCreateOutbox({ fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("400 and 401 ⇒ terminal (failed) + alert, no F1, not retried", async () => {
    for (const [status, body] of [[400, { error: "bad_request", reason: "invalid_payload", field: "deal.amount" }], [401, { error: "unauthorized" }]] as const) {
      await resetAll();
      await enqueueBidboardCreateCommand(e1());
      const fetchImpl = coreReturning(status, body);
      await processRfpCoreCreateOutbox({ fetchImpl });
      expect((await coreRows())[0], String(status)).toMatchObject({ status: "failed", last_status_code: status });
      expect(alertCodes(), String(status)).toContain("core_request_rejected");
      expect(await f1Errors(), String(status)).toEqual([]);
      await makeDue();
      await processRfpCoreCreateOutbox({ fetchImpl });
      expect(fetchImpl, String(status)).toHaveBeenCalledTimes(1);
    }
  });
  it("404 (dark) / 408 / 429 / 500 / 503 / a transport error ⇒ still pending, retried in 30 s, with an alert", async () => {
    const answers: Array<[string, () => Promise<Response>]> = [
      ...[404, 408, 429, 500, 503].map((s) => [String(s), async () => json(s, {})] as [string, () => Promise<Response>]),
      ["transport", async () => { throw new TypeError("fetch failed"); }],
    ];
    for (const [label, answer] of answers) {
      await resetAll();
      await enqueueBidboardCreateCommand(e1());
      const fetchImpl = vi.fn(async (_url: string, _init: any) => answer());
      await processRfpCoreCreateOutbox({ fetchImpl });
      expect(fetchImpl, label).toHaveBeenCalledTimes(1);
      expect((await coreRows())[0], label).toMatchObject({
        status: "pending", attempt_count: 1, delay_s: 30, e2_ever_sent: true, last_status_code: label === "transport" ? null : Number(label),
      });
      expect(alertCodes(), label).toContain("core_create_retry");
    }
  });
  it("the schedule: waits of 30 s / 2 m / 10 m / 30 m / 2 h, and the 6th failure ⇒ dead + alert + F1; a dead row is never re-sent", async () => {
    await enqueueBidboardCreateCommand(e1());
    const fetchImpl = coreReturning(503, {});
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 6; attempt++) {
      await makeDue();
      await processRfpCoreCreateOutbox({ fetchImpl });
      const [row] = await coreRows();
      expect(row.attempt_count, `attempt ${attempt}`).toBe(attempt);
      if (attempt < 6) {
        expect(row.status, `attempt ${attempt}`).toBe("pending");
        delays.push(row.delay_s);
      }
    }
    expect(delays).toEqual([30, 120, 600, 1800, 7200]);
    expect((await coreRows())[0].status).toBe("dead");
    expect(alertCodes()).toContain("core_create_dead");
    expect(await f1Errors()).toEqual(["core_create_dead"]);
    await makeDue();
    await processRfpCoreCreateOutbox({ fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });
});

describe("pre-send refusals", () => {
  it("companyId null ⇒ refused company_missing + F1 company_missing + alert; nothing sent, e2_ever_sent stays false", async () => {
    await enqueueBidboardCreateCommand(e1({}, { companyId: null }));
    const fetchImpl = coreReturning(201, receipt());
    await processRfpCoreCreateOutbox({ fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await coreRows())[0]).toMatchObject({ status: "refused", refusal_reason: "company_missing", e2_ever_sent: false, attempt_count: 0 });
    expect(await f1Errors()).toEqual(["company_missing"]);
    expect(alertCodes()).toContain("core_create_refused");
  });
  it("the same sourceEventId stored for another deal ⇒ refused source_event_reused before sending + alert + F1", async () => {
    await enqueueBidboardCreateCommand(e1());
    await pg.query(
      `UPDATE bidboard_create_outbox SET source_deal_id = $1, payload = jsonb_set(payload, '{sourceDealId}', to_jsonb($1::text)) WHERE source_event_id = $2`,
      [OTHER_DEAL, KEY],
    );
    const fetchImpl = coreReturning(201, receipt());
    await processRfpCoreCreateOutbox({ fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await coreRows())[0]).toMatchObject({ status: "refused", refusal_reason: "source_event_reused", e2_ever_sent: false });
    expect(alertCodes()).toContain("source_event_reused");
    expect(await f1Errors()).toEqual(["source_event_reused"]);
  });
});

describe("the Procore footprint, re-checked under the per-deal lock (§10)", () => {
  it("a deal that gained a Procore footprint after the stamp ⇒ held_cross_destination + alert + F1, nothing sent; the command stays routed_core", async () => {
    const seeds: Array<[string, () => Promise<unknown>]> = [
      ["sync mapping", () => pg.query(`INSERT INTO sync_mappings (source_system, source_deal_id, bidboard_project_id) VALUES ('trock_crm', $1, '900001')`, [DEAL])],
      ["procore command done", () => insertProcoreCommand("done")],
      ["request approved", () => pg.query(`INSERT INTO rfp_approval_requests (source_system, source_deal_id, status) VALUES ('trock_crm', $1, 'approved')`, [DEAL])],
    ];
    for (const [label, seed] of seeds) {
      await resetAll();
      await pg.exec(`DELETE FROM rfp_approval_requests`);
      await enqueueBidboardCreateCommand(e1());
      await seed();
      const fetchImpl = coreReturning(201, receipt());
      await processRfpCoreCreateOutbox({ fetchImpl });
      expect(fetchImpl, label).not.toHaveBeenCalled();
      expect((await coreRows())[0], label).toMatchObject({ status: "held_cross_destination", e2_ever_sent: false });
      expect(await cmdStatus(), label).toBe("routed_core");
      expect(alertCodes(), label).toContain("cross_destination_hold");
      expect(await f1Errors(), label).toEqual(["cross_destination_hold"]);
    }
  });
  it("an ORDINARY row whose command is procore-done (the re-drive shape without the marker) ⇒ held + alert + F1", async () => {
    const commandId = await insertProcoreCommand("done", { key: KEY });
    await insertCoreRowFor(commandId, null);
    const fetchImpl = coreReturning(201, receipt());
    await processRfpCoreCreateOutbox({ fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await coreRows())[0].status).toBe("held_cross_destination");
    expect(alertCodes()).toContain("cross_destination_hold");
    expect(await f1Errors()).toEqual(["cross_destination_hold"]);
  });
  it("an operator re-drive row (payload.operatorRedrive.go) whose command is procore-done ⇒ the hold is skipped and E2 is sent", async () => {
    const commandId = await insertProcoreCommand("done", { key: KEY });
    await pg.query(`INSERT INTO sync_mappings (source_system, source_deal_id, bidboard_project_id) VALUES ('trock_crm', $1, '900002')`, [DEAL]);
    await insertCoreRowFor(commandId, REDRIVE);
    const fetchImpl = coreReturning(201, receipt());
    await processRfpCoreCreateOutbox({ fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await coreRows())[0]).toMatchObject({ status: "sent", core_bid_id: BID });
    expect(alertCodes()).not.toContain("cross_destination_hold");
    expect(await f1Errors()).toEqual([]);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body)).toMatchObject({ sourceEventId: KEY, crmDealId: DEAL, approvalKind: "vote" });
  });
  it("a re-drive marker WITHOUT a procore-done command, or a procore-done command without a non-empty go ⇒ held", async () => {
    const cases: Array<[string, () => Promise<void>]> = [
      ["go + procore failed + mapping", async () => {
        const id = await insertProcoreCommand("failed", { key: KEY });
        await pg.query(`INSERT INTO sync_mappings (source_system, source_deal_id, bidboard_project_id) VALUES ('trock_crm', $1, '900003')`, [DEAL]);
        await insertCoreRowFor(id, REDRIVE);
      }],
      ["go + procore needs_manual", async () => insertCoreRowFor(await insertProcoreCommand("needs_manual", { key: KEY }), REDRIVE)],
      ["go + a core-stamped command + mapping", async () => {
        const id = await insertProcoreCommand("routed_core", { key: KEY, destination: "core" });
        await pg.query(`INSERT INTO sync_mappings (source_system, source_deal_id, bidboard_project_id) VALUES ('trock_crm', $1, '900004')`, [DEAL]);
        await insertCoreRowFor(id, REDRIVE);
      }],
      ["procore done + go empty", async () => insertCoreRowFor(await insertProcoreCommand("done", { key: KEY }), { operatorRedrive: { reason: "operator_redrive", go: "" } })],
      ["procore done + no go", async () => insertCoreRowFor(await insertProcoreCommand("done", { key: KEY }), { operatorRedrive: { reason: "operator_redrive" } })],
    ];
    for (const [label, seed] of cases) {
      await resetAll();
      await seed();
      const fetchImpl = coreReturning(201, receipt());
      await processRfpCoreCreateOutbox({ fetchImpl });
      expect(fetchImpl, label).not.toHaveBeenCalled();
      expect((await coreRows())[0].status, label).toBe("held_cross_destination");
      expect(alertCodes(), label).toContain("cross_destination_hold");
    }
  });
});

describe("retry idempotency (§5 replay)", () => {
  it("a lost response: Core created the bid but the reply never arrived ⇒ the retry is Core's replay: ONE bid, ONE follow-up, same body", async () => {
    await enqueueBidboardCreateCommand(e1());
    const bids = new Map<string, string>();
    const bodies: any[] = [];
    let lose = true;
    const fetchImpl = vi.fn(async (_url: string, init: any) => {
      const b = JSON.parse(init.body);
      bodies.push(b);
      const existing = bids.get(b.sourceEventId);
      if (existing) return json(200, receipt("replay", { coreBidId: existing }));
      bids.set(b.sourceEventId, BID);
      if (lose) {
        lose = false;
        throw new TypeError("fetch failed: the socket closed after Core committed");
      }
      return json(201, receipt());
    });
    await processRfpCoreCreateOutbox({ fetchImpl });
    expect((await coreRows())[0]).toMatchObject({ status: "pending", attempt_count: 1 });
    await makeDue();
    await processRfpCoreCreateOutbox({ fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bids.size).toBe(1);
    expect((await coreRows())[0]).toMatchObject({ status: "sent", core_bid_id: BID, attempt_count: 2 });
    expect((await followups()).map((f) => f.kind)).toEqual(["crm_link"]);
    const strip = ({ occurredAt: _o, ...rest }: any) => rest;
    expect(strip(bodies[1])).toEqual(strip(bodies[0]));
  });
  it("a row left 'sending' by a crash is re-sent only after 10 minutes, and Core's replay settles it with ONE follow-up", async () => {
    await enqueueBidboardCreateCommand(e1());
    await pg.exec(`UPDATE rfp_core_create_outbox SET status = 'sending', attempt_count = 1, e2_ever_sent = true, last_attempt_at = NOW() - interval '1 minute'`);
    const fetchImpl = coreReturning(200, receipt("replay"));
    await processRfpCoreCreateOutbox({ fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    await pg.exec(`UPDATE rfp_core_create_outbox SET last_attempt_at = NOW() - interval '11 minutes'`);
    await processRfpCoreCreateOutbox({ fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await coreRows())[0]).toMatchObject({ status: "sent", core_bid_id: BID, attempt_count: 2 });
    await processRfpCoreCreateOutbox({ fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await followups()).map((f) => f.kind)).toEqual(["crm_link"]);
  });
});

describe("wiring (server/routes/index.ts → rfp-core-worker.ts)", () => {
  it("the timer is inert when dark (no query, no send) and drains the same row once the setting is core", async () => {
    await enqueueBidboardCreateCommand(e1());
    fetchDefault.mockImplementation(async (url: string) => {
      if (url === E2_URL) return json(201, receipt());
      if (url.endsWith("/api/internal/core-bid-created")) return json(200, { result: "linked" });
      if (url.endsWith("/linked")) return json(200, { confirmed: true });
      return json(200, { result: "recorded" });
    });
    delete process.env.RFP_NONSERVICE_DESTINATION;
    const gets = dbHolder.gets;
    startRfpCoreWorkers(10);
    await new Promise((r) => setTimeout(r, 80));
    expect(fetchDefault).not.toHaveBeenCalled();
    expect(dbHolder.gets).toBe(gets);
    process.env.RFP_NONSERVICE_DESTINATION = "core";
    const drained = await until(async () => (await coreRows())[0]?.status === "sent");
    stopRfpCoreWorkers();
    expect(drained).toBe(true);
    expect(fetchDefault.mock.calls.filter((c) => c[0] === E2_URL)).toHaveLength(1);
  });
  it("routes/index.ts starts the RFP Core workers beside the Procore Bid Board create worker", () => {
    const src = readFileSync(new URL("../server/routes/index.ts", import.meta.url), "utf8");
    expect(src).toMatch(/import \{ startRfpCoreWorkers \} from "\.\.\/sync\/rfp-core-worker"/);
    expect(src).toMatch(/^\s*startBidboardCreateWorker\(\);[\s\S]*^\s*startRfpCoreWorkers\(\);/m);
  });
});
