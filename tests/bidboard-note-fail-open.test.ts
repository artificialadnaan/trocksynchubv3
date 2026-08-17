import { beforeEach, describe, expect, it, vi } from "vitest";

// The CRM activity note is posted at the END of createBidBoardProjectFromDeal and is FAIL-OPEN: creating
// the project is the critical path, a note is not. These tests pin that — a note step that throws, or
// that returns a failure result, must leave the create successful and every downstream step (sync
// mapping → which is what the create worker requires before it emits the 'created' callback to the CRM)
// untouched.
const postNoteMock = vi.hoisted(() => vi.fn(async () => ({ posted: true, skipped: false }) as any));

vi.mock("../server/db.ts", () => ({ db: {}, pool: {} }));
vi.mock("../server/storage.ts", () => ({
  storage: {
    getHubspotDealByHubspotId: vi.fn(),
    getSyncMappingBySourceDealId: vi.fn(),
    getBidboardMappingByProcoreProjectNumber: vi.fn(),
    getSyncMappingByBidboardProjectId: vi.fn(),
    createSyncMapping: vi.fn(),
    upsertBidboardSyncState: vi.fn(),
    createBidboardAutomationLog: vi.fn(),
    createAuditLog: vi.fn(),
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
vi.mock("../server/playwright/bidboard-notes.ts", () => ({ postBidBoardProjectNote: postNoteMock }));
vi.mock("../server/playwright/documents.ts", () => ({
  syncHubSpotAttachmentsToBidBoard: vi.fn().mockResolvedValue({ success: true, documentsUploaded: 0, documentsDownloaded: 0, errors: [] }),
  syncAttachmentsListToBidBoard: vi.fn().mockResolvedValue({ success: true, documentsUploaded: 0, documentsDownloaded: 0, errors: [] }),
}));

const ACTIVITY_LOG = "CRM Activity Log — DFW-4-16226-ae (as of Aug 17, 2026)\n\nAug 14, 2026 · Call · Jane Rep\n  Owner confirmed scope.";

function crmArgs(overrides: Record<string, any> = {}) {
  return {
    sourceSystem: "trock_crm" as const,
    sourceDealId: "a1c59631",
    bidboardStage: "Service – Estimating",
    normalizedDealData: {
      dealname: "jasonn ranches",
      project_number: "DFW-4-16226-ae",
      project_types: "4",
      crm_activity_log: ACTIVITY_LOG,
      ...overrides,
    },
    options: {
      syncDocuments: false,
      createProject: vi.fn(async () => ({ success: true, projectId: "562949955849472", projectName: "jasonn ranches" } as any)),
    },
  };
}

describe("createBidBoardProjectFromDeal — CRM activity note is fail-open", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    postNoteMock.mockReset();
    postNoteMock.mockResolvedValue({ posted: true, skipped: false } as any);
    const { storage } = await import("../server/storage.ts");
    vi.mocked(storage.getSyncMappingBySourceDealId).mockResolvedValue(undefined as any);
    vi.mocked(storage.getBidboardMappingByProcoreProjectNumber).mockResolvedValue(undefined as any);
    vi.mocked(storage.getAutomationConfig).mockResolvedValue(undefined as any);
  });

  it("posts the note with the created project id, the log text and the project number", async () => {
    const { storage } = await import("../server/storage.ts");
    const bidboard = await import("../server/playwright/bidboard.ts");

    const result = await bidboard.createBidBoardProjectFromDeal(crmArgs());

    expect(result.success).toBe(true);
    expect(postNoteMock).toHaveBeenCalledTimes(1);
    expect(postNoteMock).toHaveBeenCalledWith({ stub: true }, "562949955849472", ACTIVITY_LOG, "DFW-4-16226-ae");
    // A posted note is recorded in the automation log and does NOT raise an audit error row.
    expect(vi.mocked(storage.createBidboardAutomationLog)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "post_crm_activity_note", status: "success", projectId: "562949955849472" }),
    );
    expect(vi.mocked(storage.createAuditLog)).not.toHaveBeenCalled();
  });

  it("does not attempt a note when the CRM sent no activity log", async () => {
    const bidboard = await import("../server/playwright/bidboard.ts");
    const result = await bidboard.createBidBoardProjectFromDeal(crmArgs({ crm_activity_log: "" }));

    expect(result.success).toBe(true);
    expect(postNoteMock).not.toHaveBeenCalled();
  });

  it("keeps the create successful (and still writes the sync mapping) when the note step THROWS", async () => {
    const { storage } = await import("../server/storage.ts");
    const bidboard = await import("../server/playwright/bidboard.ts");
    postNoteMock.mockRejectedValue(new Error("Target page, context or browser has been closed"));

    const result = await bidboard.createBidBoardProjectFromDeal(crmArgs());

    expect(result.success).toBe(true);
    expect(result.projectId).toBe("562949955849472");
    // The sync mapping is the gate the create worker checks before emitting the 'created' callback to
    // the CRM — proving it is still written proves the note failure did not break the callback path.
    expect(vi.mocked(storage.createSyncMapping)).toHaveBeenCalledWith(
      expect.objectContaining({ sourceDealId: "a1c59631", bidboardProjectId: "562949955849472" }),
    );
    // …and the failure is observable rather than silent.
    expect(vi.mocked(storage.createAuditLog)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "bidboard_note_failed", status: "error", entityId: "562949955849472" }),
    );
  });

  it("keeps the create successful when the note step returns a FAILURE result", async () => {
    const { storage } = await import("../server/storage.ts");
    const bidboard = await import("../server/playwright/bidboard.ts");
    postNoteMock.mockResolvedValue({ posted: false, skipped: false, error: "Add-note control not found" } as any);

    const result = await bidboard.createBidBoardProjectFromDeal(crmArgs());

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(vi.mocked(storage.createSyncMapping)).toHaveBeenCalled();
    expect(vi.mocked(storage.createAuditLog)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "bidboard_note_failed", errorMessage: "Add-note control not found" }),
    );
  });

  it("keeps the create successful when even the audit logging fails", async () => {
    const { storage } = await import("../server/storage.ts");
    const bidboard = await import("../server/playwright/bidboard.ts");
    postNoteMock.mockRejectedValue(new Error("note step exploded"));
    vi.mocked(storage.createBidboardAutomationLog).mockRejectedValue(new Error("db down") as any);
    vi.mocked(storage.createAuditLog).mockRejectedValue(new Error("db down") as any);

    const result = await bidboard.createBidBoardProjectFromDeal(crmArgs());

    expect(result.success).toBe(true);
    expect(vi.mocked(storage.createSyncMapping)).toHaveBeenCalled();
  });

  it("a skipped note (marker already present) is recorded, not treated as a failure", async () => {
    const { storage } = await import("../server/storage.ts");
    const bidboard = await import("../server/playwright/bidboard.ts");
    postNoteMock.mockResolvedValue({ posted: false, skipped: true } as any);

    const result = await bidboard.createBidBoardProjectFromDeal(crmArgs());

    expect(result.success).toBe(true);
    expect(vi.mocked(storage.createBidboardAutomationLog)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "post_crm_activity_note", status: "skipped" }),
    );
    expect(vi.mocked(storage.createAuditLog)).not.toHaveBeenCalled();
  });

  it("also posts the note on an ADOPTED pre-existing project (the marker guard prevents duplicates)", async () => {
    const { storage } = await import("../server/storage.ts");
    const bidboard = await import("../server/playwright/bidboard.ts");
    // A Procore project with this exact number already exists and is unclaimed → adopt + link.
    const args = {
      ...crmArgs(),
      options: {
        ...crmArgs().options,
        findExistingProject: vi.fn(async () => ({ status: "found", id: "111222333", name: "jasonn ranches" }) as any),
      },
    };
    vi.mocked(storage.getSyncMappingByBidboardProjectId).mockResolvedValue(undefined as any);

    const result = await bidboard.createBidBoardProjectFromDeal(args);

    expect(result.adopted).toBe(true);
    expect(postNoteMock).toHaveBeenCalledWith({ stub: true }, "111222333", ACTIVITY_LOG, "DFW-4-16226-ae");
  });
});
