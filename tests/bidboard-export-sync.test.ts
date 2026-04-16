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
  beforeEach(() => {
    vi.resetAllMocks();
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
