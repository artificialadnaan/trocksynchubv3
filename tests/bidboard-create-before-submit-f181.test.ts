import { beforeEach, describe, expect, it, vi } from "vitest";

// F-181 (d9 + a4 11-11): a failed HubSpot stage trigger may be REPLAYED only on positive evidence that no Procore project can
// exist: the create failed before any create control was clicked. The new Bid Board UI creates an empty project at the Create
// dialog's Confirm and auto-saves, so the line is the FIRST create click (bidboard.ts :1143 new UI / :1177 legacy). The create
// result carries `beforeSubmit: true` ONLY on those paths: a failed login, a failed navigation, no Create button, a throw
// before the first click, a HubSpot deal missing from the cache, the beforeCreate abort. Every other failure (an indeterminate
// create, "Project creation failed", any projectId, the number-lookup conflicts) carries no marker, so the webhook treats it
// as manual. Synthetic data only.
vi.mock("../server/db.ts", () => ({ db: {}, pool: {} }));
vi.mock("../server/storage.ts", () => ({
  storage: {
    getHubspotDealByHubspotId: vi.fn(),
    getSyncMappingBySourceDealId: vi.fn(),
    getBidboardMappingByProcoreProjectNumber: vi.fn(),
    getSyncMappingByBidboardProjectId: vi.fn(),
    createSyncMapping: vi.fn(),
    upsertBidboardSyncState: vi.fn(),
    getAutomationConfig: vi.fn(),
    createBidboardAutomationLog: vi.fn(),
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
vi.mock("../server/playwright/auth.ts", () => ({ ensureLoggedIn: vi.fn() }));
vi.mock("../server/playwright/documents.ts", () => ({
  syncHubSpotAttachmentsToBidBoard: vi.fn().mockResolvedValue({ success: true, documentsUploaded: 0, documentsDownloaded: 0, errors: [] }),
  syncAttachmentsListToBidBoard: vi.fn().mockResolvedValue({ success: true, documentsUploaded: 0, documentsDownloaded: 0, errors: [] }),
}));

const { storage } = await import("../server/storage.ts");
const { ensureLoggedIn } = await import("../server/playwright/auth.ts");
const bidboard = await import("../server/playwright/bidboard.ts");

function args(o: { createProject: any; findExistingProject: any; beforeCreate?: any }) {
  return {
    sourceSystem: "trock_crm" as const,
    sourceDealId: "00000000-0000-4000-8000-0000000f1810",
    bidboardStage: "Estimate in Progress",
    normalizedDealData: { dealname: "Synthetic F181 Deal", project_number: "DFW-2-91810-zz", project_types: "2" },
    options: { syncDocuments: false, ...o },
  } as any;
}

const projectData = { name: "Synthetic F181 Deal", projectNumber: "DFW-2-91810-zz", stage: "Estimate in Progress" } as any;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(storage.getSyncMappingBySourceDealId).mockResolvedValue(undefined as any);
  vi.mocked(storage.getBidboardMappingByProcoreProjectNumber).mockResolvedValue(undefined as any);
  vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);
});

describe("F-181: the create result carries beforeSubmit only where no create control was clicked", () => {
  it("the beforeCreate abort is pre-submit evidence (beforeSubmit, no projectId)", async () => {
    const findExistingProject = vi.fn(async () => ({ status: "none" as const }));
    const createProject = vi.fn();
    const beforeCreate = vi.fn(async () => { throw new Error("synthetic submit-record failure"); });
    const result = await bidboard.createBidBoardProjectFromDeal(args({ createProject, findExistingProject, beforeCreate }));
    expect(createProject).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, beforeSubmit: true });
    expect(result.projectId).toBeUndefined();
  });

  it("a HubSpot deal missing from the cache is pre-submit evidence", async () => {
    vi.mocked(storage.getHubspotDealByHubspotId).mockResolvedValue(undefined as any);
    const result = await bidboard.createBidBoardProjectFromDeal("hs-f181-missing");
    expect(result).toMatchObject({ success: false, beforeSubmit: true });
  });

  it("createBidBoardProject: a failed login is pre-submit evidence", async () => {
    vi.mocked(ensureLoggedIn).mockResolvedValue({ page: undefined, success: false, error: "synthetic login refused" } as any);
    const result = await bidboard.createBidBoardProject(projectData);
    expect(result).toMatchObject({ success: false, error: "synthetic login refused", beforeSubmit: true });
  });

  it("createBidBoardProject: a failed navigation (no company configured) is pre-submit evidence", async () => {
    vi.mocked(ensureLoggedIn).mockResolvedValue({ page: { url: () => "about:blank" }, success: true, error: undefined } as any);
    vi.mocked(storage.getAutomationConfig).mockResolvedValue(undefined as any);
    const result = await bidboard.createBidBoardProject(projectData);
    expect(result).toMatchObject({ success: false, error: "Failed to navigate to BidBoard", beforeSubmit: true });
  });

  it("createBidBoardProject: a throw before the first create click is caught as pre-submit evidence", async () => {
    vi.mocked(ensureLoggedIn).mockResolvedValue({ page: { url: () => "about:blank" }, success: true, error: undefined } as any);
    vi.mocked(storage.getAutomationConfig).mockRejectedValue(new Error("synthetic config read failure"));
    const result = await bidboard.createBidBoardProject(projectData);
    expect(result).toMatchObject({ success: false, error: "synthetic config read failure", beforeSubmit: true });
  });

  it("(guard) an indeterminate create stays unmarked through createBidBoardProjectFromDeal; a marked one passes through", async () => {
    const findExistingProject = vi.fn(async () => ({ status: "none" as const }));
    const indeterminate = await bidboard.createBidBoardProjectFromDeal(args({
      findExistingProject,
      createProject: vi.fn(async () => ({ success: false, projectName: "Synthetic F181 Deal", error: "Could not confirm project creation" })),
    }));
    expect(indeterminate.success).toBe(false);
    expect((indeterminate as any).beforeSubmit).toBeUndefined();
    const marked = await bidboard.createBidBoardProjectFromDeal(args({
      findExistingProject,
      createProject: vi.fn(async () => ({ success: false, projectName: "Synthetic F181 Deal", error: "Failed to log in to Procore", beforeSubmit: true })),
    }));
    expect(marked).toMatchObject({ success: false, beforeSubmit: true });
  });

  it("(guard) an ambiguous number lookup is not pre-submit evidence: projects with that number exist", async () => {
    const result = await bidboard.createBidBoardProjectFromDeal(args({
      findExistingProject: vi.fn(async () => ({ status: "ambiguous" as const, count: 2 })),
      createProject: vi.fn(),
    }));
    expect(result.success).toBe(false);
    expect((result as any).beforeSubmit).toBeUndefined();
  });
});
