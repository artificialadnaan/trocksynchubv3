import { describe, expect, it, vi } from "vitest";

// The CRM company's bill address on the service-RFP handoff to TROCK Core (Core #2163's `company.billAddress`).
// The CRM sends an optional `deal.companyBillAddress {address, city, state, zip}`; SyncHub stores it with the request
// and puts it on the Core body ONLY when it meets Core's rules (company-address.ts RULES): all four parts present after
// trim, address <= 255, state two letters, ZIP 5 digits or ZIP+4. Anything else is OMITTED, never sent and never a
// refusal: Core 400s a malformed billAddress, so sending one would cost the whole RFP. Absent, the body must be
// byte-identical to what SyncHub sent before the field existed.

vi.mock("../server/db.ts", () => ({ db: { execute: vi.fn() }, pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock("../server/storage.ts", () => ({ storage: {} }));
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));
vi.mock("../server/hubspot.ts", () => ({ getHubSpotClient: vi.fn(), getAccessToken: vi.fn(), getDealOwnerInfo: vi.fn() }));
vi.mock("../server/procore-hubspot-sync.ts", () => ({ resolveHubspotStageId: vi.fn() }));
vi.mock("../server/email-service.ts", () => ({ sendEmail: vi.fn(), renderTemplate: vi.fn(), GLOBAL_CC_RECIPIENTS: [] }));
vi.mock("../server/playwright/bidboard.ts", () => ({ createBidBoardProjectFromDeal: vi.fn() }));
vi.mock("../server/lib/fetch-with-timeout.ts", () => ({ fetchWithTimeout: vi.fn() }));
vi.mock("../server/sync/bidboard-crm-alert.ts", () => ({
  recordPushOutcomeAndMaybeAlert: vi.fn(),
  escapeHtml: (s: string) => s,
  realertMinutesFromEnv: () => 60,
}));

const CRM_DEAL_ID = "9f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const CRM_COMPANY_ID = "11111111-2222-4333-8444-555555555555";
const CRM_PROPERTY_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const APPROVED_AT = new Date("2026-10-09T15:00:00.000Z");

function dealData(extra: Record<string, unknown> = {}) {
  return {
    dealname: "Roof leak triage",
    project_number: "DFW-4-12345-aa",
    project_types: "4",
    amount: 18500,
    company_name: "Acme Retail",
    contact_name: "Dana Ruiz",
    client_email: "dana@acme.example",
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
    ...extra,
  };
}

async function build(extra: Record<string, unknown> = {}) {
  const { buildServiceRfpApprovedBody } = await import("../server/sync/service-rfp-core-outbox.ts");
  const built = buildServiceRfpApprovedBody({
    sourceSystem: "trock_crm",
    sourceDealId: CRM_DEAL_ID,
    rfpRequestId: 77,
    projectNumber: "DFW-4-12345-aa",
    dealData: dealData(extra),
    editedFieldsOverride: {},
    approvedAt: APPROVED_AT,
  });
  if (!built.ok) throw new Error(`refused: ${built.detail}`);
  return built.body;
}

const GOOD = { address: "2601 Network Blvd", city: "Frisco", state: "TX", zip: "75034" };

describe("the Core service-RFP body: company.billAddress (Core #2163)", () => {
  it("carries the CRM company's bill address when all four parts are valid, trimmed", async () => {
    const body = await build({
      crm_company_bill_address: { address: "  2601 Network Blvd ", city: " Frisco", state: "tx ", zip: " 75034-1234 " },
    });
    expect(body.company).toEqual({
      id: CRM_COMPANY_ID,
      name: "Acme Retail",
      billAddress: { address: "2601 Network Blvd", city: "Frisco", state: "tx", zip: "75034-1234" },
    });
    // Exactly Core's key set (exactKeys): id, name, billAddress; and the address exactly its four.
    expect(Object.keys(body.company)).toEqual(["id", "name", "billAddress"]);
    expect(Object.keys((body.company as any).billAddress)).toEqual(["address", "city", "state", "zip"]);
  });

  it("is BYTE-IDENTICAL to today's body when the field is absent, null, or not usable", async () => {
    const absent = JSON.stringify(await build());
    expect(JSON.parse(absent).company).toEqual({ id: CRM_COMPANY_ID, name: "Acme Retail" });
    expect(absent).not.toContain("billAddress");
    for (const unusable of [
      null,
      undefined,
      "2601 Network Blvd, Frisco TX 75034",
      { ...GOOD, city: "" },
      { ...GOOD, city: "   " },
      { address: "2601 Network Blvd", city: "Frisco", state: "TX" },
      { ...GOOD, state: "Tex" },
      { ...GOOD, state: "T1" },
      { ...GOOD, zip: "7503" },
      { ...GOOD, zip: "75034-12" },
      { ...GOOD, zip: 75034 },
      { ...GOOD, address: "x".repeat(256) },
      { ...GOOD, city: "y".repeat(256) },
    ]) {
      expect(JSON.stringify(await build({ crm_company_bill_address: unusable }))).toBe(absent);
    }
  });

  it("never refuses an approval because of the bill address", async () => {
    const { buildServiceRfpApprovedBody } = await import("../server/sync/service-rfp-core-outbox.ts");
    const built = buildServiceRfpApprovedBody({
      sourceSystem: "trock_crm",
      sourceDealId: CRM_DEAL_ID,
      rfpRequestId: 77,
      projectNumber: "DFW-4-12345-aa",
      dealData: dealData({ crm_company_bill_address: { address: 12, city: {}, state: [], zip: null } }),
      editedFieldsOverride: {},
      approvedAt: APPROVED_AT,
    });
    expect(built.ok).toBe(true);
  });

  it("never sends a control character: collapses them like every other wire string (v12 P2 on #107)", async () => {
    const body = await build({
      crm_company_bill_address: { address: "2601\u0007Network\nBlvd", city: "Fri\u0000sco", state: "TX", zip: "75034" },
    });
    expect((body.company as any).billAddress).toEqual({ address: "2601 Network Blvd", city: "Fri sco", state: "TX", zip: "75034" });
    expect(JSON.stringify(body)).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it("omits an address whose part is ONLY control characters", async () => {
    const absent = JSON.stringify(await build());
    expect(JSON.stringify(await build({ crm_company_bill_address: { ...GOOD, city: "\u0001\u0002" } }))).toBe(absent);
  });

  it("accepts the edge values Core accepts: a 255-character street and a ZIP+4", async () => {
    const body = await build({ crm_company_bill_address: { ...GOOD, address: "a".repeat(255), zip: "75034-0001" } });
    expect((body.company as any).billAddress).toEqual({ ...GOOD, address: "a".repeat(255), zip: "75034-0001" });
  });
});

describe("the RFP intake keeps the CRM's companyBillAddress for the handoff", () => {
  const crmBody = (deal: Record<string, unknown> = {}) => ({
    sourceSystem: "trock_crm",
    sourceDealId: CRM_DEAL_ID,
    sourceEventId: "evt-1",
    deal: {
      name: "Acme - Roof", projectNumber: "DFW-4-12345-aa", projectType: "4", amount: null, estimator: null,
      companyName: "Acme Retail", contactName: "Dana Ruiz", clientEmail: "dana@acme.example", clientPhone: null,
      address: null, description: null, dueDate: null, workflowRoute: "service",
      ...deal,
    },
  });

  it("parses a well-formed companyBillAddress and stores it on the request's deal data", async () => {
    const { rfpRequestBodySchema } = await import("../server/routes/rfp-requests.ts");
    const { normalizedDealData } = await import("../server/rfp-approval.ts");
    const parsed = rfpRequestBodySchema.parse(crmBody({ companyBillAddress: GOOD }));
    expect(parsed.deal.companyBillAddress).toEqual(GOOD);
    const stored = normalizedDealData({ ...parsed, attachments: [] } as any, {}, null);
    expect(stored.crm_company_bill_address).toEqual(GOOD);
  });

  it("drops a malformed companyBillAddress instead of refusing the RFP (never a 422)", async () => {
    const { rfpRequestBodySchema } = await import("../server/routes/rfp-requests.ts");
    for (const bad of ["2601 Network Blvd", 42, { address: 1, city: 2, state: 3, zip: 4 }]) {
      const parsed = rfpRequestBodySchema.safeParse(crmBody({ companyBillAddress: bad }));
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.deal.companyBillAddress).toBeUndefined();
    }
  });

  it("stores null when the CRM sent none (bodies before the CRM flag)", async () => {
    const { rfpRequestBodySchema } = await import("../server/routes/rfp-requests.ts");
    const { normalizedDealData } = await import("../server/rfp-approval.ts");
    const parsed = rfpRequestBodySchema.parse(crmBody());
    expect(normalizedDealData({ ...parsed, attachments: [] } as any, {}, null).crm_company_bill_address).toBeNull();
  });
});
