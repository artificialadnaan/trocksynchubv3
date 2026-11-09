import { readFileSync } from "fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// CONTRACT v2.2 §2 (stamp, HELD, NULL adopt, kind conflict, RE-ARM) + §11 (in flight), on the REAL enqueue SQL against
// Postgres (PGlite) with the REAL migration files. Synthetic data only (I7).
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

const KEY = "crm:rfp-vote:approved:round-1";
function e1(o: Record<string, any> = {}) {
  return {
    sourceSystem: "trock_crm", sourceDealId: "00000000-0000-4000-8000-0000000000d1", sourceEventId: KEY, decision: "approved",
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
const cmd = async () => (await pg.query<any>(`SELECT * FROM bidboard_create_outbox WHERE source_event_id = $1`, [KEY])).rows[0];
const coreRows = async () => (await pg.query<any>(`SELECT * FROM rfp_core_create_outbox ORDER BY id`)).rows;
const f1Rows = async () => (await pg.query<any>(`SELECT payload FROM bidboard_callback_outbox ORDER BY id`)).rows.map((r) => r.payload);
const alertCodes = () => alertMock.mock.calls.map((c) => c[0]);

describe("the stamp (§2)", () => {
  it("setting unset: an eligible vote is stamped procore, kind and stamped_at recorded, NO Core row", async () => {
    await enqueueBidboardCreateCommand(e1());
    const row = await cmd();
    expect(row.destination).toBe("procore");
    expect(row.status).toBe("pending");
    expect(row.approval_kind).toBe("vote");
    expect(row.destination_setting).toBeNull();
    expect(row.stamped_at).not.toBeNull();
    expect(await coreRows()).toHaveLength(0);
  });
  it("setting core: an eligible vote is stamped core, status routed_core, and ONE pending Core row in the same transaction", async () => {
    process.env.RFP_NONSERVICE_DESTINATION = "core";
    await enqueueBidboardCreateCommand(e1());
    const row = await cmd();
    expect(row.destination).toBe("core");
    expect(row.status).toBe("routed_core");
    expect(row.destination_setting).toBe("core");
    expect(row.approval_kind).toBe("vote");
    const core = await coreRows();
    expect(core).toHaveLength(1);
    expect(core[0]).toMatchObject({ command_id: row.id, source_event_id: KEY, status: "pending" });
  });
  it("setting core: an override is stamped procore (ROUTE (c)), no Core row", async () => {
    process.env.RFP_NONSERVICE_DESTINATION = "core";
    await enqueueBidboardCreateCommand(e1({ approvalKind: "override", approval: undefined }));
    const row = await cmd();
    expect(row.destination).toBe("procore");
    expect(row.approval_kind).toBe("override");
    expect(row.status).toBe("pending");
    expect(await coreRows()).toHaveLength(0);
  });
});

describe("HELD = stamp ≠ ROUTE NOW (§2, b8 M4; §11)", () => {
  it("core stamp, re-posted after a rollback to procore ⇒ held_destination_changed + alert + F1; the Core row is untouched", async () => {
    process.env.RFP_NONSERVICE_DESTINATION = "core";
    await enqueueBidboardCreateCommand(e1());
    process.env.RFP_NONSERVICE_DESTINATION = "procore";
    await enqueueBidboardCreateCommand(e1());
    expect((await cmd()).status).toBe("held_destination_changed");
    expect((await cmd()).destination).toBe("core");
    expect(alertCodes()).toContain("destination_changed_hold");
    expect(await f1Rows()).toEqual([expect.objectContaining({ status: "failed", error: "destination_changed_hold" })]);
    expect((await coreRows())[0].status).toBe("pending");
  });
  it("procore stamp failed pre-flip, re-posted after the flip ⇒ held (NOT re-queued to Procore)", async () => {
    await enqueueBidboardCreateCommand(e1());
    await pg.exec(`UPDATE bidboard_create_outbox SET status = 'failed'`);
    process.env.RFP_NONSERVICE_DESTINATION = "core";
    await enqueueBidboardCreateCommand(e1());
    expect((await cmd()).status).toBe("held_destination_changed");
    expect((await cmd()).destination).toBe("procore");
    expect(alertCodes()).toContain("destination_changed_hold");
    expect(await coreRows()).toHaveLength(0);
  });
  it("an override is NEVER held by a flip: ROUTE is procore before and after ⇒ today's re-queue", async () => {
    await enqueueBidboardCreateCommand(e1({ approvalKind: "override", approval: undefined }));
    await pg.exec(`UPDATE bidboard_create_outbox SET status = 'failed'`);
    process.env.RFP_NONSERVICE_DESTINATION = "core";
    await enqueueBidboardCreateCommand(e1({ approvalKind: "override", approval: undefined }));
    expect((await cmd()).status).toBe("pending");
    expect(alertCodes()).not.toContain("destination_changed_hold");
  });
  it("§11: processing / reclaiming / needs_manual are not re-attempts: a re-post across a flip leaves them on their stamp", async () => {
    for (const status of ["processing", "reclaiming", "needs_manual"]) {
      await pg.exec(`DELETE FROM bidboard_create_outbox`);
      delete process.env.RFP_NONSERVICE_DESTINATION;
      await enqueueBidboardCreateCommand(e1());
      await pg.exec(`UPDATE bidboard_create_outbox SET status = '${status}'`);
      process.env.RFP_NONSERVICE_DESTINATION = "core";
      await enqueueBidboardCreateCommand(e1());
      expect((await cmd()).status, status).toBe(status);
      expect((await cmd()).destination, status).toBe("procore");
    }
    expect(alertCodes()).not.toContain("destination_changed_hold");
  });
});

describe("approvalKind: NULL adopt, NON-NULL conflict (§2, v2.2 b8 C2)", () => {
  it("a NULL kind re-posted WITH vote under procore ⇒ kind adopted, stamp kept, today's re-queue", async () => {
    await enqueueBidboardCreateCommand(e1({ approvalKind: undefined, approval: undefined }));
    expect((await cmd()).approval_kind).toBeNull();
    await pg.exec(`UPDATE bidboard_create_outbox SET status = 'failed'`);
    await enqueueBidboardCreateCommand(e1());
    expect((await cmd()).approval_kind).toBe("vote");
    expect((await cmd()).destination).toBe("procore");
    expect((await cmd()).status).toBe("pending");
  });
  it("a NULL kind re-posted WITH vote under core ⇒ adopted, then ROUTE NOW core ≠ procore stamp ⇒ held", async () => {
    await enqueueBidboardCreateCommand(e1({ approvalKind: undefined, approval: undefined }));
    await pg.exec(`UPDATE bidboard_create_outbox SET status = 'failed'`);
    process.env.RFP_NONSERVICE_DESTINATION = "core";
    await enqueueBidboardCreateCommand(e1());
    expect((await cmd()).approval_kind).toBe("vote");
    expect((await cmd()).destination).toBe("procore");
    expect((await cmd()).status).toBe("held_destination_changed");
  });
  it("vote stored, re-posted as override ⇒ refused + alert; kind, stamp and payload unchanged", async () => {
    await enqueueBidboardCreateCommand(e1());
    const before = await cmd();
    await enqueueBidboardCreateCommand(e1({ approvalKind: "override", deal: { ...e1().deal, name: "Changed" } }));
    const after = await cmd();
    expect(after.approval_kind).toBe("vote");
    expect(after.destination).toBe(before.destination);
    expect(after.payload.deal.name).toBe("Synthetic Deal");
    expect(alertCodes()).toContain("approval_kind_conflict");
  });
});

describe("RE-ARM (stamp = ROUTE NOW, core; §2 b8 M2 / M5)", () => {
  beforeEach(() => { process.env.RFP_NONSERVICE_DESTINATION = "core"; });
  it("core create not yet sent: failed | dead | refused ⇒ pending, attempts reset", async () => {
    for (const status of ["failed", "dead", "refused"]) {
      await pg.exec(`DELETE FROM rfp_core_followup_outbox; DELETE FROM rfp_core_create_outbox; DELETE FROM bidboard_create_outbox`);
      await enqueueBidboardCreateCommand(e1());
      await pg.exec(`UPDATE rfp_core_create_outbox SET status = '${status}', attempt_count = 4`);
      await enqueueBidboardCreateCommand(e1());
      expect((await coreRows())[0].status, status).toBe("pending");
      expect((await coreRows())[0].attempt_count, status).toBe(0);
    }
  });
  it("core create in flight (sending) ⇒ untouched", async () => {
    await enqueueBidboardCreateCommand(e1());
    await pg.exec(`UPDATE rfp_core_create_outbox SET status = 'sending', attempt_count = 2`);
    await enqueueBidboardCreateCommand(e1());
    expect((await coreRows())[0]).toMatchObject({ status: "sending", attempt_count: 2 });
  });
  it("core create already sent ⇒ E2 is NEVER re-sent; a dead E4 / E5 follow-up ⇒ pending; link_refused is never re-armed", async () => {
    await enqueueBidboardCreateCommand(e1());
    const id = (await coreRows())[0].id;
    await pg.exec(`UPDATE rfp_core_create_outbox SET status = 'sent', core_bid_id = '00000000-0000-4000-8000-0000000000b1'`);
    await pg.query(
      `INSERT INTO rfp_core_followup_outbox (create_id, kind, payload, status, attempt_count) VALUES ($1, 'crm_link', '{}'::jsonb, 'dead', 6), ($1, 'core_confirm', '{}'::jsonb, 'dead', 6)`,
      [id],
    );
    await enqueueBidboardCreateCommand(e1());
    expect((await coreRows())[0].status).toBe("sent");
    const fu = (await pg.query<any>(`SELECT kind, status, attempt_count FROM rfp_core_followup_outbox ORDER BY kind`)).rows;
    expect(fu).toEqual([
      { kind: "core_confirm", status: "pending", attempt_count: 0 },
      { kind: "crm_link", status: "pending", attempt_count: 0 },
    ]);
    await pg.exec(`UPDATE rfp_core_followup_outbox SET status = 'link_refused' WHERE kind = 'crm_link'`);
    await enqueueBidboardCreateCommand(e1());
    expect((await pg.query<any>(`SELECT status FROM rfp_core_followup_outbox WHERE kind = 'crm_link'`)).rows[0].status).toBe("link_refused");
  });
});
