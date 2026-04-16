import { beforeEach, describe, expect, it, vi } from "vitest";

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
