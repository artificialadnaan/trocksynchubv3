import { beforeEach, describe, expect, it, vi } from "vitest";

// bidboard-export.ts (and auth/browser under it) import `log` from server/index.ts, which BOOTS the app on import:
// registerRoutes then rejects with "SESSION_SECRET environment variable is required", an unhandled rejection that
// fails the run though the test passes. Stub it, and the db the storage import pulls, as the other playwright tests do.
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));
vi.mock("../server/db.ts", () => ({ db: {}, pool: {} }));

describe("openBidBoardExportMenu", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("falls back to the generic more-options selector when the svg selector is absent", async () => {
    const { openBidBoardExportMenu } = await import("../server/playwright/bidboard-export.ts");

    const click = vi.fn().mockResolvedValue(undefined);
    const hover = vi.fn().mockResolvedValue(undefined);

    const exportIndicator = {
      first: () => exportIndicator,
      isVisible: vi.fn().mockResolvedValue(true),
    };

    const missingLocator = {
      first: () => missingLocator,
      count: vi.fn().mockResolvedValue(0),
      isVisible: vi.fn().mockResolvedValue(false),
      click: vi.fn().mockResolvedValue(undefined),
    };

    const genericLocator = {
      first: () => genericLocator,
      count: vi.fn().mockResolvedValue(1),
      isVisible: vi.fn().mockResolvedValue(true),
      click,
      hover,
    };

    const page = {
      locator: vi.fn((selector: string) => {
        if (selector === "text=Export") return exportIndicator;
        if (selector.includes('[data-qa="ci-EllipsisVertical"]')) return missingLocator;
        if (selector.includes("button[aria-label*=\"more\"]")) return genericLocator;
        return missingLocator;
      }),
      keyboard: {
        press: vi.fn().mockResolvedValue(undefined),
      },
    } as any;

    const opened = await openBidBoardExportMenu(page);

    expect(opened).toBe(true);
    expect(click).toHaveBeenCalled();
  });
});

describe("waitForBidBoardReady", () => {
  const spinnerThen = (spinnerPolls: number, menuAfter: number) => {
    let polls = 0;
    const page: any = {
      reload: vi.fn(async () => {}),
      waitForTimeout: vi.fn(async () => {
        polls += 1;
      }),
      locator: vi.fn((selector: string) => {
        const loc: any = {
          count: vi.fn(async () => {
            if (/entry-routes-spinner/.test(selector)) return polls < spinnerPolls ? 1 : 0;
            return polls >= menuAfter ? 1 : 0;
          }),
          isVisible: vi.fn(async () => true),
        };
        loc.first = () => loc;
        return loc;
      }),
    };
    return page;
  };

  it("returns once the spinner is gone AND the menu is on the page", async () => {
    const { waitForBidBoardReady } = await import("../server/playwright/bidboard-export.ts");
    const page = spinnerThen(5, 6);
    expect(await waitForBidBoardReady(page, { timeoutMs: 30_000, pollMs: 1_000 })).toBe(true);
    expect(page.waitForTimeout.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(page.reload).not.toHaveBeenCalled();
  });

  it("reloads once halfway if the page is still spinning, and gives up (false) at the timeout", async () => {
    const { waitForBidBoardReady } = await import("../server/playwright/bidboard-export.ts");
    const page = spinnerThen(1_000, 1_000);
    expect(await waitForBidBoardReady(page, { timeoutMs: 10_000, pollMs: 1_000 })).toBe(false);
    expect(page.reload).toHaveBeenCalledTimes(1);
  });
});

describe("waitForBidBoardReady — CodeRabbit on #115", () => {
  it("a spinner that is attached but HIDDEN does not count as loading", async () => {
    const { waitForBidBoardReady } = await import("../server/playwright/bidboard-export.ts");
    const page: any = {
      waitForTimeout: vi.fn(async () => {}),
      locator: vi.fn((selector: string) => {
        const loc: any = {
          count: vi.fn(async () => 1),
          isVisible: vi.fn(async () => !/entry-routes-spinner/.test(selector)),
        };
        loc.first = () => loc;
        return loc;
      }),
    };
    expect(await waitForBidBoardReady(page, { timeoutMs: 5_000, pollMs: 1_000 })).toBe(true);
    expect(page.waitForTimeout).not.toHaveBeenCalled();
  });

  it("keeps to its time budget: the halfway reload may only use what's left of it", async () => {
    const { waitForBidBoardReady } = await import("../server/playwright/bidboard-export.ts");
    let clock = 0;
    const page: any = {
      reload: vi.fn(async () => {}),
      waitForTimeout: vi.fn(async (ms: number) => {
        clock += ms;
      }),
      locator: vi.fn(() => {
        const loc: any = { count: vi.fn(async () => (1)), isVisible: vi.fn(async () => true) };
        loc.first = () => loc;
        return loc;
      }),
    };
    const ready = await waitForBidBoardReady(page, { timeoutMs: 10_000, pollMs: 1_000, now: () => clock });
    expect(ready).toBe(false);
    expect(page.reload).toHaveBeenCalledTimes(1);
    const reloadTimeout = page.reload.mock.calls[0][0].timeout;
    expect(reloadTimeout).toBeLessThanOrEqual(10_000 - 5_000);
    expect(clock).toBeLessThanOrEqual(10_000);
  });
});
