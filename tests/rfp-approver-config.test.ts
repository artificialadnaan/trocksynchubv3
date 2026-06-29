import { beforeEach, describe, expect, it, vi } from "vitest";

const getRfpApproverConfigs = vi.hoisted(() => vi.fn());
const approverConfigRows = vi.hoisted(() => [] as Array<{
  projectType: string;
  sourceSystem: string | null;
  approverEmails: string[];
  isActive: boolean;
}>);

function insertApproverConfig(row: {
  projectType: string;
  sourceSystem: string | null;
  approverEmails: string[];
  isActive?: boolean;
}) {
  approverConfigRows.push({ isActive: true, ...row });
}

vi.mock("../server/storage.ts", () => ({
  storage: {
    getRfpApproverConfigs,
  },
}));

vi.mock("../server/hubspot.ts", () => ({
  getHubSpotClient: vi.fn(),
  getAccessToken: vi.fn(),
  getDealOwnerInfo: vi.fn(),
  updateHubSpotDeal: vi.fn(),
  updateHubSpotDealStage: vi.fn(),
  syncSingleHubSpotDeal: vi.fn(),
}));

vi.mock("../server/email-service.ts", () => ({
  sendEmail: vi.fn(),
  renderTemplate: vi.fn(),
}));

vi.mock("../server/procore-hubspot-sync.ts", () => ({
  resolveHubspotStageId: vi.fn(),
}));

vi.mock("../server/index.ts", () => ({
  log: vi.fn(),
}));

describe("getRfpReviewRecipients", () => {
  beforeEach(() => {
    vi.resetModules();
    getRfpApproverConfigs.mockReset();
    approverConfigRows.length = 0;
    getRfpApproverConfigs.mockImplementation(async () => approverConfigRows.filter((row) => row.isActive));
  });

  it("returns an exact projectType and sourceSystem match from approver config", async () => {
    insertApproverConfig({
      projectType: "2",
      sourceSystem: "trock_crm",
      approverEmails: ["crm-specific@trockgc.com"],
    });

    const { getRfpReviewRecipients } = await import("../server/rfp-approval.ts");

    await expect(getRfpReviewRecipients("2", "trock_crm")).resolves.toEqual(["crm-specific@trockgc.com"]);
  });

  it("uses exact source match before projectType-only, then projectType-only before default", async () => {
    insertApproverConfig({
      projectType: "2",
      sourceSystem: "trock_crm",
      approverEmails: ["crm-specific@trockgc.com"],
    });
    insertApproverConfig({
      projectType: "2",
      sourceSystem: null,
      approverEmails: ["project-type@trockgc.com"],
    });
    insertApproverConfig({
      projectType: "*",
      sourceSystem: null,
      approverEmails: ["default@trockgc.com"],
    });

    const { getRfpReviewRecipients } = await import("../server/rfp-approval.ts");

    await expect(getRfpReviewRecipients("2", "trock_crm")).resolves.toEqual(["crm-specific@trockgc.com"]);
    await expect(getRfpReviewRecipients("2", "hubspot")).resolves.toEqual(["project-type@trockgc.com"]);
    await expect(getRfpReviewRecipients("9", "hubspot")).resolves.toEqual(["default@trockgc.com"]);
  });

  it("falls back to the hardcoded safety-net recipients when config is missing", async () => {
    const { getRfpReviewRecipients } = await import("../server/rfp-approval.ts");

    await expect(getRfpReviewRecipients("4", "hubspot")).resolves.toEqual(["jhelms@trockgc.com", "cburling@trockgc.com"]);
    await expect(getRfpReviewRecipients("2", "hubspot")).resolves.toEqual(["sgibson@trockgc.com", "jhelms@trockgc.com", "tmitchell@trockgc.com"]);
  });
});
