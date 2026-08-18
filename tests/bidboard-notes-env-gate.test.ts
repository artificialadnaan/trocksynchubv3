import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// BIDBOARD_NOTES_ENABLED is a kill switch, default OFF, for the CRM activity-note step inside
// createBidBoardProjectFromDeal.
//
// The point of the flag is COST, not correctness. Every `precise` Notes selector is written from
// Procore's published docs rather than observed DOM, so in production they miss and the step declines —
// but only after navigating to the project and spending up to SECTION_TIMEOUT_MS hunting for a Notes
// card, while holding the GLOBAL browser lock that exports, other creates and the portfolio automation
// all queue behind. These tests pin that "off" means NO browser work at all, not "work, then decline".
const postNoteMock = vi.hoisted(() => vi.fn(async () => ({ posted: true, skipped: false }) as any));
const ensureLoggedInMock = vi.hoisted(() =>
  vi.fn(async () => ({ page: { stub: true }, success: true, error: undefined }) as any),
);
const syncDocumentsMock = vi.hoisted(() =>
  vi.fn(async () => ({ success: true, documentsUploaded: 1, documentsDownloaded: 1, errors: [] })),
);

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
// ensureLoggedIn is the FIRST browser touch in the note step — it is what obtains the shared page.
// If it is never called, nothing can have navigated.
vi.mock("../server/playwright/auth.ts", () => ({ ensureLoggedIn: ensureLoggedInMock }));
vi.mock("../server/playwright/bidboard-notes.ts", () => ({ postBidBoardProjectNote: postNoteMock }));
vi.mock("../server/playwright/documents.ts", () => ({
  syncHubSpotAttachmentsToBidBoard: syncDocumentsMock,
  syncAttachmentsListToBidBoard: syncDocumentsMock,
}));

const ACTIVITY_LOG = "CRM Activity Log — DFW-4-16226-ae (as of Aug 17, 2026)\n\nAug 14, 2026 · Call · Jane Rep";

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
      syncDocuments: true,
      createProject: vi.fn(async () => ({ success: true, projectId: "562949955849472", projectName: "jasonn ranches" } as any)),
    },
  };
}

describe("isBidBoardNotesEnabled", () => {
  it("is OFF unless the value is exactly 'true'", async () => {
    const { isBidBoardNotesEnabled } = await import("../server/playwright/bidboard-notes-flag.ts");
    expect(isBidBoardNotesEnabled({})).toBe(false);
    expect(isBidBoardNotesEnabled({ BIDBOARD_NOTES_ENABLED: "" })).toBe(false);
    expect(isBidBoardNotesEnabled({ BIDBOARD_NOTES_ENABLED: "false" })).toBe(false);
    // Deliberately strict: "1"/"yes"/"TRUE" do NOT enable it. A flag that guards unvalidated selectors
    // touching live Procore projects should only turn on when someone typed exactly what the docs say.
    expect(isBidBoardNotesEnabled({ BIDBOARD_NOTES_ENABLED: "1" })).toBe(false);
    expect(isBidBoardNotesEnabled({ BIDBOARD_NOTES_ENABLED: "TRUE" })).toBe(false);
    expect(isBidBoardNotesEnabled({ BIDBOARD_NOTES_ENABLED: "true" })).toBe(true);
  });

  it("defaults to OFF against the real process env in a clean environment", async () => {
    const { isBidBoardNotesEnabled } = await import("../server/playwright/bidboard-notes-flag.ts");
    delete process.env.BIDBOARD_NOTES_ENABLED;
    expect(isBidBoardNotesEnabled()).toBe(false);
  });
});

describe("createBidBoardProjectFromDeal — BIDBOARD_NOTES_ENABLED gate", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    delete process.env.BIDBOARD_NOTES_ENABLED;
    postNoteMock.mockResolvedValue({ posted: true, skipped: false } as any);
    ensureLoggedInMock.mockResolvedValue({ page: { stub: true }, success: true, error: undefined } as any);
    syncDocumentsMock.mockResolvedValue({ success: true, documentsUploaded: 1, documentsDownloaded: 1, errors: [] });
    const { storage } = await import("../server/storage.ts");
    vi.mocked(storage.getSyncMappingBySourceDealId).mockResolvedValue(undefined as any);
    vi.mocked(storage.getBidboardMappingByProcoreProjectNumber).mockResolvedValue(undefined as any);
    vi.mocked(storage.getAutomationConfig).mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    delete process.env.BIDBOARD_NOTES_ENABLED;
  });

  it("flag OFF: does NO browser work — no login, no page, no navigation, no note", async () => {
    const bidboard = await import("../server/playwright/bidboard.ts");

    const result = await bidboard.createBidBoardProjectFromDeal(crmArgs());

    expect(result.success).toBe(true);
    // ensureLoggedIn is what obtains the shared page; never calling it means nothing could navigate.
    expect(ensureLoggedInMock).not.toHaveBeenCalled();
    expect(postNoteMock).not.toHaveBeenCalled();
  });

  it("flag OFF: writes no note bookkeeping either", async () => {
    // Not just the browser work — the automation-log and audit rows the skip branches would write are
    // also suppressed, so a create with the flag off is indistinguishable from one before the feature.
    const { storage } = await import("../server/storage.ts");
    const bidboard = await import("../server/playwright/bidboard.ts");

    await bidboard.createBidBoardProjectFromDeal(crmArgs());

    const noteLogs = vi
      .mocked(storage.createBidboardAutomationLog)
      .mock.calls.filter(([row]: any[]) => row?.action === "post_crm_activity_note");
    expect(noteLogs).toEqual([]);
    expect(vi.mocked(storage.createAuditLog)).not.toHaveBeenCalled();
  });

  it("flag OFF: the rest of the create is untouched — project, mapping and documents all still run", async () => {
    const { storage } = await import("../server/storage.ts");
    const bidboard = await import("../server/playwright/bidboard.ts");
    const args = crmArgs();

    const result = await bidboard.createBidBoardProjectFromDeal(args);

    expect(args.options.createProject).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true, projectId: "562949955849472" });
    expect(vi.mocked(storage.createSyncMapping)).toHaveBeenCalledWith(
      expect.objectContaining({ sourceDealId: "a1c59631", bidboardProjectId: "562949955849472" }),
    );
    expect(syncDocumentsMock).toHaveBeenCalledTimes(1);
  });

  it("flag OFF: no note on the adopt path either", async () => {
    const { storage } = await import("../server/storage.ts");
    const bidboard = await import("../server/playwright/bidboard.ts");
    vi.mocked(storage.getSyncMappingBySourceDealId).mockResolvedValue({
      sourceSystem: "trock_crm",
      sourceDealId: "a1c59631",
      bidboardProjectId: "562949955849463",
    } as any);

    const result = await bidboard.createBidBoardProjectFromDeal(crmArgs());

    expect(result).toMatchObject({ success: true, adopted: true });
    expect(ensureLoggedInMock).not.toHaveBeenCalled();
    expect(postNoteMock).not.toHaveBeenCalled();
  });

  it("flag ON: behaves exactly as before — the note is posted", async () => {
    process.env.BIDBOARD_NOTES_ENABLED = "true";
    const bidboard = await import("../server/playwright/bidboard.ts");

    const result = await bidboard.createBidBoardProjectFromDeal(crmArgs());

    expect(result.success).toBe(true);
    expect(ensureLoggedInMock).toHaveBeenCalled();
    expect(postNoteMock).toHaveBeenCalledWith({ stub: true }, "562949955849472", ACTIVITY_LOG, "DFW-4-16226-ae");
  });

  it("flag ON: still posts on the adopt path", async () => {
    process.env.BIDBOARD_NOTES_ENABLED = "true";
    const { storage } = await import("../server/storage.ts");
    const bidboard = await import("../server/playwright/bidboard.ts");
    vi.mocked(storage.getSyncMappingBySourceDealId).mockResolvedValue({
      sourceSystem: "trock_crm",
      sourceDealId: "a1c59631",
      bidboardProjectId: "562949955849463",
    } as any);

    await bidboard.createBidBoardProjectFromDeal(crmArgs());

    expect(postNoteMock).toHaveBeenCalledWith({ stub: true }, "562949955849463", ACTIVITY_LOG, "DFW-4-16226-ae");
  });
});
