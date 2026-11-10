import { readFileSync } from "fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// S1a × S0 (CONTRACT v2.4 §2 RE-ARM rules + §10): the existing S0 re-arm paths (the CRM re-post of an existing key,
// enqueueBidboardCreateCommand) driving the new E2 sender and follow-up worker end to end, on the real migrations (PGlite):
//   - core, create not yet sent: refused (a Core 409 the rep fixed, or the company_missing pre-refusal) / dead ⇒ pending,
//     and the sender sends the CORRECTED stored payload; Core's replay keeps it to ONE bid;
//   - core, create already sent: E2 is NEVER re-sent; a dead E4 ⇒ pending (the rep's Retry) and links; a link_refused E4
//     is never re-armed;
//   - a held Core row stays held (a person resolves it).
// Every re-arm is VISIBLE (owner requirement): core_create_rearmed / core_followup_rearmed. Synthetic data only (I7).
const dbHolder = vi.hoisted(() => ({ db: null as any }));
const alertMock = vi.hoisted(() => vi.fn(async (_code: string, _detail: Record<string, unknown>) => {}));
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));
vi.mock("../server/db.ts", () => ({ get db() { return dbHolder.db; }, get pool() { return undefined; } }));
vi.mock("../server/playwright/bidboard.ts", () => ({ createBidBoardProjectFromDeal: vi.fn() }));
vi.mock("../server/rfp-approval.ts", () => ({
  checkRfpApprovalSourceEligibility: vi.fn(async () => ({ eligible: true })),
  buildSourceDealUrl: vi.fn(() => null),
  normalizedDealData: vi.fn(() => ({})),
}));
vi.mock("../server/storage.ts", () => ({ storage: { getAutomationConfig: vi.fn(async () => ({ value: { companyId: "42" } })) } }));
vi.mock("../server/sync/rfp-core-alert.ts", () => ({ raiseRfpCoreAlert: alertMock }));

const { enqueueBidboardCreateCommand } = await import("../server/sync/bidboard-create-worker.ts");
const { processRfpCoreCreateOutbox, resetRfpCoreSenderStateForTests } = await import("../server/sync/rfp-core-sender.ts");
const { processRfpCoreFollowupOutbox, resetRfpCoreFollowupStateForTests } = await import("../server/sync/rfp-core-followup.ts");

const DDL_0023 = readFileSync(new URL("../migrations/0023_create_bidboard_create_outbox.sql", import.meta.url), "utf8");
const DDL_0027 = readFileSync(new URL("../migrations/0027_rfp_core_routing.sql", import.meta.url), "utf8");

const CORE_BASE = "https://core.example.test";
const CRM_BASE = "https://crm.example.test";
const E2_URL = `${CORE_BASE}/webhooks/crm/dallas/rfp-bid-create/v1`;
const E4_URL = `${CRM_BASE}/api/internal/core-bid-created`;
const E5_URL = `${E2_URL}/linked`;
const DEAL = "00000000-0000-4000-8000-0000000000a1";
const COMPANY = "00000000-0000-4000-8000-0000000000c1";
const BID = "00000000-0000-4000-8000-0000000000b1";
const KEY = "crm:rfp-vote:approved:round-7";
const ENV_KEYS = ["RFP_NONSERVICE_DESTINATION", "RFP_BID_CREATE_INGRESS_SECRET_CURRENT", "CORE_INGRESS_BASE_URL", "TROCK_CRM_BASE_URL", "RFP_REQUEST_SYNC_SECRET"];
const savedEnv: Record<string, string | undefined> = {};

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
    CREATE TABLE sync_mappings (
      id serial PRIMARY KEY, source_system text NOT NULL DEFAULT 'hubspot', source_deal_id text NOT NULL, bidboard_project_id text
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
  await pg.exec(`DELETE FROM rfp_core_followup_outbox; DELETE FROM rfp_core_create_outbox; DELETE FROM bidboard_create_outbox;
                 DELETE FROM bidboard_callback_outbox; DELETE FROM sync_mappings;`);
  alertMock.mockReset();
  process.env.RFP_NONSERVICE_DESTINATION = "core";
  process.env.RFP_BID_CREATE_INGRESS_SECRET_CURRENT = "synthetic-rfp-bid-create-secret-0123456789";
  process.env.CORE_INGRESS_BASE_URL = CORE_BASE;
  process.env.TROCK_CRM_BASE_URL = CRM_BASE;
  process.env.RFP_REQUEST_SYNC_SECRET = "synthetic-crm-internal-secret";
  resetRfpCoreSenderStateForTests();
  resetRfpCoreFollowupStateForTests();
});

function e1(deal: Record<string, any> = {}): any {
  return {
    sourceSystem: "trock_crm", sourceDealId: DEAL, sourceEventId: KEY, decision: "approved", approvalKind: "vote", office: "dallas",
    approval: { roundEventId: "round-7", approvals: 2, rejections: 0, invitedVoterCount: 3, decidedAt: "2026-11-01T15:00:00.000Z" },
    deal: {
      name: "Synthetic Tower Reroof", projectNumber: "DFW-2-12345-ab", projectType: "2", amount: 1000, estimator: "Pat Example",
      companyId: COMPANY, companyName: "Synthetic Builders LLC", contactName: "Sam Synthetic",
      clientEmail: "sam@example.test", clientPhone: null, propertyId: null,
      address: { street: "1 Example St", city: "Dallas", state: "TX", zip: "75001", country: "US" },
      description: null, dueDate: null, workflowRoute: "normal",
      ...deal,
    },
    attachments: [],
  };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const receipt = (result: string) => ({
  version: "trock.crm.rfp-bid-create.v1", result, coreBidId: BID, boardStage: { code: "in-progress", status: "invited" },
  createdAt: "2026-11-10T12:00:01.000Z", warnings: [],
});
/** A fake Core + CRM: E2 creates ONE bid per sourceEventId (a re-delivery replays it); E4 / E5 answer per test. */
function world(o: { e2?: (n: number) => Response | "lose" | null; e4?: (n: number) => Response; e5?: () => Response } = {}) {
  const bids = new Map<string, string>();
  const e2Bodies: any[] = [];
  let e2n = 0;
  let e4n = 0;
  const fetchImpl = vi.fn(async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    if (url === E2_URL) {
      e2n += 1;
      e2Bodies.push(body);
      const forced = o.e2?.(e2n) ?? null;
      const existing = bids.get(body.sourceEventId);
      if (forced === "lose") {
        bids.set(body.sourceEventId, BID);
        throw new TypeError("fetch failed: the reply was lost after Core committed");
      }
      if (forced) return forced;
      if (existing) return json(200, receipt("replay"));
      bids.set(body.sourceEventId, BID);
      return json(201, receipt("created"));
    }
    if (url === E4_URL) {
      e4n += 1;
      return o.e4 ? o.e4(e4n) : json(200, { result: "linked", linked: true, claimed: true });
    }
    if (url === E5_URL) return o.e5 ? o.e5() : json(200, { confirmed: true });
    return json(200, { result: "recorded" });
  });
  return { fetchImpl, bids, e2Bodies, e2Calls: () => e2n, e4Calls: () => e4n };
}
const core = async () => (await pg.query<any>(`SELECT * FROM rfp_core_create_outbox ORDER BY id`)).rows;
const followup = async (kind: string) => (await pg.query<any>(`SELECT * FROM rfp_core_followup_outbox WHERE kind = $1 ORDER BY id`, [kind])).rows;
const alertCodes = () => alertMock.mock.calls.map((c) => c[0]);
const makeDue = () => pg.exec(`
  UPDATE rfp_core_create_outbox SET next_attempt_at = NOW() - interval '1 second' WHERE status = 'pending';
  UPDATE rfp_core_followup_outbox SET next_attempt_at = NOW() - interval '1 second' WHERE status = 'pending';
`);

describe("core create not yet sent: refused / dead ⇒ re-armed, and the sender sends the corrected payload", () => {
  it("a Core 409 the rep fixed: the re-post re-arms refused ⇒ pending (+ alert), and the next E2 carries the CORRECTED deal", async () => {
    await enqueueBidboardCreateCommand(e1());
    const w = world({ e2: (n) => (n === 1 ? json(409, { error: "rfp_bid_create_conflict", reason: "company_inactive" }) : null) });
    await processRfpCoreCreateOutbox({ fetchImpl: w.fetchImpl });
    expect((await core())[0]).toMatchObject({ status: "refused", refusal_reason: "company_inactive" });
    alertMock.mockClear();
    await enqueueBidboardCreateCommand(e1({ name: "Synthetic Tower Reroof (corrected)" }));
    expect((await core())[0]).toMatchObject({ status: "pending", attempt_count: 0, refusal_reason: null });
    expect(alertCodes()).toContain("core_create_rearmed");
    await processRfpCoreCreateOutbox({ fetchImpl: w.fetchImpl });
    expect(w.e2Calls()).toBe(2);
    expect(w.e2Bodies[1].deal.name).toBe("Synthetic Tower Reroof (corrected)");
    expect((await core())[0]).toMatchObject({ status: "sent", core_bid_id: BID });
    expect(await followup("crm_link")).toHaveLength(1);
  });
  it("the company_missing pre-refusal: a re-post WITH a company re-arms it and E2 is sent", async () => {
    await enqueueBidboardCreateCommand(e1({ companyId: null }));
    const w = world();
    await processRfpCoreCreateOutbox({ fetchImpl: w.fetchImpl });
    expect((await core())[0]).toMatchObject({ status: "refused", refusal_reason: "company_missing" });
    expect(w.e2Calls()).toBe(0);
    await enqueueBidboardCreateCommand(e1());
    expect((await core())[0].status).toBe("pending");
    expect(alertCodes()).toContain("core_create_rearmed");
    await processRfpCoreCreateOutbox({ fetchImpl: w.fetchImpl });
    expect(w.e2Calls()).toBe(1);
    expect(w.e2Bodies[0].company.id).toBe(COMPANY);
    expect((await core())[0].status).toBe("sent");
  });
  it("a dead E2 whose first attempt DID create the bid: the re-post re-arms it, Core replays, still ONE bid", async () => {
    await enqueueBidboardCreateCommand(e1());
    const w = world({ e2: (n) => (n === 1 ? "lose" : n <= 6 ? json(503, {}) : null) });
    for (let i = 0; i < 6; i++) {
      await makeDue();
      await processRfpCoreCreateOutbox({ fetchImpl: w.fetchImpl });
    }
    expect((await core())[0]).toMatchObject({ status: "dead", e2_ever_sent: true });
    await enqueueBidboardCreateCommand(e1());
    expect((await core())[0]).toMatchObject({ status: "pending", attempt_count: 0 });
    await processRfpCoreCreateOutbox({ fetchImpl: w.fetchImpl });
    expect((await core())[0]).toMatchObject({ status: "sent", core_bid_id: BID, last_status_code: 200 });
    expect(w.bids.size).toBe(1);
    expect(await followup("crm_link")).toHaveLength(1);
  });
});

describe("core create already sent: E2 is never re-sent", () => {
  it("a re-post after E2 sent re-sends nothing; a dead E4 is re-armed (+ alert), links, and E5 follows", async () => {
    await enqueueBidboardCreateCommand(e1());
    let crmUp = false;
    const w = world({ e4: () => (crmUp ? json(200, { result: "linked" }) : json(503, { error: "core_bid_link_disabled" })) });
    await processRfpCoreCreateOutbox({ fetchImpl: w.fetchImpl });
    expect((await core())[0].status).toBe("sent");
    for (let i = 0; i < 6; i++) {
      await makeDue();
      await processRfpCoreFollowupOutbox({ fetchImpl: w.fetchImpl });
    }
    expect(await followup("crm_link")).toMatchObject([{ status: "dead" }]);
    alertMock.mockClear();
    await enqueueBidboardCreateCommand(e1());
    expect(await followup("crm_link")).toMatchObject([{ status: "pending", attempt_count: 0 }]);
    expect(alertCodes()).toContain("core_followup_rearmed");
    crmUp = true;
    await processRfpCoreCreateOutbox({ fetchImpl: w.fetchImpl });
    await processRfpCoreFollowupOutbox({ fetchImpl: w.fetchImpl });
    expect(w.e2Calls()).toBe(1);
    expect(await followup("crm_link")).toMatchObject([{ status: "sent", result: "linked" }]);
    expect(await followup("core_confirm")).toMatchObject([{ status: "sent", result: "confirmed" }]);
  });
  it("a link_refused E4 is never re-armed by a re-post: no second E4, no re-arm alert", async () => {
    await enqueueBidboardCreateCommand(e1());
    const w = world({ e4: () => json(409, { error: "deal_claimed_by_other_bid" }) });
    await processRfpCoreCreateOutbox({ fetchImpl: w.fetchImpl });
    await processRfpCoreFollowupOutbox({ fetchImpl: w.fetchImpl });
    expect((await core())[0].status).toBe("sent");
    expect(await followup("crm_link")).toMatchObject([{ status: "link_refused" }]);
    alertMock.mockClear();
    await enqueueBidboardCreateCommand(e1());
    await makeDue();
    await processRfpCoreCreateOutbox({ fetchImpl: w.fetchImpl });
    await processRfpCoreFollowupOutbox({ fetchImpl: w.fetchImpl });
    expect(w.e2Calls()).toBe(1);
    expect(w.e4Calls()).toBe(1);
    expect(await followup("crm_link")).toMatchObject([{ status: "link_refused" }]);
    expect(alertCodes()).not.toContain("core_followup_rearmed");
  });
});

describe("held stays held", () => {
  it("a Core row the sender held (a Procore footprint appeared) is not re-armed by a re-post; nothing is sent", async () => {
    await enqueueBidboardCreateCommand(e1());
    await pg.query(`INSERT INTO sync_mappings (source_system, source_deal_id, bidboard_project_id) VALUES ('trock_crm', $1, '900010')`, [DEAL]);
    const w = world();
    await processRfpCoreCreateOutbox({ fetchImpl: w.fetchImpl });
    expect((await core())[0].status).toBe("held_cross_destination");
    await enqueueBidboardCreateCommand(e1());
    await makeDue();
    await processRfpCoreCreateOutbox({ fetchImpl: w.fetchImpl });
    expect((await core())[0].status).toBe("held_cross_destination");
    expect(w.e2Calls()).toBe(0);
  });
});
