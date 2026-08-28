import { beforeEach, describe, expect, it, vi } from "vitest";

// The Core handoff and the Playwright create are BOTH driven from processRfpApproval, so the harness
// mirrors tests/bidboard-callback-outbox.test.ts: the whole DB layer is a single `db.execute` spy and
// every outbound edge (Core POST, Procore create, alert email) is a mock we can order and inspect.
const dbExecuteMock = vi.hoisted(() => vi.fn());
const approvalRequest = vi.hoisted(() => ({ current: undefined as any }));
const alertCalls = vi.hoisted(() => [] as any[]);
// The single ordered log of outbound side effects. The ordering assertion is on THIS array, never on
// timing — a timing assertion would pass on a fast machine even if the two calls raced.
const outboundCalls = vi.hoisted(() => [] as string[]);
const coreFetchMock = vi.hoisted(() =>
  vi.fn(async () => new Response(JSON.stringify({ outcome: "created", bidId: "bid-1" }), { status: 200 })),
);
const createBidBoardMock = vi.hoisted(() => vi.fn(async () => ({ success: true, projectId: "BB-123" })));

vi.mock("../server/db.ts", () => ({
  db: { execute: dbExecuteMock },
  pool: { query: vi.fn(async () => ({ rows: [] })) },
}));

vi.mock("../server/storage.ts", () => ({
  storage: {
    getRfpApprovalRequestByToken: vi.fn(async () => approvalRequest.current),
    updateRfpApprovalRequest: vi.fn(async (_id: number, data: any) => {
      approvalRequest.current = { ...approvalRequest.current, ...data };
      return approvalRequest.current;
    }),
    approveRfpApprovalRequestWithOptionalCallback: vi.fn(async (_id: number, data: any) => {
      approvalRequest.current = { ...approvalRequest.current, ...data };
      return approvalRequest.current;
    }),
    enqueueBidboardCallback: vi.fn(async (row: any) => ({ id: 1, ...row })),
    getAutomationConfig: vi.fn(async (key: string) =>
      key === "procore_config" ? { value: { companyId: "598134325683880" } } : null,
    ),
    createAuditLog: vi.fn(async (row: any) => ({ id: 1, ...row })),
  },
}));

vi.mock("../server/hubspot.ts", () => ({
  getHubSpotClient: vi.fn(),
  getAccessToken: vi.fn(async () => "token"),
  getDealOwnerInfo: vi.fn(async () => ({ ownerName: "Owner", ownerEmail: "owner@example.com" })),
  updateHubSpotDeal: vi.fn(async () => ({ success: true })),
  updateHubSpotDealStage: vi.fn(async () => ({ success: true })),
  syncSingleHubSpotDeal: vi.fn(async () => undefined),
}));

vi.mock("../server/procore-hubspot-sync.ts", () => ({
  resolveHubspotStageId: vi.fn(async () => ({ stageId: "stage-1", stageName: "Service - Estimating" })),
}));

vi.mock("../server/email-service.ts", () => ({
  sendEmail: vi.fn(async () => ({ success: true })),
  renderTemplate: vi.fn(),
  GLOBAL_CC_RECIPIENTS: [],
}));

vi.mock("../server/index.ts", () => ({ log: vi.fn() }));

vi.mock("../server/lib/fetch-with-timeout.ts", () => ({
  fetchWithTimeout: vi.fn(async (...args: any[]) => {
    outboundCalls.push("core");
    return coreFetchMock(...(args as []));
  }),
}));

vi.mock("../server/playwright/bidboard.ts", () => ({
  createBidBoardProjectFromDeal: vi.fn(async (...args: any[]) => {
    outboundCalls.push("playwright");
    return createBidBoardMock(...(args as []));
  }),
}));

vi.mock("../server/sync/bidboard-crm-alert.ts", () => ({
  recordPushOutcomeAndMaybeAlert: vi.fn(async (args: any) => {
    alertCalls.push(args);
    return { action: "alert_failure" };
  }),
}));

// A pass-through spy, not a stub: the real handoff still runs. It exists only so the "one source of
// truth" test can assert REFERENCE equality between the object Core is built from and the object
// Playwright is handed — equal values would still pass if the two were rebuilt independently.
const handoffInputs = vi.hoisted(() => [] as any[]);
vi.mock("../server/sync/service-rfp-core-outbox.ts", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    handOffServiceRfpApprovalToCore: vi.fn(async (input: any, deps: any) => {
      handoffInputs.push(input);
      return actual.handOffServiceRfpApprovalToCore(input, deps);
    }),
  };
});

const CRM_DEAL_ID = "9f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const CRM_COMPANY_ID = "11111111-2222-4333-8444-555555555555";
const CRM_PROPERTY_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";

function makeRequest(overrides: Partial<any> = {}, dealOverrides: Record<string, any> = {}) {
  return {
    id: 77,
    token: "token-1",
    status: "pending",
    sourceSystem: "trock_crm",
    sourceDealId: CRM_DEAL_ID,
    hubspotDealId: null,
    projectNumber: "DFW-4-12345-aa",
    tokenExpiresAt: new Date(Date.now() + 60_000),
    dealData: {
      dealname: "Roof leak triage",
      project_number: "DFW-4-12345-aa",
      project_types: "4",
      amount: 18500,
      company_name: "Acme Retail",
      contact_name: "Dana Ruiz",
      client_email: "Dana.Ruiz@acme.example",
      client_phone: "214-555-0134",
      address: "1200 Main St",
      city: "Dallas",
      state: "TX",
      zip: "75201",
      country: "US",
      description: "Emergency roof leak at the north entry",
      notes: "Emergency roof leak at the north entry",
      bid_due_date: "2026-09-15T17:00:00.000Z",
      crm_company_id: CRM_COMPANY_ID,
      crm_property_id: CRM_PROPERTY_ID,
      ...dealOverrides,
    },
    ...overrides,
  };
}

/** Every statement the handoff issued, flattened, so an assertion can name the state it expects. */
function executedSql(): string {
  return dbExecuteMock.mock.calls.map((call) => JSON.stringify(call[0])).join("\n");
}

/** The exact JSON body POSTed to Core — the same bytes the signature covers. */
function corePostBody(): any {
  const call = vi.mocked(coreFetchMock).mock.calls.at(-1) as any[] | undefined;
  return call ? JSON.parse(call[1].body) : undefined;
}

async function runApproval(editedFields: Record<string, string> = {}) {
  const { processRfpApproval } = await import("../server/rfp-approval.ts");
  return processRfpApproval("token-1", editedFields, "approver@trockgc.com", {
    attachmentsOverride: [],
    newFiles: [],
  });
}

describe("service RFP → TROCK Core handoff", () => {
  beforeEach(() => {
    vi.resetModules();
    dbExecuteMock.mockReset();
    // Enqueue returns the inserted row; every later statement is an update with no rows.
    dbExecuteMock.mockResolvedValue({ rows: [{ id: 501, attempt_count: 1, max_attempts: 5 }] });
    alertCalls.length = 0;
    outboundCalls.length = 0;
    handoffInputs.length = 0;
    coreFetchMock.mockReset();
    coreFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ outcome: "created", bidId: "bid-1" }), { status: 200 }),
    );
    createBidBoardMock.mockReset();
    createBidBoardMock.mockResolvedValue({ success: true, projectId: "BB-123" });
    approvalRequest.current = makeRequest();
    process.env.CORE_INGRESS_BASE_URL = "https://core.example.com";
    process.env.SERVICE_RFP_INGRESS_SECRET_CURRENT = "s".repeat(32);
    process.env.TROCK_CRM_BASE_URL = "https://crm.example.com";
    process.env.RFP_REQUEST_SYNC_SECRET = "secret";
    // The CRM eligibility probe uses bare fetch (not fetchWithTimeout), so it is stubbed separately
    // and never lands in outboundCalls.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ stage: "opportunity" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });

  it("POSTs the job to Core BEFORE the Procore Playwright create", async () => {
    const result = await runApproval();

    expect(result).toMatchObject({ success: true, bidboardProjectId: "BB-123" });
    expect(outboundCalls).toEqual(["core", "playwright"]);
  });

  it("signs the exact bytes it sends, with the domain-separated Core header", async () => {
    await runApproval();

    const [url, init] = vi.mocked(coreFetchMock).mock.calls.at(-1) as any[];
    expect(url).toBe("https://core.example.com/webhooks/crm/dallas/service-rfp/v1");
    expect(init.headers["x-trock-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    // SyncHub's own CRM callbacks use x-rfp-request-signature; Core does not read it.
    expect(init.headers["x-rfp-request-signature"]).toBeUndefined();

    const crypto = await import("crypto");
    const NUL = Buffer.from([0]);
    const preimage = Buffer.concat([
      Buffer.from("trock.crm.service-rfp-approved.v1", "utf8"), NUL,
      Buffer.from("POST", "utf8"), NUL,
      Buffer.from("/webhooks/crm/dallas/service-rfp/v1", "utf8"), NUL,
      Buffer.from(init.body, "utf8"),
    ]);
    const expected = `sha256=${crypto.createHmac("sha256", "s".repeat(32)).update(preimage).digest("hex")}`;
    expect(init.headers["x-trock-signature"]).toBe(expected);
  });

  it("sends the v1 contract body, with money as a fixed-scale string and no notes echo", async () => {
    await runApproval();

    expect(corePostBody()).toEqual({
      version: "trock.crm.service-rfp-approved.v1",
      office: "dallas",
      occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      rfp: { requestId: 77, approvedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
      deal: { id: CRM_DEAL_ID, rfpProjectNumber: "DFW-4-12345-aa" },
      company: { id: CRM_COMPANY_ID, name: "Acme Retail" },
      primaryContact: { name: "Dana Ruiz", email: "Dana.Ruiz@acme.example", businessPhone: "214-555-0134" },
      bid: {
        title: "Roof leak triage",
        estimatedValue: "18500.00",
        dueAt: "2026-09-15T17:00:00.000Z",
        description: "Emergency roof leak at the north entry",
        // `notes` is a verbatim copy of `description` upstream; mapping it would store the string twice.
        notes: null,
      },
      property: {
        id: CRM_PROPERTY_ID,
        name: "1200 Main St",
        address: { line1: "1200 Main St", line2: null, city: "Dallas", state: "TX", postalCode: "75201", country: "US" },
      },
    });
  });

  it("enqueues nothing at all for a NON-service approval", async () => {
    approvalRequest.current = makeRequest(
      { projectNumber: "DFW-2-12345-aa" },
      { project_number: "DFW-2-12345-aa", project_types: "2" },
    );

    await runApproval();

    expect(outboundCalls).toEqual(["playwright"]);
    expect(executedSql()).not.toContain("service_rfp_core_outbox");
  });

  it("bounds the Core call at 5 s so a hung ingress cannot stall the approval", async () => {
    await runApproval();

    expect(vi.mocked(coreFetchMock).mock.calls.at(-1)?.[2]).toBe(5_000);
  });

  describe("fail-open — a Core problem never blocks the Procore create", () => {
    it("leaves the row PENDING and still runs Playwright when Core is unreachable", async () => {
      coreFetchMock.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.4:443"));

      const result = await runApproval();

      expect(result).toMatchObject({ success: true, bidboardProjectId: "BB-123" });
      expect(outboundCalls).toEqual(["core", "playwright"]);
      expect(executedSql()).toContain("status = 'pending'");
      expect(executedSql()).not.toContain("status = 'sent'");
      expect(executedSql()).not.toContain("status = 'failed'");
    });

    it("leaves the row PENDING and still runs Playwright on a Core 500", async () => {
      coreFetchMock.mockResolvedValue(new Response("boom", { status: 500 }));

      const result = await runApproval();

      expect(result).toMatchObject({ success: true, bidboardProjectId: "BB-123" });
      expect(outboundCalls).toEqual(["core", "playwright"]);
      expect(executedSql()).toContain("status = 'pending'");
      expect(executedSql()).not.toContain("status = 'failed'");
    });

    it("leaves the row PENDING and still runs Playwright when the Core call times out", async () => {
      coreFetchMock.mockRejectedValue(
        new Error("Request to https://core.example.com/webhooks/crm/dallas/service-rfp/v1 timed out after 5000ms"),
      );

      const result = await runApproval();

      expect(result).toMatchObject({ success: true, bidboardProjectId: "BB-123" });
      expect(outboundCalls).toEqual(["core", "playwright"]);
      expect(executedSql()).toContain("status = 'pending'");
    });

    it("still runs Playwright when the outbox insert itself throws", async () => {
      dbExecuteMock.mockRejectedValue(new Error("deadlock detected"));

      const result = await runApproval();

      expect(result).toMatchObject({ success: true, bidboardProjectId: "BB-123" });
      expect(outboundCalls).toEqual(["playwright"]);
    });
  });

  describe("refusals are terminal, recorded and alerted — never a silent drop", () => {
    it("marks a 409 FAILED, alerts, and does not retry it", async () => {
      coreFetchMock.mockResolvedValue(
        new Response(JSON.stringify({ error: "service_rfp_conflict", reason: "live_project" }), { status: 409 }),
      );

      const result = await runApproval();

      expect(result).toMatchObject({ success: true, bidboardProjectId: "BB-123" });
      expect(executedSql()).toContain("status = 'failed'");
      // No backoff was scheduled and no second attempt was made: a conflict retried on a schedule is
      // a retry storm against a refusal that can never change.
      expect(executedSql()).not.toContain("next_attempt_at = NOW() +");
      expect(vi.mocked(coreFetchMock)).toHaveBeenCalledTimes(1);
      expect(alertCalls).toHaveLength(1);
      expect(alertCalls[0]).toMatchObject({
        officeSlug: "service-rfp-core:dallas",
        pushResult: { ok: false, status: 409, rejected: true },
      });
      expect(alertCalls[0].pushResult.error).toContain("live_project");
    });

    it("refuses a HUBSPOT-sourced service approval before the POST and alerts", async () => {
      approvalRequest.current = makeRequest({
        sourceSystem: "hubspot",
        sourceDealId: "321011207920",
        hubspotDealId: "321011207920",
      });

      const result = await runApproval();

      expect(result).toMatchObject({ success: true, bidboardProjectId: "BB-123" });
      expect(outboundCalls).toEqual(["playwright"]);
      // A terminal row exists carrying the reason — the refusal is visible, not dropped.
      expect(executedSql()).toContain("service_rfp_core_outbox");
      expect(executedSql()).toContain("source_system_unsupported");
      expect(alertCalls).toHaveLength(1);
      expect(alertCalls[0].pushResult.rejected).toBe(true);
    });

    it("refuses an ATL project number before the POST and alerts", async () => {
      approvalRequest.current = makeRequest(
        { projectNumber: "ATL-4-12345-aa" },
        { project_number: "ATL-4-12345-aa" },
      );

      const result = await runApproval();

      expect(result).toMatchObject({ success: true, bidboardProjectId: "BB-123" });
      expect(outboundCalls).toEqual(["playwright"]);
      expect(executedSql()).toContain("office_unmapped");
      expect(executedSql()).toContain("ATL");
      expect(alertCalls).toHaveLength(1);
      // Namespaced so a Core refusal cannot share alert state with the Bid Board → CRM push, which
      // writes the same table under the bare office slug.
      expect(alertCalls[0].officeSlug).toBe("service-rfp-core:unmapped");
    });

    it("refuses, rather than guesses, when the CRM identity uuids are absent", async () => {
      approvalRequest.current = makeRequest({}, { crm_company_id: null, crm_property_id: null });

      const result = await runApproval();

      expect(result).toMatchObject({ success: true, bidboardProjectId: "BB-123" });
      expect(outboundCalls).toEqual(["playwright"]);
      expect(executedSql()).toContain("missing_crm_identity");
      expect(alertCalls).toHaveLength(1);
    });
  });

  it("posts nothing when a concurrent re-entry already owns the approval", async () => {
    // ON CONFLICT DO NOTHING returns no row: the other in-flight call owns this approval, and a second
    // POST would be a second delivery. processRfpApproval is not idempotent, so this is reachable.
    dbExecuteMock.mockResolvedValue({ rows: [] });

    await runApproval();

    expect(outboundCalls).toEqual(["playwright"]);
  });

  it("builds the Core payload and the Playwright arguments from ONE hoisted value", async () => {
    const { createBidBoardProjectFromDeal } = await import("../server/playwright/bidboard.ts");

    await runApproval({
      dealname: "Edited service title",
      company_name: "Edited Facilities Co",
      city: "Plano",
    });

    const playwrightArgs = vi.mocked(createBidBoardProjectFromDeal).mock.calls.at(-1)?.[0] as any;
    // Same OBJECT, not merely equal values — two independently rebuilt views could still agree here
    // by accident and diverge on the next field someone adds.
    expect(playwrightArgs.options.editedFieldsOverride).toBe(handoffInputs.at(-1).editedFieldsOverride);

    const body = corePostBody();
    expect(body.bid.title).toBe("Edited service title");
    expect(body.company.name).toBe("Edited Facilities Co");
    expect(body.property.address.city).toBe("Plano");
    expect(playwrightArgs.options.editedFieldsOverride).toMatchObject({
      dealname: "Edited service title",
      company_name: "Edited Facilities Co",
      city: "Plano",
    });
  });

  it("re-stamps occurredAt when the worker drains a queued row, and never rewrites approvedAt", async () => {
    // Core enforces a five-minute event-age window on occurredAt. The backoff schedule reaches 2 hours,
    // so a payload replayed verbatim would 401 as stale on every attempt after the first two — the row
    // would dead-letter for a reason that has nothing to do with the job. approvedAt carries the
    // domain fact and is never rewritten.
    const stored = {
      version: "trock.crm.service-rfp-approved.v1",
      office: "dallas",
      occurredAt: "2026-08-01T00:00:00.000Z",
      rfp: { requestId: 77, approvedAt: "2026-08-01T00:00:00.000Z" },
      deal: { id: CRM_DEAL_ID, rfpProjectNumber: "DFW-4-12345-aa" },
      company: { id: CRM_COMPANY_ID, name: "Acme Retail" },
      primaryContact: { name: "Dana Ruiz", email: "dana@acme.example", businessPhone: null },
      bid: { title: "Roof leak triage", estimatedValue: null, dueAt: null, description: null, notes: null },
      property: { id: CRM_PROPERTY_ID, name: "1200 Main St", address: null },
    };
    dbExecuteMock.mockReset();
    dbExecuteMock
      .mockResolvedValueOnce({
        rows: [{
          id: 501,
          attempt_count: 3,
          max_attempts: 5,
          target_url: "https://core.example.com/webhooks/crm/dallas/service-rfp/v1",
          payload: stored,
        }],
      })
      .mockResolvedValue({ rows: [] });
    const { processServiceRfpCoreOutbox } = await import("../server/sync/service-rfp-core-outbox.ts");

    const result = await processServiceRfpCoreOutbox();

    expect(result).toMatchObject({ processed: 1, sent: 1, failed: 0 });
    const body = corePostBody();
    expect(body.occurredAt).not.toBe("2026-08-01T00:00:00.000Z");
    expect(Date.parse(body.occurredAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(body.rfp.approvedAt).toBe("2026-08-01T00:00:00.000Z");
    expect(executedSql()).toContain("status = 'sent'");
  });

  it("claims only its OWN pending, deliverable rows", async () => {
    // The finding this closes: bidboard_create_outbox's claim query has no type filter, so sharing it
    // would let the Playwright worker claim a Core-shaped row and create a second Procore project.
    dbExecuteMock.mockResolvedValue({ rows: [] });
    const { claimPendingServiceRfpCoreRows } = await import("../server/sync/service-rfp-core-outbox.ts");

    await claimPendingServiceRfpCoreRows();

    const claim = executedSql();
    expect(claim).toContain("service_rfp_core_outbox");
    expect(claim).toContain("status = 'pending'");
    // A terminal refusal row has no destination and must never be claimable.
    expect(claim).toContain("target_url IS NOT NULL");
    expect(claim).not.toContain("bidboard_create_outbox");
  });
});
