import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../server/db.ts", () => ({ db: {}, pool: {} }));

vi.mock("../server/index.ts", () => ({
  log: vi.fn(),
}));

vi.mock("../server/storage.ts", () => ({
  storage: {
    getSettings: vi.fn(),
    getHubspotDealByHubspotId: vi.fn(),
  },
}));

vi.mock("googleapis", () => ({
  google: {
    auth: { OAuth2: vi.fn().mockReturnValue({ setCredentials: vi.fn(), getAccessToken: vi.fn() }) },
    gmail: vi.fn().mockReturnValue({ users: { messages: { send: vi.fn() } } }),
  },
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: vi.fn().mockReturnValue({ sendMail: vi.fn() }) },
  createTransport: vi.fn().mockReturnValue({ sendMail: vi.fn() }),
}));

vi.mock("playwright", () => ({ chromium: { launch: vi.fn() } }));

vi.mock("../server/playwright/browser.ts", () => ({
  ensureLoggedIn: vi.fn(),
  randomDelay: vi.fn(),
  takeScreenshot: vi.fn(),
  withBrowserLock: vi.fn(),
  withRetry: vi.fn(),
  waitForNavigation: vi.fn(),
}));

vi.mock("../server/playwright/auth.ts", () => ({
  ensureLoggedIn: vi.fn(),
}));

function makeTabPage(visibleLabels: string[]) {
  const clicks: string[] = [];
  let currentPattern: RegExp | string | undefined;

  return {
    clicks,
    locator: vi.fn(() => ({
      filter: vi.fn(({ hasText }: { hasText: RegExp | string }) => {
        currentPattern = hasText;
        return {
          first: vi.fn(() => ({
            click: vi.fn(async () => {
              const matched = visibleLabels.find((label) =>
                currentPattern instanceof RegExp
                  ? currentPattern.test(label)
                  : label.includes(String(currentPattern))
              );
              if (!matched) {
                throw new Error(`No tab matched ${String(currentPattern)}`);
              }
              clicks.push(matched);
            }),
          })),
        };
      }),
    })),
  };
}

describe("BidBoard Playwright transition selectors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes old and new estimating tab labels in selector order", async () => {
    const { BIDBOARD_STAGE_TAB_LABELS, PROCORE_SELECTORS } = await import("../server/playwright/selectors.ts");

    expect(BIDBOARD_STAGE_TAB_LABELS.estimating).toEqual(["Estimating", "Estimate in Progress"]);
    expect(PROCORE_SELECTORS.bidboard.newUi.tabEstimateInProgress).toContain(':has-text("Estimating")');
    expect(PROCORE_SELECTORS.bidboard.newUi.tabEstimateInProgress).toContain(':has-text("Estimate in Progress")');
  });

  it("includes all service estimating tab label variants in selector order", async () => {
    const { BIDBOARD_STAGE_TAB_LABELS, PROCORE_SELECTORS } = await import("../server/playwright/selectors.ts");

    expect(BIDBOARD_STAGE_TAB_LABELS.serviceEstimating).toEqual([
      "Service Estimating",
      "Service - Estimating",
      "Service \u2013 Estimating",
    ]);
    expect(PROCORE_SELECTORS.bidboard.newUi.tabServiceEstimating).toContain(':has-text("Service Estimating")');
    expect(PROCORE_SELECTORS.bidboard.newUi.tabServiceEstimating).toContain(':has-text("Service - Estimating")');
    expect(PROCORE_SELECTORS.bidboard.newUi.tabServiceEstimating).toContain(':has-text("Service \u2013 Estimating")');
  });

  it("clicks the new estimating label first when it exists and logs the match", async () => {
    const { log } = await import("../server/index.ts");
    const { clickBidBoardStageTab } = await import("../server/playwright/bidboard.ts");
    const page = makeTabPage(["Estimating", "Estimate in Progress"]);

    const matched = await clickBidBoardStageTab(page as any, "estimating");

    expect(matched).toBe("Estimating");
    expect(page.clicks).toEqual(["Estimating"]);
    expect(log).toHaveBeenCalledWith('BidBoard stage tab matched: "Estimating"', "playwright");
  });

  it("falls back to the old estimating label when the new label is absent", async () => {
    const { log } = await import("../server/index.ts");
    const { clickBidBoardStageTab } = await import("../server/playwright/bidboard.ts");
    const page = makeTabPage(["Estimate in Progress"]);

    const matched = await clickBidBoardStageTab(page as any, "estimating");

    expect(matched).toBe("Estimate in Progress");
    expect(page.clicks).toEqual(["Estimate in Progress"]);
    expect(log).toHaveBeenCalledWith('BidBoard stage tab matched: "Estimate in Progress"', "playwright");
  });

  it.each([
    "Service Estimating",
    "Service - Estimating",
    "Service \u2013 Estimating",
  ])('clicks service estimating tab variant "%s"', async (label) => {
    const { log } = await import("../server/index.ts");
    const { clickBidBoardStageTab } = await import("../server/playwright/bidboard.ts");
    const page = makeTabPage([label]);

    const matched = await clickBidBoardStageTab(page as any, "serviceEstimating");

    expect(matched).toBe(label);
    expect(page.clicks).toEqual([label]);
    expect(log).toHaveBeenCalledWith(`BidBoard stage tab matched: "${label}"`, "playwright");
  });
});
