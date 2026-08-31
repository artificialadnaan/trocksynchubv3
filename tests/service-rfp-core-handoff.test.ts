import { beforeEach, describe, expect, it, vi } from "vitest";

// The Core handoff and the Playwright create are BOTH driven from processRfpApproval, so the harness
// mirrors tests/bidboard-callback-outbox.test.ts: the whole DB layer is a single `db.execute` spy and
// every outbound edge (Core POST, Procore create, alert email) is a mock we can order and inspect.
const dbExecuteMock = vi.hoisted(() => vi.fn());
const approvalRequest = vi.hoisted(() => ({ current: undefined as any }));
const alertCalls = vi.hoisted(() => [] as any[]);
// The alerter's SECOND argument. The debounce/state machine is shared with the Bid Board → CRM push;
// the email copy must not be, so what is passed here is itself an assertion target.
const alertDeps = vi.hoisted(() => [] as any[]);
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

// A wedged alerter: a lock-contended alert-state query, or a mail provider that accepted the
// connection and then stopped talking. sendEmail has no timeout of its own, so this is reachable.
const alertGate = vi.hoisted(() => ({ stalled: false }));

vi.mock("../server/sync/bidboard-crm-alert.ts", () => ({
  recordPushOutcomeAndMaybeAlert: vi.fn(async (args: any, deps: any) => {
    alertCalls.push(args);
    alertDeps.push(deps);
    if (alertGate.stalled) await new Promise(() => {});
    return { action: "alert_failure" };
  }),
  // service-rfp-core-alert renders through this. Identity, not behaviour: the escaping itself is
  // covered against the REAL implementation in tests/service-rfp-core-alert.test.ts.
  escapeHtml: (s: string) => s,
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
const TARGET_URL = "https://core.example.com/webhooks/crm/dallas/service-rfp/v1";

/** A payload as the worker reads it back off a claimed row — already built, already persisted. */
function storedCorePayload() {
  return {
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
}

/**
 * One claimed row, exactly as claimPendingServiceRfpCoreRows returns it. `max_attempts` is left OFF
 * on purpose where the ceiling is under test: the worker then falls back to the module's own
 * constant, so the test measures the shipped ladder rather than a number the fixture supplied.
 */
function claimedRow(fields: Record<string, unknown>) {
  return { id: 501, target_url: TARGET_URL, payload: storedCorePayload(), ...fields };
}

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
    alertDeps.length = 0;
    alertGate.stalled = false;
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

    it("still runs Playwright when the ALERTER wedges, on a refusal", async () => {
      // The outbox row is durable before the alert is dispatched, so nothing about the record depends
      // on this promise — but the approval used to await it, unbounded, in front of the Procore create.
      // The alerter is three DB round-trips plus an SMTP send, none of it inside the Core POST's 5 s.
      alertGate.stalled = true;
      coreFetchMock.mockResolvedValue(
        new Response(JSON.stringify({ reason: "live_project" }), { status: 409 }),
      );

      const result = await runApproval();

      expect(result).toMatchObject({ success: true, bidboardProjectId: "BB-123" });
      expect(outboundCalls).toEqual(["core", "playwright"]);
      // The notification was still handed off — walking away from it does not cancel it.
      expect(alertCalls).toHaveLength(1);
    });

    it("still runs Playwright when the ALERTER wedges on a SUCCESSFUL delivery", async () => {
      // The common case, and the one the recovery-reporting fix newly put an await in front of.
      alertGate.stalled = true;

      const result = await runApproval();

      expect(result).toMatchObject({ success: true, bidboardProjectId: "BB-123" });
      expect(outboundCalls).toEqual(["core", "playwright"]);
    });

    it("finishes a worker tick when the alerter wedges, instead of holding the drain lock", async () => {
      // Same hazard one level down: processServiceRfpCoreOutbox holds outboxWorkerRunning across the
      // await, so a wedged alerter would starve every later interval, not just this tick.
      alertGate.stalled = true;
      coreFetchMock.mockImplementation(
        async () => new Response(JSON.stringify({ reason: "live_project" }), { status: 409 }),
      );
      dbExecuteMock.mockReset();
      dbExecuteMock
        .mockResolvedValueOnce({ rows: [claimedRow({ attempt_count: 2 })] })
        .mockResolvedValue({ rows: [] });
      const { processServiceRfpCoreOutbox } = await import("../server/sync/service-rfp-core-outbox.ts");

      const result = await processServiceRfpCoreOutbox();

      expect(result).toMatchObject({ processed: 1, sent: 0, failed: 1 });
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

    it("DELIVERS an ATL project number — the prefix is the market, not the office", async () => {
      // THIS TEST USED TO ASSERT THE OPPOSITE, and the assertion was the bug. The handoff derived a
      // Core tenant from the project-number prefix and refused anything that was not DFW, so every
      // Atlanta-prefixed service RFP was rejected as "office_unmapped". Two real approvals were lost
      // to it before anyone noticed.
      //
      // The prefix records the MARKET the work is in. Atlanta jobs are run out of the DFW office like
      // everything else, so those approvals had an office all along and the refusal was answering a
      // question nobody asked. One operating office, one tenant.
      approvalRequest.current = makeRequest(
        { projectNumber: "ATL-4-12345-aa" },
        { project_number: "ATL-4-12345-aa" },
      );

      const result = await runApproval();

      expect(result).toMatchObject({ success: true, bidboardProjectId: "BB-123" });
      // Core is told FIRST, then Procore — the ordering the whole feature exists for.
      expect(outboundCalls).toEqual(["core", "playwright"]);
      expect(executedSql()).not.toContain("office_unmapped");
      // …and it is delivered to the one tenant, addressed by that tenant's ingress path.
      const [url] = vi.mocked(coreFetchMock).mock.calls.at(-1) as any[];
      expect(String(url)).toContain("/webhooks/crm/dallas/service-rfp/v1");
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
    dbExecuteMock.mockReset();
    dbExecuteMock
      .mockResolvedValueOnce({ rows: [claimedRow({ attempt_count: 3, max_attempts: 6 })] })
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

  describe("the alert names the system that actually failed, and clears when it recovers", () => {
    it("renders Core copy, not the Bid Board → CRM push's, for a Core refusal", async () => {
      coreFetchMock.mockResolvedValue(
        new Response(JSON.stringify({ reason: "live_project" }), { status: 409 }),
      );

      await runApproval();

      // The shared debounce is reused deliberately; the WORDING is not reusable. A renderer that
      // names the CRM push tells the reader to inspect a table holding no row for this incident.
      const render = alertDeps.at(-1)?.render;
      expect(render).toBeTypeOf("function");
      const { subject, htmlBody } = render({
        kind: "request_rejected",
        office: "service-rfp-core:dallas",
        status: 409,
        error: "Core refused the approval: live_project",
        now: new Date(),
      });
      expect(subject).toContain("TROCK Core");
      expect(`${subject}\n${htmlBody}`).not.toContain("Bid Board");
    });

    it("reports a DELIVERED row to the alerter as a success, so a failing state can recover", async () => {
      await runApproval();

      // Without this the namespaced state stays 'failing' forever: no recovery email is ever sent, and
      // the failure debounce swallows the NEXT incident as a repeat of one that already cleared.
      expect(executedSql()).toContain("status = 'sent'");
      expect(alertCalls).toHaveLength(1);
      expect(alertCalls[0]).toMatchObject({
        officeSlug: "service-rfp-core:dallas",
        pushResult: { ok: true },
      });
    });
  });

  describe("the retry ladder is the one that is declared", () => {
    it("walks every declared interval — including the two-hour retry — before dead-lettering", async () => {
      // 404 is Core serving the ingress DARK: the provisioning state the retryable classification
      // exists for. The last interval is the only thing that carries an approval across a flag flipped
      // more than ~42 minutes after deploy, so a ladder that dead-letters before reaching it silently
      // discards exactly the approvals the classification was written to save.
      coreFetchMock.mockImplementation(async () => new Response("dark", { status: 404 }));
      const { processServiceRfpCoreOutbox, SERVICE_RFP_CORE_BACKOFF_INTERVALS } = await import(
        "../server/sync/service-rfp-core-outbox.ts"
      );

      const scheduled: string[] = [];
      for (let attempt = 1; attempt <= SERVICE_RFP_CORE_BACKOFF_INTERVALS.length + 1; attempt++) {
        dbExecuteMock.mockReset();
        dbExecuteMock
          .mockResolvedValueOnce({ rows: [claimedRow({ attempt_count: attempt })] })
          .mockResolvedValue({ rows: [] });

        await processServiceRfpCoreOutbox();

        const statements = executedSql();
        scheduled.push(
          statements.includes("status = 'dead'")
            ? "dead"
            : SERVICE_RFP_CORE_BACKOFF_INTERVALS.find((interval) => statements.includes(interval)) ?? "none",
        );
      }

      expect(scheduled).toEqual([...SERVICE_RFP_CORE_BACKOFF_INTERVALS, "dead"]);
    });

    it("declares the same ceiling in the migration and the drizzle table as the worker enforces", async () => {
      const { readFile } = await import("node:fs/promises");
      const { SERVICE_RFP_CORE_MAX_ATTEMPTS } = await import("../server/sync/service-rfp-core-outbox.ts");

      // The DB value WINS at runtime — the worker reads max_attempts off the claimed row — so a
      // default below the ladder strands the last interval exactly as the constant did.
      const migration = await readFile(
        new URL("../migrations/0025_create_service_rfp_core_outbox.sql", import.meta.url),
        "utf8",
      );
      expect(migration).toContain(`max_attempts integer NOT NULL DEFAULT ${SERVICE_RFP_CORE_MAX_ATTEMPTS}`);

      const schema = await readFile(new URL("../shared/schema.ts", import.meta.url), "utf8");
      expect(schema).toContain(
        `maxAttempts: integer("max_attempts").notNull().default(${SERVICE_RFP_CORE_MAX_ATTEMPTS})`,
      );
    });

    it("dead-letters AND alerts when the missing-secret retries run out", async () => {
      // An unprovisioned secret is retryable, but it is not exempt from the ceiling: each claim still
      // burns an attempt, so the row does stop being retried. Reporting that as 'pending' and skipping
      // the alert is how an approval goes permanently undelivered with nobody told.
      delete process.env.SERVICE_RFP_INGRESS_SECRET_CURRENT;
      dbExecuteMock.mockReset();
      dbExecuteMock
        .mockResolvedValueOnce({ rows: [claimedRow({ attempt_count: 6 })] })
        .mockResolvedValue({ rows: [] });
      const { processServiceRfpCoreOutbox } = await import("../server/sync/service-rfp-core-outbox.ts");

      const result = await processServiceRfpCoreOutbox();

      expect(vi.mocked(coreFetchMock)).not.toHaveBeenCalled();
      expect(executedSql()).toContain("status = 'dead'");
      expect(result).toMatchObject({ processed: 1, sent: 0, failed: 1 });
      expect(alertCalls).toHaveLength(1);
      expect(alertCalls[0]).toMatchObject({
        officeSlug: "service-rfp-core:dallas",
        pushResult: { ok: false, terminalFailure: true },
      });
      expect(alertCalls[0].pushResult.error).toContain("SERVICE_RFP_INGRESS_SECRET_CURRENT");
    });

    it("keeps the row pending, and silent, while the missing-secret retries remain", async () => {
      delete process.env.SERVICE_RFP_INGRESS_SECRET_CURRENT;
      dbExecuteMock.mockReset();
      dbExecuteMock
        .mockResolvedValueOnce({ rows: [claimedRow({ attempt_count: 2 })] })
        .mockResolvedValue({ rows: [] });
      const { processServiceRfpCoreOutbox } = await import("../server/sync/service-rfp-core-outbox.ts");

      await processServiceRfpCoreOutbox();

      expect(executedSql()).toContain("status = 'pending'");
      expect(executedSql()).not.toContain("status = 'dead'");
      // Still provisioning; an email per worker tick would be noise about a knob nobody has set yet.
      expect(alertCalls).toHaveLength(0);
    });
  });
});
