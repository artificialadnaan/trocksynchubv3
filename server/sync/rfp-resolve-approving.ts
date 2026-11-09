/**
 * The reviewed resolver for a request STUCK in `approving` (S0b-2b; runbook r5 §3; d9 Q8 + QA / QB / QC). Driven by
 * scripts/rfp-resolve-approving.ts; every `--apply` is its own a4 GO naming the request id (and, for `found`, the project).
 *
 * - DRY-RUN by default; exactly one `--id`. It refuses unless the row is `approving` AND older than 30 minutes, proven by its
 *   rfp_approval_approving row (no side-table row ⇒ the age can't be proven ⇒ refused).
 * - Read-only facts: the row, the deal's sync mappings, its Procore create commands (read through rfp-create-lock, the
 *   classified reader of that table), Core rows (rfp_core_create_outbox).
 * - Read-only Procore checks with SyncHub's existing projects search, on the STORED token as-is (expired ⇒ `error`; it never
 *   refreshes): (i) by project number, (ii) by project name, (iii) by the deal's address / client, restricted to projects
 *   created within started_at ± 2 h. A hit without a created time, or no address AND no client, makes (iii) `error`.
 *   Every call (endpoint + count) and every hit is printed.
 * - Verdicts: `found` = exactly ONE project by number and no DIFFERENT id from (ii) / (iii); `not_found_no_submit` = zero hits
 *   AND submit_at IS NULL; else `ambiguous` / `error` / `not_found_after_submit`.
 * - Decisions: A `found` ⇒ `--resolution found --project <id>`; B `not_found_no_submit` + no footprint elsewhere + the original
 *   approval's inputs recorded + the pre-create steps recorded ⇒ `--resolution recreate`; C anything else ⇒ STOP (no write).
 * - `--apply` re-runs the checks, applies only a matching A / B, then writes ONE audit row and clears the stuck alert when the
 *   row is terminal. A refused apply writes nothing.
 *
 * S0b-2b RED: stub.
 */
import type { StuckAlertSend } from "./rfp-approving-stuck";

export type ResolveResolution = "found" | "recreate";
export type ResolveArgs = { id: number; apply: boolean; resolution?: ResolveResolution; project?: string };

export type ResolveVerdict = "found" | "not_found_no_submit" | "not_found_after_submit" | "ambiguous" | "error";
export type ResolveDecision = "A_found" | "B_recreate" | "C_stop";

export type Querier = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export type ResolveDeps = {
  db: Querier;
  /** The stored Procore OAuth row, read as-is. Never a refresh. */
  readStoredToken: () => Promise<{ accessToken: string | null; expiresAt: Date | null } | undefined>;
  /** One read-only GET against Procore (the projects search); `url` is absolute. */
  procoreGet: (url: string, accessToken: string) => Promise<{ status: number; data: unknown }>;
  procoreBaseUrl: string;
  companyId: string;
  now?: Date;
  out: (line: string) => void;
  finaliseFound: (requestId: number, projectId: string) => Promise<{ success: boolean; error?: string }>;
  recreate: (requestId: number) => Promise<{ success: boolean; error?: string; bidboardProjectId?: string }>;
  alert?: { recipient: string; send: StuckAlertSend };
};

export type ResolveReport = {
  requestId: number;
  status: string | null;
  ageMinutes: number | null;
  /** Set when the CLI refuses the row before any Procore call (not approving / too young / age unknown / missing). */
  refused?: string;
  verdict: ResolveVerdict;
  decision: ResolveDecision;
  foundProjectId?: string;
  /** The deal's footprint other than this request's own `approving` row. */
  footprint: string[];
  /** Every Procore call made, as `GET <path+query>`. */
  procoreCalls: string[];
  submitAt: string | null;
  /** The recorded original-approval inputs, by field name only. */
  recordedInputs: string[];
  preCreateStepsRecorded: boolean;
};

export type ResolveApplyResult = { applied: boolean; refused?: string; report: ResolveReport };

export function parseResolveArgs(_argv: string[]): ResolveArgs | { error: string } {
  return { error: "not implemented (S0b-2b red)" };
}

function stubReport(requestId: number): ResolveReport {
  return {
    requestId,
    status: null,
    ageMinutes: null,
    verdict: "unimplemented" as unknown as ResolveVerdict,
    decision: "unimplemented" as unknown as ResolveDecision,
    footprint: [],
    procoreCalls: [],
    submitAt: null,
    recordedInputs: [],
    preCreateStepsRecorded: false,
  };
}

export async function dryRunResolveApproving(requestId: number, _deps: ResolveDeps): Promise<ResolveReport> {
  return stubReport(requestId);
}

export async function applyResolveApproving(args: ResolveArgs, _deps: ResolveDeps): Promise<ResolveApplyResult> {
  return { applied: false, refused: "not implemented (S0b-2b red)", report: stubReport(args.id) };
}
