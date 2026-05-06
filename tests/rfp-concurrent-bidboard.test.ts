import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../server/db.ts", () => ({ db: {}, pool: {} }));

vi.mock("../server/storage.ts", () => ({
  storage: {
    getHubspotDealByHubspotId: vi.fn(),
    getHubspotContactByHubspotId: vi.fn(),
    createSyncMapping: vi.fn(),
    createBidboardAutomationLog: vi.fn(),
    upsertBidboardSyncState: vi.fn(),
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

    const createProject = vi.fn(async () => ({
        success: true,
        projectId: "562949955999999",
        projectName: "Infinity on Sunnyvale - Concrete Repair",
      } as any));

    const result = await bidboard.createBidBoardProjectFromDeal("321011906262", "Service – Estimating", {
      syncDocuments: false,
      createProject,
    });

    expect(createProject).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(closeBrowser).not.toHaveBeenCalled();
    expect(withBrowserLock).toHaveBeenCalledWith("create-bidboard-project-from-deal", expect.any(Function));
    expect(vi.mocked(storage.upsertBidboardSyncState)).toHaveBeenCalledWith({
      projectId: "562949955999999",
      projectName: "Infinity on Sunnyvale - Concrete Repair",
      currentStage: "Service – Estimating",
      metadata: expect.objectContaining({
        projectNumber: "DFW-4-10626-ac",
        seededFromCreation: true,
        hubspotDealId: "321011906262",
      }),
    });
  });

  it("uses normalized CRM deal data without a HubSpot deal lookup", async () => {
    const { storage } = await import("../server/storage.ts");
    const bidboard = await import("../server/playwright/bidboard.ts");

    vi.mocked(storage.getHubspotDealByHubspotId).mockResolvedValue(undefined);

    const createProject = vi.fn(async () => ({
        success: true,
        projectId: "562949955888888",
        projectName: "CRM Normalized Project",
      } as any));

    const result = await bidboard.createBidBoardProjectFromDeal({
      sourceSystem: "trock_crm",
      sourceDealId: "crm-deal-uuid",
      bidboardStage: "Estimate in Progress",
      normalizedDealData: {
        dealname: "CRM Normalized Project",
        project_number: "CRM-2-10001",
        project_types: "2",
        estimator: "CRM Estimator",
        company_name: "CRM Client",
        contact_name: "CRM Contact",
        client_email: "crm-contact@example.com",
        client_phone: "555-0101",
        address: "10 Main St",
        city: "Dallas",
        state: "TX",
        zip: "75201",
        country: "US",
        description: "CRM normalized description",
        bid_due_date: "2026-06-01T12:00:00.000Z",
      },
      options: { syncDocuments: false, createProject },
    });

    expect(result.success).toBe(true);
    expect(storage.getHubspotDealByHubspotId).not.toHaveBeenCalled();
    expect(createProject).toHaveBeenCalledWith(expect.objectContaining({
      name: "CRM Normalized Project",
      projectNumber: "CRM-2-10001",
      stage: "Estimate in Progress",
      projectTypes: "2",
      estimator: "CRM Estimator",
      clientName: "CRM Client",
      contactName: "CRM Contact",
      clientEmail: "crm-contact@example.com",
      clientPhone: "555-0101",
      address: "10 Main St",
      city: "Dallas",
      state: "TX",
      zip: "75201",
      country: "US",
      description: "CRM normalized description",
      bidDueDate: "2026-06-01T12:00:00.000Z",
    }));
    expect(storage.createSyncMapping).toHaveBeenCalledWith(expect.objectContaining({
      sourceSystem: "trock_crm",
      sourceDealId: "crm-deal-uuid",
      hubspotDealId: null,
      hubspotDealName: "CRM Normalized Project",
      bidboardProjectId: "562949955888888",
      lastSyncStatus: "created_from_trock_crm",
    }));
  });
});
