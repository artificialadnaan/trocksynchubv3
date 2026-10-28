import { beforeEach, describe, expect, it, vi } from "vitest";

// #126 review: drift detection must compare the HubSpot stage NAME, as the fetcher's normalizer does. Comparing the
// internal stage id raised a false stage conflict and reopened a resolved reconciliation project.

const { mockDb, mockStorage } = vi.hoisted(() => {
  const chain = (result: unknown) => {
    const c: any = {};
    for (const m of ["from", "where", "set", "values"]) c[m] = vi.fn(() => c);
    c.limit = vi.fn(async () => result);
    c.then = (resolve: (v: unknown) => unknown) => resolve(undefined);
    return c;
  };
  return {
    mockDb: {
      select: vi.fn(() => chain([{ id: 7, isResolved: true, procoreProjectId: "p-1", hubspotDealId: "h-1" }])),
      delete: vi.fn(() => chain(undefined)),
      insert: vi.fn(() => chain(undefined)),
      update: vi.fn(() => chain(undefined)),
    },
    mockStorage: {
      getProcoreProjectByProcoreId: vi.fn(),
      getHubspotDealByHubspotId: vi.fn(),
    },
  };
});

vi.mock("../server/db", () => ({ db: mockDb }));
vi.mock("../server/storage", () => ({ storage: mockStorage }));

const { detectFieldDrift } = await import("../server/services/reconciliation/guardrails");

const procoreRow = {
  procoreId: "p-1",
  name: "Elm Street Remodel",
  displayName: null,
  projectNumber: "DFW-1-00126-ab",
  address: null,
  city: null,
  stateCode: null,
  zip: null,
  estimatedValue: null,
  totalValue: null,
  stage: "Closed Won",
  projectStageName: "Closed Won",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockStorage.getProcoreProjectByProcoreId.mockResolvedValue(procoreRow);
});

describe("detectFieldDrift stage source (#126)", () => {
  it("compares the HubSpot stage name, not the internal stage id: no drift when the names agree", async () => {
    mockStorage.getHubspotDealByHubspotId.mockResolvedValue({
      hubspotId: "h-1",
      dealName: "Elm Street Remodel",
      amount: null,
      properties: { project_number: "DFW-1-00126-ab" },
      dealStage: "1234567890",
      dealStageName: "Closed Won",
    });

    const result = await detectFieldDrift(7);

    expect(result.newConflicts.filter((c) => c.fieldName === "stage")).toEqual([]);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("still falls back to the internal stage when no name is stored", async () => {
    mockStorage.getHubspotDealByHubspotId.mockResolvedValue({
      hubspotId: "h-1",
      dealName: "Elm Street Remodel",
      amount: null,
      properties: { project_number: "DFW-1-00126-ab" },
      dealStage: "1234567890",
      dealStageName: null,
    });

    const result = await detectFieldDrift(7);

    expect(result.newConflicts.filter((c) => c.fieldName === "stage")).toEqual([
      expect.objectContaining({ procoreValue: "Closed Won", hubspotValue: "1234567890" }),
    ]);
  });
});
