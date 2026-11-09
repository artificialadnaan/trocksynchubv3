import { readFileSync } from "fs";
import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// S0b-2b (runbook r5 §1; a4 condition 3; d9 Q10): the request-status census. `approving` (a Bid Board create in progress) reads
// "Creating Bid Board project…" on every surface: the review page (it says "declined" today), the reports API label, CSV / PDF,
// the email pill and the dashboard badge + filter. Never blank, never "pending". The summary chips gain an in-progress count so
// they add up. Other statuses read exactly as they do today. Synthetic data only (I7).
const reqState = vi.hoisted(() => ({ current: null as any }));
vi.mock("../server/db", () => ({ db: {}, pool: {} }));
vi.mock("../server/email-service", () => ({ sendEmail: vi.fn() }));
vi.mock("../server/storage.ts", () => ({
  storage: {
    getAutomationConfig: vi.fn(async () => null),
    getRfpApprovalRequestByToken: vi.fn(async () => reqState.current),
    updateRfpApprovalRequest: vi.fn(async () => ({})),
    createAuditLog: vi.fn(async () => ({})),
    getHubspotDealByHubspotId: vi.fn(),
  },
}));
vi.mock("../server/rfp-approval.ts", () => ({
  processRfpDecline: vi.fn(),
  processRfpApproval: vi.fn(),
  resolveRfpDescription: vi.fn(() => ""),
  isRfpApprovalRequestExpired: vi.fn(() => false),
  buildExpiredRfpMessage: vi.fn(() => "expired"),
  checkRfpApprovalSourceEligibility: vi.fn(async () => ({ eligible: true })),
  cancelIneligibleRfpApproval: vi.fn(),
  isAuthorizedRfpApprover: vi.fn(async () => true),
  resolveEffectiveRfpProjectType: vi.fn(() => "2"),
}));
vi.mock("../server/sync/rfp-core-alert.ts", () => ({ raiseRfpCoreAlert: vi.fn(async () => {}) }));

const { RFP_APPROVING_LABEL, RFP_IN_PROGRESS_STATUSES, rfpStatusLabel } = await import("../shared/rfp-status-display.ts");
const { exportRfpsToCsv, exportRfpsToPdfHtml, buildRfpReportEmailHtml, toReportApprovalStatus, summarizeApprovals } = await import("../server/rfp-reports.ts");
const { registerRfpApprovalRoutes } = await import("../server/routes/rfp-approval.ts");
type Row = Parameters<typeof exportRfpsToCsv>[0][number];

const LABEL = "Creating Bid Board project…";
function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 1,
    hubspotDealId: "",
    sourceSystem: "trock_crm",
    sourceDealId: "00000000-0000-4000-8000-0000000009c1",
    projectName: "Synthetic Label Project",
    projectNumber: "DFW-2-90001-ab",
    projectType: "Interior Renovation",
    recipient: "reviewer@example.test",
    dateSent: "2026-11-09T15:00:00.000Z",
    bidboardStage: "—",
    approvalStatus: "approving",
    changeCount: 0,
    amount: null,
    amountIsCurrent: false,
    requestedBy: "Synthetic Owner",
    approvedBy: null,
    declinedBy: null,
    bidBoardUrl: null,
    crmUrl: null,
    ...overrides,
  };
}
const email = (rfps: Row[], approvalSummary: { pending: number; approved: number; rejected: number; inProgress?: number }) =>
  buildRfpReportEmailHtml({
    periodLabel: "Last 24 Hours",
    rfps,
    changes: [],
    approvalSummary,
    includeRfpLog: true,
    includeApprovalSummary: true,
    dashboardUrl: "https://synchub.example.test/settings",
  });

describe("shared/rfp-status-display: one label for every surface", () => {
  it("approving ⇒ 'Creating Bid Board project…' (never blank, never pending); other statuses unchanged", () => {
    expect(RFP_APPROVING_LABEL).toBe(LABEL);
    expect(rfpStatusLabel("approving")).toBe(LABEL);
    expect(rfpStatusLabel(null)).toBe("—");
    expect(rfpStatusLabel("")).toBe("—");
    for (const s of ["pending", "approved", "rejected", "declined", "override_approving", "held_cross_destination", "cancelled_source_ineligible"]) {
      expect(rfpStatusLabel(s)).toBe(s);
    }
  });
  it("the in-progress statuses are the two create-in-progress ones", () => {
    expect([...RFP_IN_PROGRESS_STATUSES].sort()).toEqual(["approving", "override_approving"]);
  });
});

describe("reports: API label, CSV, PDF, email pill, summary chips", () => {
  it("the reports API row carries the label next to the raw value; declined still normalises to rejected", () => {
    expect(toReportApprovalStatus("approving")).toEqual({ approvalStatus: "approving", approvalStatusLabel: LABEL });
    expect(toReportApprovalStatus("declined")).toEqual({ approvalStatus: "rejected", approvalStatusLabel: "rejected" });
    expect(toReportApprovalStatus("approved")).toEqual({ approvalStatus: "approved", approvalStatusLabel: "approved" });
  });

  it("getRfpReportList builds its status pair with toReportApprovalStatus (no second copy of the mapping)", () => {
    const src = readFileSync(new URL("../server/rfp-reports.ts", import.meta.url), "utf8");
    expect(src).toMatch(/\.\.\.toReportApprovalStatus\(rfp\.status\)/);
    expect(src).not.toMatch(/const approvalStatus = rfp\.status === "declined" \? "rejected" : rfp\.status;/);
  });

  it("CSV prints the label for an approving row, and the raw value for the others as today", () => {
    const csv = exportRfpsToCsv([row(), row({ id: 2, approvalStatus: "approved" })]);
    const [, approving, approved] = csv.split("\n");
    expect(approving).toContain(LABEL);
    expect(approving).not.toMatch(/,approving,/);
    expect(approved).toMatch(/,approved,/);
  });

  it("the PDF prints the label for an approving row", () => {
    const html = exportRfpsToPdfHtml([row()]);
    expect(html).toContain(`<td>${LABEL}</td>`);
    expect(html).not.toContain("<td>approving</td>");
  });

  it("the email pill for an approving row reads the label, not 'Approving' or 'Awaiting approval'", async () => {
    const html = await email([row()], { pending: 0, approved: 0, rejected: 0, inProgress: 1 });
    expect(html).toContain(LABEL);
    expect(html).not.toMatch(/>Approving</);
    expect(html).not.toMatch(/Awaiting approval/);
  });

  it("the summary counts an in-progress bucket so the chips add up, and the email shows it", async () => {
    const rows = ["pending", "approved", "rejected", "approving", "override_approving"].map((approvalStatus, i) => row({ id: i + 1, approvalStatus }));
    const summary = summarizeApprovals(rows);
    expect(summary).toEqual({ pending: 1, approved: 1, rejected: 1, inProgress: 2 });
    expect(summary.pending + summary.approved + summary.rejected + summary.inProgress).toBe(rows.length);
    const html = await email(rows, summary);
    expect(html).toContain("2 In progress");
  });

  it("the scheduled report's summary comes from summarizeApprovals", () => {
    const src = readFileSync(new URL("../server/rfp-reports.ts", import.meta.url), "utf8");
    expect(src).toMatch(/const approvalSummary = summarizeApprovals\(rfps\);/);
  });
});

describe("the review page (GET /rfp-review/:token)", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    registerRfpApprovalRoutes(app);
    server = await new Promise<Server>((resolve) => {
      const created = app.listen(0, () => resolve(created));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const request = (status: string, o: Record<string, unknown> = {}) => ({
    id: 1, token: "synthetic-label-token", status, sourceSystem: "trock_crm", sourceDealId: "00000000-0000-4000-8000-0000000009c1",
    approvedBy: null, declinedBy: null, tokenExpiresAt: new Date(Date.now() + 86_400_000), dealData: { dealname: "Synthetic Label Project" }, ...o,
  });

  it("an approving request reads 'Creating Bid Board project…', never 'declined'", async () => {
    reqState.current = request("approving", { approvedBy: "approver@example.test" });
    const res = await fetch(`${base}/rfp-review/synthetic-label-token`);
    const html = await res.text();
    expect(html).toContain(LABEL);
    expect(html).not.toMatch(/declined/i);
  });

  it("approved and declined requests read as today (a guard)", async () => {
    reqState.current = request("approved", { approvedBy: "approver@example.test" });
    expect(await (await fetch(`${base}/rfp-review/synthetic-label-token`)).text()).toMatch(/already <strong>approved<\/strong>/);
    reqState.current = request("declined", { declinedBy: "reviewer@example.test" });
    expect(await (await fetch(`${base}/rfp-review/synthetic-label-token`)).text()).toMatch(/<strong>declined<\/strong>/);
  });
});

describe("the dashboard card (client/src/components/rfp-automation-card.tsx)", () => {
  const src = readFileSync(new URL("../client/src/components/rfp-automation-card.tsx", import.meta.url), "utf8");
  it("imports the shared label", () => {
    expect(src).toMatch(/import \{[^}]*\brfpStatusLabel\b[^}]*\} from "@shared\/rfp-status-display";/);
    expect(src).toMatch(/import \{[^}]*\bRFP_APPROVING_LABEL\b[^}]*\} from "@shared\/rfp-status-display";/);
  });
  it("the badge prints the label, never the raw status", () => {
    expect(src).toMatch(/\{rfpStatusLabel\(row\.approvalStatus\)\}/);
    expect(src).not.toMatch(/^\s*\{row\.approvalStatus\}\s*$/m);
  });
  it("the status filter offers approving, labelled", () => {
    expect(src).toMatch(/<SelectItem value="approving">\{RFP_APPROVING_LABEL\}<\/SelectItem>/);
  });
});
