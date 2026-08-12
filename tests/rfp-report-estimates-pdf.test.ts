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
  estimatesTotalLabel,
  totalEstimateCents,
} from "../server/estimates-sent-pdf";
import { buildEstimatesAttachment, buildRfpReportEmailHtml } from "../server/rfp-reports";
import { formatEstimateAmount, type CrmEstimateSent, type CrmEstimatesSentResult } from "../server/crm-estimates-sent";

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

/**
 * The text a PDF actually RENDERS.
 *
 * pdfkit emits text as hex-encoded glyph runs inside `[ … ] TJ`, not as literal ASCII, so searching the
 * raw buffer for a rendered string silently finds nothing and the assertion passes vacuously. Callers
 * must build with `compress: false`, since the content stream is otherwise deflated.
 */
function pdfText(buf: Buffer): string {
  return (buf.toString("latin1").match(/<[0-9a-fA-F]+>/g) || [])
    .map((h) => Buffer.from(h.slice(1, -1), "hex").toString("latin1"))
    .join("");
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

  it("keeps the cents on a sub-dollar total instead of rounding it away to $0", () => {
    // The footer sums the very rows the document lists, so whole-dollar rounding made it contradict
    // them: a lone -$0.25 row under a "-$0" total. That is the same contradiction the row formatter
    // just stopped producing, one line further down the page.
    expect(formatCentsUsd(-25)).toBe("-$0.25");
    expect(formatCentsUsd(25)).toBe("$0.25");
    expect(formatCentsUsd(-49)).toBe("-$0.49");
    // Half a dollar is no longer sub-dollar once rounded, so the whole-dollar form resumes here.
    expect(formatCentsUsd(50)).toBe("$1");
    expect(formatCentsUsd(-50)).toBe("-$1");
    // Exactly zero is a true total, not a missing value: the footer states it as a number.
    expect(formatCentsUsd(0)).toBe("$0");
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
  const PERIOD = { from: new Date("2026-08-05T13:00:00Z"), to: new Date("2026-08-12T13:00:00Z") };

  it("attaches the full list when there are estimates", async () => {
    const attachment = await buildEstimatesAttachment(okResult([deal(), deal({ dealId: "d2" })]), PERIOD, "Aug 5 – Aug 12", runAt);
    expect(attachment).not.toBeNull();
    expect(attachment!.filename).toBe("estimates-sent-2026-08-12.pdf");
    expect(attachment!.contentType).toBe("application/pdf");
    expect(attachment!.content.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("attaches nothing on a quiet day", async () => {
    expect(await buildEstimatesAttachment(okResult([]), PERIOD, "Aug 5 – Aug 12", runAt)).toBeNull();
  });

  it("attaches nothing when the lookup did not answer", async () => {
    expect(
      await buildEstimatesAttachment({ ok: false, reason: "failed" } as CrmEstimatesSentResult, PERIOD, "x", runAt)
    ).toBeNull();
    expect(
      await buildEstimatesAttachment({ ok: false, reason: "not_configured" } as CrmEstimatesSentResult, PERIOD, "x", runAt)
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

// ── Codex review fixes ────────────────────────────────────────────────────────

// The endpoint caps its rows at MAX_ESTIMATES_SENT_ROWS while still reporting the true total, so past
// that the attachment holds the newest N — and must not be described as the complete list.
describe("when the endpoint capped the rows", () => {
  const cappedResult = (shown: number, total: number): CrmEstimatesSentResult =>
    ({
      ok: true,
      deals: Array.from({ length: shown }, (_, i) => deal({ dealId: `c${i}` })),
      total,
      coveredFrom: "2026-08-05T13:00:00.000Z",
      coveredThrough: "2026-08-12T13:00:00.000Z",
    }) as CrmEstimatesSentResult;

  it("the PDF footer says how many of how many, not a total it did not sum", () => {
    const four = Array.from({ length: 4 }, (_, i) => deal({ dealId: `c${i}`, amount: "10.00" }));
    // Truncated: names both numbers, and the money is what these four rows actually sum to.
    expect(estimatesTotalLabel(four, 900)).toBe("Most recent 4 of 900 estimates · $40 shown");
    // Not truncated: the plain form.
    expect(estimatesTotalLabel(four, 4)).toBe("4 estimates · $40");
    expect(estimatesTotalLabel([deal({ amount: "10.00" })], 1)).toBe("1 estimate · $10");
  });

  it("the email says 'most recent N of M', never 'full list'", async () => {
    const html = await buildRfpReportEmailHtml({
      periodLabel: "Last 24 Hours",
      rfps: [],
      changes: [],
      approvalSummary: { pending: 0, approved: 0, rejected: 0 },
      includeRfpLog: true,
      includeApprovalSummary: true,
      estimatesPeriod: { from: new Date("2026-08-05T13:00:00Z"), to: new Date("2026-08-12T13:00:00Z") },
      dashboardUrl: "https://example.test/settings",
      estimatesSent: cappedResult(500, 900),
      estimatesPdfFilename: "estimates-sent-2026-08-12.pdf",
    } as any);
    expect(html).toContain("Most recent 500 of 900 attached as");
    expect(html).not.toContain("Full list of");
  });
});

// A deductive change order is a real, signed number. The PDF now uses the SHARED formatter — the
// PDF-local signed variant is gone — so the row and the footer can no longer disagree, and neither can
// the PDF and the email.
describe("the PDF renders amounts with the shared formatter", () => {
  it("shows a negative amount signed, matching what the footer subtracts", () => {
    expect(formatEstimateAmount("-25.50")).toBe("-$26");
    expect(totalEstimateCents([deal({ amount: "-25.50" })])).toBe(-2550);
  });

  // Through the BUILDER, not just the formatter — otherwise nothing catches the row reverting to a
  // positive-only formatter. pdfkit writes text as hex-encoded glyph runs, so the rendered string has to
  // be decoded back out; asserting on the raw buffer matches nothing and passes for the wrong reason.
  it("renders the signed amount in the document itself", async () => {
    const pdf = await buildEstimatesSentPdf({
      deals: [deal({ name: "Deductive CO", amount: "-25.50" })],
      periodLabel: "Aug 5 – Aug 12",
      compress: false,
    });
    // ADJACENCY, not two independent substrings: the amount cell follows the name cell directly in the
    // decoded run, so this fails if the row reverts to the em dash it used to print. Asserting
    // `not.toContain("Deductive CO—")` would NOT — pdfText decodes glyphs as latin1 and an em dash never
    // survives that as "—", so the negative can never fail and proves nothing.
    expect(pdfText(pdf)).toContain("Deductive CO-$26");
  });

  it("renders a sub-dollar deduction with cents rather than -$0, footer included", async () => {
    const pdf = await buildEstimatesSentPdf({
      deals: [deal({ name: "Tiny deduction", amount: "-0.25" })],
      periodLabel: "Aug 5 – Aug 12",
      compress: false,
    });
    const rendered = pdfText(pdf);
    expect(rendered).toContain("Tiny deduction-$0.25");
    // The footer sums this one row, so it has to agree with it. The whole sentence is asserted rather
    // than the money alone: a bare toContain("-$0.25") is already satisfied by the ROW above, and would
    // pass with a footer still rounding to "-$0".
    expect(rendered).toContain("1 estimate · -$0.25");
  });
});

// The scheduler picks its slot in the configured timezone, so slicing the UTC date named an evening run
// for the next calendar day — the one thing the date in the filename exists to pin down.
describe("estimatesSentPdfFilename timezone", () => {
  it("uses the report timezone, not UTC", () => {
    // 2026-08-12T01:00Z is still Aug 11 in Chicago.
    expect(estimatesSentPdfFilename(new Date("2026-08-12T01:00:00.000Z"))).toBe(
      "estimates-sent-2026-08-11.pdf"
    );
  });

  it("honours a different configured zone", () => {
    expect(estimatesSentPdfFilename(new Date("2026-08-12T01:00:00.000Z"), "UTC")).toBe(
      "estimates-sent-2026-08-12.pdf"
    );
  });

  it("falls back to UTC rather than throwing on an unknown zone", () => {
    expect(estimatesSentPdfFilename(new Date("2026-08-12T13:00:00.000Z"), "Not/AZone")).toBe(
      "estimates-sent-2026-08-12.pdf"
    );
  });
});

// The badge sits below the deal name; if its line is not reserved it crosses the row rule onto the
// next row, and the page-break test is short by the same amount.
describe("re-send badge row height", () => {
  it("reserves space for the badge instead of overlapping the next row", async () => {
    const withBadge = await buildEstimatesSentPdf({
      deals: Array.from({ length: 20 }, (_, i) => deal({ dealId: `b${i}`, priorEntryCount: 2 })),
      periodLabel: "Aug 5 – Aug 12",
    });
    const withoutBadge = await buildEstimatesSentPdf({
      deals: Array.from({ length: 20 }, (_, i) => deal({ dealId: `n${i}`, priorEntryCount: 0 })),
      periodLabel: "Aug 5 – Aug 12",
    });
    // Taller rows for the same row count means the badge line was actually reserved.
    expect(withBadge.length).toBeGreaterThan(withoutBadge.length);
  });
});
