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
    // The steps after login (navigate, export, detect, save) are calls inside bidboard.ts itself, which an ESM
    // spy on the module namespace cannot intercept, so the test pins the lock boundary instead: the login that
    // opens the page has to happen INSIDE the lock callback, not before it is taken.
    const { withBrowserLock } = await import("../server/playwright/browser.ts");
    const { ensureLoggedIn } = await import("../server/playwright/auth.ts");
    const bidboard = await import("../server/playwright/bidboard.ts");

    let insideLock = false;
    const loginSawLock: boolean[] = [];
    vi.mocked(withBrowserLock).mockImplementation(async (_name: string, fn: () => Promise<unknown>) => {
      insideLock = true;
      try {
        return await fn();
      } finally {
        insideLock = false;
      }
    });
    vi.mocked(ensureLoggedIn).mockImplementation(async () => {
      loginSawLock.push(insideLock);
      return { page: { stub: true }, success: false, error: "stop after login" } as any;
    });

    const result = await bidboard.runBidBoardExportSync();

    expect(withBrowserLock).toHaveBeenCalledWith("bidboard-export-sync", expect.any(Function));
    expect(loginSawLock).toEqual([true]);
    expect(result.errors).toEqual(["stop after login"]);
  });
});
