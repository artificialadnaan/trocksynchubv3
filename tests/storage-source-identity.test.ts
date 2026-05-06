import { beforeEach, describe, expect, it, vi } from "vitest";

const rfpApprovalRows = vi.hoisted(() => [] as any[]);
const rfpApprovalEditRows = vi.hoisted(() => [] as any[]);
const tableName = vi.hoisted(() => (table: any) => table?.[Symbol.for("drizzle:Name")]);

vi.mock("../server/db.ts", () => ({
  db: {
    insert: vi.fn((table) => ({
      values: vi.fn((row) => ({
        returning: vi.fn(async () => {
          const rows = tableName(table) === "rfp_approval_edits" ? rfpApprovalEditRows : rfpApprovalRows;
          const inserted = { id: rows.length + 1, createdAt: new Date(), editedAt: new Date(), ...row };
          rows.push(inserted);
          return [inserted];
        }),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn((table) => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(async () => tableName(table) === "rfp_approval_edits" ? rfpApprovalEditRows : rfpApprovalRows),
        })),
      })),
    })),
  },
}));

describe("storage source identity compatibility wrappers", () => {
  beforeEach(() => {
    rfpApprovalRows.length = 0;
    rfpApprovalEditRows.length = 0;
  });

  it("routes legacy HubSpot RFP approval lookups through the source-aware lookup", async () => {
    const { DatabaseStorage } = await import("../server/storage.ts");
    const storage = new DatabaseStorage();
    const sourceLookup = vi.fn().mockResolvedValue({ id: 123 });

    (storage as any).getRfpApprovalRequestBySourceDealId = sourceLookup;

    await storage.getRfpApprovalRequestByDealId("deal-1");

    expect(sourceLookup).toHaveBeenCalledWith("hubspot", "deal-1");
  });

  it("routes legacy HubSpot sync mapping lookups through the source-aware lookup", async () => {
    const { DatabaseStorage } = await import("../server/storage.ts");
    const storage = new DatabaseStorage();
    const sourceLookup = vi.fn().mockResolvedValue({ id: 456 });

    (storage as any).getSyncMappingBySourceDealId = sourceLookup;

    await storage.getSyncMappingByHubspotDealId("deal-2");

    expect(sourceLookup).toHaveBeenCalledWith("hubspot", "deal-2");
  });

  it("round-trips a CRM-sourced RFP approval request without a HubSpot deal ID", async () => {
    const { DatabaseStorage } = await import("../server/storage.ts");
    const { insertRfpApprovalRequestSchema } = await import("../shared/schema.ts");
    const storage = new DatabaseStorage();

    const input = {
      sourceSystem: "trock_crm",
      sourceDealId: "crm-deal-1",
      sourceEventId: "crm-event-1",
      projectNumber: "DFW-2-12345",
      hubspotDealId: null,
      token: "token-1",
      status: "pending",
      dealData: { dealname: "CRM Deal" },
    };

    expect(() => insertRfpApprovalRequestSchema.parse(input)).not.toThrow();

    await storage.createRfpApprovalRequest(input);
    const found = await storage.getRfpApprovalRequestBySourceDealId("trock_crm", "crm-deal-1");

    expect(found).toMatchObject({
      sourceSystem: "trock_crm",
      sourceDealId: "crm-deal-1",
      hubspotDealId: null,
    });
  });

  it("round-trips logged RFP approval edits", async () => {
    const { DatabaseStorage } = await import("../server/storage.ts");
    const storage = new DatabaseStorage();

    const inserted = await storage.createRfpApprovalEdit({
      rfpApprovalRequestId: 42,
      editedFields: { dealname: "Edited deal" },
    });
    const edits = await storage.getRfpApprovalEdits(42);

    expect(inserted).toMatchObject({
      rfpApprovalRequestId: 42,
      editedFields: { dealname: "Edited deal" },
    });
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({
      rfpApprovalRequestId: 42,
      editedFields: { dealname: "Edited deal" },
    });
  });
});
