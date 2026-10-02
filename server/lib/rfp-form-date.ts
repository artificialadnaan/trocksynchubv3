/**
 * The RFP review form's `<input type="date">` value for a stored due date: YYYY-MM-DD in the SERVER's
 * local zone (getFullYear/getMonth/getDate), accepting an epoch-ms digit string as HubSpot sends one.
 *
 * ONE definition, shared by the form that renders the value and the Core handoff that compares an
 * approval's posted date against it — a second, subtly different formatter would make an untouched date
 * look edited.
 */
export function formatRfpFormDate(val: any): string {
  if (val == null || val === '') return '';
  const n = typeof val === 'string' && /^\d+$/.test(val) ? parseInt(val, 10) : val;
  const date = new Date(n);
  if (isNaN(date.getTime())) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** The stored due date the review form pre-fills its date input from — the form's own fallback chain. */
export function rfpFormDueDateSource(d: Record<string, any>): any {
  return d.proposal_due_date || d.bid_due_date || d.due_date;
}
