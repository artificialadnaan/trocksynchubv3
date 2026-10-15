import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../server/db.ts", () => ({ db: {}, pool: {} }));

vi.mock("../server/storage.ts", () => ({
  storage: {
    getBidboardSyncStates: vi.fn().mockResolvedValue([]),
    upsertBidboardSyncState: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("../server/index.ts", () => ({
  log: vi.fn(),
}));

vi.mock("../server/playwright/auth.ts", () => ({
  ensureLoggedIn: vi.fn().mockResolvedValue({
    page: { stub: true },
    success: true,
    error: undefined,
  }),
}));

vi.mock("../server/playwright/browser.ts", () => ({
  randomDelay: vi.fn(),
  takeScreenshot: vi.fn(),
  waitForNavigation: vi.fn(),
  withRetry: vi.fn(),
  withBrowserLock: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
}));

describe("runBidBoardExportSync", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    // resetAllMocks also wipes the factory's implementations: put back the two the flow needs, or
    // ensureLoggedIn resolves undefined and the sync stops before it ever navigates (red on main 805311716).
    const auth = await import("../server/playwright/auth.ts");
    vi.mocked(auth.ensureLoggedIn).mockResolvedValue({ page: { stub: true }, success: true, error: undefined } as any);
    const browser = await import("../server/playwright/browser.ts");
    vi.mocked(browser.withBrowserLock).mockImplementation(async (_name: string, fn: () => Promise<unknown>) => fn() as any);
  });

  it("runs under the shared browser lock so concurrent flows cannot close its page", async () => {
    const { withBrowserLock } = await import("../server/playwright/browser.ts");
    const bidboard = await import("../server/playwright/bidboard.ts");

    const navigateSpy = vi.spyOn(bidboard, "navigateToBidBoard").mockResolvedValue(true);
    const exportSpy = vi.spyOn(bidboard, "exportBidBoardCsv").mockResolvedValue("/tmp/bidboard-export.xlsx");
    const detectSpy = vi.spyOn(bidboard, "detectStageChanges").mockResolvedValue([]);
    const saveSpy = vi.spyOn(bidboard, "saveBidBoardState").mockResolvedValue();

    const result = await bidboard.runBidBoardExportSync();

    expect(withBrowserLock).toHaveBeenCalledWith("bidboard-export-sync", expect.any(Function));
    expect(navigateSpy).toHaveBeenCalled();
    expect(exportSpy).toHaveBeenCalled();
    expect(detectSpy).toHaveBeenCalled();
    expect(saveSpy).toHaveBeenCalled();
    expect(result.errors).toEqual([]);
  });
});
