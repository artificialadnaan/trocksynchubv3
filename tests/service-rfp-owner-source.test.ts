import { describe, expect, it, vi } from "vitest";

// The deal owner's SOURCE on the service-RFP handoff to TROCK Core (owner 2026-10-14). The CRM sends an optional
// `deal.ownerSource` (assigned_rep / hubspot / creator); SyncHub stores it with the request and puts it on the Core body
// ONLY when it is one of the three and an owner email goes too. Core seats the card owner only from "assigned_rep".
// Absent, the body must be byte-identical to what SyncHub sent before the field existed (Core refuses unknown keys).

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

describe("the Core service-RFP body: deal.ownerSource (owner 2026-10-14)", () => {
  it("carries the owner's source beside a valid owner email", async () => {
    const body = await build({ ownerEmail: "KReeder@TRockGC.com", ownerSource: "assigned_rep" });
    expect(body.deal).toEqual({ id: CRM_DEAL_ID, rfpProjectNumber: "DFW-4-12345-aa", ownerEmail: "kreeder@trockgc.com", ownerSource: "assigned_rep" });
    expect(Object.keys(body.deal)).toEqual(["id", "rfpProjectNumber", "ownerEmail", "ownerSource"]);
  });

  it("is BYTE-IDENTICAL to today's deal when the source is absent, null, unknown, or has no owner email", async () => {
    const today = JSON.stringify((await build({ ownerEmail: "kreeder@trockgc.com" })).deal);
    expect(today).not.toContain("ownerSource");
    for (const extra of [
      { ownerEmail: "kreeder@trockgc.com", ownerSource: null },
      { ownerEmail: "kreeder@trockgc.com", ownerSource: "boss" },
      { ownerEmail: "kreeder@trockgc.com", ownerSource: 7 },
    ]) {
      expect(JSON.stringify((await build(extra)).deal), JSON.stringify(extra)).toBe(today);
    }
    const noEmail = (await build({ ownerSource: "assigned_rep" })).deal;
    expect(noEmail).toEqual({ id: CRM_DEAL_ID, rfpProjectNumber: "DFW-4-12345-aa", ownerEmail: null });
  });
});
