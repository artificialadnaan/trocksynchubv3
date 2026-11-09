import { readFileSync } from "fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// d9 implementation rulings on CONTRACT v2.2 §2 / §11 (no wire change), pinned at GREEN on the REAL enqueue SQL (PGlite + the
// real migration files). Synthetic data only (I7).
//   Q1: 'done' and 'superseded' are SETTLED, never held by a flip: a re-post takes today's path (done ⇒ callback recovery,
//       superseded ⇒ no-op), with no F1 and no hold alert.
//   Q2: no invented Core-row status: a second core round while the older Core row is pending / sending is refused by the
//       per-deal partial unique index (rollback ⇒ 500 ⇒ the CRM retries): one live Core row, no Procore create.
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
vi.mock("../server/sync/bidboard-callback-worker.ts", () => ({
  buildBidBoardCreatedCallbackTargetUrl: () => "https://crm.example.test/api/internal/bid-board-created",
}));
vi.mock("../server/storage.ts", () => ({ storage: { getAutomationConfig: vi.fn(async () => ({ value: { companyId: "42" } })) } }));
vi.mock("../server/sync/rfp-core-alert.ts", () => ({ raiseRfpCoreAlert: alertMock }));

const { enqueueBidboardCreateCommand } = await import("../server/sync/bidboard-create-worker.ts");

const DDL_0023 = readFileSync(new URL("../migrations/0023_create_bidboard_create_outbox.sql", import.meta.url), "utf8");
const DDL_0027 = readFileSync(new URL("../migrations/0027_rfp_core_routing.sql", import.meta.url), "utf8");

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE bidboard_callback_outbox (
      id serial PRIMARY KEY, source_system text NOT NULL, source_deal_id text NOT NULL,
      rfp_approval_request_id integer NOT NULL, payload jsonb NOT NULL, target_url text NOT NULL,
      status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pg.exec(DDL_0023); // also drops NOT NULL on bidboard_callback_outbox.rfp_approval_request_id
  await pg.exec(DDL_0027);
  dbHolder.db = drizzle(pg);
}, 30000);
afterAll(async () => { await pg?.close?.(); });
beforeEach(async () => {
  await pg.exec(`DELETE FROM rfp_core_followup_outbox; DELETE FROM rfp_core_create_outbox; DELETE FROM bidboard_create_outbox; DELETE FROM bidboard_callback_outbox;`);
  alertMock.mockReset();
  delete process.env.RFP_NONSERVICE_DESTINATION;
});

const DEAL = "00000000-0000-4000-8000-0000000000d2";
const KEY = "crm:rfp-vote:approved:round-1";
const KEY2 = "crm:rfp-vote:approved:round-2";
function e1(o: Record<string, any> = {}) {
  return {
    sourceSystem: "trock_crm", sourceDealId: DEAL, sourceEventId: KEY, decision: "approved",
    approvalKind: "vote", office: "dallas",
    approval: { roundEventId: "round-1", approvals: 2, rejections: 0, invitedVoterCount: 3, decidedAt: "2026-11-01T15:00:00.000Z" },
    deal: {
      name: "Synthetic Deal", projectNumber: "DFW-2-12345-ab", projectType: "2", amount: 1000, estimator: "Pat Example",
      companyId: "00000000-0000-4000-8000-0000000000c1", companyName: "Synthetic Co", contactName: "Sam Synthetic",
      clientEmail: "sam@example.test", clientPhone: null, propertyId: null,
      address: { street: "1 Example St", city: "Dallas", state: "TX", zip: "75001", country: "US" },
      description: null, dueDate: null, workflowRoute: "normal",
    },
    attachments: [],
    ...o,
  } as any;
}
const cmd = async (key = KEY) => (await pg.query<any>(`SELECT * FROM bidboard_create_outbox WHERE source_event_id = $1`, [key])).rows[0];
const coreRows = async () => (await pg.query<any>(`SELECT * FROM rfp_core_create_outbox ORDER BY id`)).rows;
const callbacks = async () => (await pg.query<any>(`SELECT payload, status FROM bidboard_callback_outbox ORDER BY id`)).rows;
const alertCodes = () => alertMock.mock.calls.map((c) => c[0]);
function messageChain(err: unknown): string {
  const out: string[] = [];
  for (let e: any = err, i = 0; e && i < 5; e = e.cause, i++) out.push(String(e.message ?? e));
  return out.join(" | ");
}

describe("Q1: done / superseded are settled, never held by a flip (§11)", () => {
  it("done with a live created callback, re-posted after the flip ⇒ unchanged: done, procore, no F1, no alert", async () => {
    await enqueueBidboardCreateCommand(e1());
    await pg.exec(`UPDATE bidboard_create_outbox SET status = 'done'`);
    await pg.query(
      `INSERT INTO bidboard_callback_outbox (source_system, source_deal_id, rfp_approval_request_id, payload, target_url, status)
       VALUES ('trock_crm', $1, NULL, '{"status":"created"}'::jsonb, 'https://crm.example.test/x', 'sent')`,
      [DEAL],
    );
    process.env.RFP_NONSERVICE_DESTINATION = "core";
    await enqueueBidboardCreateCommand(e1());
    expect((await cmd()).status).toBe("done");
    expect((await cmd()).destination).toBe("procore");
    expect(await callbacks()).toEqual([{ payload: { status: "created" }, status: "sent" }]);
    expect(alertCodes()).toEqual([]);
    expect(await coreRows()).toHaveLength(0);
  });
  it("done whose created callback was lost, re-posted after the flip ⇒ today's callback recovery on its procore stamp, no F1", async () => {
    await enqueueBidboardCreateCommand(e1());
    await pg.exec(`UPDATE bidboard_create_outbox SET status = 'done'`);
    process.env.RFP_NONSERVICE_DESTINATION = "core";
    await enqueueBidboardCreateCommand(e1());
    expect((await cmd()).status).toBe("pending");
    expect((await cmd()).destination).toBe("procore");
    expect(await callbacks()).toEqual([]);
    expect(alertCodes()).toEqual([]);
    expect(await coreRows()).toHaveLength(0);
  });
  it("superseded, re-posted after the flip ⇒ no-op: stays superseded, no F1, no alert", async () => {
    await enqueueBidboardCreateCommand(e1());
    await pg.exec(`UPDATE bidboard_create_outbox SET status = 'superseded'`);
    process.env.RFP_NONSERVICE_DESTINATION = "core";
    await enqueueBidboardCreateCommand(e1());
    expect((await cmd()).status).toBe("superseded");
    expect((await cmd()).destination).toBe("procore");
    expect(await callbacks()).toEqual([]);
    expect(alertCodes()).toEqual([]);
    expect(await coreRows()).toHaveLength(0);
  });
});

describe("Q2: a second core round while the older Core row is live is refused (no invented status)", () => {
  it("older Core row pending | sending ⇒ the new round rolls back: one live Core row, no new command row, no Procore create", async () => {
    for (const status of ["pending", "sending"]) {
      await pg.exec(`DELETE FROM rfp_core_followup_outbox; DELETE FROM rfp_core_create_outbox; DELETE FROM bidboard_create_outbox`);
      process.env.RFP_NONSERVICE_DESTINATION = "core";
      await enqueueBidboardCreateCommand(e1());
      await pg.exec(`UPDATE rfp_core_create_outbox SET status = '${status}'`);
      const err = await enqueueBidboardCreateCommand(
        e1({ sourceEventId: KEY2, approval: { ...e1().approval, roundEventId: "round-2" } }),
      ).then(() => null, (e: unknown) => e);
      expect(err, status).not.toBeNull();
      expect(messageChain(err), status).toMatch(/idx_rfp_core_create_outbox_live_deal|duplicate key/);
      const core = await coreRows();
      expect(core, status).toHaveLength(1);
      expect(core[0], status).toMatchObject({ source_event_id: KEY, status });
      expect(await cmd(KEY2), status).toBeUndefined();
      const procore = (await pg.query<any>(`SELECT id FROM bidboard_create_outbox WHERE destination = 'procore'`)).rows;
      expect(procore, status).toHaveLength(0);
    }
  });
});
