import { beforeEach, describe, expect, it, vi } from "vitest";

// S0b-2a (runbook r5; d9 Q1): createBidBoardProjectFromDeal takes a `beforeCreate` option and awaits it after the read-only
// exact-number lookup, immediately BEFORE createProject (createBidBoardProject: login, navigation, any create click). The new
// Bid Board UI creates an empty project at the Create dialog's Confirm and then auto-saves, so there is no single submit
// click: this is the earliest moment a Procore project can exist, and processRfpApproval commits
// rfp_approval_approving.submit_at there (NULL ⇒ the create never started). A hook that throws ABORTS the create (fail closed:
// no evidence, no create). An adopted project is not a create, so the hook never runs for it. Synthetic data only (I7).
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

const { storage } = await import("../server/storage.ts");
const bidboard = await import("../server/playwright/bidboard.ts");

function args(o: { createProject: any; findExistingProject: any; beforeCreate: any }) {
  return {
    sourceSystem: "trock_crm" as const,
    sourceDealId: "00000000-0000-4000-8000-0000000000f4",
    bidboardStage: "Estimate in Progress",
    normalizedDealData: { dealname: "Synthetic Deal", project_number: "DFW-2-54321-cd", project_types: "2" },
    options: { syncDocuments: false, ...o },
  } as any;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(storage.getSyncMappingBySourceDealId).mockResolvedValue(undefined as any);
  vi.mocked(storage.getBidboardMappingByProcoreProjectNumber).mockResolvedValue(undefined as any);
});

describe("createBidBoardProjectFromDeal beforeCreate hook (S0b-2a)", () => {
  it("no existing project ⇒ the hook runs once, after the number lookup and BEFORE createProject", async () => {
    const findExistingProject = vi.fn(async () => ({ status: "none" as const }));
    const createProject = vi.fn(async () => ({ success: true, projectId: "900222", projectName: "Synthetic Deal" }));
    const beforeCreate = vi.fn(async () => {});
    const result = await bidboard.createBidBoardProjectFromDeal(args({ createProject, findExistingProject, beforeCreate }));
    expect(beforeCreate).toHaveBeenCalledTimes(1);
    expect(findExistingProject.mock.invocationCallOrder[0]).toBeLessThan(beforeCreate.mock.invocationCallOrder[0]);
    expect(beforeCreate.mock.invocationCallOrder[0]).toBeLessThan(createProject.mock.invocationCallOrder[0]);
    expect(result).toMatchObject({ success: true, projectId: "900222" });
  });
  it("a hook that throws ABORTS the create: createProject never runs and the result names the failed submit record", async () => {
    const findExistingProject = vi.fn(async () => ({ status: "none" as const }));
    const createProject = vi.fn(async () => ({ success: true, projectId: "900222", projectName: "Synthetic Deal" }));
    const beforeCreate = vi.fn(async () => { throw new Error("synthetic submit-record failure"); });
    const result = await bidboard.createBidBoardProjectFromDeal(args({ createProject, findExistingProject, beforeCreate }));
    expect(createProject).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/synthetic submit-record failure/);
  });
  it("an existing project adopted by number is not a create: the hook never runs (guard)", async () => {
    vi.mocked(storage.getSyncMappingByBidboardProjectId).mockResolvedValue(undefined as any);
    const findExistingProject = vi.fn(async () => ({ status: "found" as const, id: "900333", name: "Synthetic Deal" }));
    const createProject = vi.fn(async () => ({ success: true, projectId: "900222", projectName: "Synthetic Deal" }));
    const beforeCreate = vi.fn(async () => {});
    const result = await bidboard.createBidBoardProjectFromDeal(args({ createProject, findExistingProject, beforeCreate }));
    expect(createProject).not.toHaveBeenCalled();
    expect(beforeCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, projectId: "900333", adopted: true });
  });
  it("without a hook, today's create is unchanged (guard)", async () => {
    const findExistingProject = vi.fn(async () => ({ status: "none" as const }));
    const createProject = vi.fn(async () => ({ success: true, projectId: "900222", projectName: "Synthetic Deal" }));
    const result = await bidboard.createBidBoardProjectFromDeal({ ...args({ createProject, findExistingProject, beforeCreate: undefined }) });
    expect(createProject).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true, projectId: "900222" });
  });
});
