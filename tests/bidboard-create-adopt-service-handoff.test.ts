// =============================================================================
// A SERVICE deal whose create-from-rfp vote ADOPTS an existing Bid Board job hands that job to TROCK Core.
//
// create-from-rfp never CREATES a service job (it refuses type 4), but when the deal already has a Bid Board
// project the vote adopts it — and before this, Core was never told. The handoff needs a REAL
// rfp_approval_requests id (Core requires a positive safe integer and orders by (approvedAt, requestId)), so the
// interesting behaviour is which row's id is used, that a retry reuses it, and that nothing about the adopt itself
// changes. db.ts is a PGlite instance so storage, the Core outbox and the callback outbox run their ACTUAL SQL.
// =============================================================================

import { readFileSync } from "fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

const dbHolder = vi.hoisted(() => ({ db: null as any, pool: undefined as any }));
vi.mock("../server/db.ts", () => ({
  get db() { return dbHolder.db; },
  get pool() { return dbHolder.pool; },
}));
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));

const createBidBoardMock = vi.hoisted(() => vi.fn());
vi.mock("../server/playwright/bidboard.ts", () => ({ createBidBoardProjectFromDeal: createBidBoardMock }));
vi.mock("../server/sync/bidboard-callback-worker.ts", () => ({
  buildBidBoardCreatedCallbackTargetUrl: () => "https://crm.example.com/api/internal/bid-board-created",
  buildRfpDeclinedCallbackTargetUrl: () => "https://crm.example.com/api/internal/rfp-declined",
}));
// rfp-approval.ts is REAL (its normalizedDealData is the thing under test) except the CRM eligibility call.
vi.mock("../server/rfp-approval.ts", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  checkRfpApprovalSourceEligibility: vi.fn(async () => ({ eligible: true })),
}));
vi.mock("../server/hubspot.ts", () => ({
  getHubSpotClient: vi.fn(),
  getAccessToken: vi.fn(async () => "token"),
  getDealOwnerInfo: vi.fn(async () => ({ ownerName: "", ownerEmail: "" })),
  updateHubSpotDeal: vi.fn(),
  updateHubSpotDealStage: vi.fn(),
  syncSingleHubSpotDeal: vi.fn(),
}));
vi.mock("../server/procore-hubspot-sync.ts", () => ({ resolveHubspotStageId: vi.fn() }));
vi.mock("../server/email-service.ts", () => ({ sendEmail: vi.fn(), renderTemplate: vi.fn(), GLOBAL_CC_RECIPIENTS: [] }));
vi.mock("../server/sync/service-rfp-core-alert.ts", () => ({ recordServiceRfpCoreDelivery: vi.fn(async () => undefined) }));
const coreFetchMock = vi.hoisted(() =>
  vi.fn(async (..._args: any[]) => new Response(JSON.stringify({ outcome: "created", bidId: "bid-1" }), { status: 200 })),
);
vi.mock("../server/lib/fetch-with-timeout.ts", () => ({ fetchWithTimeout: coreFetchMock }));

// A pass-through spy over the REAL handoff, so its own outbox dedupe runs; a test can make it throw instead.
const handoffMode = vi.hoisted(() => ({ throws: false }));
const handoffSpy = vi.hoisted(() => vi.fn());
vi.mock("../server/sync/service-rfp-core-outbox.ts", async (importOriginal) => {
  const actual = await importOriginal<any>();
  handoffSpy.mockImplementation(async (input: any, deps: any) => {
    if (handoffMode.throws) throw new Error("outbox exploded");
    return actual.handOffServiceRfpApprovalToCore(input, deps);
  });
  return { ...actual, handOffServiceRfpApprovalToCore: handoffSpy };
});

const { storage } = await import("../server/storage.ts");
const { performCreateFromRfpVote } = await import("../server/sync/bidboard-create-worker.ts");

const DEAL_ID = "9f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const COMPANY_ID = "11111111-2222-4333-8444-555555555555";
const PROPERTY_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const SERVICE_NUMBER = "DFW-4-12345-aa";
// The command's receipt time — what the drain passes as callbackAt and the override's approval moment.
const VOTE_AT = "2026-10-01T15:30:00.000Z";

const DDL = `
  CREATE TABLE rfp_approval_requests (
    id serial PRIMARY KEY,
    source_system text NOT NULL DEFAULT 'hubspot',
    source_deal_id text NOT NULL,
    source_event_id text,
    project_number text,
    hubspot_deal_id text,
    token text NOT NULL UNIQUE,
    token_expires_at timestamp,
    status text NOT NULL DEFAULT 'pending',
    deal_data jsonb NOT NULL,
    edited_fields jsonb,
    approved_attachments jsonb,
    approved_by text,
    approved_at timestamp,
    declined_by text,
    declined_at timestamp,
    bidboard_project_id text,
    created_at timestamp DEFAULT now()
  );
  CREATE UNIQUE INDEX idx_rfp_approval_pending_source_deal ON rfp_approval_requests(source_system, source_deal_id)
    WHERE status IN ('pending', 'override_approving');
  CREATE TABLE sync_mappings (
    id SERIAL PRIMARY KEY,
    source_system text NOT NULL DEFAULT 'hubspot',
    source_deal_id text NOT NULL,
    hubspot_deal_id text,
    hubspot_company_id text,
    procore_project_id text,
    procore_company_id text,
    companycam_project_id text,
    hubspot_deal_name text,
    procore_project_name text,
    procore_project_number text,
    bidboard_project_id text,
    bidboard_project_name text,
    portfolio_project_id text,
    portfolio_project_name text,
    project_phase text DEFAULT 'bidboard',
    sent_to_portfolio_at timestamp,
    last_sync_at timestamp,
    last_sync_status text DEFAULT 'pending',
    last_sync_direction text,
    metadata jsonb,
    created_at timestamp DEFAULT now()
  );
  CREATE TABLE bidboard_callback_outbox (
    id serial PRIMARY KEY,
    source_system text NOT NULL,
    source_deal_id text NOT NULL,
    rfp_approval_request_id integer,
    payload jsonb NOT NULL,
    target_url text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    attempt_count integer NOT NULL DEFAULT 0,
    max_attempts integer NOT NULL DEFAULT 5,
    last_error text,
    last_attempt_at timestamp,
    next_attempt_at timestamp NOT NULL DEFAULT now(),
    created_at timestamp NOT NULL DEFAULT now(),
    sent_at timestamp
  );
  CREATE UNIQUE INDEX idx_bidboard_callback_outbox_rfp_request ON bidboard_callback_outbox(rfp_approval_request_id);
`;
const migration = (file: string) => readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");
// The create outbox (read by the sibling-recovery guard on the create path) and the Core outbox, as shipped.
const CREATE_OUTBOX_DDL = migration("0023_create_bidboard_create_outbox.sql");
const CORE_OUTBOX_DDL = migration("0025_create_service_rfp_core_outbox.sql");

let pg: PGlite;

function vote(overrides: { sourceEventId?: string; sourceSystem?: string; deal?: Record<string, any> } = {}) {
  return {
    sourceSystem: overrides.sourceSystem ?? "trock_crm",
    sourceDealId: DEAL_ID,
    sourceEventId: overrides.sourceEventId ?? "crm:rfp-vote:approved:round-2",
    decision: "approved",
    deal: {
      name: "Tides North Dallas roof leak",
      projectNumber: SERVICE_NUMBER,
      projectType: "4",
      amount: 1200,
      estimator: null,
      ownerName: "Rita Rep",
      ownerEmail: "rita@trock.example",
      companyId: COMPANY_ID,
      propertyId: PROPERTY_ID,
      propertyName: "Tides North Dallas",
      companyName: "RPM Investments",
      contactName: "Dana Ruiz",
      clientEmail: "dana@rpm.example",
      clientPhone: null,
      address: { street: "1 Main St", city: "Dallas", state: "TX", zip: "75201", country: "US" },
      description: "roof leak over unit 4",
      dueDate: null,
      workflowRoute: "service",
      ...overrides.deal,
    },
    attachments: [],
  } as any;
}

async function mapDealTo(projectNumber: string, bidboardProjectId = "777", sourceSystem = "trock_crm") {
  await pg.query(
    `INSERT INTO sync_mappings (source_system, source_deal_id, bidboard_project_id, procore_project_number) VALUES ($1, $2, $3, $4)`,
    [sourceSystem, DEAL_ID, bidboardProjectId, projectNumber],
  );
}

async function seedRequest(status: string, sourceEventId: string, sourceDealId = DEAL_ID): Promise<number> {
  const res = await pg.query(
    `INSERT INTO rfp_approval_requests (source_system, source_deal_id, source_event_id, project_number, token, status, deal_data)
     VALUES ('trock_crm', $1, $2, $3, $4, $5, '{}'::jsonb) RETURNING id`,
    [sourceDealId, sourceEventId, SERVICE_NUMBER, `tok-${sourceEventId}-${status}`, status],
  );
  return Number((res.rows[0] as any).id);
}

const rows = async (table: string, where = "TRUE") => (await pg.query(`SELECT * FROM ${table} WHERE ${where} ORDER BY id`)).rows as any[];
const handoffArg = (i = 0) => handoffSpy.mock.calls[i]![0] as any;

beforeEach(async () => {
  pg = new PGlite();
  await pg.exec(DDL);
  await pg.exec(CREATE_OUTBOX_DDL);
  await pg.exec(CORE_OUTBOX_DDL);
  dbHolder.db = drizzle(pg);
  vi.spyOn(storage, "getAutomationConfig").mockResolvedValue({ value: { companyId: "42" } } as any);
  process.env.CORE_INGRESS_BASE_URL = "https://core.example.com";
  process.env.SERVICE_RFP_INGRESS_SECRET_CURRENT = "s".repeat(32);
  process.env.TROCK_CRM_BASE_URL = "https://crm.example.com";
  handoffMode.throws = false;
  handoffSpy.mockClear();
  coreFetchMock.mockClear();
  createBidBoardMock.mockReset();
  createBidBoardMock.mockImplementation(async () => {
    await mapDealTo("TR-1001", "999");
    return { success: true, projectId: "999" };
  });
});

describe("create-from-rfp ADOPT of a service deal -> TROCK Core handoff", () => {
  it("records an approved request for the vote and hands Core its REAL id, the CRM ids, type 4 and the vote time", async () => {
    await mapDealTo(SERVICE_NUMBER);

    const outcome = await performCreateFromRfpVote(vote(), VOTE_AT);

    expect(outcome).toBe("adopted");
    const [request] = await rows("rfp_approval_requests");
    expect(request).toMatchObject({
      status: "approved",
      source_system: "trock_crm",
      source_deal_id: DEAL_ID,
      source_event_id: "crm:rfp-vote:approved:round-2",
      project_number: SERVICE_NUMBER,
      bidboard_project_id: "777",
    });
    expect(new Date(request.approved_at + "Z").toISOString()).toBe(VOTE_AT);
    // The row carries the SAME deal_data an ordinary approval stores, CRM identity included.
    expect(request.deal_data).toMatchObject({ crm_company_id: COMPANY_ID, crm_property_id: PROPERTY_ID, crm_property_name: "Tides North Dallas" });

    expect(handoffSpy).toHaveBeenCalledTimes(1);
    const arg = handoffArg();
    expect(arg.rfpRequestId).toBe(request.id);
    expect(Number.isSafeInteger(arg.rfpRequestId) && arg.rfpRequestId > 0).toBe(true);
    expect(arg.projectNumber).toBe(SERVICE_NUMBER);
    expect(arg.dealData).toMatchObject({ crm_company_id: COMPANY_ID, crm_property_id: PROPERTY_ID, crm_property_name: "Tides North Dallas" });
    expect(arg.editedFieldsOverride).toEqual({ project_types: "4" });
    expect(arg.approvedAt.toISOString()).toBe(VOTE_AT);

    // What Core was actually told.
    const [core] = await rows("service_rfp_core_outbox");
    expect(core.status).toBe("sent");
    expect(core.payload.rfp).toEqual({ requestId: request.id, approvedAt: VOTE_AT });
    expect(core.payload.company.id).toBe(COMPANY_ID);
    expect(core.payload.property).toMatchObject({ id: PROPERTY_ID, name: "Tides North Dallas" });
    expect(coreFetchMock).toHaveBeenCalledTimes(1);
  });

  it("REUSES the deal's latest request when it is APPROVED, instead of inserting one", async () => {
    await mapDealTo(SERVICE_NUMBER);
    await seedRequest("declined", "crm:rfp:request-1");
    const latest = await seedRequest("approved", "crm:rfp:request-2");

    await performCreateFromRfpVote(vote(), VOTE_AT);

    expect(await rows("rfp_approval_requests")).toHaveLength(2); // nothing inserted
    expect(handoffArg().rfpRequestId).toBe(latest);
    expect(handoffArg().approvedAt.toISOString()).toBe(VOTE_AT); // the override's time, not the original request's
  });

  it("a DECLINED latest request is never the handoff id: the vote records its own approved row", async () => {
    await mapDealTo(SERVICE_NUMBER);
    await seedRequest("approved", "crm:rfp:request-1");
    const declined = await seedRequest("declined", "crm:rfp:request-2");

    await performCreateFromRfpVote(vote(), VOTE_AT);

    const inserted = await rows("rfp_approval_requests", `source_event_id = 'crm:rfp-vote:approved:round-2'`);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].status).toBe("approved");
    expect(handoffArg().rfpRequestId).toBe(inserted[0].id);
    expect(handoffArg().rfpRequestId).not.toBe(declined);
  });

  it.each(["pending", "override_approving"])(
    "a deal whose latest request is still %s is NOT handed off here (its own approval will), and no row is inserted",
    async (status) => {
      await mapDealTo(SERVICE_NUMBER);
      await seedRequest(status, "crm:rfp:request-1");

      const outcome = await performCreateFromRfpVote(vote(), VOTE_AT);

      expect(outcome).toBe("adopted");
      expect(handoffSpy).not.toHaveBeenCalled();
      expect(await rows("rfp_approval_requests")).toHaveLength(1);
      expect(await rows("service_rfp_core_outbox")).toHaveLength(0);
      const [callback] = await rows("bidboard_callback_outbox");
      expect(callback.payload).toMatchObject({ status: "created", bidboardProjectId: "777" });
    },
  );

  it("a retried command (same sourceEventId) reuses the SAME request id and Core is told once", async () => {
    await mapDealTo(SERVICE_NUMBER);

    await performCreateFromRfpVote(vote(), VOTE_AT);
    await performCreateFromRfpVote(vote(), VOTE_AT);

    expect(await rows("rfp_approval_requests")).toHaveLength(1);
    expect(handoffSpy).toHaveBeenCalledTimes(2);
    expect(handoffArg(1).rfpRequestId).toBe(handoffArg(0).rfpRequestId);
    expect(await rows("service_rfp_core_outbox")).toHaveLength(1);
    expect(await handoffSpy.mock.results[1]!.value).toEqual({ status: "duplicate" });
    expect(coreFetchMock).toHaveBeenCalledTimes(1);
  });

  it("a retry keeps ITS OWN row even when a newer request for the deal appeared in between", async () => {
    await mapDealTo(SERVICE_NUMBER);
    await performCreateFromRfpVote(vote(), VOTE_AT);
    const first = handoffArg(0).rfpRequestId;
    await seedRequest("pending", "crm:rfp:request-3");

    await performCreateFromRfpVote(vote(), VOTE_AT);

    expect(handoffArg(1).rfpRequestId).toBe(first);
    expect(await rows("service_rfp_core_outbox")).toHaveLength(1);
  });

  it("does not adopt another deal's request that happens to share the sourceEventId", async () => {
    await mapDealTo(SERVICE_NUMBER);
    const foreign = await seedRequest("approved", "crm:rfp-vote:approved:round-2", "00000000-0000-4000-8000-000000000000");

    await performCreateFromRfpVote(vote(), VOTE_AT);

    expect(handoffArg().rfpRequestId).not.toBe(foreign);
    const [own] = await rows("rfp_approval_requests", `source_deal_id = '${DEAL_ID}'`);
    expect(handoffArg().rfpRequestId).toBe(own.id);
  });

  it("a NON-service deal that adopts is NOT handed to Core", async () => {
    await mapDealTo("TR-1001");

    const outcome = await performCreateFromRfpVote(
      vote({ deal: { projectNumber: "TR-1001", projectType: "9", workflowRoute: "normal" } }),
      VOTE_AT,
    );

    expect(outcome).toBe("adopted");
    expect(handoffSpy).not.toHaveBeenCalled();
    expect(await rows("rfp_approval_requests")).toHaveLength(0);
  });

  it("a non-trock_crm service adopt is NOT handed to Core", async () => {
    await mapDealTo(SERVICE_NUMBER, "777", "hubspot");

    const outcome = await performCreateFromRfpVote(vote({ sourceSystem: "hubspot" }), VOTE_AT);

    expect(outcome).toBe("adopted");
    expect(handoffSpy).not.toHaveBeenCalled();
    expect(await rows("rfp_approval_requests")).toHaveLength(0);
  });

  it("the CREATED (non-adopt) path is unchanged: creates, no request row, no handoff", async () => {
    const outcome = await performCreateFromRfpVote(
      vote({ deal: { projectNumber: "TR-1001", projectType: "9", workflowRoute: "normal" } }),
      VOTE_AT,
    );

    expect(outcome).toBe("created");
    expect(createBidBoardMock).toHaveBeenCalledTimes(1);
    expect(handoffSpy).not.toHaveBeenCalled();
    expect(await rows("rfp_approval_requests")).toHaveLength(0);
  });

  it("a service deal with NO project is still REFUSED, with no handoff and no request row", async () => {
    const outcome = await performCreateFromRfpVote(vote(), VOTE_AT);

    expect(outcome).toBe("failed");
    expect(createBidBoardMock).not.toHaveBeenCalled();
    expect(handoffSpy).not.toHaveBeenCalled();
    expect(await rows("rfp_approval_requests")).toHaveLength(0);
    const [callback] = await rows("bidboard_callback_outbox");
    expect(callback.payload.status).toBe("failed");
  });

  it.each([
    ["throws", () => { handoffMode.throws = true; }],
    ["is skipped (Core ingress unprovisioned)", () => { delete process.env.CORE_INGRESS_BASE_URL; }],
  ])("when the handoff %s, the adopt result and its 'created' callback are unchanged", async (_label, arrange) => {
    await mapDealTo(SERVICE_NUMBER);
    arrange();

    const outcome = await performCreateFromRfpVote(vote(), VOTE_AT);

    expect(outcome).toBe("adopted");
    expect(handoffSpy).toHaveBeenCalledTimes(1);
    const callbacks = await rows("bidboard_callback_outbox");
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]).toMatchObject({ source_deal_id: DEAL_ID, rfp_approval_request_id: null, status: "pending" });
    expect(callbacks[0].payload).toMatchObject({ status: "created", bidboardProjectId: "777", projectNumber: SERVICE_NUMBER, createdAt: VOTE_AT });
    expect(await rows("service_rfp_core_outbox")).toHaveLength(0);
  });
});
