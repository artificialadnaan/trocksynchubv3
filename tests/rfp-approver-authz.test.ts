import { beforeEach, describe, expect, it, vi } from "vitest";

// Service-level coverage of isAuthorizedRfpApprover. Mirrors tests/rfp-approver-config.test.ts:
// mock the deps, import the REAL rfp-approval module fresh per test (vi.resetModules clears the
// per-process recipient cache), exercise the real getRfpReviewRecipients-backed authz logic.

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
  // Mirrors the real always-CC admin allowlist — these directors receive every review email.
  GLOBAL_CC_RECIPIENTS: ["adnaan.iqbal@gmail.com", "bbell@trockgc.com"],
}));

vi.mock("../server/procore-hubspot-sync.ts", () => ({
  resolveHubspotStageId: vi.fn(),
}));

vi.mock("../server/index.ts", () => ({
  log: vi.fn(),
}));

describe("isAuthorizedRfpApprover", () => {
  beforeEach(() => {
    vi.resetModules();
    getRfpApproverConfigs.mockReset();
    approverConfigRows.length = 0;
    getRfpApproverConfigs.mockImplementation(async () => approverConfigRows.filter((row) => row.isActive));
  });

  it("ALLOWS a service approver on a service ('4') RFP (safety-net routing)", async () => {
    const { isAuthorizedRfpApprover } = await import("../server/rfp-approval.ts");
    // Safety net for type 4 = James + Colby.
    await expect(isAuthorizedRfpApprover("cburling@trockgc.com", "4", "hubspot")).resolves.toBe(true);
    await expect(isAuthorizedRfpApprover("jhelms@trockgc.com", "4", "hubspot")).resolves.toBe(true);
  });

  it("REJECTS a non-service approver (sgibson) on a service ('4') RFP", async () => {
    const { isAuthorizedRfpApprover } = await import("../server/rfp-approval.ts");
    await expect(isAuthorizedRfpApprover("sgibson@trockgc.com", "4", "hubspot")).resolves.toBe(false);
  });

  it("ALLOWS a non-service approver (sgibson) on a non-service ('2') RFP", async () => {
    const { isAuthorizedRfpApprover } = await import("../server/rfp-approval.ts");
    // Safety net for non-4 = Sidney + James.
    await expect(isAuthorizedRfpApprover("sgibson@trockgc.com", "2", "hubspot")).resolves.toBe(true);
  });

  it("ALLOWS an always-CC admin/director (bbell / adnaan) outside the config (override exemption)", async () => {
    const { isAuthorizedRfpApprover } = await import("../server/rfp-approval.ts");
    await expect(isAuthorizedRfpApprover("bbell@trockgc.com", "4", "hubspot")).resolves.toBe(true);
    await expect(isAuthorizedRfpApprover("adnaan.iqbal@gmail.com", "4", "trock_crm")).resolves.toBe(true);
  });

  it("compares case-insensitively and trims surrounding whitespace", async () => {
    const { isAuthorizedRfpApprover } = await import("../server/rfp-approval.ts");
    await expect(isAuthorizedRfpApprover("  CBurling@TrockGC.com  ", "4", "hubspot")).resolves.toBe(true);
  });

  it("rejects an empty/missing email", async () => {
    const { isAuthorizedRfpApprover } = await import("../server/rfp-approval.ts");
    await expect(isAuthorizedRfpApprover("", "4", "hubspot")).resolves.toBe(false);
    await expect(isAuthorizedRfpApprover(undefined, "2", "hubspot")).resolves.toBe(false);
  });

  it("authorizes against the SAME rfp_approver_config source the routing uses", async () => {
    insertApproverConfig({ projectType: "4", sourceSystem: null, approverEmails: ["custom-approver@trockgc.com"] });
    const { isAuthorizedRfpApprover } = await import("../server/rfp-approval.ts");
    // Config row overrides the safety net: the configured approver is allowed...
    await expect(isAuthorizedRfpApprover("custom-approver@trockgc.com", "4", "hubspot")).resolves.toBe(true);
    // ...and the old safety-net address is NOT (it is no longer the routed approver).
    await expect(isAuthorizedRfpApprover("cburling@trockgc.com", "4", "hubspot")).resolves.toBe(false);
  });

  it("FAILS CLOSED when the approver-config read THROWS (does not authorize the safety net)", async () => {
    // Simulate rfp_approver_config being temporarily unreadable (DB error) while the request row
    // itself is readable. The safety-net addresses MUST NOT be authorized off a config read error —
    // otherwise the route would approve even though the live config can't confirm authorization.
    getRfpApproverConfigs.mockRejectedValue(new Error("db unreadable"));
    const { isAuthorizedRfpApprover } = await import("../server/rfp-approval.ts");
    // Safety-net addresses for a service ('4') RFP are denied because the config could not be read.
    await expect(isAuthorizedRfpApprover("cburling@trockgc.com", "4", "hubspot")).resolves.toBe(false);
    await expect(isAuthorizedRfpApprover("jhelms@trockgc.com", "4", "hubspot")).resolves.toBe(false);
    // Non-service safety-net address is likewise denied on a read error.
    await expect(isAuthorizedRfpApprover("sgibson@trockgc.com", "2", "hubspot")).resolves.toBe(false);
    // The route consumes this false → returns 403 and never calls processRfpApproval (proven in
    // tests/rfp-approval-authz-route.test.ts "rejects an unauthorized approver with 403").
  });

  it("still authorizes a config-INDEPENDENT admin/director even when the config read THROWS", async () => {
    // The always-CC admin allowlist comes from email-service, not the DB, so a transient config
    // read failure must NOT lock out a director (bbell / adnaan).
    getRfpApproverConfigs.mockRejectedValue(new Error("db unreadable"));
    const { isAuthorizedRfpApprover } = await import("../server/rfp-approval.ts");
    await expect(isAuthorizedRfpApprover("bbell@trockgc.com", "4", "hubspot")).resolves.toBe(true);
    await expect(isAuthorizedRfpApprover("adnaan.iqbal@gmail.com", "2", "trock_crm")).resolves.toBe(true);
  });
});

describe("resolveEffectiveRfpProjectType (canonical created type — single source for the authz gate)", () => {
  it("derives the type from the project NUMBER even when project_types disagrees (the bypass case)", async () => {
    const { resolveEffectiveRfpProjectType } = await import("../server/rfp-approval.ts");
    // project_types says non-service '2' but the number encodes service '4' → the SERVICE type wins,
    // which is exactly what processRfpApproval creates the BidBoard project as.
    expect(resolveEffectiveRfpProjectType({ project_number: "DFW-4-06426-ah", project_types: "2" })).toBe("4");
  });

  it("lets an EDITED project_types override into a different routing group", async () => {
    const { resolveEffectiveRfpProjectType } = await import("../server/rfp-approval.ts");
    expect(
      resolveEffectiveRfpProjectType({ project_number: "DFW-2-06426-ah", project_types: "2" }, { project_types: "4" }),
    ).toBe("4");
  });

  it("keeps the project-number type when an edit matches it (no spurious change)", async () => {
    const { resolveEffectiveRfpProjectType } = await import("../server/rfp-approval.ts");
    expect(
      resolveEffectiveRfpProjectType({ project_number: "DFW-2-06426-ah", project_types: "2" }, { project_types: "2" }),
    ).toBe("2");
  });

  it("falls back to project_types when there is no project number, then to '2'", async () => {
    const { resolveEffectiveRfpProjectType } = await import("../server/rfp-approval.ts");
    expect(resolveEffectiveRfpProjectType({ project_types: "5" })).toBe("5");
    expect(resolveEffectiveRfpProjectType({})).toBe("2");
    expect(resolveEffectiveRfpProjectType(null)).toBe("2");
  });
});
