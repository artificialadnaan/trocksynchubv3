import { beforeEach, describe, expect, it, vi } from "vitest";

// The CRM activity note is posted by createBidBoardProjectFromDeal and is FAIL-OPEN: creating the
// project is the critical path, a note is not. These tests pin two things:
//
//  1. ORDERING. The note runs only AFTER storage.createSyncMapping — that mapping is the idempotency
//     record the adopt-instead-of-create guard reads, so anything between the Procore create and the
//     mapping widens the window where a hard kill leaves a real project unmapped and the next run
//     creates a duplicate. Asserted by recorded call order, not by "the mapping was written".
//  2. FAIL-OPEN. A note step that throws, or returns a failure, leaves the create successful and is
//     recorded (automation log + a 'bidboard_note_failed' audit row) rather than swallowed silently.
const postNoteMock = vi.hoisted(() => vi.fn());
const callOrder = vi.hoisted(() => [] as string[]);

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

/**
 * Set the note step's outcome while keeping it recorded in the call order.
 *
 * Records start AND done either side of a real timer so the order assertions also pin that the note is
 * AWAITED. A fire-and-forget `void postCrmActivityNoteFailOpen(...)` would still record "start" in the
 * right place but would let createBidBoardProjectFromDeal resolve before "done" — racing the document
 * sync that runs next on the same page under the same browser lock.
 */
function setNoteOutcome(outcome: Error | { posted?: boolean; skipped?: boolean; error?: string }) {
  postNoteMock.mockImplementation(async () => {
    callOrder.push("postNote:start");
    await new Promise((resolve) => setTimeout(resolve, 5));
    callOrder.push("postNote:done");
    if (outcome instanceof Error) throw outcome;
    return { posted: false, skipped: false, ...outcome };
  });
}

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

describe("createBidBoardProjectFromDeal — CRM activity note ordering and fail-open", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    callOrder.length = 0;
    setNoteOutcome({ posted: true });
    const { storage } = await import("../server/storage.ts");
    vi.mocked(storage.createSyncMapping).mockImplementation(async () => {
      callOrder.push("createSyncMapping");
      return {} as any;
    });
    vi.mocked(storage.getSyncMappingBySourceDealId).mockResolvedValue(undefined as any);
    vi.mocked(storage.getBidboardMappingByProcoreProjectNumber).mockResolvedValue(undefined as any);
    vi.mocked(storage.getAutomationConfig).mockResolvedValue(undefined as any);
  });

  it("writes the sync mapping BEFORE attempting the note", async () => {
    // The whole point of the ordering: createSyncMapping is the record the duplicate-project guard
    // reads. A kill during the (brittle, browser-driven) note step must not be able to strand a real
    // Procore project with no mapping — the …849463 vs …849472 duplicate-project class of bug.
    const { storage } = await import("../server/storage.ts");
    const bidboard = await import("../server/playwright/bidboard.ts");

    const result = await bidboard.createBidBoardProjectFromDeal(crmArgs());

    expect(result.success).toBe(true);
    expect(callOrder).toEqual(["createSyncMapping", "postNote:start", "postNote:done"]);
    expect(vi.mocked(storage.createSyncMapping)).toHaveBeenCalledWith(
      expect.objectContaining({ sourceDealId: "a1c59631", bidboardProjectId: "562949955849472" }),
    );
  });

  it("keeps that order even when the note step throws (nothing is retried before the mapping)", async () => {
    const bidboard = await import("../server/playwright/bidboard.ts");
    setNoteOutcome(new Error("Target page, context or browser has been closed"));

    const result = await bidboard.createBidBoardProjectFromDeal(crmArgs());

    expect(result.success).toBe(true);
    expect(callOrder).toEqual(["createSyncMapping", "postNote:start", "postNote:done"]);
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

  it("keeps the create successful when the note step THROWS", async () => {
    const { storage } = await import("../server/storage.ts");
    const bidboard = await import("../server/playwright/bidboard.ts");
    setNoteOutcome(new Error("Target page, context or browser has been closed"));

    const result = await bidboard.createBidBoardProjectFromDeal(crmArgs());

    expect(result.success).toBe(true);
    expect(result.projectId).toBe("562949955849472");
    expect(result.error).toBeUndefined();
    // …and the failure is observable rather than silent.
    expect(vi.mocked(storage.createAuditLog)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "bidboard_note_failed", status: "error", entityId: "562949955849472" }),
    );
  });

  it("keeps the create successful when the note step returns a FAILURE result", async () => {
    const { storage } = await import("../server/storage.ts");
    const bidboard = await import("../server/playwright/bidboard.ts");
    setNoteOutcome({ error: "Add-note control not found" });

    const result = await bidboard.createBidBoardProjectFromDeal(crmArgs());

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(vi.mocked(storage.createAuditLog)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "bidboard_note_failed", errorMessage: "Add-note control not found" }),
    );
  });

  it("keeps the create successful when even the audit logging fails", async () => {
    const { storage } = await import("../server/storage.ts");
    const bidboard = await import("../server/playwright/bidboard.ts");
    setNoteOutcome(new Error("note step exploded"));
    vi.mocked(storage.createBidboardAutomationLog).mockRejectedValue(new Error("db down") as any);
    vi.mocked(storage.createAuditLog).mockRejectedValue(new Error("db down") as any);

    const result = await bidboard.createBidBoardProjectFromDeal(crmArgs());

    expect(result.success).toBe(true);
    expect(callOrder).toEqual(["createSyncMapping", "postNote:start", "postNote:done"]);
  });

  it("a skipped note (marker already present) is recorded, not treated as a failure", async () => {
    const { storage } = await import("../server/storage.ts");
    const bidboard = await import("../server/playwright/bidboard.ts");
    setNoteOutcome({ skipped: true });

    const result = await bidboard.createBidBoardProjectFromDeal(crmArgs());

    expect(result.success).toBe(true);
    expect(vi.mocked(storage.createBidboardAutomationLog)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "post_crm_activity_note", status: "skipped" }),
    );
    expect(vi.mocked(storage.createAuditLog)).not.toHaveBeenCalled();
  });

  it("posts the note on a project ADOPTED by exact number, still after the mapping is written", async () => {
    const { storage } = await import("../server/storage.ts");
    const bidboard = await import("../server/playwright/bidboard.ts");
    // A Procore project with this exact number already exists and is unclaimed → adopt, then map it.
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
    expect(callOrder).toEqual(["createSyncMapping", "postNote:start", "postNote:done"]);
    expect(postNoteMock).toHaveBeenCalledWith({ stub: true }, "111222333", ACTIVITY_LOG, "DFW-4-16226-ae");
  });

  it("posts the note on a project adopted from an EXISTING sync mapping (the early-return path)", async () => {
    // This path returns before createSyncMapping — the mapping is why it's taken — so it needs its own
    // call or a re-run would never (re-)attempt the note. Safe because the marker check makes a repeat
    // a no-op, and it gives a run whose earlier note attempt failed a second chance.
    const { storage } = await import("../server/storage.ts");
    const bidboard = await import("../server/playwright/bidboard.ts");
    vi.mocked(storage.getSyncMappingBySourceDealId).mockResolvedValue({
      sourceSystem: "trock_crm",
      sourceDealId: "a1c59631",
      bidboardProjectId: "562949955849463",
      bidboardProjectName: "jasonn ranches",
      procoreProjectNumber: "DFW-4-16226-ae",
    } as any);
    const args = crmArgs();

    const result = await bidboard.createBidBoardProjectFromDeal(args);

    expect(result).toMatchObject({ success: true, adopted: true, projectId: "562949955849463" });
    expect(args.options.createProject).not.toHaveBeenCalled();
    // No mapping is written on this path (one already exists), so the note is the only recorded step.
    expect(callOrder).toEqual(["postNote:start", "postNote:done"]);
    expect(postNoteMock).toHaveBeenCalledWith({ stub: true }, "562949955849463", ACTIVITY_LOG, "DFW-4-16226-ae");
  });

  it("a note failure on the mapping-adopt path still returns the adopted project", async () => {
    const { storage } = await import("../server/storage.ts");
    const bidboard = await import("../server/playwright/bidboard.ts");
    vi.mocked(storage.getSyncMappingBySourceDealId).mockResolvedValue({
      sourceSystem: "trock_crm",
      sourceDealId: "a1c59631",
      bidboardProjectId: "562949955849463",
    } as any);
    setNoteOutcome(new Error("Notes section not found"));

    const result = await bidboard.createBidBoardProjectFromDeal(crmArgs());

    expect(result).toMatchObject({ success: true, adopted: true, projectId: "562949955849463" });
    expect(vi.mocked(storage.createAuditLog)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "bidboard_note_failed", entityId: "562949955849463" }),
    );
  });

  it("does not attempt a note on the mapping-adopt path when there is no activity log", async () => {
    const { storage } = await import("../server/storage.ts");
    const bidboard = await import("../server/playwright/bidboard.ts");
    vi.mocked(storage.getSyncMappingBySourceDealId).mockResolvedValue({
      sourceDealId: "a1c59631",
      bidboardProjectId: "562949955849463",
    } as any);

    const result = await bidboard.createBidBoardProjectFromDeal(crmArgs({ crm_activity_log: "" }));

    expect(result.adopted).toBe(true);
    expect(postNoteMock).not.toHaveBeenCalled();
  });
});
