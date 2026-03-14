/**
 * Archive PDF Generator
 * =====================
 *
 * Converts structured Procore API data into formatted PDF reports for project archives.
 * Used by project-archive.ts instead of raw JSON exports.
 * Branded with T-Rock Construction visual identity.
 *
 * @module archive-pdf-generator
 */

import * as fs from 'fs';
import * as path from 'path';
import PDFDocument from 'pdfkit';

// Brand constants
const BRAND_RED = '#d11921';
const BRAND_DARK = '#0a0a0a';
const BRAND_GRAY = '#2c2f32';
const BRAND_LIGHT = '#f5f5f5';
const BRAND_WHITE = '#ffffff';

const MARGIN = 50;
const BOTTOM_MARGIN = 50;
const HEADER_BAND_HEIGHT = 70;
const ROW_HEIGHT = 20;
const TABLE_HEADER_HEIGHT = 20;
const FOOTER_TOP_OFFSET = 40;
const LOGO_SIZE = 40;
const LOGO_LEFT = 20;
const COMPANY_NAME_LEFT = 70;
const CONTENT_WIDTH_PORTRAIT = 512; // PAGE_WIDTH - 2*MARGIN for LETTER
const CONTENT_WIDTH_LANDSCAPE = 692; // PAGE_HEIGHT - 2*MARGIN for LETTER landscape

// Load logo once at module level
let logoBuffer: Buffer | null = null;
try {
  logoBuffer = fs.readFileSync(path.join(process.cwd(), 'client', 'public', 'favicon.png'));
} catch {
  console.warn('[archive-pdf] Could not load T-Rock logo, PDFs will be generated without logo');
}

function fmtCurrency(val: any): string {
  if (val == null || val === '') return '$0.00';
  const n = typeof val === 'number' ? val : parseFloat(String(val).replace(/[^0-9.-]/g, ''));
  if (Number.isNaN(n)) return '$0.00';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(val: any): string {
  if (val == null || val === '') return '';
  const d = typeof val === 'string' ? new Date(val) : val instanceof Date ? val : new Date(String(val));
  if (Number.isNaN(d.getTime())) return '';
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const y = d.getFullYear();
  return `${m}/${day}/${y}`;
}

function truncate(s: string, max: number): string {
  const str = String(s ?? '');
  if (str.length <= max) return str;
  return str.slice(0, Math.max(0, max - 3)) + '...';
}

type Align = 'left' | 'right' | 'center';

function isTotalsRow(row: string[], rowIndex: number, totalRows: number): boolean {
  if (rowIndex !== totalRows - 1) return false;
  const text = row.join(' ').toLowerCase();
  return text.includes('total') || text.includes('totals');
}

interface DrawTableOptions {
  projectName?: string;
  reportTitle?: string;
  landscape?: boolean;
}

function drawTable(
  doc: PDFKit.PDFDocument,
  headers: { label: string; width: number; align?: Align }[],
  rows: string[][],
  startY?: number,
  options?: DrawTableOptions
): number {
  const tableTop = startY ?? doc.y;
  const tableLeft = MARGIN;
  const totalWidth = headers.reduce((a, h) => a + h.width, 0);
  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const bottomY = pageHeight - FOOTER_TOP_OFFSET - 20;
  const projectName = options?.projectName ?? '';
  const reportTitle = options?.reportTitle ?? '';
  const landscape = options?.landscape ?? false;
  const pageOpts = landscape ? { size: 'LETTER' as const, layout: 'landscape' as const } : { size: 'LETTER' as const };

  function drawTableHeaderRow(y: number): void {
    doc.fillColor(BRAND_GRAY).rect(tableLeft, y, totalWidth, TABLE_HEADER_HEIGHT).fill();
    doc.fontSize(9).font('Helvetica-Bold').fillColor(BRAND_WHITE);
    let x = tableLeft;
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i];
      const align = h.align ?? 'left';
      const text = truncate(h.label, 25).toUpperCase();
      const paddingH = 5;
      const paddingV = 4;
      if (align === 'right') {
        doc.text(text, x, y + paddingV, { width: h.width - paddingH * 2, align: 'right' });
      } else if (align === 'center') {
        doc.text(text, x, y + paddingV, { width: h.width, align: 'center' });
      } else {
        doc.text(text, x + paddingH, y + paddingV, { width: h.width - paddingH * 2 });
      }
      x += h.width;
    }
    doc.font('Helvetica').fillColor(BRAND_DARK);
  }

  function checkPageBreak(needed: number): void {
    if (doc.y + needed > bottomY) {
      doc.addPage(pageOpts);
      addPageHeader(doc, projectName, reportTitle, false);
      doc.y = 90;
      drawTableHeaderRow(doc.y);
      doc.y += TABLE_HEADER_HEIGHT;
    }
  }

  let y = tableTop;

  // Draw header row
  drawTableHeaderRow(y);
  y += TABLE_HEADER_HEIGHT;
  doc.y = y;

  for (let ri = 0; ri < rows.length; ri++) {
    checkPageBreak(ROW_HEIGHT);
    const row = rows[ri];
    const isTotals = isTotalsRow(row, ri, rows.length);
    const bg = isTotals ? BRAND_RED : (ri % 2 === 0 ? BRAND_WHITE : BRAND_LIGHT);
    const textColor = isTotals ? BRAND_WHITE : BRAND_DARK;

    doc.fillColor(bg).rect(tableLeft, doc.y, totalWidth, ROW_HEIGHT).fill();
    doc.fillColor(textColor).fontSize(9).font(isTotals ? 'Helvetica-Bold' : 'Helvetica');

    const paddingH = 5;
    const paddingV = 4;
    let x = tableLeft;
    for (let ci = 0; ci < headers.length; ci++) {
      const h = headers[ci];
      const align = (h.align ?? 'left') as Align;
      const cellText = truncate(row[ci] ?? '', 40);
      if (align === 'right') {
        doc.text(cellText, x, doc.y + paddingV, { width: h.width - paddingH * 2, align: 'right' });
      } else if (align === 'center') {
        doc.text(cellText, x, doc.y + paddingV, { width: h.width, align: 'center' });
      } else {
        doc.text(cellText, x + paddingH, doc.y + paddingV, { width: h.width - paddingH * 2 });
      }
      x += h.width;
    }
    doc.font('Helvetica');
    doc.y += ROW_HEIGHT;

    // Horizontal divider line between rows (not after last row to avoid double line)
    if (ri < rows.length - 1) {
      doc.strokeColor('#e0e0e0').lineWidth(0.5)
        .moveTo(tableLeft, doc.y).lineTo(tableLeft + totalWidth, doc.y).stroke();
    }
  }

  return doc.y;
}

/**
 * Adds the branded header band to a page. Returns the y-position where content should start.
 * @param isFirstPage - if true, also draws project name, subtitle, date, and red accent line
 */
function addPageHeader(
  doc: PDFKit.PDFDocument,
  projectName: string,
  reportTitle: string,
  isFirstPage: boolean
): number {
  const pageWidth = doc.page.width;

  // Header band - full width dark bar
  doc.fillColor(BRAND_GRAY).rect(0, 0, pageWidth, HEADER_BAND_HEIGHT).fill();

  // Logo
  if (logoBuffer) {
    try {
      doc.image(logoBuffer, LOGO_LEFT, (HEADER_BAND_HEIGHT - LOGO_SIZE) / 2, {
        width: LOGO_SIZE,
        height: LOGO_SIZE,
      });
    } catch {
      // Ignore image errors
    }
  }

  // Company name
  doc.fontSize(14).font('Helvetica-Bold').fillColor(BRAND_WHITE);
  doc.text('T-ROCK CONSTRUCTION', COMPANY_NAME_LEFT, 22);

  // Report title in header band
  doc.fontSize(10).font('Helvetica');
  doc.text(reportTitle, COMPANY_NAME_LEFT, 44);

  doc.fillColor(BRAND_DARK);

  if (isFirstPage) {
    // Sub-header: project name, subtitle, date
    doc.fontSize(20).font('Helvetica-Bold').fillColor(BRAND_RED);
    doc.text(projectName || 'Project', MARGIN, 90);
    doc.fontSize(12).font('Helvetica').fillColor('#666666');
    doc.text(reportTitle || 'Report', MARGIN, 115);
    doc.fontSize(10).fillColor('#999999');
    doc.text(`Generated: ${fmtDate(new Date())}`, MARGIN, 130);
    doc.fillColor(BRAND_DARK);

    // Red accent line
    doc.strokeColor(BRAND_RED).lineWidth(2)
      .moveTo(MARGIN, 145).lineTo(pageWidth - MARGIN, 145).stroke();

    return 150;
  }

  return 90;
}

function addFooter(doc: PDFKit.PDFDocument): void {
  const pages = doc.bufferedPageRange();

  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(i);
    const w = doc.page.width;
    const h = doc.page.height;

    doc.strokeColor('#cccccc').lineWidth(0.5)
      .moveTo(MARGIN, h - FOOTER_TOP_OFFSET).lineTo(w - MARGIN, h - FOOTER_TOP_OFFSET).stroke();

    doc.fontSize(8).font('Helvetica').fillColor('#999999');
    doc.text('T-Rock Construction — Confidential', MARGIN, h - 35, { width: w / 2 });
    doc.text(`Page ${i + 1} of ${pages.count}`, w / 2, h - 35, {
      width: w / 2 - MARGIN,
      align: 'right',
    });
    doc.fillColor(BRAND_DARK);
  }
}

function bufferFromDoc(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

async function createEmptyPdf(projectName: string, reportTitle: string, category: string): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: MARGIN, bottom: BOTTOM_MARGIN, left: MARGIN, right: MARGIN },
  });
  const startY = addPageHeader(doc, projectName, reportTitle, true);
  const pageHeight = doc.page.height;
  const contentMidY = (startY + pageHeight - FOOTER_TOP_OFFSET) / 2;
  doc.fontSize(14).font('Helvetica').fillColor('#999999');
  const msg = `No ${category} data available for this project.`;
  const textHeight = 18;
  doc.text(msg, MARGIN, contentMidY - textHeight / 2, {
    width: CONTENT_WIDTH_PORTRAIT,
    align: 'center',
  });
  doc.fillColor(BRAND_DARK);
  addFooter(doc);
  return bufferFromDoc(doc);
}

// ---------------------------------------------------------------------------
// Shared commitments table (Subcontracts / Purchase Orders)
// ---------------------------------------------------------------------------

function generateCommitmentsTablePdf(
  data: any[],
  projectName: string,
  reportTitle: string,
  sectionTitle: string,
  emptyMessage: string
): Promise<Buffer> {
  if (data.length === 0) {
    return createEmptyPdf(projectName, reportTitle, emptyMessage);
  }

  const doc = new PDFDocument({
    size: 'LETTER',
    layout: 'landscape',
    margins: { top: MARGIN, bottom: BOTTOM_MARGIN, left: MARGIN, right: MARGIN },
  });

  let y = addPageHeader(doc, projectName, reportTitle, true);

  // Section header
  doc.fontSize(13).font('Helvetica-Bold').fillColor(BRAND_RED);
  doc.text(sectionTitle, MARGIN, y);
  doc.strokeColor(BRAND_RED).lineWidth(1).moveTo(MARGIN, y + 14).lineTo(MARGIN + 150, y + 14).stroke();
  doc.fillColor(BRAND_DARK);
  y += 34;

  // Column widths for landscape (692pt content width), 8 columns
  const headers = [
    { label: 'Contract #', width: 75 },
    { label: 'Title', width: 130 },
    { label: 'Vendor', width: 110 },
    { label: 'Status', width: 65 },
    { label: 'Executed', width: 70 },
    { label: 'Value', width: 90, align: 'right' as Align },
    { label: '% Done', width: 55, align: 'right' as Align },
    { label: 'Paid to Date', width: 97, align: 'right' as Align },
  ];

  const rows = data.map((c: any) => [
    truncate(c.number ?? c.contract_number ?? c.id ?? '', 12),
    truncate(c.title ?? c.name ?? '', 25),
    truncate(c.vendor?.name ?? c.vendor_name ?? '', 22),
    truncate(c.status ?? c.status_name ?? '', 10),
    fmtDate(c.executed_at ?? c.executed_date ?? c.signed_date),
    fmtCurrency(c.total_value ?? c.value ?? c.amount ?? 0),
    String(c.percent_complete ?? c.percentage_complete ?? '') + (c.percent_complete != null ? '%' : ''),
    fmtCurrency(c.paid_to_date ?? c.amount_paid ?? 0),
  ]);

  let totalVal = 0,
    totalPaid = 0;
  for (const c of data) {
    totalVal += parseFloat(c.total_value ?? c.value ?? c.amount ?? 0) || 0;
    totalPaid += parseFloat(c.paid_to_date ?? c.amount_paid ?? 0) || 0;
  }
  rows.push(['', '', '', '', 'Totals', fmtCurrency(totalVal), '', fmtCurrency(totalPaid)]);

  drawTable(doc, headers, rows, y, {
    projectName,
    reportTitle,
    landscape: true,
  });

  // Line items per contract
  for (const c of data) {
    const lineItems = c.line_items ?? c.line_items_data ?? [];
    if (lineItems.length > 0) {
      if (doc.y > doc.page.height - 140) {
        doc.addPage({ size: 'LETTER', layout: 'landscape' });
        doc.y = addPageHeader(doc, projectName, reportTitle, false);
      }
      doc.moveDown(0.5);
      doc.fontSize(13).font('Helvetica-Bold').fillColor(BRAND_RED);
      doc.text(`Line Items: ${c.number ?? c.title ?? c.id}`, MARGIN, doc.y);
      doc.strokeColor(BRAND_RED).lineWidth(1).moveTo(MARGIN, doc.y + 14).lineTo(MARGIN + 250, doc.y + 14).stroke();
      doc.fillColor(BRAND_DARK);
      doc.y += 34;
      const liHeaders = [
        { label: 'Line #', width: 75 },
        { label: 'Description', width: 422 },
        { label: 'Amount', width: 145, align: 'right' as Align },
      ];
      const liRows = lineItems.map((li: any) => [
        truncate(li.line_number ?? li.number ?? li.id ?? '', 10),
        truncate(li.description ?? li.name ?? '', 50),
        fmtCurrency(li.amount ?? li.total ?? 0),
      ]);
      drawTable(doc, liHeaders, liRows, doc.y, {
        projectName,
        reportTitle,
        landscape: true,
      });
    }
  }

  addFooter(doc);
  return bufferFromDoc(doc);
}

// ---------------------------------------------------------------------------
// Report generators
// ---------------------------------------------------------------------------

export async function generateBudgetPdf(
  data: { lineItems?: any[]; line_items?: any[]; summary?: any },
  projectName: string
): Promise<Buffer> {
  const lineItems = Array.isArray(data?.lineItems) ? data.lineItems : (Array.isArray(data?.line_items) ? data.line_items : []);
  const summary = data?.summary ?? {};

  if (lineItems.length === 0 && !summary) {
    return createEmptyPdf(projectName, 'Budget Report', 'budget');
  }

  const doc = new PDFDocument({
    size: 'LETTER',
    layout: 'landscape',
    margins: { top: MARGIN, bottom: BOTTOM_MARGIN, left: MARGIN, right: MARGIN },
  });

  let y = addPageHeader(doc, projectName, 'Budget Report', true);

  doc.fontSize(13).font('Helvetica-Bold').fillColor(BRAND_RED);
  doc.text('Budget Summary', MARGIN, y);
  doc.strokeColor(BRAND_RED).lineWidth(1).moveTo(MARGIN, y + 14).lineTo(MARGIN + 120, y + 14).stroke();
  doc.fillColor(BRAND_DARK);
  y += 28;

  doc.fontSize(10).font('Helvetica');
  const s = summary;
  doc.text(`Total Budget: ${fmtCurrency(s.total_budget_amount ?? s.total_budget ?? s.total ?? 0)}`, MARGIN, y);
  y += 14;
  doc.text(`Original Budget: ${fmtCurrency(s.original_budget ?? s.original ?? 0)}`, MARGIN, y);
  y += 14;
  doc.text(`Approved Changes: ${fmtCurrency(s.approved_changes ?? s.approved_change_orders ?? 0)}`, MARGIN, y);
  y += 14;
  doc.text(`Revised Budget: ${fmtCurrency(s.revised_budget ?? s.revised ?? 0)}`, MARGIN, y);
  y += 14;
  doc.text(`Pending Changes: ${fmtCurrency(s.pending_changes ?? s.pending_change_orders ?? 0)}`, MARGIN, y);
  y += 14;
  doc.text(`Projected Over/Under: ${fmtCurrency(s.projected_over_under ?? s.projected ?? 0)}`, MARGIN, y);
  y += 24;

  if (lineItems.length > 0) {
    doc.fontSize(13).font('Helvetica-Bold').fillColor(BRAND_RED);
    doc.text('Line Items', MARGIN, y);
    doc.strokeColor(BRAND_RED).lineWidth(1).moveTo(MARGIN, y + 14).lineTo(MARGIN + 80, y + 14).stroke();
    doc.fillColor(BRAND_DARK);
    y += 34;

    // 8 columns, landscape 692pt: ~86 each, adjust for readability
    const headers = [
      { label: 'Cost Code', width: 72 },
      { label: 'Description', width: 115 },
      { label: 'Original', width: 72, align: 'right' as Align },
      { label: 'Approved COs', width: 72, align: 'right' as Align },
      { label: 'Revised', width: 72, align: 'right' as Align },
      { label: 'Pending', width: 72, align: 'right' as Align },
      { label: 'Projected', width: 72, align: 'right' as Align },
      { label: 'Over/Under', width: 81, align: 'right' as Align },
    ];
    const rows = lineItems.map((li: any) => [
      truncate(li.cost_code ?? li.code ?? '', 15),
      truncate(li.description ?? li.name ?? '', 25),
      fmtCurrency(li.original_budget ?? li.original ?? 0),
      fmtCurrency(li.approved_change_orders ?? li.approved_cos ?? 0),
      fmtCurrency(li.revised_budget ?? li.revised ?? 0),
      fmtCurrency(li.pending_change_orders ?? li.pending_cos ?? 0),
      fmtCurrency(li.projected_cost ?? li.projected ?? 0),
      fmtCurrency(li.over_under ?? 0),
    ]);

    let totalOrig = 0,
      totalRev = 0,
      totalProj = 0;
    for (const li of lineItems) {
      totalOrig += parseFloat(li.original_budget ?? li.original ?? 0) || 0;
      totalRev += parseFloat(li.revised_budget ?? li.revised ?? 0) || 0;
      totalProj += parseFloat(li.projected_cost ?? li.projected ?? 0) || 0;
    }
    rows.push(['', 'TOTAL', fmtCurrency(totalOrig), '', fmtCurrency(totalRev), '', fmtCurrency(totalProj), '']);

    drawTable(doc, headers, rows, y, {
      projectName,
      reportTitle: 'Budget Report',
      landscape: true,
    });
  }

  addFooter(doc);
  return bufferFromDoc(doc);
}

export async function generateDailyLogsPdf(data: any[], projectName: string): Promise<Buffer> {
  const items = Array.isArray(data) ? data : [];
  if (items.length === 0) {
    return createEmptyPdf(projectName, 'Daily Logs Report', 'daily log');
  }

  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: MARGIN, bottom: BOTTOM_MARGIN, left: MARGIN, right: MARGIN },
  });

  const sorted = [...items].sort((a, b) => {
    const da = new Date(a.date ?? a.log_date ?? 0).getTime();
    const db = new Date(b.date ?? b.log_date ?? 0).getTime();
    return db - da;
  });

  let y = addPageHeader(doc, projectName, 'Daily Logs Report', true);
  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const bottomY = pageHeight - FOOTER_TOP_OFFSET - 80;

  doc.fontSize(13).font('Helvetica-Bold').fillColor(BRAND_RED);
  doc.text('Daily Logs', MARGIN, y);
  doc.strokeColor(BRAND_RED).lineWidth(1).moveTo(MARGIN, y + 14).lineTo(MARGIN + 100, y + 14).stroke();
  doc.fillColor(BRAND_DARK);
  y += 34;

  for (let i = 0; i < sorted.length; i++) {
    const log = sorted[i];
    if (y > bottomY) {
      doc.addPage({ size: 'LETTER' });
      y = addPageHeader(doc, projectName, 'Daily Logs Report', false);
    }

    doc.fontSize(13).font('Helvetica-Bold').fillColor(BRAND_RED);
    doc.text(fmtDate(log.date ?? log.log_date ?? '') || 'Unknown Date', MARGIN, y);
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').fillColor(BRAND_DARK);

    const weather = log.weather ?? log.weather_conditions ?? '';
    if (weather) doc.text(`Weather: ${truncate(String(weather), 80)}`);

    const work = log.work_performed ?? log.notes ?? log.description ?? '';
    if (work) doc.text(`Work Performed: ${truncate(String(work), 200)}`);

    const workers = log.workers_on_site ?? log.workers ?? log.craft_workers ?? '';
    if (workers) doc.text(`Workers: ${truncate(String(workers), 80)}`);

    const visitors = log.visitors ?? '';
    if (visitors) doc.text(`Visitors: ${truncate(String(visitors), 80)}`);

    const equipment = log.equipment ?? log.equipment_used ?? '';
    if (equipment) doc.text(`Equipment: ${truncate(String(equipment), 80)}`);

    doc.moveDown(0.5);
    doc.strokeColor('#cccccc').lineWidth(0.5).moveTo(MARGIN, doc.y).lineTo(pageWidth - MARGIN, doc.y).stroke();
    doc.moveDown(0.5);
    y = doc.y;
  }

  addFooter(doc);
  return bufferFromDoc(doc);
}

export async function generatePrimeContractsPdf(data: any[], projectName: string): Promise<Buffer> {
  const items = Array.isArray(data) ? data : [];
  if (items.length === 0) {
    return createEmptyPdf(projectName, 'Prime Contracts Report', 'prime contracts');
  }

  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: MARGIN, bottom: BOTTOM_MARGIN, left: MARGIN, right: MARGIN },
  });

  let y = addPageHeader(doc, projectName, 'Prime Contracts Report', true);

  doc.fontSize(13).font('Helvetica-Bold').fillColor(BRAND_RED);
  doc.text('Prime Contracts', MARGIN, y);
  doc.strokeColor(BRAND_RED).lineWidth(1).moveTo(MARGIN, y + 14).lineTo(MARGIN + 130, y + 14).stroke();
  doc.fillColor(BRAND_DARK);
  y += 34;

  // 7 columns, portrait 512pt
  const headers = [
    { label: 'Contract #', width: 68 },
    { label: 'Title', width: 130 },
    { label: 'Vendor', width: 95 },
    { label: 'Status', width: 55 },
    { label: 'Executed', width: 65 },
    { label: 'Value', width: 55, align: 'right' as Align },
    { label: '% Complete', width: 44, align: 'right' as Align },
  ];
  const rows = items.map((c: any) => [
    truncate(c.number ?? c.contract_number ?? c.id ?? '', 12),
    truncate(c.title ?? c.name ?? '', 25),
    truncate(c.vendor?.name ?? c.vendor_name ?? '', 18),
    truncate(c.status ?? c.status_name ?? '', 10),
    fmtDate(c.executed_at ?? c.executed_date ?? c.signed_date),
    fmtCurrency(c.total_value ?? c.value ?? c.amount ?? 0),
    String(c.percent_complete ?? c.percentage_complete ?? '') + (c.percent_complete != null ? '%' : ''),
  ]);

  let totalVal = 0;
  for (const c of items) totalVal += parseFloat(c.total_value ?? c.value ?? c.amount ?? 0) || 0;
  rows.push(['', '', '', '', 'Total', fmtCurrency(totalVal), '']);

  y = drawTable(doc, headers, rows, y, { projectName, reportTitle: 'Prime Contracts Report' });

  for (const c of items) {
    const lineItems = c.line_items ?? c.line_items_data ?? [];
    if (lineItems.length > 0) {
      if (doc.y > doc.page.height - 140) {
        doc.addPage({ size: 'LETTER' });
        doc.y = addPageHeader(doc, projectName, 'Prime Contracts Report', false);
      }
      doc.moveDown(0.5);
      doc.fontSize(13).font('Helvetica-Bold').fillColor(BRAND_RED);
      doc.text(`Line Items: ${c.number ?? c.title ?? c.id}`, MARGIN, doc.y);
      doc.strokeColor(BRAND_RED).lineWidth(1).moveTo(MARGIN, doc.y + 14).lineTo(MARGIN + 200, doc.y + 14).stroke();
      doc.fillColor(BRAND_DARK);
      doc.y += 34;
      const liHeaders = [
        { label: 'Line #', width: 55 },
        { label: 'Description', width: 312 },
        { label: 'Amount', width: 95, align: 'right' as Align },
      ];
      const liRows = lineItems.map((li: any) => [
        truncate(li.line_number ?? li.number ?? li.id ?? '', 10),
        truncate(li.description ?? li.name ?? '', 40),
        fmtCurrency(li.amount ?? li.total ?? 0),
      ]);
      drawTable(doc, liHeaders, liRows, doc.y, { projectName, reportTitle: 'Prime Contracts Report' });
    }
  }

  addFooter(doc);
  return bufferFromDoc(doc);
}

export async function generateSubcontractsPdf(data: any[], projectName: string): Promise<Buffer> {
  return generateCommitmentsTablePdf(
    data,
    projectName,
    'Subcontracts Report',
    'Subcontracts',
    'subcontracts'
  );
}

export async function generatePurchaseOrdersPdf(data: any[], projectName: string): Promise<Buffer> {
  return generateCommitmentsTablePdf(
    data,
    projectName,
    'Purchase Orders Report',
    'Purchase Orders',
    'purchase orders'
  );
}

export async function generateChangeOrdersPdf(data: any[], projectName: string): Promise<Buffer> {
  const items = Array.isArray(data) ? data : [];
  if (items.length === 0) {
    return createEmptyPdf(projectName, 'Change Orders Report', 'change orders');
  }

  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: MARGIN, bottom: BOTTOM_MARGIN, left: MARGIN, right: MARGIN },
  });

  let y = addPageHeader(doc, projectName, 'Change Orders Report', true);

  doc.fontSize(13).font('Helvetica-Bold').fillColor(BRAND_RED);
  doc.text('Change Orders', MARGIN, y);
  doc.strokeColor(BRAND_RED).lineWidth(1).moveTo(MARGIN, y + 14).lineTo(MARGIN + 120, y + 14).stroke();
  doc.fillColor(BRAND_DARK);
  y += 34;

  const headers = [
    { label: 'CO Package #', width: 82 },
    { label: 'Title', width: 175 },
    { label: 'Status', width: 68 },
    { label: 'Created', width: 68 },
    { label: 'Due Date', width: 68 },
    { label: 'Grand Total', width: 51, align: 'right' as Align },
  ];
  const rows = items.map((c: any) => [
    truncate(c.number ?? c.package_number ?? c.id ?? '', 14),
    truncate(c.title ?? c.name ?? '', 30),
    truncate(c.status ?? c.status_name ?? '', 12),
    fmtDate(c.created_at ?? c.created_date ?? c.created),
    fmtDate(c.due_date ?? c.due),
    fmtCurrency(c.grand_total ?? c.total ?? c.amount ?? 0),
  ]);

  drawTable(doc, headers, rows, y, { projectName, reportTitle: 'Change Orders Report' });

  for (const pkg of items) {
    const coItems = pkg.change_order_line_items ?? pkg.potential_change_orders ?? pkg.line_items ?? [];
    if (coItems.length > 0) {
      if (doc.y > doc.page.height - 140) {
        doc.addPage({ size: 'LETTER' });
        doc.y = addPageHeader(doc, projectName, 'Change Orders Report', false);
      }
      doc.moveDown(0.5);
      doc.fontSize(13).font('Helvetica-Bold').fillColor(BRAND_RED);
      doc.text(`Line Items: ${pkg.number ?? pkg.title ?? pkg.id}`, MARGIN, doc.y);
      doc.strokeColor(BRAND_RED).lineWidth(1).moveTo(MARGIN, doc.y + 14).lineTo(MARGIN + 200, doc.y + 14).stroke();
      doc.fillColor(BRAND_DARK);
      doc.y += 34;
      const liHeaders = [
        { label: 'Line #', width: 55 },
        { label: 'Description', width: 262 },
        { label: 'Amount', width: 95, align: 'right' as Align },
        { label: 'Status', width: 70 },
      ];
      const liRows = coItems.map((li: any) => [
        truncate(li.line_number ?? li.number ?? li.id ?? '', 10),
        truncate(li.description ?? li.name ?? '', 35),
        fmtCurrency(li.amount ?? li.total ?? 0),
        truncate(li.status ?? li.status_name ?? '', 12),
      ]);
      drawTable(doc, liHeaders, liRows, doc.y, { projectName, reportTitle: 'Change Orders Report' });
    }
  }

  addFooter(doc);
  return bufferFromDoc(doc);
}

export async function generateChangeEventsPdf(data: any[], projectName: string): Promise<Buffer> {
  const items = Array.isArray(data) ? data : [];
  if (items.length === 0) {
    return createEmptyPdf(projectName, 'Change Events Report', 'change events');
  }

  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: MARGIN, bottom: BOTTOM_MARGIN, left: MARGIN, right: MARGIN },
  });

  let y = addPageHeader(doc, projectName, 'Change Events Report', true);

  doc.fontSize(13).font('Helvetica-Bold').fillColor(BRAND_RED);
  doc.text('Change Events', MARGIN, y);
  doc.strokeColor(BRAND_RED).lineWidth(1).moveTo(MARGIN, y + 14).lineTo(MARGIN + 120, y + 14).stroke();
  doc.fillColor(BRAND_DARK);
  y += 34;

  const headers = [
    { label: 'Event #', width: 62 },
    { label: 'Title', width: 175 },
    { label: 'Status', width: 68 },
    { label: 'Type', width: 88 },
    { label: 'Created', width: 68 },
    { label: 'Amount', width: 51, align: 'right' as Align },
  ];
  const rows = items.map((c: any) => [
    truncate(c.number ?? c.event_number ?? c.id ?? '', 12),
    truncate(c.title ?? c.name ?? '', 30),
    truncate(c.status ?? c.status_name ?? '', 12),
    truncate(c.change_event_type ?? c.type ?? '', 15),
    fmtDate(c.created_at ?? c.created_date ?? c.created),
    fmtCurrency(c.amount ?? c.total ?? 0),
  ]);

  let total = 0;
  for (const c of items) total += parseFloat(c.amount ?? c.total ?? 0) || 0;
  rows.push(['', '', '', '', 'Total', fmtCurrency(total)]);

  drawTable(doc, headers, rows, y, { projectName, reportTitle: 'Change Events Report' });
  addFooter(doc);
  return bufferFromDoc(doc);
}

export async function generateDirectCostsPdf(data: any[], projectName: string): Promise<Buffer> {
  const items = Array.isArray(data) ? data : [];
  if (items.length === 0) {
    return createEmptyPdf(projectName, 'Direct Costs Report', 'direct costs');
  }

  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: MARGIN, bottom: BOTTOM_MARGIN, left: MARGIN, right: MARGIN },
  });

  let y = addPageHeader(doc, projectName, 'Direct Costs Report', true);

  doc.fontSize(13).font('Helvetica-Bold').fillColor(BRAND_RED);
  doc.text('Direct Costs', MARGIN, y);
  doc.strokeColor(BRAND_RED).lineWidth(1).moveTo(MARGIN, y + 14).lineTo(MARGIN + 100, y + 14).stroke();
  doc.fillColor(BRAND_DARK);
  y += 34;

  const headers = [
    { label: 'ID', width: 52 },
    { label: 'Vendor', width: 130 },
    { label: 'Description', width: 145 },
    { label: 'Status', width: 68 },
    { label: 'Created', width: 68 },
    { label: 'Amount', width: 49, align: 'right' as Align },
  ];
  const rows = items.map((c: any) => [
    truncate(c.id ?? '', 10),
    truncate(c.vendor?.name ?? c.vendor_name ?? '', 25),
    truncate(c.description ?? c.name ?? '', 28),
    truncate(c.status ?? c.status_name ?? '', 12),
    fmtDate(c.created_at ?? c.created_date ?? c.created),
    fmtCurrency(c.amount ?? c.total ?? 0),
  ]);

  let total = 0;
  for (const c of items) total += parseFloat(c.amount ?? c.total ?? 0) || 0;
  rows.push(['', '', '', '', 'Total', fmtCurrency(total)]);

  drawTable(doc, headers, rows, y, { projectName, reportTitle: 'Direct Costs Report' });
  addFooter(doc);
  return bufferFromDoc(doc);
}

export async function generateInvoicingPdf(data: any[], projectName: string): Promise<Buffer> {
  const items = Array.isArray(data) ? data : [];
  if (items.length === 0) {
    return createEmptyPdf(projectName, 'Invoicing Report', 'invoicing');
  }

  const doc = new PDFDocument({
    size: 'LETTER',
    layout: 'landscape',
    margins: { top: MARGIN, bottom: BOTTOM_MARGIN, left: MARGIN, right: MARGIN },
  });

  let y = addPageHeader(doc, projectName, 'Invoicing Report', true);

  doc.fontSize(13).font('Helvetica-Bold').fillColor(BRAND_RED);
  doc.text('Invoicing / Requisitions', MARGIN, y);
  doc.strokeColor(BRAND_RED).lineWidth(1).moveTo(MARGIN, y + 14).lineTo(MARGIN + 180, y + 14).stroke();
  doc.fillColor(BRAND_DARK);
  y += 34;

  // 7 columns, landscape 692pt
  const headers = [
    { label: 'Invoice #', width: 85 },
    { label: 'Billing Period', width: 100 },
    { label: 'Contract', width: 115 },
    { label: 'Status', width: 85 },
    { label: 'Billed', width: 95, align: 'right' as Align },
    { label: 'Paid', width: 95, align: 'right' as Align },
    { label: 'Balance', width: 117, align: 'right' as Align },
  ];
  const rows = items.map((c: any) => [
    truncate(c.number ?? c.invoice_number ?? c.id ?? '', 12),
    truncate(c.billing_period ?? c.period ?? '', 15),
    truncate(c.contract?.title ?? c.contract_title ?? c.contract_number ?? '', 22),
    truncate(c.status ?? c.status_name ?? '', 12),
    fmtCurrency(c.amount_billed ?? c.billed ?? 0),
    fmtCurrency(c.amount_paid ?? c.paid ?? 0),
    fmtCurrency(c.balance ?? c.amount_due ?? 0),
  ]);

  let totalBilled = 0,
    totalPaid = 0,
    totalBal = 0;
  for (const c of items) {
    totalBilled += parseFloat(c.amount_billed ?? c.billed ?? 0) || 0;
    totalPaid += parseFloat(c.amount_paid ?? c.paid ?? 0) || 0;
    totalBal += parseFloat(c.balance ?? c.amount_due ?? 0) || 0;
  }
  rows.push(['', '', '', 'Totals', fmtCurrency(totalBilled), fmtCurrency(totalPaid), fmtCurrency(totalBal)]);

  drawTable(doc, headers, rows, y, {
    projectName,
    reportTitle: 'Invoicing Report',
    landscape: true,
  });
  addFooter(doc);
  return bufferFromDoc(doc);
}

export async function generateDirectoryPdf(data: any[], projectName: string): Promise<Buffer> {
  const items = Array.isArray(data) ? data : [];
  if (items.length === 0) {
    return createEmptyPdf(projectName, 'Project Directory', 'directory');
  }

  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: MARGIN, bottom: BOTTOM_MARGIN, left: MARGIN, right: MARGIN },
  });

  let y = addPageHeader(doc, projectName, 'Project Directory', true);

  doc.fontSize(13).font('Helvetica-Bold').fillColor(BRAND_RED);
  doc.text('Project Directory', MARGIN, y);
  doc.strokeColor(BRAND_RED).lineWidth(1).moveTo(MARGIN, y + 14).lineTo(MARGIN + 140, y + 14).stroke();
  doc.fillColor(BRAND_DARK);
  y += 34;

  const byCompany = new Map<string, any[]>();
  for (const p of items) {
    const company = p.company?.name ?? p.company_name ?? p.vendor?.name ?? 'Unknown';
    if (!byCompany.has(company)) byCompany.set(company, []);
    byCompany.get(company)!.push(p);
  }

  const headers = [
    { label: 'Name', width: 115 },
    { label: 'Company', width: 115 },
    { label: 'Role', width: 95 },
    { label: 'Email', width: 140 },
    { label: 'Phone', width: 47 },
  ];

  const companies = Array.from(byCompany.keys()).sort();
  for (const company of companies) {
    if (doc.y > doc.page.height - 120) {
      doc.addPage({ size: 'LETTER' });
      doc.y = addPageHeader(doc, projectName, 'Project Directory', false);
    }
    doc.fontSize(13).font('Helvetica-Bold').fillColor(BRAND_RED);
    doc.text(company, MARGIN, doc.y);
    doc.strokeColor(BRAND_RED).lineWidth(1).moveTo(MARGIN, doc.y + 14).lineTo(MARGIN + 150, doc.y + 14).stroke();
    doc.fillColor(BRAND_DARK);
    doc.y += 24;
    const members = byCompany.get(company)!;
    const rows = members.map((p: any) => [
      truncate(p.name ?? `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() ?? p.user?.name ?? '', 22),
      truncate(company, 22),
      truncate(p.role ?? p.job_title ?? p.title ?? '', 18),
      truncate(p.email ?? p.email_address ?? p.user?.email ?? '', 28),
      truncate(p.phone ?? p.phone_number ?? '', 16),
    ]);
    drawTable(doc, headers, rows, doc.y, { projectName, reportTitle: 'Project Directory' });
    doc.moveDown(0.5);
  }

  addFooter(doc);
  return bufferFromDoc(doc);
}

export async function generateEstimatingPdf(data: any[], projectName: string): Promise<Buffer> {
  const items = Array.isArray(data) ? data : [];
  if (items.length === 0) {
    return createEmptyPdf(projectName, 'Estimating Report', 'estimating');
  }

  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: MARGIN, bottom: BOTTOM_MARGIN, left: MARGIN, right: MARGIN },
  });

  let y = addPageHeader(doc, projectName, 'Estimating Report', true);

  doc.fontSize(13).font('Helvetica-Bold').fillColor(BRAND_RED);
  doc.text('Estimating / Bid Board', MARGIN, y);
  doc.strokeColor(BRAND_RED).lineWidth(1).moveTo(MARGIN, y + 14).lineTo(MARGIN + 180, y + 14).stroke();
  doc.fillColor(BRAND_DARK);
  y += 34;

  const flatRows: string[][] = [];
  for (const item of items) {
    const lineItems = item.line_items ?? item.bid_items ?? item.items ?? [item];
    for (const li of lineItems) {
      flatRows.push([
        truncate(li.line_number ?? li.number ?? li.id ?? '', 10),
        truncate(li.description ?? li.name ?? li.item_name ?? '', 35),
        String(li.quantity ?? li.qty ?? ''),
        truncate(li.unit ?? li.unit_of_measure ?? '', 10),
        fmtCurrency(li.unit_cost ?? li.cost ?? 0),
        fmtCurrency(
          li.total_cost ??
            li.total ??
            (Number(li.quantity ?? li.qty) || 0) * (Number(li.unit_cost ?? li.cost) || 0)
        ),
      ]);
    }
  }

  if (flatRows.length === 0) {
    flatRows.push(['No line items found', '', '', '', '', '']);
  }

  const headers = [
    { label: 'Line #', width: 52 },
    { label: 'Description', width: 215 },
    { label: 'Qty', width: 52, align: 'right' as Align },
    { label: 'Unit', width: 52 },
    { label: 'Unit Cost', width: 82, align: 'right' as Align },
    { label: 'Total Cost', width: 59, align: 'right' as Align },
  ];

  let totalCost = 0;
  for (const r of flatRows) {
    const val = parseFloat(String(r[5]).replace(/[^0-9.-]/g, '')) || 0;
    if (!Number.isNaN(val)) totalCost += val;
  }
  flatRows.push(['', '', '', '', 'Total', fmtCurrency(totalCost)]);

  drawTable(doc, headers, flatRows, y, { projectName, reportTitle: 'Estimating Report' });
  addFooter(doc);
  return bufferFromDoc(doc);
}

// ---------------------------------------------------------------------------
// Archive Cover Sheet
// ---------------------------------------------------------------------------

const STAT_LABELS: Record<string, string> = {
  folders: 'Documents (Folders)',
  drawings: 'Drawings',
  submittals: 'Submittals',
  rfis: 'RFIs',
  bidPackages: 'Bid Packages',
  photos: 'Photos',
  hasBudget: 'Budget',
  emails: 'Emails',
  incidents: 'Incidents',
  punchList: 'Punch List',
  meetings: 'Meetings',
  schedule: 'Schedule',
  dailyLogs: 'Daily Logs',
  specifications: 'Specifications',
  primeContracts: 'Prime Contracts',
  commitments: 'Commitments',
  changeOrders: 'Change Orders',
  changeEvents: 'Change Events',
  directCosts: 'Direct Costs',
  invoicing: 'Invoicing',
  directory: 'Directory Contacts',
  estimating: 'Estimating',
};

function drawHeaderBand(doc: PDFKit.PDFDocument, reportTitle: string): void {
  const pageWidth = doc.page.width;
  doc.fillColor(BRAND_GRAY).rect(0, 0, pageWidth, HEADER_BAND_HEIGHT).fill();
  if (logoBuffer) {
    try {
      doc.image(logoBuffer, LOGO_LEFT, (HEADER_BAND_HEIGHT - LOGO_SIZE) / 2, {
        width: LOGO_SIZE,
        height: LOGO_SIZE,
      });
    } catch {
      /* ignore */
    }
  }
  doc.fontSize(14).font('Helvetica-Bold').fillColor(BRAND_WHITE);
  doc.text('T-ROCK CONSTRUCTION', COMPANY_NAME_LEFT, 22);
  doc.fontSize(10).font('Helvetica');
  doc.text(reportTitle, COMPANY_NAME_LEFT, 44);
  doc.fillColor(BRAND_DARK);
}

export async function generateArchiveCoverSheetPdf(
  summary: {
    projectId: string;
    projectName: string;
    archivedAt: string;
    extractedAt: string;
    providerType: string;
    statistics: Record<string, any>;
    filesUploaded: number;
    errors: number;
  },
  storageUrl?: string
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: MARGIN, bottom: BOTTOM_MARGIN, left: MARGIN, right: MARGIN },
  });

  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;

  drawHeaderBand(doc, 'Project Archive');

  // Centered project name
  doc.fontSize(24).font('Helvetica-Bold').fillColor(BRAND_RED);
  doc.text(summary.projectName || 'Project', 0, 90, {
    width: pageWidth,
    align: 'center',
  });
  doc.fontSize(16).font('Helvetica-Bold').fillColor(BRAND_GRAY);
  doc.text('PROJECT ARCHIVE', 0, 118, {
    width: pageWidth,
    align: 'center',
  });
  doc.fillColor(BRAND_DARK);

  doc.strokeColor(BRAND_RED).lineWidth(2)
    .moveTo(MARGIN, 138).lineTo(pageWidth - MARGIN, 138).stroke();

  let y = 155;

  // Archive info block - ~400pt wide, centered
  const boxWidth = 400;
  const boxLeft = (pageWidth - boxWidth) / 2;
  const boxPadding = 16;
  const lineHeight = 18;

  const boxHeight = storageUrl ? 150 : 120;
  doc.fillColor(BRAND_LIGHT).rect(boxLeft, y, boxWidth, boxHeight).fill();
  doc.fillColor(BRAND_DARK);

  const col1X = boxLeft + boxPadding;
  const col2X = boxLeft + boxWidth / 2 + boxPadding;
  const labelWidth = 75;
  const row1Y = y + boxPadding;
  const row2Y = row1Y + lineHeight;
  const row3Y = row2Y + lineHeight;

  doc.fontSize(10).font('Helvetica-Bold').fillColor('#666666');
  doc.text('Archived:', col1X, row1Y);
  doc.text('Extracted:', col1X, row2Y);
  doc.text('Storage:', col1X, row3Y);
  doc.text('Total Files:', col2X, row1Y);
  doc.text('Errors:', col2X, row2Y);

  doc.font('Helvetica').fillColor(BRAND_DARK);
  doc.text(fmtDate(summary.archivedAt), col1X + labelWidth, row1Y);
  doc.text(fmtDate(summary.extractedAt), col1X + labelWidth, row2Y);
  doc.text(summary.providerType || '—', col1X + labelWidth, row3Y);
  doc.text(String(summary.filesUploaded), col2X + labelWidth, row1Y);
  doc.fillColor(summary.errors > 0 ? BRAND_RED : '#228B22');
  doc.text(String(summary.errors), col2X + labelWidth, row2Y);
  doc.fillColor(BRAND_DARK);

  if (storageUrl) {
    doc.fontSize(9).font('Helvetica').fillColor('#666666');
    doc.text(storageUrl, col1X, row3Y + lineHeight + 8, { width: boxWidth - boxPadding * 2 });
  }

  y += boxHeight + 16;

  // Archive contents section
  doc.fontSize(14).font('Helvetica-Bold').fillColor(BRAND_RED);
  doc.text('Archive Contents', MARGIN, y);
  doc.strokeColor(BRAND_RED).lineWidth(1).moveTo(MARGIN, y + 16).lineTo(MARGIN + 140, y + 16).stroke();
  doc.fillColor(BRAND_DARK);
  y += 36;

  const stats = summary.statistics ?? {};
  const tableLeft = MARGIN;
  const tableWidth = CONTENT_WIDTH_PORTRAIT;
  const colCategory = 320;
  const colItems = tableWidth - colCategory;
  const arcRowHeight = 16;

  // Table header
  doc.fillColor(BRAND_GRAY).rect(tableLeft, y, tableWidth, TABLE_HEADER_HEIGHT).fill();
  doc.fontSize(9).font('Helvetica-Bold').fillColor(BRAND_WHITE);
  doc.text('CATEGORY', tableLeft + 5, y + 4, { width: colCategory - 10 });
  doc.text('ITEMS', tableLeft + colCategory, y + 4, { width: colItems - 10, align: 'right' });
  doc.font('Helvetica').fillColor(BRAND_DARK);
  y += TABLE_HEADER_HEIGHT;

  const statOrder = [
    'folders', 'drawings', 'submittals', 'rfis', 'bidPackages', 'photos', 'hasBudget',
    'emails', 'incidents', 'punchList', 'meetings', 'schedule', 'dailyLogs',
    'specifications', 'primeContracts', 'commitments', 'changeOrders', 'changeEvents',
    'directCosts', 'invoicing', 'directory', 'estimating',
  ];

  for (let i = 0; i < statOrder.length; i++) {
    const key = statOrder[i];
    const label = STAT_LABELS[key] ?? key;
    const val = stats[key];

    const bg = i % 2 === 0 ? BRAND_WHITE : BRAND_LIGHT;
    doc.fillColor(bg).rect(tableLeft, y, tableWidth, arcRowHeight).fill();

    const isZeroOrEmpty =
      key === 'hasBudget' ? false : (typeof val === 'number' ? val === 0 : !val);
    doc.fillColor(isZeroOrEmpty ? '#bbbbbb' : BRAND_DARK).fontSize(9).font('Helvetica');

    doc.text(label, tableLeft + 5, y + 4, { width: colCategory - 10 });

    const displayVal =
      key === 'hasBudget'
        ? (val ? 'Yes' : 'No')
        : String(typeof val === 'number' ? val : val ?? 0);
    doc.text(displayVal, tableLeft + colCategory, y + 4, {
      width: colItems - 10,
      align: 'right',
    });

    doc.fillColor(BRAND_DARK);
    if (i < statOrder.length - 1) {
      doc.strokeColor('#e0e0e0').lineWidth(0.5)
        .moveTo(tableLeft, y + arcRowHeight).lineTo(tableLeft + tableWidth, y + arcRowHeight).stroke();
    }
    y += arcRowHeight;
  }

  addFooter(doc);
  return bufferFromDoc(doc);
}
