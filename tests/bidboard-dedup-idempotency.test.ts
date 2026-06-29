import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../server/db.ts", () => ({ db: {}, pool: {} }));

vi.mock("../server/storage.ts", () => ({
  storage: {
    getHubspotDealByHubspotId: vi.fn(),
    getSyncMappingBySourceDealId: vi.fn(),
    getBidboardMappingByProcoreProjectNumber: vi.fn(),
    createSyncMapping: vi.fn(),
    upsertBidboardSyncState: vi.fn(),
    // Used by getCompanyId() inside the default Procore-lookup helper; returns undefined
    // here so the helper short-circuits when no findExistingProject seam is injected.
    getAutomationConfig: vi.fn(),
  },
}));

vi.mock("../server/index.ts", () => ({ log: vi.fn() }));

vi.mock("../server/playwright/browser.ts", () => ({
  closeBrowser: vi.fn(),
  randomDelay: vi.fn(),
  takeScreenshot: vi.fn(),
  waitForNavigation: vi.fn(),
  withBrowserLock: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
  withRetry: vi.fn(),
}));

vi.mock("../server/playwright/auth.ts", () => ({
  ensureLoggedIn: vi.fn().mockResolvedValue({ page: { stub: true }, success: true, error: undefined }),
}));

vi.mock("../server/playwright/documents.ts", () => ({
  syncHubSpotAttachmentsToBidBoard: vi.fn().mockResolvedValue({ success: true, documentsUploaded: 0, documentsDownloaded: 0, errors: [] }),
  syncAttachmentsListToBidBoard: vi.fn().mockResolvedValue({ success: true, documentsUploaded: 0, documentsDownloaded: 0, errors: [] }),
}));

const crmArgs = (createProject: any) => ({
  sourceSystem: "trock_crm" as const,
  sourceDealId: "a1c59631",
  bidboardStage: "Service – Estimating",
  normalizedDealData: { dealname: "jasonn ranches", project_number: "DFW-4-16226-ae", project_types: "4" },
  options: { syncDocuments: false, createProject },
});

describe("createBidBoardProjectFromDeal idempotency", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("adopts the deal's existing BidBoard project instead of creating a duplicate", async () => {
    const { storage } = await import("../server/storage.ts");
    const bidboard = await import("../server/playwright/bidboard.ts");

    vi.mocked(storage.getSyncMappingBySourceDealId).mockResolvedValue({
      sourceSystem: "trock_crm",
      sourceDealId: "a1c59631",
      bidboardProjectId: "562949955849463",
      bidboardProjectName: "jasonn ranches",
      procoreProjectNumber: "DFW-4-16226-ae",
    } as any);

    const createProject = vi.fn(async () => ({ success: true, projectId: "562949955849472", projectName: "jasonn ranches" } as any));

    const result = await bidboard.createBidBoardProjectFromDeal(crmArgs(createProject));

    expect(createProject).not.toHaveBeenCalled();
    expect(storage.createSyncMapping).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.projectId).toBe("562949955849463");
    expect(result.adopted).toBe(true);
  });

  it("adopts by project number when the deal has no mapping but the number does", async () => {
    const { storage } = await import("../server/storage.ts");
    const bidboard = await import("../server/playwright/bidboard.ts");

    vi.mocked(storage.getSyncMappingBySourceDealId).mockResolvedValue(undefined as any);
    vi.mocked(storage.getBidboardMappingByProcoreProjectNumber).mockResolvedValue({
      bidboardProjectId: "562949955849463",
      bidboardProjectName: "jasonn ranches",
      procoreProjectNumber: "DFW-4-16226-ae",
    } as any);

    const createProject = vi.fn(async () => ({ success: true, projectId: "562949955849472" } as any));
    const result = await bidboard.createBidBoardProjectFromDeal(crmArgs(createProject));

    expect(createProject).not.toHaveBeenCalled();
    expect(result.projectId).toBe("562949955849463");
    expect(result.adopted).toBe(true);
  });

  it("creates a new project when a deal mapping exists but has no bidboard project id", async () => {
    const { storage } = await import("../server/storage.ts");
    const bidboard = await import("../server/playwright/bidboard.ts");

    vi.mocked(storage.getSyncMappingBySourceDealId).mockResolvedValue({ sourceDealId: "a1c59631", bidboardProjectId: null } as any);
    vi.mocked(storage.getBidboardMappingByProcoreProjectNumber).mockResolvedValue(undefined as any);

    const createProject = vi.fn(async () => ({ success: true, projectId: "562949955849472", projectName: "jasonn ranches" } as any));
    const result = await bidboard.createBidBoardProjectFromDeal(crmArgs(createProject));

    expect(createProject).toHaveBeenCalled();
    expect(result.projectId).toBe("562949955849472");
    expect(result.adopted).toBeFalsy();
  });

  // The Terraces/DFW-1-17326-ad scenario: the SyncHub mapping doesn't exist (the project was
  // created manually in Procore after the UI create flow failed), but a Procore project with the
  // exact number does. We must LINK it — not create a duplicate — and still write the sync mapping
  // (under the project's canonical name, carrying the RFP proposalId) so the deal is connected and
  // documents can sync.
  it("links an existing Procore project by exact number when SyncHub has no mapping (manual creation)", async () => {
    const { storage } = await import("../server/storage.ts");
    const bidboard = await import("../server/playwright/bidboard.ts");

    vi.mocked(storage.getSyncMappingBySourceDealId).mockResolvedValue(undefined as any);
    vi.mocked(storage.getBidboardMappingByProcoreProjectNumber).mockResolvedValue(undefined as any);

    const createProject = vi.fn(async () => ({ success: true, projectId: "should-not-be-used" } as any));
    const findExistingProject = vi.fn(async () => ({
      status: "found" as const,
      id: "999000111",
      name: "Terraces at Highbury Court (canonical)",
    }));

    const result = await bidboard.createBidBoardProjectFromDeal({
      sourceSystem: "trock_crm" as const,
      sourceDealId: "2a4b0d9f",
      bidboardStage: "Estimate in Progress",
      // Requested name deliberately differs from the canonical Procore name to prove we persist canonical.
      normalizedDealData: { dealname: "terraces requested name", project_number: "DFW-1-17326-ad" },
      options: { syncDocuments: false, createProject, findExistingProject, proposalId: "PROP-123" },
    });

    expect(findExistingProject).toHaveBeenCalledWith("DFW-1-17326-ad");
    expect(createProject).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.projectId).toBe("999000111");
    expect(result.adopted).toBe(true);
    // Mapping links the deal to the manually-created project, under its canonical name, and keeps the proposalId.
    expect(storage.createSyncMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        bidboardProjectId: "999000111",
        procoreProjectNumber: "DFW-1-17326-ad",
        bidboardProjectName: "Terraces at Highbury Court (canonical)",
        metadata: { proposalId: "PROP-123" },
      }),
    );
  });

  it("creates a new project when no existing Procore project is found by number", async () => {
    const { storage } = await import("../server/storage.ts");
    const bidboard = await import("../server/playwright/bidboard.ts");

    vi.mocked(storage.getSyncMappingBySourceDealId).mockResolvedValue(undefined as any);
    vi.mocked(storage.getBidboardMappingByProcoreProjectNumber).mockResolvedValue(undefined as any);

    const createProject = vi.fn(async () => ({ success: true, projectId: "562949955849472", projectName: "x" } as any));
    const findExistingProject = vi.fn(async () => ({ status: "none" as const }));

    const result = await bidboard.createBidBoardProjectFromDeal({
      sourceSystem: "trock_crm" as const,
      sourceDealId: "deal-no-match",
      bidboardStage: "Estimate in Progress",
      normalizedDealData: { dealname: "x", project_number: "DFW-1-99999-zz" },
      options: { syncDocuments: false, createProject, findExistingProject },
    });

    expect(findExistingProject).toHaveBeenCalledWith("DFW-1-99999-zz");
    expect(createProject).toHaveBeenCalled();
    expect(result.projectId).toBe("562949955849472");
    expect(result.adopted).toBeFalsy();
  });

  // ≥2 Procore projects already share the exact number: do NOT add a third — stop for manual resolution.
  it("does not create a project when the exact number is ambiguous (>=2 existing)", async () => {
    const { storage } = await import("../server/storage.ts");
    const bidboard = await import("../server/playwright/bidboard.ts");

    vi.mocked(storage.getSyncMappingBySourceDealId).mockResolvedValue(undefined as any);
    vi.mocked(storage.getBidboardMappingByProcoreProjectNumber).mockResolvedValue(undefined as any);

    const createProject = vi.fn(async () => ({ success: true, projectId: "should-not-be-used" } as any));
    const findExistingProject = vi.fn(async () => ({ status: "ambiguous" as const, count: 2 }));

    const result = await bidboard.createBidBoardProjectFromDeal({
      sourceSystem: "trock_crm" as const,
      sourceDealId: "deal-ambiguous",
      bidboardStage: "Estimate in Progress",
      normalizedDealData: { dealname: "dup", project_number: "DFW-1-17326-ad" },
      options: { syncDocuments: false, createProject, findExistingProject },
    });

    expect(createProject).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Multiple BidBoard projects \(2\)/);
    expect(storage.createSyncMapping).not.toHaveBeenCalled();
  });

  // A lookup error must NOT block creation — that would turn a transient Procore API blip into an
  // outage for every RFP. Proceed to create (the pre-existing behaviour).
  it("proceeds to create when the existing-project lookup errors", async () => {
    const { storage } = await import("../server/storage.ts");
    const bidboard = await import("../server/playwright/bidboard.ts");

    vi.mocked(storage.getSyncMappingBySourceDealId).mockResolvedValue(undefined as any);
    vi.mocked(storage.getBidboardMappingByProcoreProjectNumber).mockResolvedValue(undefined as any);

    const createProject = vi.fn(async () => ({ success: true, projectId: "562949955849472" } as any));
    const findExistingProject = vi.fn(async () => ({ status: "error" as const, message: "procore down" }));

    const result = await bidboard.createBidBoardProjectFromDeal({
      sourceSystem: "trock_crm" as const,
      sourceDealId: "deal-lookup-error",
      bidboardStage: "Estimate in Progress",
      normalizedDealData: { dealname: "x", project_number: "DFW-1-55555-yy" },
      options: { syncDocuments: false, createProject, findExistingProject },
    });

    expect(createProject).toHaveBeenCalled();
    expect(result.projectId).toBe("562949955849472");
    expect(result.adopted).toBeFalsy();
  });
});
