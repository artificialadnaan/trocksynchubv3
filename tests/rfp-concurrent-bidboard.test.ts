import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../server/db.ts", () => ({ db: {}, pool: {} }));

vi.mock("../server/storage.ts", () => ({
  storage: {
    getHubspotDealByHubspotId: vi.fn(),
    getHubspotContactByHubspotId: vi.fn(),
    createSyncMapping: vi.fn(),
    createBidboardAutomationLog: vi.fn(),
  },
}));

vi.mock("../server/index.ts", () => ({
  log: vi.fn(),
}));

vi.mock("../server/playwright/browser.ts", () => ({
  closeBrowser: vi.fn(),
  randomDelay: vi.fn(),
  takeScreenshot: vi.fn(),
  waitForNavigation: vi.fn(),
  withBrowserLock: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
  withRetry: vi.fn(),
}));

vi.mock("../server/playwright/auth.ts", () => ({
  ensureLoggedIn: vi.fn().mockResolvedValue({
    page: { stub: true },
    success: true,
    error: undefined,
  }),
}));

vi.mock("../server/playwright/documents.ts", () => ({
  syncHubSpotAttachmentsToBidBoard: vi.fn().mockResolvedValue({
    success: true,
    documentsUploaded: 0,
    documentsDownloaded: 0,
    errors: [],
  }),
  syncAttachmentsListToBidBoard: vi.fn().mockResolvedValue({
    success: true,
    documentsUploaded: 0,
    documentsDownloaded: 0,
    errors: [],
  }),
}));

describe("createBidBoardProjectFromDeal", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("does not close the shared browser after creating a project", async () => {
    const { storage } = await import("../server/storage.ts");
    const { closeBrowser, withBrowserLock } = await import("../server/playwright/browser.ts");
    const bidboard = await import("../server/playwright/bidboard.ts");

    vi.mocked(storage.getHubspotDealByHubspotId).mockResolvedValue({
      hubspotId: "321011906262",
      dealName: "Infinity on Sunnyvale - Concrete Repair",
      associatedCompanyName: "Infinity on Sunnyvale",
      associatedContactIds: [],
      properties: {
        project_number: "DFW-4-10626-ac",
        project_types: "4",
        company_name: "Infinity on Sunnyvale",
      },
    } as any);

    const createSpy = vi
      .spyOn(bidboard, "createBidBoardProject")
      .mockResolvedValue({
        success: true,
        projectId: "562949955999999",
        projectName: "Infinity on Sunnyvale - Concrete Repair",
      } as any);

    const result = await bidboard.createBidBoardProjectFromDeal("321011906262", "Service – Estimating", {
      syncDocuments: false,
    });

    expect(createSpy).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(closeBrowser).not.toHaveBeenCalled();
    expect(withBrowserLock).toHaveBeenCalledWith("create-bidboard-project-from-deal", expect.any(Function));
  });
});
