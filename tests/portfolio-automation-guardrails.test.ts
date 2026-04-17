import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../server/storage.ts", () => ({
  storage: {
    getSyncMappingByBidboardProjectId: vi.fn(),
    updateSyncMapping: vi.fn(),
    createAuditLog: vi.fn(),
    createBidboardAutomationLog: vi.fn(),
    getProcoreProjectByProcoreId: vi.fn(),
    getSyncMappingByPortfolioProjectId: vi.fn(),
    getOAuthToken: vi.fn(),
    upsertOAuthToken: vi.fn(),
    getAutomationConfig: vi.fn(),
  },
}));

vi.mock("../server/index.ts", () => ({
  log: vi.fn(),
}));

vi.mock("../server/playwright/auth.ts", () => ({
  ensureLoggedIn: vi.fn(),
}));

vi.mock("../server/playwright/browser.ts", () => ({
  randomDelay: vi.fn(),
  takeScreenshot: vi.fn(),
}));

describe("portfolio automation guard rails", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("treats the Documents Tool page as not ready while a modal or loading spinner is still visible", async () => {
    const { isDocumentsToolUiSettled } = await import("../server/playwright/portfolio-automation.ts");

    expect(
      isDocumentsToolUiSettled({
        hasModal: true,
        hasLoadingSpinner: false,
      })
    ).toBe(false);

    expect(
      isDocumentsToolUiSettled({
        hasModal: false,
        hasLoadingSpinner: true,
      })
    ).toBe(false);

    expect(
      isDocumentsToolUiSettled({
        hasModal: false,
        hasLoadingSpinner: false,
      })
    ).toBe(true);
  });

  it("does not treat the financial workflow as ready while Procore is still busy after Send to Budget", async () => {
    const { isPortfolioFinancialWorkflowReady } = await import("../server/playwright/portfolio-automation.ts");

    expect(
      isPortfolioFinancialWorkflowReady({
        sendToBudgetVisible: true,
        sendToBudgetEnabled: false,
        createPrimeContractVisible: true,
        createPrimeContractEnabled: false,
        hasModal: true,
        hasLoadingSpinner: true,
      })
    ).toBe(false);

    expect(
      isPortfolioFinancialWorkflowReady({
        sendToBudgetVisible: true,
        sendToBudgetEnabled: false,
        createPrimeContractVisible: true,
        createPrimeContractEnabled: true,
        hasModal: false,
        hasLoadingSpinner: true,
      })
    ).toBe(true);

    expect(
      isPortfolioFinancialWorkflowReady({
        sendToBudgetVisible: true,
        sendToBudgetEnabled: false,
        createPrimeContractVisible: true,
        createPrimeContractEnabled: true,
        hasModal: false,
        hasLoadingSpinner: false,
      })
    ).toBe(true);
  });

  it("detects a mismatch when the actual portfolio project number belongs to a different job", async () => {
    const { detectPortfolioIdentityMismatch } = await import("../server/playwright/portfolio-automation.ts");

    const mismatch = detectPortfolioIdentityMismatch(
      {
        bidboardProjectId: "562949955676785",
        expectedProjectName: "Vitruvian West",
        expectedProjectNumber: "DFW-4-08926-ac",
        expectedHubspotDealId: "318186066630",
      },
      {
        portfolioProjectId: "598134326553811",
        actualProjectName: "Tides Royal Lane North",
        actualProjectNumber: "DFW-4-08626-af",
        linkedHubspotDealId: "318226200296",
        linkedProjectName: "Tides Royal Lane North",
        linkedProjectNumber: "DFW-4-08626-af",
      }
    );

    expect(mismatch).toMatchObject({
      reason: "portfolio_project_number_mismatch",
      expectedProjectNumber: "DFW-4-08926-ac",
      actualProjectNumber: "DFW-4-08626-af",
      linkedHubspotDealId: "318226200296",
    });
  });

  it("does not flag a mismatch when the expected and actual identity align", async () => {
    const { detectPortfolioIdentityMismatch } = await import("../server/playwright/portfolio-automation.ts");

    const mismatch = detectPortfolioIdentityMismatch(
      {
        bidboardProjectId: "562949955676785",
        expectedProjectName: "Vitruvian West",
        expectedProjectNumber: "DFW-4-08926-ac",
        expectedHubspotDealId: "318186066630",
      },
      {
        portfolioProjectId: "598134326553900",
        actualProjectName: "Vitruvian West",
        actualProjectNumber: "DFW-4-08926-ac",
        linkedHubspotDealId: "318186066630",
        linkedProjectName: "Vitruvian West",
        linkedProjectNumber: "DFW-4-08926-ac",
      }
    );

    expect(mismatch).toBeNull();
  });

  it("quarantines the sync mapping and writes an audit log when a mismatch is detected", async () => {
    const { storage } = await import("../server/storage.ts");
    const { quarantinePortfolioIdentityMismatch } = await import("../server/playwright/portfolio-automation.ts");

    vi.mocked(storage.getSyncMappingByBidboardProjectId).mockResolvedValue({
      id: 44,
      bidboardProjectId: "562949955676785",
      bidboardProjectName: "Vitruvian West",
      procoreProjectNumber: "DFW-4-08926-ac",
      hubspotDealId: "318186066630",
      metadata: { proposalId: "3770135" },
    } as any);
    vi.mocked(storage.updateSyncMapping).mockResolvedValue({} as any);
    vi.mocked(storage.createAuditLog).mockResolvedValue({} as any);

    await quarantinePortfolioIdentityMismatch(
      {
        bidboardProjectId: "562949955676785",
        expectedProjectName: "Vitruvian West",
        expectedProjectNumber: "DFW-4-08926-ac",
        expectedHubspotDealId: "318186066630",
      },
      {
        portfolioProjectId: "598134326553811",
        actualProjectName: "Tides Royal Lane North",
        actualProjectNumber: "DFW-4-08626-af",
        linkedHubspotDealId: "318226200296",
        linkedProjectName: "Tides Royal Lane North",
        linkedProjectNumber: "DFW-4-08626-af",
      },
      "portfolio_project_number_mismatch"
    );

    expect(vi.mocked(storage.updateSyncMapping)).toHaveBeenCalledWith(
      44,
      expect.objectContaining({
        metadata: expect.objectContaining({
          proposalId: "3770135",
          portfolioIdentityQuarantine: expect.objectContaining({
            status: "active",
            reason: "portfolio_project_number_mismatch",
            actual: expect.objectContaining({
              portfolioProjectId: "598134326553811",
              actualProjectNumber: "DFW-4-08626-af",
            }),
          }),
        }),
      })
    );
    expect(vi.mocked(storage.createAuditLog)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "portfolio_automation_identity_quarantined",
        entityType: "bidboard_project",
        entityId: "562949955676785",
        status: "error",
      })
    );
  });
});
