import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../server/db.ts", () => ({ db: {}, pool: {} }));

vi.mock("../server/storage.ts", () => ({
  storage: {
    getHubspotDealByHubspotId: vi.fn(),
    getSyncMappingBySourceDealId: vi.fn(),
    getBidboardMappingByProcoreProjectNumber: vi.fn(),
    createSyncMapping: vi.fn(),
    upsertBidboardSyncState: vi.fn(),
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
});
