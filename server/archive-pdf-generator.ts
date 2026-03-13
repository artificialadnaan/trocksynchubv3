/**
 * Archive PDF Generator
 * =====================
 *
 * Converts structured Procore API data into formatted PDF reports for project archives.
 * Used by project-archive.ts instead of raw JSON exports.
 *
 * @module archive-pdf-generator
 */

import PDFDocument from 'pdfkit';

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 50;
const BOTTOM_MARGIN = 50;
const ROW_HEIGHT = 16;
const HEADER_HEIGHT = 20;

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

function drawTable(
  doc: PDFKit.PDFDocument,
  headers: { label: string; width: number; align?: Align }[],
  rows: string[][],
  startY?: number
): number {
  const tableTop = startY ?? doc.y;
  const tableLeft = MARGIN;
  const totalWidth = headers.reduce((a, h) => a + h.width, 0);

  let y = tableTop;
  const pageHeight = doc.page.height;
  const bottomY = pageHeight - BOTTOM_MARGIN;

  function checkPageBreak(needed: number): void {
    if (y + needed > bottomY) {
      doc.addPage({ size: 'LETTER' });
      addPageHeader(doc, '', '');
      y = MARGIN + 60;
      doc.fontSize(10).font('Helvetica');
      doc.fillColor('#f0f0f0').rect(tableLeft, y, totalWidth, HEADER_HEIGHT).fill();
      doc.fillColor('#000000').font('Helvetica-Bold');
      let x = tableLeft;
      for (let i = 0; i < headers.length; i++) {
        const h = headers[i];
        const align = h.align ?? 'left';
        const text = truncate(h.label, 25);
        if (align === 'right') doc.text(text, x, y + 4, { width: h.width, align: 'right' });
        else if (align === 'center') doc.text(text, x, y + 4, { width: h.width, align: 'center' });
        else doc.text(text, x + 4, y + 4, { width: h.width - 8 });
        x += h.width;
      }
      doc.font('Helvetica');
      y += HEADER_HEIGHT;
    }
  }

  doc.fontSize(10).font('Helvetica');
  doc.fillColor('#f0f0f0').rect(tableLeft, y, totalWidth, HEADER_HEIGHT).fill();
  doc.fillColor('#000000').font('Helvetica-Bold');
  let x = tableLeft;
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const align = h.align ?? 'left';
    const text = truncate(h.label, 25);
    if (align === 'right') doc.text(text, x, y + 4, { width: h.width, align: 'right' });
    else if (align === 'center') doc.text(text, x, y + 4, { width: h.width, align: 'center' });
    else doc.text(text, x + 4, y + 4, { width: h.width - 8 });
    x += h.width;
  }
  doc.font('Helvetica');
  y += HEADER_HEIGHT;

  for (let ri = 0; ri < rows.length; ri++) {
    checkPageBreak(ROW_HEIGHT);
    const row = rows[ri];
    const bg = ri % 2 === 0 ? '#ffffff' : '#fafafa';
    doc.fillColor(bg).rect(tableLeft, y, totalWidth, ROW_HEIGHT).fill();
    doc.fillColor('#000000');
    x = tableLeft;
    for (let ci = 0; ci < headers.length; ci++) {
      const h = headers[ci];
      const align = (h.align ?? 'left') as Align;
      const cellText = truncate(row[ci] ?? '', 40);
      if (align === 'right') doc.text(cellText, x, y + 3, { width: h.width - 8, align: 'right' });
      else if (align === 'center') doc.text(cellText, x, y + 3, { width: h.width, align: 'center' });
      else doc.text(cellText, x + 4, y + 3, { width: h.width - 8 });
      x += h.width;
    }
    y += ROW_HEIGHT;
  }

  doc.y = y;
  return y;
}

function addPageHeader(doc: PDFKit.PDFDocument, projectName: string, reportTitle: string): void {
  doc.fontSize(10).font('Helvetica').fillColor('#666666');
  doc.text(projectName || 'Project', MARGIN, MARGIN);
  doc.text(reportTitle || 'Report', MARGIN, MARGIN + 12);
  doc.text(`Generated: ${fmtDate(new Date())}`, MARGIN, MARGIN + 24);
  doc.fillColor('#000000');
  doc.moveDown(2);
  doc.y = MARGIN + 50;
}

function addFooter(doc: PDFKit.PDFDocument): void {
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(i);
    doc.fontSize(9).font('Helvetica').fillColor('#666666');
    doc.text(
      `Page ${i + 1} of ${pages.count}`,
      0,
      PAGE_HEIGHT - 30,
      { align: 'center', width: PAGE_WIDTH }
    );
    doc.fillColor('#000000');
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

async function createEmptyPdf(projectName: string, reportTitle: string, message: string): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'LETTER', margins: { top: MARGIN, bottom: BOTTOM_MARGIN, left: MARGIN, right: MARGIN } });
  addPageHeader(doc, projectName, reportTitle);
  doc.fontSize(12).font('Helvetica');
  doc.text(message, MARGIN, doc.y);
  addFooter(doc);
  return bufferFromDoc(doc);
}

export async function generateBudgetPdf(
  data: { lineItems?: any[]; line_items?: any[]; summary?: any },
  projectName: string
): Promise<Buffer> {
  const lineItems = Array.isArray(data?.lineItems) ? data.lineItems : (Array.isArray(data?.line_items) ? data.line_items : []);
  const summary = data?.summary ?? {};

  if (lineItems.length === 0 && !summary) {
    return createEmptyPdf(projectName, 'Budget Report', 'No budget data available for this project.');
  }

  const doc = new PDFDocument({ size: 'LETTER', margins: { top: MARGIN, bottom: BOTTOM_MARGIN, left: MARGIN, right: MARGIN } });

  addPageHeader(doc, projectName, 'Budget Report');
  doc.fontSize(18).font('Helvetica-Bold').text('Budget Summary', MARGIN, doc.y);
  doc.moveDown(0.5);
  doc.fontSize(10).font('Helvetica');

  const s = summary;
  doc.text(`Total Budget: ${fmtCurrency(s.total_budget_amount ?? s.total_budget ?? s.total ?? 0)}`);
  doc.text(`Original Budget: ${fmtCurrency(s.original_budget ?? s.original ?? 0)}`);
  doc.text(`Approved Changes: ${fmtCurrency(s.approved_changes ?? s.approved_change_orders ?? 0)}`);
  doc.text(`Revised Budget: ${fmtCurrency(s.revised_budget ?? s.revised ?? 0)}`);
  doc.text(`Pending Changes: ${fmtCurrency(s.pending_changes ?? s.pending_change_orders ?? 0)}`);
  doc.text(`Projected Over/Under: ${fmtCurrency(s.projected_over_under ?? s.projected ?? 0)}`);
  doc.moveDown(1);

  if (lineItems.length > 0) {
    doc.fontSize(14).font('Helvetica-Bold').text('Line Items', MARGIN, doc.y);
    doc.moveDown(0.5);

    const headers = [
      { label: 'Cost Code', width: 70 },
      { label: 'Description', width: 120 },
      { label: 'Original', width: 70, align: 'right' as Align },
      { label: 'Approved COs', width: 70, align: 'right' as Align },
      { label: 'Revised', width: 70, align: 'right' as Align },
      { label: 'Pending', width: 70, align: 'right' as Align },
      { label: 'Projected', width: 70, align: 'right' as Align },
      { label: 'Over/Under', width: 70, align: 'right' as Align },
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

    let totalOrig = 0, totalRev = 0, totalProj = 0;
    for (const li of lineItems) {
      totalOrig += parseFloat(li.original_budget ?? li.original ?? 0) || 0;
      totalRev += parseFloat(li.revised_budget ?? li.revised ?? 0) || 0;
      totalProj += parseFloat(li.projected_cost ?? li.projected ?? 0) || 0;
    }
    rows.push(['', 'TOTAL', fmtCurrency(totalOrig), '', fmtCurrency(totalRev), '', fmtCurrency(totalProj), '']);

    drawTable(doc, headers, rows, doc.y);
  }

  addFooter(doc);
  return bufferFromDoc(doc);
}

export async function generateDailyLogsPdf(data: any[], projectName: string): Promise<Buffer> {
  const items = Array.isArray(data) ? data : [];
  if (items.length === 0) {
    return createEmptyPdf(projectName, 'Daily Logs Report', 'No daily log data available for this project.');
  }

  const doc = new PDFDocument({ size: 'LETTER', margins: { top: MARGIN, bottom: BOTTOM_MARGIN, left: MARGIN, right: MARGIN } });

  const sorted = [...items].sort((a, b) => {
    const da = new Date(a.date ?? a.log_date ?? 0).getTime();
    const db = new Date(b.date ?? b.log_date ?? 0).getTime();
    return db - da;
  });

  addPageHeader(doc, projectName, 'Daily Logs Report');
  doc.fontSize(18).font('Helvetica-Bold').text('Daily Logs', MARGIN, doc.y);
  doc.moveDown(1);

  const bottomY = PAGE_HEIGHT - BOTTOM_MARGIN;
  for (let i = 0; i < sorted.length; i++) {
    const log = sorted[i];
    if (doc.y > bottomY - 80) {
      doc.addPage({ size: 'LETTER' });
      addPageHeader(doc, projectName, 'Daily Logs Report');
    }

    doc.fontSize(14).font('Helvetica-Bold').text(fmtDate(log.date ?? log.log_date ?? '') || 'Unknown Date', MARGIN, doc.y);
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica');

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
    doc.strokeColor('#cccccc').lineWidth(0.5).moveTo(MARGIN, doc.y).lineTo(PAGE_WIDTH - MARGIN, doc.y).stroke();
    doc.moveDown(0.5);
  }

  addFooter(doc);
  return bufferFromDoc(doc);
}

export async function generatePrimeContractsPdf(data: any[], projectName: string): Promise<Buffer> {
  const items = Array.isArray(data) ? data : [];
  if (items.length === 0) {
    return createEmptyPdf(projectName, 'Prime Contracts Report', 'No prime contracts data available for this project.');
  }

  const doc = new PDFDocument({ size: 'LETTER', margins: { top: MARGIN, bottom: BOTTOM_MARGIN, left: MARGIN, right: MARGIN } });

  addPageHeader(doc, projectName, 'Prime Contracts Report');
  doc.fontSize(18).font('Helvetica-Bold').text('Prime Contracts', MARGIN, doc.y);
  doc.moveDown(0.5);

  const headers = [
    { label: 'Contract #', width: 70 },
    { label: 'Title', width: 140 },
    { label: 'Vendor', width: 100 },
    { label: 'Status', width: 60 },
    { label: 'Executed', width: 70 },
    { label: 'Value', width: 90, align: 'right' as Align },
    { label: '% Complete', width: 60, align: 'right' as Align },
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

  drawTable(doc, headers, rows, doc.y);

  for (const c of items) {
    const lineItems = c.line_items ?? c.line_items_data ?? [];
    if (lineItems.length > 0) {
      if (doc.y > PAGE_HEIGHT - 120) {
        doc.addPage({ size: 'LETTER' });
        addPageHeader(doc, projectName, 'Prime Contracts Report');
      }
      doc.moveDown(0.5);
      doc.fontSize(12).font('Helvetica-Bold').text(`Line Items: ${c.number ?? c.title ?? c.id}`, MARGIN, doc.y);
      doc.moveDown(0.3);
      const liHeaders = [
        { label: 'Line #', width: 50 },
        { label: 'Description', width: 250 },
        { label: 'Amount', width: 100, align: 'right' as Align },
      ];
      const liRows = lineItems.map((li: any) => [
        truncate(li.line_number ?? li.number ?? li.id ?? '', 10),
        truncate(li.description ?? li.name ?? '', 40),
        fmtCurrency(li.amount ?? li.total ?? 0),
      ]);
      drawTable(doc, liHeaders, liRows, doc.y);
    }
  }

  addFooter(doc);
  return bufferFromDoc(doc);
}

export async function generateSubcontractsPdf(data: any[], projectName: string): Promise<Buffer> {
  const items = Array.isArray(data) ? data : [];
  if (items.length === 0) {
    return createEmptyPdf(projectName, 'Subcontracts Report', 'No subcontracts data available for this project.');
  }

  const doc = new PDFDocument({ size: 'LETTER', margins: { top: MARGIN, bottom: BOTTOM_MARGIN, left: MARGIN, right: MARGIN } });

  addPageHeader(doc, projectName, 'Subcontracts Report');
  doc.fontSize(18).font('Helvetica-Bold').text('Subcontracts', MARGIN, doc.y);
  doc.moveDown(0.5);

  const headers = [
    { label: 'Contract #', width: 65 },
    { label: 'Title', width: 110 },
    { label: 'Vendor', width: 90 },
    { label: 'Status', width: 55 },
    { label: 'Executed', width: 60 },
    { label: 'Value', width: 80, align: 'right' as Align },
    { label: '% Done', width: 50, align: 'right' as Align },
    { label: 'Paid', width: 80, align: 'right' as Align },
  ];
  const rows = items.map((c: any) => [
    truncate(c.number ?? c.contract_number ?? c.id ?? '', 10),
    truncate(c.title ?? c.name ?? '', 20),
    truncate(c.vendor?.name ?? c.vendor_name ?? '', 16),
    truncate(c.status ?? c.status_name ?? '', 8),
    fmtDate(c.executed_at ?? c.executed_date ?? c.signed_date),
    fmtCurrency(c.total_value ?? c.value ?? c.amount ?? 0),
    String(c.percent_complete ?? c.percentage_complete ?? '') + (c.percent_complete != null ? '%' : ''),
    fmtCurrency(c.paid_to_date ?? c.amount_paid ?? 0),
  ]);

  let totalVal = 0, totalPaid = 0;
  for (const c of items) {
    totalVal += parseFloat(c.total_value ?? c.value ?? c.amount ?? 0) || 0;
    totalPaid += parseFloat(c.paid_to_date ?? c.amount_paid ?? 0) || 0;
  }
  rows.push(['', '', '', '', 'Totals', fmtCurrency(totalVal), '', fmtCurrency(totalPaid)]);

  drawTable(doc, headers, rows, doc.y);

  for (const c of items) {
    const lineItems = c.line_items ?? c.line_items_data ?? [];
    if (lineItems.length > 0 && doc.y < PAGE_HEIGHT - 120) {
      doc.moveDown(0.5);
      doc.fontSize(12).font('Helvetica-Bold').text(`Line Items: ${c.number ?? c.title ?? c.id}`, MARGIN, doc.y);
      doc.moveDown(0.3);
      const liHeaders = [
        { label: 'Line #', width: 50 },
        { label: 'Description', width: 250 },
        { label: 'Amount', width: 100, align: 'right' as Align },
      ];
      const liRows = lineItems.map((li: any) => [
        truncate(li.line_number ?? li.number ?? li.id ?? '', 10),
        truncate(li.description ?? li.name ?? '', 40),
        fmtCurrency(li.amount ?? li.total ?? 0),
      ]);
      drawTable(doc, liHeaders, liRows, doc.y);
    }
  }

  addFooter(doc);
  return bufferFromDoc(doc);
}

export async function generatePurchaseOrdersPdf(data: any[], projectName: string): Promise<Buffer> {
  return generateSubcontractsPdf(data, projectName);
}

export async function generateChangeOrdersPdf(data: any[], projectName: string): Promise<Buffer> {
  const items = Array.isArray(data) ? data : [];
  if (items.length === 0) {
    return createEmptyPdf(projectName, 'Change Orders Report', 'No change orders data available for this project.');
  }

  const doc = new PDFDocument({ size: 'LETTER', margins: { top: MARGIN, bottom: BOTTOM_MARGIN, left: MARGIN, right: MARGIN } });

  addPageHeader(doc, projectName, 'Change Orders Report');
  doc.fontSize(18).font('Helvetica-Bold').text('Change Orders', MARGIN, doc.y);
  doc.moveDown(0.5);

  const headers = [
    { label: 'CO Package #', width: 80 },
    { label: 'Title', width: 180 },
    { label: 'Status', width: 70 },
    { label: 'Created', width: 70 },
    { label: 'Due Date', width: 70 },
    { label: 'Grand Total', width: 90, align: 'right' as Align },
  ];
  const rows = items.map((c: any) => [
    truncate(c.number ?? c.package_number ?? c.id ?? '', 14),
    truncate(c.title ?? c.name ?? '', 30),
    truncate(c.status ?? c.status_name ?? '', 12),
    fmtDate(c.created_at ?? c.created_date ?? c.created),
    fmtDate(c.due_date ?? c.due),
    fmtCurrency(c.grand_total ?? c.total ?? c.amount ?? 0),
  ]);

  drawTable(doc, headers, rows, doc.y);

  for (const pkg of items) {
    const coItems = pkg.change_order_line_items ?? pkg.potential_change_orders ?? pkg.line_items ?? [];
    if (coItems.length > 0) {
      if (doc.y > PAGE_HEIGHT - 120) {
        doc.addPage({ size: 'LETTER' });
        addPageHeader(doc, projectName, 'Change Orders Report');
      }
      doc.moveDown(0.5);
      doc.fontSize(12).font('Helvetica-Bold').text(`Line Items: ${pkg.number ?? pkg.title ?? pkg.id}`, MARGIN, doc.y);
      doc.moveDown(0.3);
      const liHeaders = [
        { label: 'Line #', width: 50 },
        { label: 'Description', width: 200 },
        { label: 'Amount', width: 90, align: 'right' as Align },
        { label: 'Status', width: 70 },
      ];
      const liRows = coItems.map((li: any) => [
        truncate(li.line_number ?? li.number ?? li.id ?? '', 10),
        truncate(li.description ?? li.name ?? '', 35),
        fmtCurrency(li.amount ?? li.total ?? 0),
        truncate(li.status ?? li.status_name ?? '', 12),
      ]);
      drawTable(doc, liHeaders, liRows, doc.y);
    }
  }

  addFooter(doc);
  return bufferFromDoc(doc);
}

export async function generateChangeEventsPdf(data: any[], projectName: string): Promise<Buffer> {
  const items = Array.isArray(data) ? data : [];
  if (items.length === 0) {
    return createEmptyPdf(projectName, 'Change Events Report', 'No change events data available for this project.');
  }

  const doc = new PDFDocument({ size: 'LETTER', margins: { top: MARGIN, bottom: BOTTOM_MARGIN, left: MARGIN, right: MARGIN } });

  addPageHeader(doc, projectName, 'Change Events Report');
  doc.fontSize(18).font('Helvetica-Bold').text('Change Events', MARGIN, doc.y);
  doc.moveDown(0.5);

  const headers = [
    { label: 'Event #', width: 60 },
    { label: 'Title', width: 180 },
    { label: 'Status', width: 70 },
    { label: 'Type', width: 90 },
    { label: 'Created', width: 70 },
    { label: 'Amount', width: 90, align: 'right' as Align },
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

  drawTable(doc, headers, rows, doc.y);
  addFooter(doc);
  return bufferFromDoc(doc);
}

export async function generateDirectCostsPdf(data: any[], projectName: string): Promise<Buffer> {
  const items = Array.isArray(data) ? data : [];
  if (items.length === 0) {
    return createEmptyPdf(projectName, 'Direct Costs Report', 'No direct costs data available for this project.');
  }

  const doc = new PDFDocument({ size: 'LETTER', margins: { top: MARGIN, bottom: BOTTOM_MARGIN, left: MARGIN, right: MARGIN } });

  addPageHeader(doc, projectName, 'Direct Costs Report');
  doc.fontSize(18).font('Helvetica-Bold').text('Direct Costs', MARGIN, doc.y);
  doc.moveDown(0.5);

  const headers = [
    { label: 'ID', width: 50 },
    { label: 'Vendor', width: 140 },
    { label: 'Description', width: 150 },
    { label: 'Status', width: 70 },
    { label: 'Created', width: 70 },
    { label: 'Amount', width: 90, align: 'right' as Align },
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

  drawTable(doc, headers, rows, doc.y);
  addFooter(doc);
  return bufferFromDoc(doc);
}

export async function generateInvoicingPdf(data: any[], projectName: string): Promise<Buffer> {
  const items = Array.isArray(data) ? data : [];
  if (items.length === 0) {
    return createEmptyPdf(projectName, 'Invoicing Report', 'No invoicing data available for this project.');
  }

  const doc = new PDFDocument({ size: 'LETTER', margins: { top: MARGIN, bottom: BOTTOM_MARGIN, left: MARGIN, right: MARGIN } });

  addPageHeader(doc, projectName, 'Invoicing Report');
  doc.fontSize(18).font('Helvetica-Bold').text('Invoicing / Requisitions', MARGIN, doc.y);
  doc.moveDown(0.5);

  const headers = [
    { label: 'Invoice #', width: 70 },
    { label: 'Billing Period', width: 90 },
    { label: 'Contract', width: 100 },
    { label: 'Status', width: 70 },
    { label: 'Billed', width: 80, align: 'right' as Align },
    { label: 'Paid', width: 80, align: 'right' as Align },
    { label: 'Balance', width: 80, align: 'right' as Align },
  ];
  const rows = items.map((c: any) => [
    truncate(c.number ?? c.invoice_number ?? c.id ?? '', 12),
    truncate(c.billing_period ?? c.period ?? '', 15),
    truncate(c.contract?.title ?? c.contract_title ?? c.contract_number ?? '', 18),
    truncate(c.status ?? c.status_name ?? '', 12),
    fmtCurrency(c.amount_billed ?? c.billed ?? 0),
    fmtCurrency(c.amount_paid ?? c.paid ?? 0),
    fmtCurrency(c.balance ?? c.amount_due ?? 0),
  ]);

  let totalBilled = 0, totalPaid = 0, totalBal = 0;
  for (const c of items) {
    totalBilled += parseFloat(c.amount_billed ?? c.billed ?? 0) || 0;
    totalPaid += parseFloat(c.amount_paid ?? c.paid ?? 0) || 0;
    totalBal += parseFloat(c.balance ?? c.amount_due ?? 0) || 0;
  }
  rows.push(['', '', '', 'Totals', fmtCurrency(totalBilled), fmtCurrency(totalPaid), fmtCurrency(totalBal)]);

  drawTable(doc, headers, rows, doc.y);
  addFooter(doc);
  return bufferFromDoc(doc);
}

export async function generateDirectoryPdf(data: any[], projectName: string): Promise<Buffer> {
  const items = Array.isArray(data) ? data : [];
  if (items.length === 0) {
    return createEmptyPdf(projectName, 'Directory Report', 'No directory data available for this project.');
  }

  const doc = new PDFDocument({ size: 'LETTER', margins: { top: MARGIN, bottom: BOTTOM_MARGIN, left: MARGIN, right: MARGIN } });

  addPageHeader(doc, projectName, 'Project Directory');
  doc.fontSize(18).font('Helvetica-Bold').text('Project Directory', MARGIN, doc.y);
  doc.moveDown(0.5);

  const byCompany = new Map<string, any[]>();
  for (const p of items) {
    const company = p.company?.name ?? p.company_name ?? p.vendor?.name ?? 'Unknown';
    if (!byCompany.has(company)) byCompany.set(company, []);
    byCompany.get(company)!.push(p);
  }

  const headers = [
    { label: 'Name', width: 120 },
    { label: 'Company', width: 120 },
    { label: 'Role', width: 100 },
    { label: 'Email', width: 150 },
    { label: 'Phone', width: 90 },
  ];

  const companies = Array.from(byCompany.keys()).sort();
  for (const company of companies) {
    if (doc.y > PAGE_HEIGHT - 100) {
      doc.addPage({ size: 'LETTER' });
      addPageHeader(doc, projectName, 'Project Directory');
    }
    doc.fontSize(12).font('Helvetica-Bold').text(company, MARGIN, doc.y);
    doc.moveDown(0.3);
    const members = byCompany.get(company)!;
    const rows = members.map((p: any) => [
      truncate(p.name ?? `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() ?? p.user?.name ?? '', 22),
      truncate(company, 22),
      truncate(p.role ?? p.job_title ?? p.title ?? '', 18),
      truncate(p.email ?? p.email_address ?? p.user?.email ?? '', 28),
      truncate(p.phone ?? p.phone_number ?? '', 16),
    ]);
    drawTable(doc, headers, rows, doc.y);
    doc.moveDown(0.5);
  }

  addFooter(doc);
  return bufferFromDoc(doc);
}

export async function generateEstimatingPdf(data: any[], projectName: string): Promise<Buffer> {
  const items = Array.isArray(data) ? data : [];
  if (items.length === 0) {
    return createEmptyPdf(projectName, 'Estimating Report', 'No estimating data available for this project.');
  }

  const doc = new PDFDocument({ size: 'LETTER', margins: { top: MARGIN, bottom: BOTTOM_MARGIN, left: MARGIN, right: MARGIN } });

  addPageHeader(doc, projectName, 'Estimating Report');
  doc.fontSize(18).font('Helvetica-Bold').text('Estimating / Bid Board', MARGIN, doc.y);
  doc.moveDown(0.5);

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
        fmtCurrency(li.total_cost ?? li.total ?? (Number(li.quantity ?? li.qty) || 0) * (Number(li.unit_cost ?? li.cost) || 0)),
      ]);
    }
  }

  if (flatRows.length === 0) {
    flatRows.push(['No line items found', '', '', '', '', '']);
  }

  const headers = [
    { label: 'Line #', width: 50 },
    { label: 'Description', width: 180 },
    { label: 'Qty', width: 50, align: 'right' as Align },
    { label: 'Unit', width: 50 },
    { label: 'Unit Cost', width: 80, align: 'right' as Align },
    { label: 'Total Cost', width: 90, align: 'right' as Align },
  ];

  let totalCost = 0;
  for (const r of flatRows) {
    const val = parseFloat(String(r[5]).replace(/[^0-9.-]/g, '')) || 0;
    if (!Number.isNaN(val)) totalCost += val;
  }
  flatRows.push(['', '', '', '', 'Total', fmtCurrency(totalCost)]);

  drawTable(doc, headers, flatRows, doc.y);
  addFooter(doc);
  return bufferFromDoc(doc);
}
