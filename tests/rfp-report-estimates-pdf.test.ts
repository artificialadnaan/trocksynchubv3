import { describe, expect, it, vi } from "vitest";

// Same stubs as the sibling estimates test: rfp-reports.ts imports ./db, ./storage and ./email-service
// at module load. buildEstimatesAttachment and the HTML builder under test are pure.
vi.mock("../server/db", () => {
  const chain: any = {};
  for (const method of [
    "select", "from", "where", "orderBy", "limit", "offset",
    "innerJoin", "leftJoin", "groupBy", "having", "insert", "values", "update", "set",
  ]) {
    chain[method] = () => chain;
  }
  chain.then = (resolve: (rows: unknown[]) => unknown) => resolve([]);
  return { db: chain, pool: {} };
});
vi.mock("../server/storage", () => ({
  storage: {
    getReportScheduleConfig: async () => ({ enabled: false, recipients: [] }),
    upsertReportScheduleConfig: async (next: Record<string, unknown>) => next,
  },
}));
vi.mock("../server/email-service", () => ({
  sendEmail: vi.fn(async () => ({ success: true })),
  renderTemplate: vi.fn(),
}));

import {
  buildEstimatesSentPdf,
  estimatesSentPdfFilename,
  formatCentsUsd,
  totalEstimateCents,
} from "../server/estimates-sent-pdf";
import { buildEstimatesAttachment, buildRfpReportEmailHtml } from "../server/rfp-reports";
import type { CrmEstimateSent, CrmEstimatesSentResult } from "../server/crm-estimates-sent";

function deal(overrides: Partial<CrmEstimateSent> = {}): CrmEstimateSent {
  return {
    dealId: "d1",
    officeSlug: "dallas",
    name: "Test Deal",
    dealNumber: "DFW-1-00126-aa",
    projectNumber: "P-1001",
    stageSlug: "estimate_sent_to_client",
    enteredAt: "2026-08-11T14:00:00.000Z",
    amount: "1000.00",
    ownerName: "Owner One",
    ownerEmail: "owner@example.com",
    priorEntryCount: 0,
    ...overrides,
  };
}

function okResult(deals: CrmEstimateSent[]): CrmEstimatesSentResult {
  return {
    ok: true,
    deals,
    total: deals.length,
    coveredFrom: "2026-08-05T13:00:00.000Z",
    coveredThrough: "2026-08-12T13:00:00.000Z",
  } as CrmEstimatesSentResult;
}

// The amounts cross the wire as decimal STRINGS precisely so no cent is lost to a float. Summing them
// back through Number would hand that loss straight back at the one place a total is stated.
describe("totalEstimateCents", () => {
  it("adds cents exactly where floating point would not", () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point; in cents it is simply 30.
    expect(totalEstimateCents([deal({ amount: "0.10" }), deal({ amount: "0.20" })])).toBe(30);
  });

  it("keeps full precision on values large enough to lose a cent as a float", () => {
    expect(
      totalEstimateCents([deal({ amount: "99999999.99" }), deal({ amount: "0.01" })])
    ).toBe(10000000000);
  });

  it("handles a missing decimal part and a single decimal digit", () => {
    expect(totalEstimateCents([deal({ amount: "5" }), deal({ amount: "2.5" })])).toBe(750);
  });

  it("supports negative amounts, which deductive change orders produce", () => {
    expect(totalEstimateCents([deal({ amount: "100.00" }), deal({ amount: "-25.50" })])).toBe(7450);
  });

  it("skips an unparseable amount instead of poisoning the whole total with NaN", () => {
    const total = totalEstimateCents([deal({ amount: "oops" }), deal({ amount: "10.00" })]);
    expect(total).toBe(1000);
    expect(Number.isNaN(total)).toBe(false);
  });
});

describe("formatCentsUsd", () => {
  it("renders whole dollars with separators", () => {
    expect(formatCentsUsd(694055739)).toBe("$6,940,557");
  });

  it("keeps a negative total signed rather than showing it as positive", () => {
    expect(formatCentsUsd(-2550)).toBe("-$26");
  });
});

describe("estimatesSentPdfFilename", () => {
  it("dates the file so a forwarded copy still names its run", () => {
    expect(estimatesSentPdfFilename(new Date("2026-08-12T13:00:00.000Z"))).toBe(
      "estimates-sent-2026-08-12.pdf"
    );
  });
});

describe("buildEstimatesSentPdf", () => {
  it("produces a real PDF", async () => {
    const pdf = await buildEstimatesSentPdf({ deals: [deal()], periodLabel: "Aug 5 – Aug 12" });
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(500);
  });

  it("carries EVERY row, not the 15 the email body can afford", async () => {
    // The whole point of the attachment, so the assertion has to actually discriminate. Both inputs are
    // WELL ABOVE any plausible cap: if the builder ever truncated at 15 (or 30, or 100) these two
    // documents would come out the same size and the comparison fails. Comparing 3 rows against 120
    // would NOT catch that — a 15-row cap still dwarfs 3 rows.
    const rows = (n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => deal({ dealId: `${tag}${i}`, name: `${tag} deal ${i}` }));

    const oneTwenty = await buildEstimatesSentPdf({ deals: rows(120, "a"), periodLabel: "Aug 5 – Aug 12" });
    const fourEighty = await buildEstimatesSentPdf({ deals: rows(480, "b"), periodLabel: "Aug 5 – Aug 12" });

    // Four times the rows, so materially more document. A cap anywhere at or below 120 collapses this.
    expect(fourEighty.length).toBeGreaterThan(oneTwenty.length * 2);

    const pageCount = (doc: Buffer) => (doc.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
    expect(pageCount(oneTwenty)).toBeGreaterThan(1);
    expect(pageCount(fourEighty)).toBeGreaterThan(pageCount(oneTwenty) * 2);
  });

  it("does not throw on the degenerate rows the CRM can legitimately send", async () => {
    const pdf = await buildEstimatesSentPdf({
      deals: [
        deal({ name: null, projectNumber: null, dealNumber: null, ownerName: null, ownerEmail: null }),
        deal({ enteredAt: "not-a-date", amount: "0.00", priorEntryCount: 3 }),
      ],
      periodLabel: "Aug 5 – Aug 12",
    });
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });
});

describe("buildEstimatesAttachment", () => {
  const runAt = new Date("2026-08-12T13:00:00.000Z");

  it("attaches the full list when there are estimates", async () => {
    const attachment = await buildEstimatesAttachment(okResult([deal(), deal({ dealId: "d2" })]), "Aug 5 – Aug 12", runAt);
    expect(attachment).not.toBeNull();
    expect(attachment!.filename).toBe("estimates-sent-2026-08-12.pdf");
    expect(attachment!.contentType).toBe("application/pdf");
    expect(attachment!.content.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("attaches nothing on a quiet day", async () => {
    expect(await buildEstimatesAttachment(okResult([]), "Aug 5 – Aug 12", runAt)).toBeNull();
  });

  it("attaches nothing when the lookup did not answer", async () => {
    expect(
      await buildEstimatesAttachment({ ok: false, reason: "failed" } as CrmEstimatesSentResult, "x", runAt)
    ).toBeNull();
    expect(
      await buildEstimatesAttachment({ ok: false, reason: "not_configured" } as CrmEstimatesSentResult, "x", runAt)
    ).toBeNull();
  });
});

// The body names the attachment. A report that promised a file it failed to produce would send the
// reader looking for something that is not there — worse than never mentioning it.
describe("the attachment note in the email body", () => {
  const base = {
    periodLabel: "Last 24 Hours",
    rfps: [],
    changes: [],
    approvalSummary: { pending: 0, approved: 0, rejected: 0 },
    includeRfpLog: true,
    includeApprovalSummary: true,
    estimatesPeriod: { from: new Date("2026-08-05T13:00:00Z"), to: new Date("2026-08-12T13:00:00Z") },
    dashboardUrl: "https://example.test/settings",
  };

  it("names the file when one was attached", async () => {
    const html = await buildRfpReportEmailHtml({
      ...base,
      estimatesSent: okResult([deal()]),
      estimatesPdfFilename: "estimates-sent-2026-08-12.pdf",
    } as any);
    expect(html).toContain("attached as <strong>estimates-sent-2026-08-12.pdf</strong>");
  });

  it("says nothing about an attachment when the PDF could not be built", async () => {
    const html = await buildRfpReportEmailHtml({
      ...base,
      estimatesSent: okResult([deal()]),
      estimatesPdfFilename: null,
    } as any);
    expect(html).not.toContain("attached as");
    // The section itself is unaffected — only the appendix is missing.
    expect(html).toContain(">Estimates Sent to Client — ");
  });

  it("still reports the true total in the overflow line when the list is trimmed", async () => {
    const many = Array.from({ length: 40 }, (_, i) => deal({ dealId: `d${i}`, name: `Deal ${i}` }));
    const html = await buildRfpReportEmailHtml({
      ...base,
      estimatesSent: okResult(many),
      estimatesPdfFilename: "estimates-sent-2026-08-12.pdf",
    } as any);
    expect(html).toContain("of 40 estimates sent.");
    expect(html).toContain("Full list of 40 attached as");
  });
});
