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
    // navigateToBidBoard & co. are called from inside bidboard.ts, where a spy on the module's exports
    // never sees them (ESM), so this test used to fail on main. What it is for is the lock: the flow's
    // first browser step (signing in) must happen INSIDE withBrowserLock("bidboard-export-sync").
    const browser = await import("../server/playwright/browser.ts");
    const auth = await import("../server/playwright/auth.ts");
    let held = false;
    let signedInUnderLock: boolean | null = null;
    vi.mocked(browser.withBrowserLock).mockImplementation(async (_name: string, fn: () => Promise<unknown>) => {
      held = true;
      try {
        return (await fn()) as any;
      } finally {
        held = false;
      }
    });
    vi.mocked(auth.ensureLoggedIn).mockImplementation(async () => {
      signedInUnderLock = held;
      return { page: { stub: true }, success: false, error: "stop here" } as any;
    });
    const bidboard = await import("../server/playwright/bidboard.ts");

    const result = await bidboard.runBidBoardExportSync();

    expect(browser.withBrowserLock).toHaveBeenCalledWith("bidboard-export-sync", expect.any(Function));
    expect(signedInUnderLock).toBe(true);
    expect(result.errors).toEqual(["stop here"]);
  });
});
