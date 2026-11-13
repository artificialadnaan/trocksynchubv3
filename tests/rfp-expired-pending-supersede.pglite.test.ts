import { readFileSync } from "fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// REQ 939 (2026-11-13): a pending request whose review link EXPIRED (nobody can approve or decline it) no longer blocks a
// re-send for the same project number or source deal: createRfpApprovalRequestFromNormalizedInput supersedes it
// (pending → 'expired') and creates the new request. A LIVE pending request, and a legacy one with no expiry, still collide.
// PGlite runs the REAL storage SQL and the real migrations (0021, 0023, 0027), so the conditional UPDATE's expiry clause is
// exercised as written. Mocks = rfp-approving-guards.pglite.test.ts's. Synthetic data only (I7).
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
const { createRfpApprovalRequestFromNormalizedInput } = await import("../server/rfp-approval.ts");

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
  -- F-181: the review-email template read now runs before the insert (prod has this table); empty = no template = no email.
  CREATE TABLE email_templates (
    id serial PRIMARY KEY, template_key text NOT NULL UNIQUE, name text NOT NULL, description text, subject text NOT NULL,
    body_html text NOT NULL, enabled boolean NOT NULL DEFAULT true, variables jsonb, created_at timestamp DEFAULT now(),
    updated_at timestamp DEFAULT now()
  );
`;
const migration = (file: string) => readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");

const DEAL = "00000000-0000-4000-8000-0000000009e1";
const OTHER_DEAL = "00000000-0000-4000-8000-0000000009e2";
const THIRD_DEAL = "00000000-0000-4000-8000-0000000009e3";
const PN = "DFW-4-60606-aa";

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
}, 30000);

// A CRM service RFP re-send (a fresh source event, as the CRM's Send RFP mints one per trigger).
function resend(sourceEventId: string) {
  return {
    sourceSystem: "trock_crm", sourceDealId: DEAL, sourceEventId,
    deal: {
      name: "Synthetic Service Deal", projectNumber: PN, projectType: "4", amount: 1000, estimator: null,
      ownerName: "Pat Example", ownerEmail: "pat@example.test",
      companyId: "00000000-0000-4000-8000-0000000000c1", propertyId: "00000000-0000-4000-8000-0000000000d1",
      propertyName: "Synthetic Site", companyName: "Synthetic Co", contactName: "Sam Synthetic", clientEmail: "sam@example.test",
      clientPhone: null, address: { street: "1 Example St", city: "Dallas", state: "TX", zip: "75001", country: "US" },
      description: null, dueDate: null, workflowRoute: "service",
    },
    attachments: [],
  } as any;
}

// token_expires_at is a UTC wall-clock timestamp (drizzle writes toISOString), so the seeds are relative to now() in UTC.
const EXPIRY = {
  expired: "(now() AT TIME ZONE 'UTC') - interval '1 day'",
  live: "(now() AT TIME ZONE 'UTC') + interval '1 day'",
  none: "NULL",
} as const;
let seq = 0;
async function seedRequest(o: { expires: keyof typeof EXPIRY; status?: string; deal?: string; projectNumber?: string }) {
  seq += 1;
  const res = await pg.query(
    `INSERT INTO rfp_approval_requests (source_system, source_deal_id, source_event_id, project_number, token, token_expires_at, status, deal_data)
     VALUES ('trock_crm', $1, $2, $3, $4, ${EXPIRY[o.expires]}, $5, '{}'::jsonb) RETURNING id`,
    [o.deal ?? DEAL, `synthetic-event-${seq}`, o.projectNumber ?? PN, `synthetic-token-${seq}`, o.status ?? "pending"],
  );
  return Number((res.rows[0] as any).id);
}
const requestRows = async () =>
  (await pg.query(`SELECT id, status, source_deal_id, project_number FROM rfp_approval_requests ORDER BY id`)).rows as any[];

describe("createRfpApprovalRequestFromNormalizedInput vs an EXPIRED pending request (REQ 939)", () => {
  it("an expired pending request for the project number is superseded ('expired') and the re-send creates a new pending request", async () => {
    const old = await seedRequest({ expires: "expired" });
    const result = await createRfpApprovalRequestFromNormalizedInput(resend("crm:deal-stage:opportunity:resend-1"));
    expect(result).toMatchObject({ success: true, status: "pending" });
    expect(await requestRows()).toEqual([
      { id: old, status: "expired", source_deal_id: DEAL, project_number: PN },
      { id: (result as any).requestId, status: "pending", source_deal_id: DEAL, project_number: PN },
    ]);
  });

  it("an expired pending request for the source deal under an OLDER project number is superseded too; the re-send is created", async () => {
    const old = await seedRequest({ expires: "expired", projectNumber: "DFW-4-60606-zz" });
    const result = await createRfpApprovalRequestFromNormalizedInput(resend("crm:deal-stage:opportunity:resend-2"));
    expect(result).toMatchObject({ success: true, status: "pending" });
    expect(await requestRows()).toEqual([
      { id: old, status: "expired", source_deal_id: DEAL, project_number: "DFW-4-60606-zz" },
      { id: (result as any).requestId, status: "pending", source_deal_id: DEAL, project_number: PN },
    ]);
  });

  it("a LIVE pending request (its link not yet expired) still collides: 409 pending_collision naming it; it stays pending", async () => {
    const old = await seedRequest({ expires: "live" });
    const result = await createRfpApprovalRequestFromNormalizedInput(resend("crm:deal-stage:opportunity:resend-3"));
    expect(result).toMatchObject({ success: false, statusCode: 409, code: "pending_collision", conflict: { requestId: old, status: "pending" } });
    expect(await requestRows()).toEqual([{ id: old, status: "pending", source_deal_id: DEAL, project_number: PN }]);
  });

  it("a legacy pending request with NO expiry never expires: still a 409 pending_collision; it stays pending", async () => {
    const old = await seedRequest({ expires: "none" });
    const result = await createRfpApprovalRequestFromNormalizedInput(resend("crm:deal-stage:opportunity:resend-4"));
    expect(result).toMatchObject({ success: false, statusCode: 409, code: "pending_collision", conflict: { requestId: old, status: "pending" } });
    expect(await requestRows()).toEqual([{ id: old, status: "pending", source_deal_id: DEAL, project_number: PN }]);
  });
});

describe("storage.supersedeExpiredPendingRfpApprovalRequest: the conditional UPDATE is the authority", () => {
  it("writes only a row that is still pending AND still expired; a live, a legacy and an expired-but-approved row are left alone", async () => {
    expect(typeof storage.supersedeExpiredPendingRfpApprovalRequest).toBe("function");
    const live = await seedRequest({ expires: "live" });
    const legacy = await seedRequest({ expires: "none", deal: OTHER_DEAL, projectNumber: "DFW-4-60606-bb" });
    const approved = await seedRequest({ expires: "expired", status: "approved", deal: THIRD_DEAL, projectNumber: "DFW-4-60606-cc" });
    const expired = await seedRequest({ expires: "expired", deal: THIRD_DEAL, projectNumber: "DFW-4-60606-dd" });
    for (const id of [live, legacy, approved]) {
      expect(await storage.supersedeExpiredPendingRfpApprovalRequest(id), `row ${id}`).toBeUndefined();
    }
    expect(await storage.supersedeExpiredPendingRfpApprovalRequest(expired)).toMatchObject({ id: expired, status: "expired" });
    expect((await requestRows()).map((r) => [r.id, r.status])).toEqual([
      [live, "pending"], [legacy, "pending"], [approved, "approved"], [expired, "expired"],
    ]);
  });
});
