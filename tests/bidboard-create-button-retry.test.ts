import { describe, expect, it, vi } from "vitest";

// bidboard.ts pulls in db/storage/browser/auth at import time — stub them so the module loads.
vi.mock("../server/db.ts", () => ({ db: {}, pool: {} }));
vi.mock("../server/storage.ts", () => ({ storage: {} }));
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));
vi.mock("../server/playwright/browser.ts", () => ({
  closeBrowser: vi.fn(),
  randomDelay: vi.fn(), // no real delay in the reload-retry path
  takeScreenshot: vi.fn(),
  waitForNavigation: vi.fn(),
  withBrowserLock: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
  withRetry: vi.fn(),
}));
vi.mock("../server/playwright/auth.ts", () => ({ ensureLoggedIn: vi.fn() }));

describe("findCreateNewProjectButton — transient blank-load resilience", () => {
  it("returns the button immediately when it is already present (no reload)", async () => {
    const { findCreateNewProjectButton } = await import("../server/playwright/bidboard.ts");
    const handle = { id: "btn" };
    const page: any = {
      waitForSelector: vi.fn().mockResolvedValue(handle),
      $: vi.fn().mockResolvedValue(handle),
      reload: vi.fn(),
    };

    const result = await findCreateNewProjectButton(page);

    expect(result).toBe(handle);
    expect(page.reload).not.toHaveBeenCalled();
  });

  it("reloads once and retries when the button is missing on first load (the Jun-29 blank-load case)", async () => {
    const { findCreateNewProjectButton } = await import("../server/playwright/bidboard.ts");
    const handle = { id: "btn" };
    const page: any = {
      waitForSelector: vi
        .fn()
        .mockRejectedValueOnce(new Error("locator.waitForSelector: Timeout 15000ms exceeded"))
        .mockResolvedValueOnce(handle),
      $: vi.fn().mockResolvedValue(handle),
      reload: vi.fn().mockResolvedValue(undefined),
    };

    const result = await findCreateNewProjectButton(page);

    expect(page.reload).toHaveBeenCalledTimes(1);
    expect(result).toBe(handle);
  });

  it("returns null when the button never appears, even after a reload", async () => {
    const { findCreateNewProjectButton } = await import("../server/playwright/bidboard.ts");
    const page: any = {
      waitForSelector: vi.fn().mockRejectedValue(new Error("Timeout")),
      $: vi.fn().mockResolvedValue(null),
      reload: vi.fn().mockResolvedValue(undefined),
    };

    const result = await findCreateNewProjectButton(page);

    expect(page.reload).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });
});
