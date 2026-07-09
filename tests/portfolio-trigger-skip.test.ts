/**
 * Real-implementation coverage for triggerPortfolioAutomationFromStageChange's discriminated skip returns.
 *
 * The bidboard-to-portfolio.test.ts suite MOCKS this function, so it proves the caller handles a skip but
 * never proves the function actually PRODUCES one. These tests run the REAL function (storage + browser deps
 * mocked) and assert it returns the skip object — so a regression in the actual `!bidboardProjectId` /
 * `!companyId` branches would be caught.
 *
 * @module tests/portfolio-trigger-skip
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../server/storage.ts", () => ({
  storage: {
    getSyncMappingByHubspotDealId: vi.fn(),
    getSyncMappingByProcoreProjectNumber: vi.fn(),
    getSyncMappings: vi.fn(),
    getHubspotDealByProjectNumber: vi.fn(),
    createSyncMapping: vi.fn(),
    getAutomationConfig: vi.fn(),
  },
}));

vi.mock("../server/index.ts", () => ({ log: vi.fn() }));
vi.mock("../server/playwright/auth.ts", () => ({ ensureLoggedIn: vi.fn() }));
vi.mock("../server/playwright/browser.ts", () => ({ randomDelay: vi.fn(), takeScreenshot: vi.fn() }));

describe("triggerPortfolioAutomationFromStageChange skip returns (real implementation)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns a no_bidboard_project_id skip when the resolved mapping has no bidboard_project_id", async () => {
    const { storage } = await import("../server/storage.ts");
    const { triggerPortfolioAutomationFromStageChange } = await import("../server/playwright/portfolio-automation.ts");

    // Mapping resolves (by HubSpot deal id) but carries NO bidboard_project_id; company id IS configured.
    vi.mocked(storage.getSyncMappingByHubspotDealId).mockResolvedValue({
      hubspotDealId: "hs-1",
      bidboardProjectId: null,
    } as any);
    vi.mocked(storage.getAutomationConfig).mockResolvedValue({
      key: "procore_config",
      value: { companyId: "12345" },
    } as any);

    // projectNumber = null so the project-number fallback lookups (and the browser Phase-1 path) are never hit.
    const result = await triggerPortfolioAutomationFromStageChange("Proj A", null, "Cust A", "hs-1");

    expect(result).toMatchObject({
      skipped: true,
      reason: "no_bidboard_project_id",
      projectName: "Proj A",
      projectNumber: null,
      customerName: "Cust A",
      hubspotDealId: "hs-1",
    });
  });

  it("returns a no_company_id skip when Procore company id is not configured", async () => {
    const { storage } = await import("../server/storage.ts");
    const { triggerPortfolioAutomationFromStageChange } = await import("../server/playwright/portfolio-automation.ts");

    // Even with a bidboard_project_id present, a missing company id short-circuits FIRST.
    vi.mocked(storage.getSyncMappingByHubspotDealId).mockResolvedValue({
      hubspotDealId: "hs-2",
      bidboardProjectId: "562949955000000",
    } as any);
    vi.mocked(storage.getAutomationConfig).mockResolvedValue(undefined as any);

    const result = await triggerPortfolioAutomationFromStageChange("Proj B", null, "Cust B", "hs-2");

    expect(result).toMatchObject({
      skipped: true,
      reason: "no_company_id",
      projectName: "Proj B",
      hubspotDealId: "hs-2",
    });
  });

  it("prioritizes the per-deal no_bidboard_project_id skip over no_company_id during a config outage", async () => {
    const { storage } = await import("../server/storage.ts");
    const { triggerPortfolioAutomationFromStageChange } = await import("../server/playwright/portfolio-automation.ts");

    // Mapping has NO bidboard id AND company id is missing. The per-deal skip must win so the unmapped deal
    // still reaches manual review (not classified as an alert-only global outage that advances + is lost).
    vi.mocked(storage.getSyncMappingByHubspotDealId).mockResolvedValue({
      hubspotDealId: "hs-3",
      bidboardProjectId: null,
    } as any);
    vi.mocked(storage.getAutomationConfig).mockResolvedValue(undefined as any);

    const result = await triggerPortfolioAutomationFromStageChange("Proj C", null, "Cust C", "hs-3");

    expect(result).toMatchObject({ skipped: true, reason: "no_bidboard_project_id" });
  });
});
