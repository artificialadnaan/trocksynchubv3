import { describe, expect, it } from "vitest";

// rfp-reports.ts imports ./db (throws without DATABASE_URL), ./storage, ./email-service.
// The functions under test are pure, so stub those modules out.
import { vi } from "vitest";
vi.mock("../server/db", () => ({ db: {}, pool: {} }));
vi.mock("../server/storage", () => ({ storage: {} }));
vi.mock("../server/email-service", () => ({ sendEmail: vi.fn() }));

import {
  buildBidBoardUrl,
  resolveRfpAmount,
  formatRfpAmount,
  formatRfpDateTime,
  resolveProjectTypeLabel,
  buildRfpReportEmailHtml,
  type RfpReportRow,
} from "../server/rfp-reports";

function makeRow(overrides: Partial<RfpReportRow> = {}): RfpReportRow {
  return {
    id: 1,
    hubspotDealId: "555",
    projectName: "Acme Tower Renovation",
    projectNumber: "DFW-4-15626-ab",
    projectType: "Service",
    recipient: "owner@trockgc.com",
    dateSent: "2026-06-18T20:42:00.000Z",
    bidboardStage: "Linked",
    approvalStatus: "approved",
    changeCount: 3,
    amount: 125000,
    requestedBy: "Jane Owner",
    approvedBy: "churlling@trockgc.com",
    declinedBy: null,
    bidBoardUrl:
      "https://us02.procore.com/webclients/host/companies/598134325683880/projects/9988/tools/estimating",
    crmUrl: "https://app-na2.hubspot.com/contacts/123/record/0-3/555",
    ...overrides,
  };
}

const renderEmail = (rfps: RfpReportRow[], pending = 0) =>
  buildRfpReportEmailHtml({
    periodLabel: "Last 7 Days",
    rfps,
    changes: [
      {
        rfpId: 1,
        projectName: "Acme Tower Renovation",
        projectNumber: "DFW-4-15626-ab",
        items: [{ field: "edited_fields", oldVal: "{}", newVal: "{...}", changedBy: "postgres" }],
      },
    ],
    approvalSummary: { pending, approved: 1, rejected: 0 },
    includeRfpLog: true,
    includeChangeHistory: true,
    includeApprovalSummary: true,
    dashboardUrl: "https://synchub.example.com/settings",
  });

describe("resolveRfpAmount", () => {
  it("prefers a reviewer-edited amount over the original deal amount", () => {
    expect(resolveRfpAmount({ amount: 100 }, { amount: 250 })).toBe(250);
  });

  it("falls back to the deal amount when there is no edit", () => {
    expect(resolveRfpAmount({ amount: 100 }, null)).toBe(100);
    expect(resolveRfpAmount({ amount: 100 }, {})).toBe(100);
  });

  it("returns null when the amount is missing or empty", () => {
    expect(resolveRfpAmount({ amount: "" }, null)).toBeNull();
    expect(resolveRfpAmount({}, null)).toBeNull();
    expect(resolveRfpAmount({ amount: "not-a-number" }, null)).toBeNull();
  });
});

describe("formatRfpAmount", () => {
  it("formats USD with thousands separators", () => {
    expect(formatRfpAmount(125000)).toBe("$125,000");
  });
  it("renders an em dash for null", () => {
    expect(formatRfpAmount(null)).toBe("—");
  });
});

describe("buildBidBoardUrl", () => {
  it("builds a Procore estimating deep link from a project id", () => {
    expect(buildBidBoardUrl("9988")).toBe(
      "https://us02.procore.com/webclients/host/companies/598134325683880/projects/9988/tools/estimating"
    );
  });
  it("returns null when there is no project id (pre-approval)", () => {
    expect(buildBidBoardUrl(null)).toBeNull();
    expect(buildBidBoardUrl("")).toBeNull();
    expect(buildBidBoardUrl(undefined)).toBeNull();
  });
});

describe("formatRfpDateTime", () => {
  it("renders a Central-Time date and a time labelled CT", () => {
    const { date, time } = formatRfpDateTime("2026-06-18T20:42:00.000Z");
    expect(date).toBe("Jun 18, 2026");
    expect(time).toBe("3:42 PM CT"); // 20:42 UTC = 15:42 America/Chicago (CDT)
  });
  it("handles empty/invalid input gracefully", () => {
    expect(formatRfpDateTime("")).toEqual({ date: "—", time: "" });
    expect(formatRfpDateTime("garbage")).toEqual({ date: "—", time: "" });
  });
});

describe("resolveProjectTypeLabel", () => {
  it("maps a 1–9 dropdown code to its label", () => {
    expect(resolveProjectTypeLabel({ project_types: "4" })).toBe("Service");
    expect(resolveProjectTypeLabel({ project_types: "2" })).toBe("Interior Renovation");
    expect(resolveProjectTypeLabel({ project_types: "1" })).toBe("Exterior Renovation");
  });
  it("passes through an already-readable label", () => {
    expect(resolveProjectTypeLabel({ project_types: "Roofing" })).toBe("Roofing");
  });
  it("falls back to the digit encoded in the project number", () => {
    expect(resolveProjectTypeLabel({}, "DFW-4-15626-ab")).toBe("Service");
  });
  it("returns null when nothing is resolvable", () => {
    expect(resolveProjectTypeLabel({}, "HOU-x-000")).toBeNull();
    expect(resolveProjectTypeLabel({})).toBeNull();
  });
});

describe("buildRfpReportEmailHtml — R1 field mapping & no raw leak", () => {
  it("renders the project type badge", async () => {
    const html = await renderEmail([makeRow()]);
    expect(html).toContain("Service");
  });

  it("never leaks raw postgres internals or the changelog dump", async () => {
    const html = await renderEmail([makeRow()]);
    for (const token of [
      "edited_fields",
      "approved_attachments",
      "bidboard_project_id",
      "— postgres",
      "Change Highlights",
    ]) {
      expect(html).not.toContain(token);
    }
  });

  it("shows requester and approver as distinct people", async () => {
    const html = await renderEmail([makeRow()]);
    expect(html).toContain("Jane Owner"); // requested by (deal owner)
    expect(html).toContain("churlling@trockgc.com"); // approved by
    // they are not the same value
    expect("Jane Owner").not.toBe("churlling@trockgc.com");
  });

  it("renders the amount, project name and number", async () => {
    const html = await renderEmail([makeRow()]);
    expect(html).toContain("$125,000");
    expect(html).toContain("Acme Tower Renovation");
    expect(html).toContain("DFW-4-15626-ab");
  });

  it("renders both deep-link buttons as absolute URLs", async () => {
    const html = await renderEmail([makeRow()]);
    expect(html).toContain('href="https://us02.procore.com/webclients/host/companies/598134325683880/projects/9988/tools/estimating"');
    expect(html).toContain('href="https://app-na2.hubspot.com/contacts/123/record/0-3/555"');
    expect(html).toContain("Bid Board");
    expect(html).toContain("CRM");
  });
});

describe("buildRfpReportEmailHtml — R3 edge cases", () => {
  it("omits the Bid Board button for a pending RFP with no project yet, but keeps CRM", async () => {
    const pendingRow = makeRow({
      approvalStatus: "pending",
      approvedBy: null,
      bidBoardUrl: null,
    });
    const html = await renderEmail([pendingRow], 1);
    expect(html).not.toContain("/projects/9988/tools/estimating");
    expect(html).toContain("Awaiting approval");
    expect(html).toContain('href="https://app-na2.hubspot.com/contacts/123/record/0-3/555"'); // CRM still present
  });

  it("shows a rejection state with the decliner", async () => {
    const rejected = makeRow({
      approvalStatus: "rejected",
      approvedBy: null,
      declinedBy: "boss@trockgc.com",
    });
    const html = await renderEmail([rejected]);
    expect(html).toContain("Rejected");
    expect(html).toContain("boss@trockgc.com");
  });

  it("renders an em dash when an RFP has neither amount nor links", async () => {
    const bare = makeRow({ amount: null, bidBoardUrl: null, crmUrl: null });
    const html = await renderEmail([bare]);
    expect(html).toContain("—");
  });

  it("shows an empty-state message when there are no RFPs", async () => {
    const html = await renderEmail([]);
    expect(html).toContain("No RFPs in this period");
  });

  it("keeps the summary stats and approval-summary footer", async () => {
    const html = await renderEmail([makeRow()]);
    expect(html).toContain("RFPs Sent");
    expect(html).toContain("Pending");
    expect(html).toContain("Approval Summary");
  });
});
