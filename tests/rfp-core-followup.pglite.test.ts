import crypto from "crypto";
import { readFileSync } from "fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// S1a (CONTRACT v2.4 §6 / §7 / §10): the follow-ups of a created Core bid on the real 0023 / 0027 migrations (PGlite), with
// a mocked CRM and Core. E4 → E5 sequencing (E4 decided on `result`; linked / claimed optional extras, a link-only answer
// is linked); E4 stale / 409 / retry / dead / terminal; E5 never dead (the schedule, then every 2 h; ONE pending N1, daily
// alerts; the CLEAR on success); each N1 kind on the strict wire; the stable noticeId across redelivery; N1 dead = alert
// only. r2 (d9's §12 ruling): due follow-ups drain under ANY RFP_NONSERVICE_DESTINATION (inert by data); tables absent ⇒
// silent unless the setting is core; unconfigured ⇒ one alert only when a follow-up is due. r2 (d9 ruling 5): the office
// rides E4 / E5 / N1 (atlanta ⇒ Core's atlanta …/linked path). r2 (ruling 6): E5 after attempt 6 pinned explicitly.
// Synthetic data only (I7).
const dbHolder = vi.hoisted(() => ({ db: null as any, gets: 0 }));
const alertMock = vi.hoisted(() => vi.fn(async (_code: string, _detail: Record<string, unknown>) => {}));
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

const { enqueueBidboardCreateCommand } = await import("../server/sync/bidboard-create-worker.ts");
const { processRfpCoreFollowupOutbox, resetRfpCoreFollowupStateForTests } = await import("../server/sync/rfp-core-followup.ts");

const DDL_0023 = readFileSync(new URL("../migrations/0023_create_bidboard_create_outbox.sql", import.meta.url), "utf8");
const DDL_0027 = readFileSync(new URL("../migrations/0027_rfp_core_routing.sql", import.meta.url), "utf8");

const SECRET = "synthetic-rfp-bid-create-secret-0123456789";
const CRM_SECRET = "synthetic-crm-internal-secret";
const CORE_BASE = "https://core.example.test";
const CRM_BASE = "https://crm.example.test";
const E4_URL = `${CRM_BASE}/api/internal/core-bid-created`;
const N1_URL = `${CRM_BASE}/api/internal/rfp-core-notice`;
const E5_URL = `${CORE_BASE}/webhooks/crm/dallas/rfp-bid-create/v1/linked`;
const E5_PATH = "/webhooks/crm/dallas/rfp-bid-create/v1/linked";
const E5_ATL_URL = `${CORE_BASE}/webhooks/crm/atlanta/rfp-bid-create/v1/linked`;
const E5_ATL_PATH = "/webhooks/crm/atlanta/rfp-bid-create/v1/linked";
const DEAL = "00000000-0000-4000-8000-0000000000a1";
const BID = "00000000-0000-4000-8000-0000000000b1";
const KEY = "crm:rfp-vote:approved:round-7";
const CREATED_AT = "2026-11-10T12:00:01.000Z";
const ENV_KEYS = ["RFP_NONSERVICE_DESTINATION", "RFP_BID_CREATE_INGRESS_SECRET_CURRENT", "CORE_INGRESS_BASE_URL", "TROCK_CRM_BASE_URL", "RFP_REQUEST_SYNC_SECRET"];
const savedEnv: Record<string, string | undefined> = {};
const N1_KEYS = ["sourceSystem", "sourceDealId", "sourceEventId", "office", "kind", "reason", "coreBidId", "noticeId", "occurredAt"].sort();
const E4_BODY = {
  sourceSystem: "trock_crm", sourceDealId: DEAL, sourceEventId: KEY, approvalKind: "vote", office: "dallas", coreBidId: BID,
  coreCreatedAt: CREATED_AT, projectNumber: "DFW-2-12345-ab", warnings: ["owner_not_found"],
};

let pg: PGlite;
beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE bidboard_callback_outbox (
      id serial PRIMARY KEY, source_system text NOT NULL, source_deal_id text NOT NULL,
      rfp_approval_request_id integer NOT NULL, payload jsonb NOT NULL, target_url text NOT NULL,
      status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pg.exec(DDL_0023);
  await pg.exec(DDL_0027);
  dbHolder.db = drizzle(pg);
}, 30000);
afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await pg?.close?.();
});
beforeEach(async () => {
  await reset();
  process.env.RFP_NONSERVICE_DESTINATION = "core";
  process.env.RFP_BID_CREATE_INGRESS_SECRET_CURRENT = SECRET;
  process.env.CORE_INGRESS_BASE_URL = CORE_BASE;
  process.env.TROCK_CRM_BASE_URL = CRM_BASE;
  process.env.RFP_REQUEST_SYNC_SECRET = CRM_SECRET;
});
async function reset() {
  await pg.exec(`DELETE FROM rfp_core_followup_outbox; DELETE FROM rfp_core_create_outbox; DELETE FROM bidboard_create_outbox; DELETE FROM bidboard_callback_outbox;`);
  alertMock.mockReset();
  resetRfpCoreFollowupStateForTests();
}

const numberFor = (office: string) => (office === "atlanta" ? "ATL-2-12345-ab" : "DFW-2-12345-ab");
function e1(office = "dallas"): any {
  return {
    sourceSystem: "trock_crm", sourceDealId: DEAL, sourceEventId: KEY, decision: "approved", approvalKind: "vote", office,
    approval: { roundEventId: "round-7", approvals: 2, rejections: 0, invitedVoterCount: 3, decidedAt: "2026-11-01T15:00:00.000Z" },
    deal: {
      name: "Synthetic Tower Reroof", projectNumber: numberFor(office), projectType: "2", amount: 1000, estimator: "Pat Example",
      companyId: "00000000-0000-4000-8000-0000000000c1", companyName: "Synthetic Builders LLC", contactName: "Sam Synthetic",
      clientEmail: "sam@example.test", clientPhone: null, propertyId: null,
      address: { street: "1 Example St", city: "Dallas", state: "TX", zip: "75001", country: "US" },
      description: null, dueDate: null, workflowRoute: "normal",
    },
    attachments: [],
  };
}
/** A Core create Core answered (sent), with its pending E4: the state the E2 sender leaves. */
async function seedSent(office = "dallas"): Promise<{ createId: number; e4Id: number }> {
  await enqueueBidboardCreateCommand(e1(office));
  const c = (await pg.query<any>(
    `UPDATE rfp_core_create_outbox SET status = 'sent', e2_ever_sent = true, attempt_count = 1, core_bid_id = $1,
            core_created_at = $2::timestamptz, warnings = '["owner_not_found"]'::jsonb, sent_at = NOW()
      RETURNING id`, [BID, CREATED_AT])).rows[0];
  const f = (await pg.query<any>(
    `INSERT INTO rfp_core_followup_outbox (create_id, kind, payload) VALUES ($1, 'crm_link', $2::jsonb) RETURNING id`,
    [c.id, JSON.stringify({ ...E4_BODY, office, projectNumber: numberFor(office) })])).rows[0];
  return { createId: c.id, e4Id: f.id };
}
/** …and E4 linked: the pending E5. */
async function seedConfirm(crmResult = "linked"): Promise<{ createId: number; e5Id: number }> {
  const { createId, e4Id } = await seedSent();
  await pg.query(`UPDATE rfp_core_followup_outbox SET status = 'sent', result = 'linked', attempt_count = 1 WHERE id = $1`, [e4Id]);
  const f = (await pg.query<any>(
    `INSERT INTO rfp_core_followup_outbox (create_id, kind, payload) VALUES ($1, 'core_confirm', $2::jsonb) RETURNING id`,
    [createId, JSON.stringify({ sourceEventId: KEY, crmDealId: DEAL, coreBidId: BID, crmResult })])).rows[0];
  return { createId, e5Id: f.id };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Handler = (body: any) => Response | Promise<Response>;
function router(h: { e4?: Handler; e5?: Handler; n1?: Handler } = {}) {
  return vi.fn(async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    if (url === E4_URL) return h.e4 ? h.e4(body) : json(200, { result: "linked", linked: true, claimed: true });
    if (url === E5_URL || url === E5_ATL_URL) return h.e5 ? h.e5(body) : json(200, { confirmed: true });
    if (url === N1_URL) return h.n1 ? h.n1(body) : json(200, { result: "recorded" });
    throw new Error(`unexpected URL ${url}`);
  });
}
const callsTo = (f: ReturnType<typeof router>, url: string) => f.mock.calls.filter((c) => c[0] === url);
const rows = async () =>
  (await pg.query<any>(`SELECT *, EXTRACT(EPOCH FROM (next_attempt_at - last_attempt_at))::int AS delay_s FROM rfp_core_followup_outbox ORDER BY id`)).rows;
const byKind = async (kind: string, noticeKind = "") => (await rows()).filter((r) => r.kind === kind && r.notice_kind === noticeKind);
const alertCodes = () => alertMock.mock.calls.map((c) => c[0]);
const f1Errors = async () =>
  (await pg.query<any>(`SELECT payload FROM bidboard_callback_outbox WHERE payload->>'status' = 'failed' ORDER BY id`)).rows.map((r) => r.payload.error);
const makeDue = () => pg.exec(`UPDATE rfp_core_followup_outbox SET next_attempt_at = NOW() - interval '1 second' WHERE status = 'pending'`);
const crmSig = (raw: string) => `sha256=${crypto.createHmac("sha256", CRM_SECRET).update(raw).digest("hex")}`;
function framed(domain: string, path: string, body: string, key: string): string {
  const NUL = Buffer.from([0]);
  const pre = Buffer.concat([Buffer.from(domain), NUL, Buffer.from("POST"), NUL, Buffer.from(path), NUL, Buffer.from(body)]);
  return `sha256=${crypto.createHmac("sha256", key).update(pre).digest("hex")}`;
}

describe("E4 → E5 sequencing (§6 / §7)", () => {
  it("E4 is POSTed to the CRM's core-bid-created with bid-board-created's HMAC over the raw body, redirect 'error', the stored strict body", async () => {
    await seedSent();
    const fetchImpl = router();
    await processRfpCoreFollowupOutbox({ fetchImpl });
    expect(callsTo(fetchImpl, E4_URL)).toHaveLength(1);
    const init = callsTo(fetchImpl, E4_URL)[0]![1];
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("x-rfp-request-signature")).toBe(crmSig(init.body));
    expect(JSON.parse(init.body)).toEqual(E4_BODY);
  });
  it("E4 linked ⇒ done (sent, result linked) and ONE E5 core_confirm; E5 goes only after E4 answered, signed with the -linked domain", async () => {
    const { createId } = await seedSent();
    expect(await byKind("core_confirm")).toEqual([]);
    const fetchImpl = router();
    await processRfpCoreFollowupOutbox({ fetchImpl });
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([E4_URL, E5_URL]);
    expect((await byKind("crm_link"))[0]).toMatchObject({ status: "sent", result: "linked", last_status_code: 200 });
    const e5 = await byKind("core_confirm");
    expect(e5).toHaveLength(1);
    expect(e5[0]).toMatchObject({ create_id: createId, status: "sent", result: "confirmed" });
    const init = callsTo(fetchImpl, E5_URL)[0]![1];
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body)).toEqual({
      version: "trock.crm.rfp-bid-create-linked.v1", occurredAt: expect.any(String), sourceEventId: KEY, crmDealId: DEAL, coreBidId: BID, crmResult: "linked",
    });
    expect(new Headers(init.headers).get("x-trock-signature")).toBe(framed("trock.crm.rfp-bid-create-linked.v1", E5_PATH, init.body, SECRET));
    expect(await byKind("crm_notice", "core_link_confirmed")).toEqual([]);
  });
  it("E4 {result:'linked'} with NO extras (an old CRM) ⇒ done + E5 enqueued", async () => {
    await seedSent();
    const fetchImpl = router({ e4: () => json(200, { result: "linked" }), e5: () => json(503, {}) });
    await processRfpCoreFollowupOutbox({ fetchImpl });
    expect((await byKind("crm_link"))[0]).toMatchObject({ status: "sent", result: "linked" });
    expect((await byKind("core_confirm")).map((r) => r.payload.crmResult)).toEqual(["linked"]);
  });
  it("E4 {result:'linked', linked:true, claimed:false} (link-only) ⇒ done + E5 enqueued, distinct from stale and from a 409", async () => {
    const outcomes: Record<string, { e4: string; e5: number; notices: string[] }> = {};
    const answers: Array<[string, Handler]> = [
      ["link-only", () => json(200, { result: "linked", linked: true, claimed: false })],
      ["stale", () => json(200, { result: "stale" })],
      ["409", () => json(409, { error: "deal_claimed_by_other_bid" })],
    ];
    for (const [label, e4] of answers) {
      await reset();
      await seedSent();
      await processRfpCoreFollowupOutbox({ fetchImpl: router({ e4 }) });
      outcomes[label] = {
        e4: (await byKind("crm_link"))[0].status,
        e5: (await byKind("core_confirm")).length,
        notices: (await rows()).filter((r) => r.kind === "crm_notice").map((r) => r.notice_kind),
      };
    }
    expect(outcomes).toEqual({
      "link-only": { e4: "sent", e5: 1, notices: [] },
      stale: { e4: "orphan_stale", e5: 0, notices: ["core_bid_orphan"] },
      "409": { e4: "link_refused", e5: 0, notices: ["core_bid_link_refused"] },
    });
    // the link-only answer is recorded as such on the row
    await reset();
    await seedSent();
    await processRfpCoreFollowupOutbox({ fetchImpl: router({ e4: () => json(200, { result: "linked", linked: true, claimed: false }) }) });
    expect((await byKind("crm_link"))[0].result).toBe("link_only");
  });
  it("E4 replay ⇒ done + E5 with crmResult replay", async () => {
    await seedSent();
    const fetchImpl = router({ e4: () => json(200, { result: "replay", linked: true, claimed: true }) });
    await processRfpCoreFollowupOutbox({ fetchImpl });
    expect((await byKind("crm_link"))[0]).toMatchObject({ status: "sent", result: "replay" });
    expect(callsTo(fetchImpl, E5_URL)).toHaveLength(1);
    expect(JSON.parse(callsTo(fetchImpl, E5_URL)[0]![1].body).crmResult).toBe("replay");
  });
  it("an unknown E4 result ⇒ retried with an alert (never linked, never stale), no E5", async () => {
    await seedSent();
    await processRfpCoreFollowupOutbox({ fetchImpl: router({ e4: () => json(200, { result: "claimed_elsewhere" }) }) });
    expect((await byKind("crm_link"))[0]).toMatchObject({ status: "pending", attempt_count: 1, delay_s: 30 });
    expect(alertCodes()).toContain("crm_link_retry");
    expect(await byKind("core_confirm")).toEqual([]);
  });
});

describe("E4 failures (§10 E4 results)", () => {
  it("stale ⇒ orphan_stale + alert core_bid_orphan + N1 core_bid_orphan (reason stale); no E5", async () => {
    await seedSent();
    const fetchImpl = router({ e4: () => json(200, { result: "stale" }) });
    await processRfpCoreFollowupOutbox({ fetchImpl });
    expect((await byKind("crm_link"))[0]).toMatchObject({ status: "orphan_stale", result: "stale" });
    expect(alertCodes()).toContain("core_bid_orphan");
    expect(callsTo(fetchImpl, N1_URL)).toHaveLength(1);
    expect(JSON.parse(callsTo(fetchImpl, N1_URL)[0]![1].body)).toMatchObject({ kind: "core_bid_orphan", reason: "stale", coreBidId: BID });
    expect(await byKind("core_confirm")).toEqual([]);
    expect(callsTo(fetchImpl, E5_URL)).toHaveLength(0);
  });
  it("409 ⇒ link_refused + alert + N1 core_bid_link_refused carrying the 409 code; NEVER auto-retried", async () => {
    await seedSent();
    const fetchImpl = router({ e4: () => json(409, { error: "deal_on_procore" }) });
    await processRfpCoreFollowupOutbox({ fetchImpl });
    expect((await byKind("crm_link"))[0]).toMatchObject({ status: "link_refused", result: "deal_on_procore", last_status_code: 409 });
    expect(alertCodes()).toContain("core_bid_link_refused");
    expect(JSON.parse(callsTo(fetchImpl, N1_URL)[0]![1].body)).toMatchObject({ kind: "core_bid_link_refused", reason: "deal_on_procore" });
    await makeDue();
    await processRfpCoreFollowupOutbox({ fetchImpl });
    expect(callsTo(fetchImpl, E4_URL)).toHaveLength(1);
    expect((await byKind("crm_link"))[0].status).toBe("link_refused");
  });
  it("503 / 5xx / transport ⇒ retried on 30 s / 2 m / 10 m / 30 m / 2 h with an alert; the 6th failure ⇒ dead + alert + F1; no E5", async () => {
    await seedSent();
    let n = 0;
    const fetchImpl = router({
      e4: () => {
        n += 1;
        if (n === 2) throw new TypeError("fetch failed");
        return json(n === 3 ? 500 : 503, { error: "core_bid_link_disabled" });
      },
    });
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 6; attempt++) {
      await makeDue();
      await processRfpCoreFollowupOutbox({ fetchImpl });
      const [e4] = await byKind("crm_link");
      expect(e4.attempt_count, `attempt ${attempt}`).toBe(attempt);
      if (attempt < 6) {
        expect(e4.status, `attempt ${attempt}`).toBe("pending");
        delays.push(e4.delay_s);
      }
    }
    expect(delays).toEqual([30, 120, 600, 1800, 7200]);
    expect(alertCodes().filter((c) => c === "crm_link_retry")).toHaveLength(5);
    expect((await byKind("crm_link"))[0].status).toBe("dead");
    expect(alertCodes()).toContain("crm_link_dead");
    expect(await f1Errors()).toEqual(["crm_link_dead"]);
    expect(await byKind("core_confirm")).toEqual([]);
  });
  it("400 / 401 / 404 / 422 ⇒ failed + alert, not retried", async () => {
    for (const status of [400, 401, 404, 422]) {
      await reset();
      await seedSent();
      const fetchImpl = router({ e4: () => json(status, { error: "invalid_payload" }) });
      await processRfpCoreFollowupOutbox({ fetchImpl });
      expect((await byKind("crm_link"))[0], String(status)).toMatchObject({ status: "failed", last_status_code: status });
      expect(alertCodes(), String(status)).toContain("crm_request_rejected");
      await makeDue();
      await processRfpCoreFollowupOutbox({ fetchImpl });
      expect(callsTo(fetchImpl, E4_URL), String(status)).toHaveLength(1);
    }
  });
});

describe("E5 never dead-letters (§7, b8 M3)", () => {
  it("(ruling 6) after attempt 6 E5 stays pending, never dead: the next attempt is in 2 h (and again after 7), and the stale alert core_confirm_delayed fires", async () => {
    const { e5Id } = await seedConfirm();
    await pg.query(`UPDATE rfp_core_followup_outbox SET attempt_count = 5 WHERE id = $1`, [e5Id]);
    const fetchImpl = router({ e5: () => json(503, {}) });
    await processRfpCoreFollowupOutbox({ fetchImpl });
    expect((await rows()).find((r) => r.id === e5Id)).toMatchObject({ status: "pending", attempt_count: 6, delay_s: 7200 });
    expect(alertCodes()).toContain("core_confirm_delayed");
    await makeDue();
    await processRfpCoreFollowupOutbox({ fetchImpl });
    expect((await rows()).find((r) => r.id === e5Id)).toMatchObject({ status: "pending", attempt_count: 7, delay_s: 7200 });
    expect((await rows()).filter((r) => r.status === "dead")).toEqual([]);
  });
  it("the 6-step schedule, then every 2 h; at the 6th failure ONE ops alert + ONE N1 core_link_confirm_pending; then a daily alert; never dead", async () => {
    const { e5Id } = await seedConfirm();
    const fetchImpl = router({ e5: () => json(503, {}) });
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 7; attempt++) {
      await makeDue();
      await processRfpCoreFollowupOutbox({ fetchImpl });
      const e5 = (await rows()).find((r) => r.id === e5Id);
      expect(e5, `attempt ${attempt}`).toMatchObject({ status: "pending", attempt_count: attempt });
      delays.push(e5.delay_s);
    }
    expect(delays).toEqual([30, 120, 600, 1800, 7200, 7200, 7200]);
    expect(alertCodes().filter((c) => c === "core_confirm_retry")).toHaveLength(5);
    expect(alertCodes().filter((c) => c === "core_confirm_delayed")).toHaveLength(1);
    expect(await byKind("crm_notice", "core_link_confirm_pending")).toHaveLength(1);
    expect(callsTo(fetchImpl, N1_URL).map((c) => JSON.parse(c[1].body).kind)).toEqual(["core_link_confirm_pending"]);
    // a day of 2-hourly retries later (attempt 18): the daily alert; still ONE pending notice, still pending, never dead
    await pg.query(`UPDATE rfp_core_followup_outbox SET attempt_count = 16 WHERE id = $1`, [e5Id]);
    for (const attempt of [17, 18]) {
      await makeDue();
      await processRfpCoreFollowupOutbox({ fetchImpl });
      expect((await rows()).find((r) => r.id === e5Id), `attempt ${attempt}`).toMatchObject({ status: "pending", attempt_count: attempt, delay_s: 7200 });
    }
    expect(alertCodes().filter((c) => c === "core_confirm_delayed")).toHaveLength(2);
    expect(await byKind("crm_notice", "core_link_confirm_pending")).toHaveLength(1);
    expect((await rows()).filter((r) => r.status === "dead")).toEqual([]);
  });
  it("success after the pending notice ⇒ sent + N1 core_link_confirmed (the CLEAR); success without one ⇒ no N1", async () => {
    const { e5Id } = await seedConfirm();
    await pg.query(`UPDATE rfp_core_followup_outbox SET attempt_count = 5 WHERE id = $1`, [e5Id]);
    let up = false;
    const fetchImpl = router({ e5: () => (up ? json(200, { confirmed: true }) : json(503, {})) });
    await makeDue();
    await processRfpCoreFollowupOutbox({ fetchImpl });
    expect(await byKind("crm_notice", "core_link_confirm_pending")).toHaveLength(1);
    up = true;
    await makeDue();
    await processRfpCoreFollowupOutbox({ fetchImpl });
    expect((await rows()).find((r) => r.id === e5Id)).toMatchObject({ status: "sent", result: "confirmed" });
    expect(await byKind("crm_notice", "core_link_confirmed")).toHaveLength(1);
    expect(callsTo(fetchImpl, N1_URL).map((c) => JSON.parse(c[1].body).kind)).toEqual(["core_link_confirm_pending", "core_link_confirmed"]);

    await reset();
    await seedConfirm();
    const quiet = router();
    await processRfpCoreFollowupOutbox({ fetchImpl: quiet });
    expect((await byKind("core_confirm"))[0].status).toBe("sent");
    expect(callsTo(quiet, N1_URL)).toHaveLength(0);
    expect((await rows()).filter((r) => r.kind === "crm_notice")).toEqual([]);
  });
});

describe("N1 notices (§10 wire shape)", () => {
  it("each kind is POSTed to /api/internal/rfp-core-notice with the strict 9 keys, the internal HMAC and the reason rules", async () => {
    const seen: Array<{ raw: string; sig: string | null; rowId: number }> = [];
    const capture = (fetchImpl: ReturnType<typeof router>) => async () => {
      for (const c of callsTo(fetchImpl, N1_URL)) {
        const b = JSON.parse(c[1].body);
        const row = (await byKind("crm_notice", b.kind))[0];
        seen.push({ raw: c[1].body, sig: new Headers(c[1].headers).get("x-rfp-request-signature"), rowId: row?.id });
      }
    };
    const stale = router({ e4: () => json(200, { result: "stale" }) });
    await seedSent();
    await processRfpCoreFollowupOutbox({ fetchImpl: stale });
    await capture(stale)();
    await reset();
    const refused = router({ e4: () => json(409, { error: "approval_kind_mismatch" }) });
    await seedSent();
    await processRfpCoreFollowupOutbox({ fetchImpl: refused });
    await capture(refused)();
    await reset();
    const { e5Id } = await seedConfirm();
    await pg.query(`UPDATE rfp_core_followup_outbox SET attempt_count = 5 WHERE id = $1`, [e5Id]);
    let up = false;
    const confirm = router({ e5: () => (up ? json(200, { confirmed: true }) : json(503, {})) });
    await processRfpCoreFollowupOutbox({ fetchImpl: confirm });
    up = true;
    await makeDue();
    await processRfpCoreFollowupOutbox({ fetchImpl: confirm });
    await capture(confirm)();

    expect(seen.map((s) => JSON.parse(s.raw).kind)).toEqual(["core_bid_orphan", "core_bid_link_refused", "core_link_confirm_pending", "core_link_confirmed"]);
    const reasons = seen.map((s) => JSON.parse(s.raw).reason);
    expect(reasons).toEqual(["stale", "approval_kind_mismatch", null, null]);
    for (const s of seen) {
      const b = JSON.parse(s.raw);
      expect(Object.keys(b).sort(), b.kind).toEqual(N1_KEYS);
      expect(b, b.kind).toMatchObject({ sourceSystem: "trock_crm", sourceDealId: DEAL, sourceEventId: KEY, office: "dallas", coreBidId: BID });
      expect(Number.isFinite(Date.parse(b.occurredAt)), b.kind).toBe(true);
      expect(b.noticeId, b.kind).toBe(`rfp-core-notice:rfp_core_followup_outbox:${s.rowId}:${b.kind}`);
      expect(s.sig, b.kind).toBe(crmSig(s.raw));
    }
  });
  it("the noticeId is built once, stored, and every redelivery is byte-identical (503 then 200)", async () => {
    await seedSent();
    let n = 0;
    const fetchImpl = router({ e4: () => json(200, { result: "stale" }), n1: () => (++n === 1 ? json(503, {}) : json(200, { result: "recorded" })) });
    await processRfpCoreFollowupOutbox({ fetchImpl });
    expect(await byKind("crm_notice", "core_bid_orphan")).toMatchObject([{ status: "pending", attempt_count: 1 }]);
    await makeDue();
    await processRfpCoreFollowupOutbox({ fetchImpl });
    const raws = callsTo(fetchImpl, N1_URL).map((c) => c[1].body);
    expect(raws).toHaveLength(2);
    expect(raws[1]).toBe(raws[0]);
    const [after] = await byKind("crm_notice", "core_bid_orphan");
    expect(after.status).toBe("sent");
    expect(after.notice_id).toBe(`rfp-core-notice:rfp_core_followup_outbox:${after.id}:core_bid_orphan`);
    expect(JSON.parse(raws[0]).noticeId).toBe(after.notice_id);
    expect(after.payload.noticeId).toBe(after.notice_id);
  });
  it("an N1 dead after the schedule ⇒ alert only (no F1)", async () => {
    await seedSent();
    const fetchImpl = router({ e4: () => json(200, { result: "stale" }), n1: () => json(503, {}) });
    for (let i = 0; i < 6; i++) {
      await makeDue();
      await processRfpCoreFollowupOutbox({ fetchImpl });
    }
    expect(await byKind("crm_notice", "core_bid_orphan")).toMatchObject([{ status: "dead", attempt_count: 6 }]);
    expect(alertCodes()).toContain("crm_notice_dead");
    expect(await f1Errors()).toEqual([]);
  });
});

describe("office, carried end to end (d9 ruling 5, r2)", () => {
  it("an atlanta create: E4 carries office atlanta, E5 goes to Core's atlanta …/linked path signed over it, N1 carries atlanta", async () => {
    await seedSent("atlanta");
    const fetchImpl = router();
    await processRfpCoreFollowupOutbox({ fetchImpl });
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([E4_URL, E5_ATL_URL]);
    expect(JSON.parse(callsTo(fetchImpl, E4_URL)[0]![1].body)).toMatchObject({ office: "atlanta", projectNumber: "ATL-2-12345-ab" });
    const init = callsTo(fetchImpl, E5_ATL_URL)[0]![1];
    expect(new Headers(init.headers).get("x-trock-signature")).toBe(framed("trock.crm.rfp-bid-create-linked.v1", E5_ATL_PATH, init.body, SECRET));
    await reset();
    const stale = router({ e4: () => json(200, { result: "stale" }) });
    await seedSent("atlanta");
    await processRfpCoreFollowupOutbox({ fetchImpl: stale });
    expect(callsTo(stale, N1_URL)).toHaveLength(1);
    expect(JSON.parse(callsTo(stale, N1_URL)[0]![1].body)).toMatchObject({ kind: "core_bid_orphan", office: "atlanta" });
  });
});

describe("§12 drains by data, not by the setting (d9 ruling, r2); unconfigured", () => {
  it("(a) setting unset or procore and NO follow-up rows ⇒ no fetch, no alert; the drain still looks for due rows (no setting gate)", async () => {
    const fetchImpl = router();
    for (const setting of [undefined, "procore"]) {
      if (setting === undefined) delete process.env.RFP_NONSERVICE_DESTINATION;
      else process.env.RFP_NONSERVICE_DESTINATION = setting;
      const gets = dbHolder.gets;
      await processRfpCoreFollowupOutbox({ fetchImpl });
      expect(fetchImpl, String(setting)).not.toHaveBeenCalled();
      expect(alertCodes(), String(setting)).toEqual([]);
      expect(dbHolder.gets, `${setting}: not gated on the setting, the drain reads the outbox`).toBeGreaterThan(gets);
    }
  });
  it("(b) the rollback: setting procore (or unset) + a due E4 ⇒ it drains, and the E5 it enqueues drains too", async () => {
    for (const setting of ["procore", undefined]) {
      await reset();
      await seedSent();
      if (setting === undefined) delete process.env.RFP_NONSERVICE_DESTINATION;
      else process.env.RFP_NONSERVICE_DESTINATION = setting;
      const fetchImpl = router();
      await processRfpCoreFollowupOutbox({ fetchImpl });
      expect(fetchImpl.mock.calls.map((c) => c[0]), String(setting)).toEqual([E4_URL, E5_URL]);
      expect(await byKind("crm_link"), String(setting)).toMatchObject([{ status: "sent", result: "linked" }]);
      expect(await byKind("core_confirm"), String(setting)).toMatchObject([{ status: "sent", result: "confirmed" }]);
      process.env.RFP_NONSERVICE_DESTINATION = "core";
    }
  });
  it("(c) the 0027 tables absent with the setting unset or procore ⇒ a SILENT no-op; the same with setting core ⇒ the HOLD alert", async () => {
    const bare = new PGlite();
    try {
      await bare.exec(`
        CREATE TABLE bidboard_callback_outbox (
          id serial PRIMARY KEY, source_system text NOT NULL, source_deal_id text NOT NULL,
          rfp_approval_request_id integer NOT NULL, payload jsonb NOT NULL, target_url text NOT NULL,
          status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now()
        );
      `);
      await bare.exec(DDL_0023);
      dbHolder.db = drizzle(bare);
      const fetchImpl = router();
      for (const setting of [undefined, "procore"]) {
        if (setting === undefined) delete process.env.RFP_NONSERVICE_DESTINATION;
        else process.env.RFP_NONSERVICE_DESTINATION = setting;
        await processRfpCoreFollowupOutbox({ fetchImpl });
        await processRfpCoreFollowupOutbox({ fetchImpl });
      }
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(alertCodes()).toEqual([]);
      process.env.RFP_NONSERVICE_DESTINATION = "core";
      await processRfpCoreFollowupOutbox({ fetchImpl });
      expect(alertCodes()).toEqual(["core_tables_missing"]);
    } finally {
      dbHolder.db = drizzle(pg);
      await bare.close();
    }
  });
  it("(d) unconfigured (CRM secret unset): no due follow-up ⇒ NO alert (one not yet due included); a due one ⇒ ONE alert, unchanged", async () => {
    delete process.env.RFP_REQUEST_SYNC_SECRET;
    delete process.env.RFP_NONSERVICE_DESTINATION; // an un-activated deploy
    const fetchImpl = router();
    await processRfpCoreFollowupOutbox({ fetchImpl });
    await processRfpCoreFollowupOutbox({ fetchImpl });
    expect(alertCodes(), "no rows").toEqual([]);
    process.env.RFP_NONSERVICE_DESTINATION = "core";
    await seedSent();
    delete process.env.RFP_NONSERVICE_DESTINATION;
    await pg.exec(`UPDATE rfp_core_followup_outbox SET next_attempt_at = NOW() + interval '1 hour'`);
    await processRfpCoreFollowupOutbox({ fetchImpl });
    expect(alertCodes(), "a follow-up not yet due").toEqual([]);
    await makeDue();
    await processRfpCoreFollowupOutbox({ fetchImpl });
    await processRfpCoreFollowupOutbox({ fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(alertCodes(), "a due follow-up").toEqual(["rfp_core_unconfigured"]);
    expect(await byKind("crm_link")).toMatchObject([{ status: "pending", attempt_count: 0 }]);
  });
  it("a missing CRM secret or base URL holds E4 / N1, a missing Core secret holds E5: rows stay pending, ONE alert", async () => {
    const cases: Array<[string, () => void, () => Promise<unknown>, string]> = [
      ["CRM secret unset", () => { delete process.env.RFP_REQUEST_SYNC_SECRET; }, () => seedSent(), "crm_link"],
      ["CRM base unset", () => { delete process.env.TROCK_CRM_BASE_URL; }, () => seedSent(), "crm_link"],
      ["Core secret short", () => { process.env.RFP_BID_CREATE_INGRESS_SECRET_CURRENT = "s".repeat(31); }, () => seedConfirm(), "core_confirm"],
      ["Core base unset", () => { delete process.env.CORE_INGRESS_BASE_URL; }, () => seedConfirm(), "core_confirm"],
    ];
    for (const [label, apply, seed, kind] of cases) {
      await reset();
      process.env.RFP_REQUEST_SYNC_SECRET = CRM_SECRET;
      process.env.TROCK_CRM_BASE_URL = CRM_BASE;
      process.env.RFP_BID_CREATE_INGRESS_SECRET_CURRENT = SECRET;
      process.env.CORE_INGRESS_BASE_URL = CORE_BASE;
      await seed();
      apply();
      const fetchImpl = router();
      await processRfpCoreFollowupOutbox({ fetchImpl });
      await processRfpCoreFollowupOutbox({ fetchImpl });
      expect(fetchImpl, label).not.toHaveBeenCalled();
      expect((await byKind(kind))[0], label).toMatchObject({ status: "pending", attempt_count: 0 });
      expect(alertCodes(), label).toEqual(["rfp_core_unconfigured"]);
    }
  });
});
