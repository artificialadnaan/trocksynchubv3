import { readFileSync } from "fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// S0b-2a (d9 Q6): `approving` is a create in progress, exactly like override_approving, for every guard that stops a SECOND
// create for the same deal / project number (inventory: ee-synchub-gate/S0b2-APPROVING-READER-INVENTORY.r1.md):
//   - createRfpApprovalRequestFromNormalizedInput's pre-checks (project number; source deal) and its unique-violation handler
//     (0027's NEW wider indexes idx_rfp_approval_live_*);
//   - createRfpApprovalRequest(hubspotDealId)'s "already exists" skip (the HubSpot webhook path);
//   - performCreateFromRfpVote's collision guard;
//   - handOffAdoptedServiceDealToCore's "its approval hands off" skip.
// PGlite runs the REAL storage SQL and the real migrations (0021, 0023, 0027). Synthetic data only (I7).
const dbHolder = vi.hoisted(() => ({ db: null as any, pool: undefined as any }));
vi.mock("../server/db.ts", () => ({ get db() { return dbHolder.db; }, get pool() { return dbHolder.pool; } }));
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));
const createBidBoardMock = vi.hoisted(() => vi.fn(async (..._a: any[]): Promise<any> => ({ success: true, projectId: "900444" })));
vi.mock("../server/playwright/bidboard.ts", () => ({ createBidBoardProjectFromDeal: createBidBoardMock }));
vi.mock("../server/sync/bidboard-callback-worker.ts", () => ({
  buildBidBoardCreatedCallbackTargetUrl: () => "https://crm.example.test/api/internal/bid-board-created",
  buildRfpDeclinedCallbackTargetUrl: () => "https://crm.example.test/api/internal/rfp-declined",
}));
vi.mock("../server/rfp-source-eligibility.ts", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  checkRfpApprovalSourceEligibility: vi.fn(async () => ({ eligible: true })),
  checkCrmDealEligibility: vi.fn(async () => ({ eligible: true })),
}));
vi.mock("../server/hubspot.ts", () => ({
  getHubSpotClient: vi.fn(),
  getAccessToken: vi.fn(async () => "synthetic-token"),
  getDealOwnerInfo: vi.fn(async () => ({ ownerName: "", ownerEmail: "" })),
  updateHubSpotDeal: vi.fn(),
  updateHubSpotDealStage: vi.fn(),
  syncSingleHubSpotDeal: vi.fn(),
}));
vi.mock("../server/procore-hubspot-sync.ts", () => ({ resolveHubspotStageId: vi.fn() }));
vi.mock("../server/email-service.ts", () => ({ sendEmail: vi.fn(async () => ({ success: true })), renderTemplate: vi.fn(), GLOBAL_CC_RECIPIENTS: [] }));
vi.mock("../server/lib/fetch-with-timeout.ts", () => ({ fetchWithTimeout: vi.fn(async () => new Response("", { status: 200 })) }));
const handoffMock = vi.hoisted(() => vi.fn(async (..._a: any[]) => undefined));
vi.mock("../server/sync/service-rfp-core-outbox.ts", () => ({ handOffServiceRfpApprovalToCore: handoffMock }));
vi.mock("../server/sync/rfp-core-alert.ts", () => ({ raiseRfpCoreAlert: vi.fn(async () => {}) }));

const { storage } = await import("../server/storage.ts");
const { createRfpApprovalRequest, createRfpApprovalRequestFromNormalizedInput } = await import("../server/rfp-approval.ts");
const { performCreateFromRfpVote } = await import("../server/sync/bidboard-create-worker.ts");

const DDL = `
  CREATE TABLE rfp_approval_requests (
    id serial PRIMARY KEY, source_system text NOT NULL DEFAULT 'hubspot', source_deal_id text NOT NULL, source_event_id text,
    project_number text, hubspot_deal_id text, token text NOT NULL UNIQUE, token_expires_at timestamp,
    status text NOT NULL DEFAULT 'pending', deal_data jsonb NOT NULL, edited_fields jsonb, approved_attachments jsonb,
    approved_by text, approved_at timestamp, declined_by text, declined_at timestamp, bidboard_project_id text,
    created_at timestamp DEFAULT now()
  );
  CREATE TABLE sync_mappings (
    id SERIAL PRIMARY KEY, source_system text NOT NULL DEFAULT 'hubspot', source_deal_id text NOT NULL, hubspot_deal_id text,
    hubspot_company_id text, procore_project_id text, procore_company_id text, companycam_project_id text,
    hubspot_deal_name text, procore_project_name text, procore_project_number text, bidboard_project_id text,
    bidboard_project_name text, portfolio_project_id text, portfolio_project_name text, project_phase text DEFAULT 'bidboard',
    sent_to_portfolio_at timestamp, last_sync_at timestamp, last_sync_status text DEFAULT 'pending', last_sync_direction text,
    metadata jsonb, created_at timestamp DEFAULT now()
  );
  CREATE TABLE bidboard_callback_outbox (
    id serial PRIMARY KEY, source_system text NOT NULL, source_deal_id text NOT NULL, rfp_approval_request_id integer,
    payload jsonb NOT NULL, target_url text NOT NULL, status text NOT NULL DEFAULT 'pending',
    attempt_count integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 5, last_error text,
    last_attempt_at timestamp, next_attempt_at timestamp NOT NULL DEFAULT now(), created_at timestamp NOT NULL DEFAULT now(),
    sent_at timestamp
  );
  CREATE UNIQUE INDEX idx_bidboard_callback_outbox_rfp_request ON bidboard_callback_outbox(rfp_approval_request_id);
`;
const migration = (file: string) => readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");

const DEAL = "00000000-0000-4000-8000-0000000000f6";
const OTHER_DEAL = "00000000-0000-4000-8000-0000000000f7";
const HS_DEAL = "910000006";
const PN = "DFW-2-54321-cd";
const SERVICE_PN = "DFW-4-54321-cd";

let pg: PGlite;
beforeEach(async () => {
  pg = new PGlite();
  await pg.exec(DDL);
  await pg.exec(migration("0021_extend_pending_unique_indexes_to_override_approving.sql"));
  await pg.exec(migration("0023_create_bidboard_create_outbox.sql"));
  await pg.exec(migration("0027_rfp_core_routing.sql"));
  dbHolder.db = drizzle(pg);
  vi.spyOn(storage, "getAutomationConfig").mockResolvedValue({ value: { companyId: "42" } } as any);
  vi.spyOn(storage, "createAuditLog").mockResolvedValue({} as any);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in tests"); }));
  process.env.TROCK_CRM_BASE_URL = "https://crm.example.test";
  createBidBoardMock.mockClear();
  handoffMock.mockClear();
}, 30000);

function vote(o: { sourceEventId?: string; projectNumber?: string; projectType?: string } = {}) {
  return {
    sourceSystem: "trock_crm", sourceDealId: DEAL, sourceEventId: o.sourceEventId ?? "crm:rfp-vote:approved:round-4",
    decision: "approved", approvalKind: "vote", office: "dallas",
    deal: {
      name: "Synthetic Deal", projectNumber: o.projectNumber ?? PN, projectType: o.projectType ?? "2", amount: 1000, estimator: null,
      ownerName: "Pat Example", ownerEmail: "pat@example.test",
      companyId: "00000000-0000-4000-8000-0000000000c1", propertyId: "00000000-0000-4000-8000-0000000000d1",
      propertyName: "Synthetic Site", companyName: "Synthetic Co", contactName: "Sam Synthetic", clientEmail: "sam@example.test",
      clientPhone: null, address: { street: "1 Example St", city: "Dallas", state: "TX", zip: "75001", country: "US" },
      description: null, dueDate: null, workflowRoute: "normal",
    },
    attachments: [],
  } as any;
}
let seq = 0;
async function seedRequest(status: string, o: { deal?: string; projectNumber?: string; system?: string } = {}) {
  const system = o.system ?? "trock_crm";
  const deal = o.deal ?? (system === "hubspot" ? HS_DEAL : DEAL);
  const token = `synthetic-token-${++seq}`;
  const res = await pg.query(
    `INSERT INTO rfp_approval_requests (source_system, source_deal_id, source_event_id, project_number, hubspot_deal_id, token, status, deal_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb) RETURNING id`,
    [system, deal, `synthetic-event-${seq}`, o.projectNumber ?? PN, system === "hubspot" ? deal : null, token, status],
  );
  return { id: Number((res.rows[0] as any).id), token };
}
const requestRows = async () => (await pg.query(`SELECT id, status, source_deal_id FROM rfp_approval_requests ORDER BY id`)).rows as any[];
const failedCallbackErrors = async () =>
  ((await pg.query(`SELECT payload->>'error' AS error FROM bidboard_callback_outbox WHERE payload->>'status' = 'failed' ORDER BY id`)).rows as any[])
    .map((r) => r.error as string);

describe("createRfpApprovalRequestFromNormalizedInput vs an approving request", () => {
  it("an approving request for the project number ⇒ 409 pending_collision naming it; no second request", async () => {
    const { id } = await seedRequest("approving", { deal: OTHER_DEAL });
    const result = await createRfpApprovalRequestFromNormalizedInput(vote({ sourceEventId: "crm:rfp-request:new-1" }));
    expect(result).toMatchObject({ success: false, statusCode: 409, code: "pending_collision", conflict: { requestId: id, status: "approving" } });
    expect(await requestRows()).toHaveLength(1);
  });
  it("an approving request for the source deal (a revised project number) ⇒ 409 naming it; no second request", async () => {
    const { id } = await seedRequest("approving", { projectNumber: "DFW-2-11111-aa" });
    const result = await createRfpApprovalRequestFromNormalizedInput(vote({ sourceEventId: "crm:rfp-request:new-2" }));
    expect(result).toMatchObject({ success: false, statusCode: 409, conflict: { requestId: id, status: "approving", sourceDealId: DEAL } });
    expect(await requestRows()).toHaveLength(1);
  });
  it("a request that turns approving between the pre-checks and the insert ⇒ the wider index's violation is a clean 409, never a thrown 500", async () => {
    const original = storage.createRfpApprovalRequest.bind(storage);
    vi.spyOn(storage, "createRfpApprovalRequest").mockImplementationOnce(async (row: any) => {
      await seedRequest("approving", { deal: OTHER_DEAL });
      return original(row);
    });
    const result = await createRfpApprovalRequestFromNormalizedInput(vote({ sourceEventId: "crm:rfp-request:new-3" }));
    expect(result).toMatchObject({ success: false, statusCode: 409, code: "pending_collision", conflict: { status: "approving" } });
  });
});

describe("createRfpApprovalRequest (the HubSpot webhook path) vs an approving request", () => {
  it("an approving request for the HubSpot deal ⇒ skipped like a pending one: its token returned, no second request", async () => {
    const { token } = await seedRequest("approving", { system: "hubspot" });
    const result = await createRfpApprovalRequest(HS_DEAL);
    expect(result).toEqual({ success: true, token });
    expect(await requestRows()).toHaveLength(1);
  });
});

describe("create-from-rfp vs an approving request", () => {
  it("performCreateFromRfpVote: an approving request for the project number ⇒ the vote fails with the conflicting request named; no Playwright create", async () => {
    await seedRequest("approving", { deal: OTHER_DEAL });
    // Caught: at red the create proceeds and then throws (no mapping written by the mock); the assertions below decide.
    const outcome = await performCreateFromRfpVote(vote(), "2026-11-01T15:00:00.000Z").catch((e: any) => `threw: ${e?.message ?? e}`);
    expect(createBidBoardMock).not.toHaveBeenCalled();
    expect(outcome).toBe("failed");
    expect((await failedCallbackErrors()).join(" | ")).toMatch(/conflicting RFP approval .*status approving/);
  });
  it("handOffAdoptedServiceDealToCore: the deal's request is approving ⇒ its own approval hands off; no second request, no handoff here", async () => {
    await pg.query(
      `INSERT INTO sync_mappings (source_system, source_deal_id, bidboard_project_id, procore_project_number) VALUES ('trock_crm', $1, '777', $2)`,
      [DEAL, SERVICE_PN],
    );
    await seedRequest("approving", { projectNumber: SERVICE_PN });
    const outcome = await performCreateFromRfpVote(vote({ projectNumber: SERVICE_PN, projectType: "4" }), "2026-11-01T15:00:00.000Z");
    expect(outcome).toBe("adopted");
    expect(handoffMock).not.toHaveBeenCalled();
    expect((await requestRows()).map((r) => r.status)).toEqual(["approving"]);
  });
});
