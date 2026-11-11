import { readFileSync } from "fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// CONTRACT v2.2 §10: SyncHub migrations are hand-applied (Dockerfile:69), so S0's code can be live before 0027 is.
//   - preflight reports present / missing from to_regclass;
//   - 0027 missing + ROUTE procore ⇒ TODAY's enqueue, unchanged (a dark deploy must not break the Procore path);
//   - 0027 missing + ROUTE core ⇒ HOLD: refuse (the route answers 500, the CRM retries durably) + a loud alert; NO Procore fallback.
const dbHolder = vi.hoisted(() => ({ db: null as any }));
const alertMock = vi.hoisted(() => vi.fn(async (_c: string, _d: Record<string, unknown>) => {}));
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));
vi.mock("../server/db.ts", () => ({ get db() { return dbHolder.db; }, get pool() { return undefined; } }));
vi.mock("../server/playwright/bidboard.ts", () => ({ createBidBoardProjectFromDeal: vi.fn() }));
vi.mock("../server/rfp-approval.ts", () => ({ checkRfpApprovalSourceEligibility: vi.fn(), buildSourceDealUrl: vi.fn(), normalizedDealData: vi.fn() }));
vi.mock("../server/sync/bidboard-callback-worker.ts", () => ({ buildBidBoardCreatedCallbackTargetUrl: () => "https://crm.example.test/x" }));
vi.mock("../server/storage.ts", () => ({ storage: {} }));
vi.mock("../server/sync/rfp-core-alert.ts", () => ({ raiseRfpCoreAlert: alertMock }));

const { preflightRfpCoreTables } = await import("../server/sync/rfp-core-preflight.ts");
const { enqueueBidboardCreateCommand } = await import("../server/sync/bidboard-create-worker.ts");
const DDL_0023 = readFileSync(new URL("../migrations/0023_create_bidboard_create_outbox.sql", import.meta.url), "utf8");
const DDL_0027 = readFileSync(new URL("../migrations/0027_rfp_core_routing.sql", import.meta.url), "utf8");

let pg: PGlite;
async function freshDb(with0027: boolean) {
  pg = new PGlite();
  await pg.exec(`CREATE TABLE bidboard_callback_outbox (id serial PRIMARY KEY, source_system text, source_deal_id text, rfp_approval_request_id integer NOT NULL, payload jsonb, target_url text, status text, created_at timestamptz DEFAULT now())`);
  await pg.exec(DDL_0023);
  if (with0027) await pg.exec(DDL_0027);
  dbHolder.db = drizzle(pg);
}
beforeEach(() => { alertMock.mockReset(); delete process.env.RFP_NONSERVICE_DESTINATION; process.env.RFP_CORE_OFFICES = "dallas"; });
afterEach(async () => { await pg?.close?.(); });

function e1(o: Record<string, any> = {}) {
  return {
    sourceSystem: "trock_crm", sourceDealId: "00000000-0000-4000-8000-0000000000d2", sourceEventId: "crm:rfp-vote:approved:round-7",
    decision: "approved", approvalKind: "vote", office: "dallas",
    approval: { roundEventId: "round-7", approvals: 2, rejections: 1, invitedVoterCount: 3, decidedAt: "2026-11-02T15:00:00.000Z" },
    deal: { name: "Synthetic", projectNumber: "DFW-3-54321-cd", projectType: "3", amount: null, estimator: null, companyName: null,
      contactName: null, clientEmail: null, clientPhone: null, address: null, description: null, dueDate: null, workflowRoute: "normal" },
    attachments: [], ...o,
  } as any;
}

describe("preflightRfpCoreTables", () => {
  it("reports present when 0027 is applied", async () => {
    await freshDb(true);
    expect(await preflightRfpCoreTables(dbHolder.db)).toBe("present");
  });
  it("reports missing when 0027 is not applied", async () => {
    await freshDb(false);
    expect(await preflightRfpCoreTables(dbHolder.db)).toBe("missing");
  });
});

describe("enqueue with 0027 missing", () => {
  it("ROUTE procore (setting unset) ⇒ today's enqueue, unchanged: one pending command row", async () => {
    await freshDb(false);
    await enqueueBidboardCreateCommand(e1());
    const rows = (await pg.query<any>(`SELECT status FROM bidboard_create_outbox`)).rows;
    expect(rows).toEqual([{ status: "pending" }]);
  });
  it("ROUTE core ⇒ HOLD: throws (500 to the CRM, which retries), loud alert, and NOTHING enqueued for Procore", async () => {
    await freshDb(false);
    process.env.RFP_NONSERVICE_DESTINATION = "core";
    await expect(enqueueBidboardCreateCommand(e1())).rejects.toThrow(/rfp core tables missing/i);
    expect(alertMock.mock.calls.map((c) => c[0])).toContain("core_tables_missing");
    expect((await pg.query<any>(`SELECT count(*)::int AS n FROM bidboard_create_outbox`)).rows[0].n).toBe(0);
  });
});
