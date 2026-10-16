/**
 * Which 'pending' RFP approval requests are still OPEN (owner 2026-10-15, via 68)
 * ================================================================================
 * The daily digest emailed EVERY rfp_approval_requests row with status 'pending', forever: nothing closes a request
 * when its source deal is won, lost, deactivated or no longer an RFP. On 10-15, 107 were pending and about three
 * quarters were already decided in the CRM.
 *
 * "Open" is the approve gate's OWN rule, checkRfpApprovalSourceEligibility (rfp-approval.ts): the source deal still
 * exists and is still RFP-eligible (CRM: Opportunity stage; HubSpot: an RFP/Estimating stage). Its failure is
 * FAIL-OPEN, as at approve time: a digest that shows one RFP too many beats hiding one that still needs a decision.
 * PURE (no DB, no network): callers pass the eligibility result, so this is unit-testable.
 */

export type RfpEligibility = { eligible: boolean; reason?: string; checkFailed?: boolean };

export type PendingRfpClassification = {
  open: boolean;
  /** source_ineligible: decided / gone in its source. older: open, but pending longer than N days. open: current. */
  group: "source_ineligible" | "older" | "open";
  reason: string;
  ageDays: number | null;
};

const DAY_MS = 86_400_000;

export function rfpAgeDays(createdAt: Date | string | null | undefined, now: Date): number | null {
  if (!createdAt) return null;
  const t = new Date(createdAt).getTime();
  return Number.isNaN(t) ? null : Math.floor((now.getTime() - t) / DAY_MS);
}

export function classifyPendingRfp(
  row: { createdAt: Date | string | null },
  eligibility: RfpEligibility,
  now: Date,
  olderThanDays: number,
): PendingRfpClassification {
  const ageDays = rfpAgeDays(row.createdAt, now);
  if (!eligibility.eligible) {
    return { open: false, group: "source_ineligible", reason: eligibility.reason ?? "source deal is no longer RFP-eligible", ageDays };
  }
  const reason = eligibility.checkFailed ? "eligibility check failed (kept, fail-open)" : "source deal still RFP-eligible";
  return { open: true, group: isOlderThan(row.createdAt, now, olderThanDays) ? "older" : "open", reason, ageDays };
}

/**
 * THE one "older" boundary, shared with the digest (CodeRabbit on #114): elapsed time strictly over N days, never the
 * truncated day count, so the cleanup preview and the email agree on every row.
 */
export function isOlderThan(createdAt: Date | string | null | undefined, now: Date, days: number): boolean {
  if (!createdAt) return false;
  const t = new Date(createdAt).getTime();
  return !Number.isNaN(t) && now.getTime() - t > days * DAY_MS;
}

/**
 * The cleanup's --ids, ALL OR NOTHING (CodeRabbit on #114): every token a distinct positive integer, or the whole
 * command is refused. An operator must never get a partially accepted list.
 */
export function parseRfpCleanupIds(argv: string[]): { ok: true; ids: number[] } | { ok: false; error: string } {
  const arg = argv.find((a) => a.startsWith("--ids="));
  if (arg === undefined) return { ok: false, error: "--apply needs --ids=<the ids the owner approved by name>" };
  const tokens = arg.slice("--ids=".length).split(",").map((t) => t.trim());
  if (tokens.length === 0 || tokens.some((t) => !/^[1-9][0-9]*$/.test(t))) {
    return { ok: false, error: `--ids must be a comma-separated list of positive integers: "${arg}"` };
  }
  const ids = tokens.map(Number);
  if (new Set(ids).size !== ids.length) return { ok: false, error: `--ids repeats an id: "${arg}"` };
  return { ok: true, ids };
}

/**
 * The rows the digest may list: every one whose source deal is still open. Each row is checked once, in order. An
 * EXPIRED row is skipped before any check (Codex P2 on #114): the digest drops it anyway, and a remote CRM / HubSpot
 * call for it every day would only grow.
 */
export async function selectOpenPendingRfps<T>(
  rows: T[],
  check: (row: T) => Promise<RfpEligibility>,
  isExpired: (row: T) => boolean = () => false,
): Promise<T[]> {
  const kept: T[] = [];
  for (const row of rows) {
    if (isExpired(row)) continue;
    if ((await check(row)).eligible) kept.push(row);
  }
  return kept;
}
