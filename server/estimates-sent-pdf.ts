/**
 * The COMPLETE Estimates Sent to Client list, as a PDF attached to the RFP report email.
 *
 * The email body can only ever show part of this. Cards are expensive — roughly 1.6 KB of HTML each —
 * and Gmail clips a message at about 102 KB, so EMAIL_CARD_BUDGET caps the two sections at 30 cards
 * between them. On a busy day that meant "Showing 15 of 35 estimates sent." with no way to reach the
 * other twenty: the reader was told the list was incomplete and given nowhere to go.
 *
 * A PDF rather than a link because Sync Hub does not STORE these rows — they are pulled from the CRM at
 * compose time — so a "view all" page would have to re-query the CRM and would put the full list behind
 * a Sync Hub login that report recipients may not have. The attachment travels with the mail, is
 * forwardable, and keeps working when nobody can log in.
 *
 * Row order and content mirror the email exactly, so the two never disagree about what was sent.
 */
import PDFDocument from "pdfkit";
import { type CrmEstimateSent, formatEstimateAmount, resendLabel } from "./crm-estimates-sent";

const BRAND_RED = "#d11921";
const BRAND_DARK = "#111214";
const BRAND_MUTED = "#6b7280";
const BRAND_WHITE = "#ffffff";
const ROW_ALT = "#f9fafb";
const RULE = "#e5e7eb";

const MARGIN = 40;
const PAGE_WIDTH = 792; // LETTER landscape
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const FOOTER_RESERVE = 48;

/** Landscape, because five columns of real project names do not fit portrait without truncating them. */
const COLUMNS: Array<{ key: string; label: string; width: number; align?: "left" | "right" }> = [
  { key: "number", label: "PROJECT #", width: 96 },
  { key: "name", label: "DEAL", width: 268 },
  { key: "amount", label: "AMOUNT", width: 92, align: "right" },
  { key: "owner", label: "OWNER", width: 132 },
  { key: "sent", label: "SENT", width: 84 },
];

function columnX(index: number): number {
  let x = MARGIN;
  for (let i = 0; i < index; i++) x += COLUMNS[i]!.width;
  return x;
}

/** `2026-08-12T13:04:00Z` -> `Aug 12, 2026`. Invalid input degrades to the raw string, never to a throw. */
function formatSentDate(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return new Date(parsed).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Chicago",
  });
}

function drawTableHeader(doc: PDFKit.PDFDocument, y: number): number {
  doc.rect(MARGIN, y, CONTENT_WIDTH, 22).fill(BRAND_DARK);
  doc.fillColor(BRAND_WHITE).fontSize(8).font("Helvetica-Bold");
  COLUMNS.forEach((col, i) => {
    doc.text(col.label, columnX(i) + 8, y + 7, {
      width: col.width - 16,
      align: col.align ?? "left",
      lineBreak: false,
    });
  });
  doc.fillColor(BRAND_DARK).font("Helvetica");
  return y + 22;
}

function drawPageChrome(doc: PDFKit.PDFDocument, periodLabel: string, isFirst: boolean): number {
  let y = MARGIN;
  doc.rect(0, 0, PAGE_WIDTH, 46).fill(BRAND_DARK);
  doc.fillColor(BRAND_WHITE).fontSize(11).font("Helvetica-Bold").text("T-ROCK CONSTRUCTION", MARGIN, 14, { lineBreak: false });
  doc.fillColor("#9ca3af").fontSize(9).font("Helvetica").text("Sync Hub", MARGIN, 29, { lineBreak: false });
  doc.rect(0, 46, PAGE_WIDTH, 3).fill(BRAND_RED);
  y = 46 + 3 + 20;

  if (isFirst) {
    doc.fillColor(BRAND_DARK).fontSize(18).font("Helvetica-Bold").text("Estimates Sent to Client", MARGIN, y, { lineBreak: false });
    y += 24;
    doc.fillColor(BRAND_MUTED).fontSize(10).font("Helvetica").text(periodLabel, MARGIN, y, { lineBreak: false });
    y += 22;
  }

  doc.fillColor(BRAND_DARK);
  return y;
}

function bufferFromDoc(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

/**
 * Sum the decimal STRINGS in integer cents.
 *
 * The rows arrive as `numeric(12,2)` verbatim precisely so no cent is lost to a float, and adding them
 * back through `Number` would hand that back at the only place the total is stated. A malformed amount
 * contributes nothing rather than turning the whole total into NaN.
 */
export function totalEstimateCents(deals: CrmEstimateSent[]): number {
  let cents = 0;
  for (const deal of deals) {
    const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec((deal.amount ?? "").trim());
    if (!match) continue;
    const [, sign, whole, frac = ""] = match;
    const value = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
    cents += sign === "-" ? -value : value;
  }
  return cents;
}

export function formatCentsUsd(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const body = `$${Math.round(abs / 100).toLocaleString("en-US")}`;
  return negative ? `-${body}` : body;
}


/**
 * The footer line: what this DOCUMENT contains, and — when the endpoint capped the rows — that it is
 * not all of them.
 *
 * Printing the true total beside a sum of only the newest 500 would be a footer that does not add up;
 * printing the row count alone would present a truncated list as complete. Pure and exported because
 * pdfkit compresses its content streams, so this sentence cannot be asserted from the rendered bytes.
 */
export function estimatesTotalLabel(deals: CrmEstimateSent[], total?: number): string {
  const trueTotal = total ?? deals.length;
  const money = formatCentsUsd(totalEstimateCents(deals));
  if (trueTotal > deals.length) {
    return `Most recent ${deals.length} of ${trueTotal} estimates · ${money} shown`;
  }
  return `${deals.length} estimate${deals.length === 1 ? "" : "s"} · ${money}`;
}

export interface EstimatesSentPdfInput {
  deals: CrmEstimateSent[];
  /** The span the list actually covers, rendered verbatim under the title. */
  periodLabel: string;
  /**
   * The TRUE number of estimates in the window, which exceeds `deals.length` once the endpoint's
   * 500-row cap bites. Defaults to the row count for callers that have no separate total.
   */
  total?: number;
}

/** Builds the attachment. Callers must treat a rejection as "send without the attachment". */
export async function buildEstimatesSentPdf(input: EstimatesSentPdfInput): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "LETTER",
    layout: "landscape",
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    // pdfkit otherwise emits its first page before the header is drawn, leaving a blank leading sheet.
    autoFirstPage: false,
  });

  doc.addPage();
  let y = drawPageChrome(doc, input.periodLabel, true);
  y = drawTableHeader(doc, y);

  const pageBottom = doc.page.height - FOOTER_RESERVE;
  let alt = false;

  for (const deal of input.deals) {
    const name = deal.name || "(untitled deal)";
    const owner = deal.ownerName || deal.ownerEmail || "—";
    const identifier = deal.projectNumber || deal.dealNumber || "—";
    const resend = resendLabel(deal.priorEntryCount);

    // Measured before drawing: a long deal name wraps to two lines, and a row that would straddle the
    // page break has to move WHOLE rather than leave its second line orphaned on the next sheet.
    const nameHeight = doc.fontSize(9).font("Helvetica").heightOfString(name, {
      width: COLUMNS[1]!.width - 16,
    });
    // The re-send badge sits BELOW the name, so its line has to be reserved too. Without it the badge
    // started at y + 6 + nameHeight with only six points left in the row, crossed the row rule and
    // could land on the following row — and the page-break test was short by the same amount.
    const badgeHeight = resend ? doc.fontSize(7.5).heightOfString(resend, { width: COLUMNS[1]!.width - 16 }) : 0;
    doc.fontSize(9);
    const rowHeight = Math.max(22, nameHeight + badgeHeight + 12);

    if (y + rowHeight > pageBottom) {
      doc.addPage();
      y = drawPageChrome(doc, input.periodLabel, false);
      y = drawTableHeader(doc, y);
      alt = false;
    }

    if (alt) doc.rect(MARGIN, y, CONTENT_WIDTH, rowHeight).fill(ROW_ALT);
    alt = !alt;

    doc.fillColor(BRAND_DARK).fontSize(9).font("Helvetica");
    doc.text(identifier, columnX(0) + 8, y + 6, { width: COLUMNS[0]!.width - 16, lineBreak: false, ellipsis: true });
    doc.text(name, columnX(1) + 8, y + 6, { width: COLUMNS[1]!.width - 16 });
    doc.font("Helvetica-Bold").text(formatEstimateAmount(deal.amount), columnX(2) + 8, y + 6, {
      width: COLUMNS[2]!.width - 16,
      align: "right",
      lineBreak: false,
    });
    doc.font("Helvetica").text(owner, columnX(3) + 8, y + 6, { width: COLUMNS[3]!.width - 16, lineBreak: false, ellipsis: true });
    doc.text(formatSentDate(deal.enteredAt), columnX(4) + 8, y + 6, { width: COLUMNS[4]!.width - 16, lineBreak: false });

    // Carried into the PDF for the same reason the email badges it: a revised estimate is not new
    // business, and a total read without that distinction overstates the pipeline.
    if (resend) {
      doc.fillColor("#92400e").fontSize(7.5).text(resend, columnX(1) + 8, y + 6 + nameHeight, {
        width: COLUMNS[1]!.width - 16,
        lineBreak: false,
      });
      doc.fillColor(BRAND_DARK).fontSize(9);
    }

    y += rowHeight;
    doc.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_WIDTH, y).strokeColor(RULE).lineWidth(0.5).stroke();
  }

  const totalLabel = estimatesTotalLabel(input.deals, input.total);
  if (y + 30 > pageBottom) {
    doc.addPage();
    y = drawPageChrome(doc, input.periodLabel, false);
  }
  doc.fillColor(BRAND_DARK).fontSize(10).font("Helvetica-Bold").text(totalLabel, MARGIN, y + 10, {
    width: CONTENT_WIDTH,
    align: "right",
    lineBreak: false,
  });

  return bufferFromDoc(doc);
}

/**
 * `estimates-sent-2026-08-12.pdf` — dated so a forwarded copy still says which run it came from.
 *
 * In the REPORT's timezone, not UTC. The scheduler picks its slot in the configured zone, so an 8pm
 * Chicago run slicing the UTC date named itself for the next calendar day — the one thing the date in
 * the filename is there to pin down.
 */
export function estimatesSentPdfFilename(runAt: Date, timezone = "America/Chicago"): string {
  let stamp: string;
  try {
    // en-CA gives ISO-ordered YYYY-MM-DD directly.
    stamp = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(runAt);
  } catch {
    // An unknown zone from config must not cost the attachment its name.
    stamp = runAt.toISOString().slice(0, 10);
  }
  return `estimates-sent-${stamp}.pdf`;
}
