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
  // The re-alert window service-rfp-core-alert keys its per-reason memory on.
  realertMinutesFromEnv: () => 60,
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
    deal: { id: CRM_DEAL_ID, rfpProjectNumber: "DFW-4-12345-aa", ownerEmail: null },
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

/** Only the UPDATE statements — an INSERT's ON CONFLICT predicate names states it does not SET. */
function updateStatements(): string {
  return dbExecuteMock.mock.calls
    .map((call) => JSON.stringify(call[0]))
    .filter((text) => /UPDATE/i.test(text) && !/INSERT/i.test(text))
    .join("\n");
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
      // ownerEmail: the fixture deal has none, and the key is still PRESENT (Core checks the exact key set).
      deal: { id: CRM_DEAL_ID, rfpProjectNumber: "DFW-4-12345-aa", ownerEmail: null },
      company: { id: CRM_COMPANY_ID, name: "Acme Retail" },
      primaryContact: { name: "Dana Ruiz", email: "Dana.Ruiz@acme.example", businessPhone: "214-555-0134" },
      bid: {
        title: "Roof leak triage",
        estimatedValue: "18500.00",
        dueAt: "2026-09-15T17:00:00.000Z",
        description: "Emergency roof leak at the north entry",
        // No reviewer note: the deal's `notes` is a verbatim copy of `description` and is never echoed.
        notes: null,
      },
      property: {
        id: CRM_PROPERTY_ID,
        name: "1200 Main St",
        address: { line1: "1200 Main St", line2: null, city: "Dallas", state: "TX", postalCode: "75201", country: "US" },
      },
    });
  });

  /** The body built straight from one approval's inputs — the pure half, no POST. */
  async function buildBody(dealOverrides: Record<string, any> = {}, edited: Record<string, string> = {}) {
    const { buildServiceRfpApprovedBody } = await import("../server/sync/service-rfp-core-outbox.ts");
    const built = buildServiceRfpApprovedBody({
      sourceSystem: "trock_crm",
      sourceDealId: CRM_DEAL_ID,
      rfpRequestId: 77,
      projectNumber: "DFW-4-12345-aa",
      dealData: makeRequest({}, dealOverrides).dealData,
      editedFieldsOverride: edited,
    });
    if (!built.ok) throw new Error(`refused: ${built.detail}`);
    return built.body;
  }

  /** The server's local zone is what the review form renders its date input in; pin it for the test. */
  async function inServerZone<T>(tz: string, fn: () => Promise<T>): Promise<T> {
    const previous = process.env.TZ;
    process.env.TZ = tz;
    try {
      return await fn();
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  }

  describe("bid.dueAt: the form's date-only value keeps an unchanged CRM time, else 5:00 PM Chicago", () => {
    it("keeps the CRM timestamp when the form posts the untouched date", async () => {
      // The form always posts bid_due_date as YYYY-MM-DD; sending that verbatim was midnight UTC.
      await runApproval({ bid_due_date: "2026-09-15" });
      expect(corePostBody().bid.dueAt).toBe("2026-09-15T17:00:00.000Z");
    });

    it("sends a CHANGED date as 5:00 PM CDT (22:00Z)", async () => {
      await runApproval({ bid_due_date: "2026-09-20" });
      expect(corePostBody().bid.dueAt).toBe("2026-09-20T22:00:00.000Z");
    });

    it("sends a winter date as 5:00 PM CST (23:00Z)", async () => {
      expect((await buildBody({}, { bid_due_date: "2026-12-10" })).bid.dueAt).toBe("2026-12-10T23:00:00.000Z");
    });

    it("lands on the right side of both 2026 DST changes", async () => {
      const at = async (date: string) => (await buildBody({}, { bid_due_date: date })).bid.dueAt;
      expect(await at("2026-03-07")).toBe("2026-03-07T23:00:00.000Z");
      expect(await at("2026-03-08")).toBe("2026-03-08T22:00:00.000Z");
      expect(await at("2026-10-31")).toBe("2026-10-31T22:00:00.000Z");
      expect(await at("2026-11-01")).toBe("2026-11-01T23:00:00.000Z");
    });

    it("passes a full timestamp through unchanged", async () => {
      expect((await buildBody({}, { bid_due_date: "2026-09-18T15:30:00Z" })).bid.dueAt).toBe("2026-09-18T15:30:00.000Z");
      // …and the cached CRM timestamp, when nothing was posted at all.
      expect((await buildBody()).bid.dueAt).toBe("2026-09-15T17:00:00.000Z");
    });

    // 10 PM CDT on Sep 15 is Sep 16 UTC: a UTC server's form rendered 09-16, the office calls it 09-15.
    const LATE_EVENING = { bid_due_date: "2026-09-16T03:00:00.000Z" };

    it("treats the date as unchanged when it matches the form's own rendering", async () => {
      await inServerZone("UTC", async () => {
        expect((await buildBody(LATE_EVENING, { bid_due_date: "2026-09-16" })).bid.dueAt).toBe("2026-09-16T03:00:00.000Z");
        expect((await buildBody(LATE_EVENING, { bid_due_date: "2026-09-17" })).bid.dueAt).toBe("2026-09-17T22:00:00.000Z");
      });
    });

    it("only the date the form RENDERED counts as unchanged, not the CRM time's Chicago date (#92 R1)", async () => {
      await inServerZone("UTC", async () => {
        // 10 PM Chicago on Sep 15 renders as 2026-09-16 on a UTC server: leaving it keeps the CRM time ...
        expect((await buildBody(LATE_EVENING, { bid_due_date: "2026-09-16" })).bid.dueAt).toBe("2026-09-16T03:00:00.000Z");
        // ... and picking Sep 15 is a real edit: 5:00 PM Chicago on the date chosen, not the old 10 PM.
        expect((await buildBody(LATE_EVENING, { bid_due_date: "2026-09-15" })).bid.dueAt).toBe("2026-09-15T22:00:00.000Z");
      });
    });

    it("compares against the form's own chain: proposal_due_date first", async () => {
      const deal = { proposal_due_date: "2026-09-10T20:00:00.000Z" };
      expect((await buildBody(deal, { bid_due_date: "2026-09-10" })).bid.dueAt).toBe("2026-09-10T20:00:00.000Z");
    });

    it("never keeps a date-only CRM value as midnight UTC", async () => {
      await inServerZone("UTC", async () => {
        const deal = { bid_due_date: "2026-09-15" };
        expect((await buildBody(deal, { bid_due_date: "2026-09-15" })).bid.dueAt).toBe("2026-09-15T22:00:00.000Z");
      });
    });

    it("an invalid edited due date is not replaced by the cached due_date (#92 CodeRabbit)", async () => {
      const deal = { due_date: "2026-09-15T17:00:00.000Z" };
      expect((await buildBody(deal, { bid_due_date: "2026-02-31" })).bid.dueAt).toBeNull();
      // An EMPTY bid_due_date still falls back to due_date.
      expect((await buildBody(deal, { bid_due_date: "" })).bid.dueAt).toBe("2026-09-15T17:00:00.000Z");
    });

    it("drops a date that does not exist rather than rolling it over", async () => {
      expect((await buildBody({}, { bid_due_date: "2026-02-31" })).bid.dueAt).toBeNull();
    });
  });

  describe("deal.ownerEmail", () => {
    it("sends the deal owner trimmed and lowercased", async () => {
      approvalRequest.current = makeRequest({}, { ownerEmail: "  Pat.Owner@TRockGC.com " });
      await runApproval();
      expect(corePostBody().deal).toEqual({ id: CRM_DEAL_ID, rfpProjectNumber: "DFW-4-12345-aa", ownerEmail: "pat.owner@trockgc.com" });
    });

    it("sends null for an owner that is not an email", async () => {
      expect((await buildBody({ ownerEmail: "Pat Owner" })).deal.ownerEmail).toBeNull();
    });

    it("sends the key as null when the deal has no owner", async () => {
      for (const ownerEmail of [undefined, "", "   "]) {
        const deal = (await buildBody({ ownerEmail })).deal;
        expect(Object.keys(deal)).toContain("ownerEmail");
        expect(deal.ownerEmail).toBeNull();
      }
    });
  });

  describe("bid.notes carries only a note the reviewer wrote", () => {
    it("sends a reviewer's own note", async () => {
      await runApproval({ notes: "Gate code 4411; call the super before arriving" });
      expect(corePostBody().bid.notes).toBe("Gate code 4411; call the super before arriving");
    });

    it("sends null for the untouched, prefilled Notes box", async () => {
      // The prefill is the deal's own `notes`, here different from the description; a browser posts its
      // newlines as CRLF, which the wire coercion folds exactly as it folds the stored value.
      const deal = { notes: "Prefilled line one\nline two" };
      expect((await buildBody(deal, { notes: "Prefilled line one\r\nline two" })).bid.notes).toBeNull();
    });

    it("sends null for a note that only repeats the description being sent", async () => {
      const edited = { description: "Re-scoped: north entry only", notes: "Re-scoped: north entry only" };
      expect((await buildBody({}, edited)).bid.notes).toBeNull();
    });

    it("sends only what a reviewer typed AFTER the prefilled text (#92 R1)", async () => {
      const deal = { notes: "Prefilled line one\nline two" };
      expect((await buildBody(deal, { notes: "Prefilled line one\r\nline two\r\nGate code 4411" })).bid.notes).toBe("Gate code 4411");
    });

    it("sends null for an empty note", async () => {
      expect((await buildBody({}, { notes: "   " })).bid.notes).toBeNull();
    });
  });

  it("sends a PARTIAL address as null — Core's parseAddress refuses the whole body for one", async () => {
    // Deliberately NOT sent partially: Core requires line1, city, state and postalCode together.
    for (const missing of ["address", "city", "state", "zip"]) {
      const body = await buildBody({ [missing]: null });
      expect(body.property.address).toBeNull();
    }
  });

  it("names the job site with the CRM property's NAME, the street staying in the address", async () => {
    approvalRequest.current = makeRequest({}, { crm_property_name: "Tides North Dallas" });
    await runApproval();
    expect(corePostBody().property).toEqual({
      id: CRM_PROPERTY_ID,
      name: "Tides North Dallas",
      address: { line1: "1200 Main St", line2: null, city: "Dallas", state: "TX", postalCode: "75201", country: "US" },
    });
  });

  it("keeps the CRM property name through the intake schema (zod would strip an undeclared key)", async () => {
    const { rfpRequestBodySchema } = await import("../server/routes/rfp-requests.ts");
    const parsed = rfpRequestBodySchema.safeParse({
      sourceSystem: "trock_crm",
      sourceDealId: CRM_DEAL_ID,
      sourceEventId: "evt-1",
      deal: {
        name: "Tides North Dallas - Roof leak",
        projectNumber: "DFW-4-12345-aa",
        projectType: "4",
        amount: null,
        estimator: null,
        propertyId: CRM_PROPERTY_ID,
        propertyName: "Tides North Dallas",
        companyName: "Acme Retail",
        contactName: null,
        clientEmail: null,
        clientPhone: null,
        address: { street: "1200 Main St", city: "Dallas", state: "TX", zip: "75201", country: "US" },
        description: null,
        dueDate: null,
        workflowRoute: null,
      },
      attachments: [],
    });
    expect(parsed.success && parsed.data.deal.propertyName).toBe("Tides North Dallas");
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
      // Asserted on the UPDATE statements only. The INSERT's ON CONFLICT predicate legitimately mentions
      // `status = 'failed'` — it is the guard that lets a corrected re-approval replace a never-sent
      // refusal row — so a substring match across ALL executed SQL now reads that guard as an outcome.
      // What these assert is that nothing MARKED the row sent or failed, which is the fail-open property.
      expect(updateStatements()).not.toContain("status = 'sent'");
      expect(updateStatements()).not.toContain("status = 'failed'");
    });

    it("leaves the row PENDING and still runs Playwright on a Core 500", async () => {
      coreFetchMock.mockResolvedValue(new Response("boom", { status: 500 }));

      const result = await runApproval();

      expect(result).toMatchObject({ success: true, bidboardProjectId: "BB-123" });
      expect(outboundCalls).toEqual(["core", "playwright"]);
      expect(executedSql()).toContain("status = 'pending'");
      // UPDATEs only — see the note above: the INSERT's ON CONFLICT guard names 'failed' without setting it.
      expect(updateStatements()).not.toContain("status = 'failed'");
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

  describe("a deal with no usable contact email still reaches Core, with primaryContact: null", () => {
    /** The exact bytes POSTed — `null` must be ON THE WIRE, not merely absent from a parsed object. */
    function corePostRawBody(): string {
      const call = vi.mocked(coreFetchMock).mock.calls.at(-1) as any[] | undefined;
      return call ? String(call[1].body) : "";
    }

    it("POSTs primaryContact: null, rather than refusing, when the deal has no contact email", async () => {
      approvalRequest.current = makeRequest({}, { client_email: "" });

      const result = await runApproval();

      expect(result).toMatchObject({ success: true, bidboardProjectId: "BB-123" });
      expect(outboundCalls).toEqual(["core", "playwright"]);
      expect(executedSql()).not.toContain("missing_required_field");
      // The KEY is present and explicitly null: Core's parser demands the exact key set.
      expect(corePostRawBody()).toContain('"primaryContact":null');
      expect(corePostBody()).toHaveProperty("primaryContact", null);
    });

    it("sends null for a NAME with no email — Core requires an email on any contact it is sent", async () => {
      approvalRequest.current = makeRequest({}, { contact_name: "Dana Ruiz", client_email: "dana at acme" });

      await runApproval();

      expect(outboundCalls).toEqual(["core", "playwright"]);
      expect(corePostBody().primaryContact).toBeNull();
      expect(executedSql()).not.toContain("missing_required_field");
    });

    it("sends null when the deal has no contact at all", async () => {
      approvalRequest.current = makeRequest({}, { contact_name: null, client_email: null, client_phone: null });

      await runApproval();

      expect(outboundCalls).toEqual(["core", "playwright"]);
      expect(corePostBody().primaryContact).toBeNull();
    });

    it("leaves a deal WITH a valid contact email unchanged", async () => {
      await runApproval();

      expect(corePostBody().primaryContact).toEqual({
        name: "Dana Ruiz",
        email: "Dana.Ruiz@acme.example",
        businessPhone: "214-555-0134",
      });
    });

    it("still refuses a valid email with no contact NAME, rather than dropping a real address", async () => {
      approvalRequest.current = makeRequest({}, { contact_name: "" });

      await runApproval();

      expect(outboundCalls).toEqual(["playwright"]);
      expect(executedSql()).toContain("missing_required_field");
      expect(executedSql()).toContain("contact name");
    });

    it("still refuses a missing COMPANY name before the POST, with or without a contact", async () => {
      approvalRequest.current = makeRequest({}, { company_name: "", client_email: "" });

      await runApproval();

      expect(outboundCalls).toEqual(["playwright"]);
      expect(executedSql()).toContain("missing_required_field");
      expect(executedSql()).toContain("company name");
      expect(executedSql()).not.toContain("contact email");
    });

    it("still refuses a missing PROPERTY identity before the POST, with or without a contact", async () => {
      approvalRequest.current = makeRequest({}, { crm_property_id: null, client_email: "" });

      await runApproval();

      expect(outboundCalls).toEqual(["playwright"]);
      expect(executedSql()).toContain("missing_crm_identity");
      expect(executedSql()).toContain("non-canonical: property");
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

  it("a REDELIVERY differs from the first send in occurredAt and NOTHING else [Codex #76]", async () => {
    // THE CLAIM THIS GUARDS: a retry is recognisable to Core as the same approval. Core keys idempotency
    // on an ordered semantic projection that excludes occurredAt, so if any OTHER field moved between
    // attempts the retry would read as a CORRECTION — re-entering the newest-wins update path and
    // overwriting whatever an estimator had changed on the still-pre-award card.
    //
    // Asserted across two REAL SENDS rather than two builder calls. The builder never applies
    // stampOccurredAt (it is module-private, applied at send time), so a builder-only comparison passes
    // even if that transformation is deleted or starts rewriting a semantic field — which is exactly the
    // regression this is supposed to catch.
    // The FIRST send: the ordinary approval path posts to Core.
    await runApproval();
    const first = corePostBody();
    expect(first, "the approval must have POSTed once before we redeliver it").toBeTruthy();

    // …now redeliver the SAME row through the worker.
    dbExecuteMock.mockReset();
    dbExecuteMock
      // The claimed row carries THE BODY THE FIRST SEND STORED — otherwise this compares two different
      // rows and the assertion is meaningless (the fixture's stub payload nulls half the bid fields).
      .mockResolvedValueOnce({
        rows: [claimedRow({ attempt_count: 2, max_attempts: 6, payload: first })],
      })
      .mockResolvedValue({ rows: [] });
    const { processServiceRfpCoreOutbox } = await import("../server/sync/service-rfp-core-outbox.ts");
    // ADVANCE THE CLOCK between the sends. Both otherwise land in the same millisecond and the stamps
    // tie, which makes the inequality below flaky rather than false — it would pass or fail on timing.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(first.occurredAt) + 90_000));
    try {
      await processServiceRfpCoreOutbox();
    } finally {
      vi.useRealTimers();
    }
    const second = corePostBody();

    const semantic = (b: any) => {
      const { occurredAt, ...rest } = b;
      return rest;
    };
    // The transport stamp MOVED — proving stampOccurredAt actually ran on this path…
    expect(second.occurredAt).not.toBe(first.occurredAt);
    // …and nothing Core hashes changed with it.
    expect(semantic(second)).toEqual(semantic(first));
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

  /**
   * [Codex #75] A CORRECTABLE REFUSAL MUST NOT BE PERMANENT.
   *
   * A row refused BEFORE any POST — missing CRM uuids, an office with no Core tenant — holds only the
   * reason, carries `target_url` NULL, and is never claimable (the drain requires `target_url IS NOT NULL`).
   * With `ON CONFLICT DO NOTHING`, re-approving the same request after fixing the data hit the unique triple,
   * returned `duplicate`, and delivered nothing: the approval could never reach Core again without hand
   * -editing the table.
   *
   * The guard is the interesting half. Only a row that NEVER LEFT may be replaced; one that already carries a
   * target_url has been POSTed or is queued to be, and overwriting it is how one approval becomes two bids —
   * which is exactly what this unique index exists to prevent.
   */
  describe("a never-sent refusal row can be re-driven by a corrected approval", () => {
    it("upgrades the row in place, and only when it never left AND the retry can actually be delivered", async () => {
      await runApproval();
      const insert = dbExecuteMock.mock.calls
        .map((call) => JSON.stringify(call[0]))
        .find((text) => /INSERT INTO service_rfp_core_outbox/i.test(text));
      expect(insert).toBeDefined();
      // ASSERTED ON THE PREDICATE, NOT THE WHOLE STATEMENT. The SQL carries a long comment that NAMES
      // the states it does not set, so a substring match over the statement passes on PROSE — which is
      // how an earlier version of this test survived narrowing the predicate back [Codex #83].
      expect(insert).toContain("DO UPDATE");
      const predicate = String(insert).split("DO UPDATE")[1] ?? "";
      // A TERMINAL row may be replaced: "failed" covers a Core 4xx that kept its target_url, "dead" an
      // exhausted ladder. Restricting this to never-sent rows is what missed the motivating case.
      expect(predicate).toMatch(/status IN \('failed', ?'dead'\)/);
      // …and only when THIS attempt is deliverable, so a refusal cannot clobber a real queued row.
      expect(predicate).toContain("EXCLUDED.target_url IS NOT NULL");
      // "pending" is never replaceable: overwriting an in-flight row races the worker.
      expect(predicate).not.toContain("'pending'");
    });
  });
});
