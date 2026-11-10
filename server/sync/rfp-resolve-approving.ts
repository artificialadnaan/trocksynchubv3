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
 */
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { parseProjectTypeFromNumber, replaceProjectTypeInNumber } from "../constants";
import {
  approvingRecreateRefusal,
  readApprovingFacts,
  readApprovingResolveFootprint,
  RECORDED_APPROVAL_FIELDS,
  type ApprovingFacts,
} from "./rfp-approving";
import { clearRfpApprovingStuckAlert, type StuckAlertSend } from "./rfp-approving-stuck";

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
  /** Every Procore call made, as `GET <url>`. */
  procoreCalls: string[];
  submitAt: string | null;
  /** The recorded original-approval inputs, by field name only. */
  recordedInputs: string[];
  preCreateStepsRecorded: boolean;
};

export type ResolveApplyResult = { applied: boolean; refused?: string; report: ResolveReport };

/** (iii)'s window around rfp_approval_approving.started_at (runbook r5 §3 step 2). */
const WINDOW_MS = 2 * 60 * 60_000;
const PER_PAGE = 10;

export function parseResolveArgs(argv: string[]): ResolveArgs | { error: string } {
  const err = (error: string) => ({ error });
  let id: number | undefined;
  let apply = false;
  let resolution: ResolveResolution | undefined;
  let project: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--id") {
      if (id !== undefined) return err("exactly one --id");
      const v = argv[++i];
      if (!v || !/^[1-9]\d*$/.test(v)) return err("--id needs a positive integer");
      id = Number(v);
    } else if (a === "--apply") {
      if (apply) return err("--apply given twice");
      apply = true;
    } else if (a === "--resolution") {
      const v = argv[++i];
      if (resolution !== undefined) return err("--resolution given twice");
      if (v !== "found" && v !== "recreate") return err("--resolution must be found or recreate");
      resolution = v;
    } else if (a === "--project") {
      const v = argv[++i];
      if (project !== undefined) return err("--project given twice");
      if (!v || !/^\d+$/.test(v)) return err("--project needs a Procore project id");
      project = v;
    } else {
      return err(`unknown argument ${a}`);
    }
  }
  if (id === undefined) return err("--id is required");
  if (!apply) {
    if (resolution !== undefined || project !== undefined) return err("--resolution / --project need --apply");
    return { id, apply: false };
  }
  if (!resolution) return err("--apply needs --resolution found|recreate");
  if (resolution === "found") {
    if (!project) return err("--resolution found needs --project <id>");
    return { id, apply: true, resolution, project };
  }
  if (project !== undefined) return err("--resolution recreate takes no --project");
  return { id, apply: true, resolution };
}

const dialect = new PgDialect();
/** The drizzle `sql` readers (rfp-approving / rfp-create-lock) over a plain pg querier. */
function asExecutor(db: Querier) {
  return {
    execute: async (q: SQL) => {
      const { sql, params } = dialect.sqlToQuery(q);
      return db.query(sql, params);
    },
  };
}

type Hit = { id: string; projectNumber: string | null; name: string | null; createdAt: string | null };

function emptyReport(requestId: number): ResolveReport {
  return {
    requestId,
    status: null,
    ageMinutes: null,
    verdict: "error",
    decision: "C_stop",
    footprint: [],
    procoreCalls: [],
    submitAt: null,
    recordedInputs: [],
    preCreateStepsRecorded: false,
  };
}

function rowRefusal(f: ApprovingFacts): string | null {
  if (f.status !== "approving") return `the request is not approving (status ${f.status})`;
  if (!f.hasSideRow) return "its age can't be proven: no rfp_approval_approving row (d9 QB) ⇒ STOP / escalate";
  if (!f.olderThan30) return `younger than 30 min (${f.ageMinutes ?? "?"} min): it may still be mid-create`;
  return null;
}

const trimLower = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

export async function dryRunResolveApproving(requestId: number, deps: ResolveDeps): Promise<ResolveReport> {
  const out = deps.out;
  const report = emptyReport(requestId);
  const ex = asExecutor(deps.db);
  const facts = await readApprovingFacts(requestId, ex);
  if (!facts) {
    report.refused = "request not found";
    out(`REFUSED request ${requestId}: not found`);
    return report;
  }
  report.status = facts.status;
  report.ageMinutes = facts.ageMinutes;
  report.submitAt = facts.submitAt;
  report.recordedInputs = [...facts.recordedFields];
  report.preCreateStepsRecorded = facts.preCreateStepsRecorded;
  out(`request ${facts.requestId}: status ${facts.status}, age ${facts.ageMinutes ?? "unknown"} min, project number ${facts.projectNumber ?? "—"}, source ${facts.sourceSystem}`);

  const refusal = rowRefusal(facts);
  if (refusal) {
    report.refused = refusal;
    out(`REFUSED: ${refusal}. No Procore call made; nothing written.`);
    return report;
  }

  // Facts (read-only).
  report.footprint = await readApprovingResolveFootprint(ex, facts.sourceSystem, facts.sourceDealId);
  out(`footprint (other than this request's own approving row): ${report.footprint.length ? report.footprint.join(", ") : "none"}`);
  out(`submit_at: ${facts.submitAt === null ? "NULL (the create never started)" : facts.submitAt}`);
  out(
    facts.recorded
      ? `recorded inputs: ${facts.recordedFields.join(", ")}`
      : `original approval inputs not recorded (missing: ${RECORDED_APPROVAL_FIELDS.filter((x) => !facts.recordedFields.includes(x)).join(", ")})`,
  );
  out(`pre-create steps: ${facts.preCreateStepsRecorded ? "recorded" : "not recorded"}`);

  const stop = (verdict: ResolveVerdict, why: string): ResolveReport => {
    report.verdict = verdict;
    report.decision = "C_stop";
    out(`Procore calls: ${report.procoreCalls.length}`);
    out(`VERDICT ${verdict}: ${why}`);
    out("DECISION C: STOP. No write; escalate to a4 with this output.");
    return report;
  };

  // The stored token, as-is: never refreshed.
  const token = await deps.readStoredToken();
  const nowMs = (deps.now ?? new Date()).getTime();
  if (!token?.accessToken) return stop("error", "no stored Procore token");
  if (!token.expiresAt) return stop("error", "the stored Procore token has no known expiry; this tool never refreshes");
  if (token.expiresAt.getTime() <= nowMs) {
    return stop("error", `the stored Procore token expired at ${token.expiresAt.toISOString()}; this tool never refreshes`);
  }
  const accessToken = token.accessToken;

  const dealData = facts.dealData;
  const edited = (facts.recorded?.editedFields ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (v === undefined || v === null || String(v).trim() === "" ? null : String(v).trim());
  const baseNumber = str(edited.project_number) ?? str(facts.projectNumber) ?? str(dealData.project_number);
  // The create renumbers when the approver changed the type (processRfpApproval): search (i) by the number it created under.
  const editedType = str(edited.project_types);
  const currentType = baseNumber ? (parseProjectTypeFromNumber(baseNumber) ?? str(dealData.project_types)) : null;
  const number = baseNumber && editedType && editedType !== currentType ? replaceProjectTypeInNumber(baseNumber, editedType) : baseNumber;
  const name = str(edited.dealname) ?? str(dealData.dealname);
  const address = str(edited.address) ?? str(dealData.address);
  const client = str(edited.company_name) ?? str(dealData.company_name);

  const search = async (term: string): Promise<Hit[] | null> => {
    const url = `${deps.procoreBaseUrl}/rest/v1.1/companies/${deps.companyId}/projects?filters[search]=${encodeURIComponent(term)}&per_page=${PER_PAGE}`;
    const call = `GET ${url}`;
    report.procoreCalls.push(call);
    out(call);
    let res: { status: number; data: unknown };
    try {
      res = await deps.procoreGet(url, accessToken);
    } catch (e: any) {
      out(`  failed: ${e?.message ?? e}`);
      return null;
    }
    if (res.status !== 200 || !Array.isArray(res.data)) {
      out(`  failed: HTTP ${res.status}`);
      return null;
    }
    // One page only: a FULL page may have cut the real project off, so it cannot prove "not found".
    if (res.data.length >= PER_PAGE) {
      out(`  failed: a full page (${res.data.length} hits); the list may be cut off`);
      return null;
    }
    const hits = (res.data as any[]).map((p) => ({
      id: String(p?.id),
      projectNumber: p?.project_number == null ? null : String(p.project_number),
      name: p?.name == null ? null : String(p.name),
      createdAt: p?.created_at == null ? null : String(p.created_at),
    }));
    for (const h of hits) out(`  hit id=${h.id} number=${h.projectNumber ?? "—"} name=${h.name ?? "—"} created=${h.createdAt ?? "—"}`);
    if (hits.length === 0) out("  no hits");
    return hits;
  };

  if (!number) return stop("error", "(i) the request has no project number to search by");
  if (!name) return stop("error", "(ii) the request has no project name to search by");
  const byNumberAll = await search(number);
  if (!byNumberAll) return stop("error", "(i) the search by number failed");
  const byNameAll = await search(name);
  if (!byNameAll) return stop("error", "(ii) the search by name failed");
  const windowHits: Hit[] = [];
  let windowError: string | null = address || client ? null : "(iii) the deal has no address and no client to search by (d9 QC)";
  for (const term of [address, client]) {
    if (!term || windowError) continue;
    const hits = await search(term);
    if (!hits) {
      windowError = "(iii) a search by address / client failed";
      break;
    }
    for (const h of hits) {
      const t = h.createdAt ? Date.parse(h.createdAt) : NaN;
      if (!Number.isFinite(t)) {
        windowError ??= `(iii) hit ${h.id} has no created time, so the ± 2 h window can't be applied`;
        continue;
      }
      if (facts.startedAtMs !== null && Math.abs(t - facts.startedAtMs) <= WINDOW_MS) windowHits.push(h);
    }
  }
  if (windowError) return stop("error", windowError);

  const byNumber = byNumberAll.filter((h) => trimLower(h.projectNumber) === trimLower(number));
  const byName = byNameAll.filter((h) => trimLower(h.name) === trimLower(name));
  out(`Procore calls: ${report.procoreCalls.length}`);
  out(`(i) by number: ${byNumber.map((h) => h.id).join(", ") || "none"}; (ii) by name: ${byName.map((h) => h.id).join(", ") || "none"}; (iii) in the window: ${windowHits.map((h) => h.id).join(", ") || "none"}`);

  if (byNumber.length > 1) return stop("ambiguous", `${byNumber.length} projects carry the number`);
  if (byNumber.length === 1) {
    const id = byNumber[0].id;
    const different = [...byName, ...windowHits].filter((h) => h.id !== id).map((h) => h.id);
    if (different.length > 0) return stop("ambiguous", `the number matches ${id} but name / address / client match ${[...new Set(different)].join(", ")}`);
    report.verdict = "found";
    report.decision = "A_found";
    report.foundProjectId = id;
    out(`VERDICT found: project ${id}`);
    out(`DECISION A: --apply --resolution found --project ${id} (its own a4 GO naming request ${requestId} AND project ${id})`);
    return report;
  }
  if (byName.length > 0 || windowHits.length > 0) return stop("ambiguous", "no project by number, but one by name / address / client");
  if (facts.submitAt !== null) return stop("not_found_after_submit", "nothing found, but the create had started (submit_at is set)");

  report.verdict = "not_found_no_submit";
  const recreateBlock = report.footprint.length > 0 ? `a footprint exists (${report.footprint.join(", ")})` : approvingRecreateRefusal(facts);
  if (recreateBlock) {
    report.decision = "C_stop";
    out(`VERDICT not_found_no_submit, but recreate is not allowed: ${recreateBlock}`);
    out("DECISION C: STOP. No write; escalate to a4 with this output.");
    return report;
  }
  report.decision = "B_recreate";
  out("VERDICT not_found_no_submit: zero hits and the create never started");
  out(`DECISION B: --apply --resolution recreate (its own a4 GO naming request ${requestId})`);
  return report;
}

async function writeAudit(deps: ResolveDeps, args: ResolveArgs, report: ResolveReport, status: "success" | "error", error?: string) {
  await deps.db.query(
    `INSERT INTO audit_logs (action, entity_type, entity_id, source, status, details, error_message, category)
     VALUES ('rfp_resolve_approving', 'rfp_approval_request', $1, 'rfp-resolve-approving', $2, $3::jsonb, $4, 'system')`,
    [
      String(args.id),
      status,
      JSON.stringify({
        resolution: args.resolution,
        project: args.project ?? null,
        verdict: report.verdict,
        decision: report.decision,
        procoreCalls: report.procoreCalls.length,
        footprint: report.footprint,
      }),
      error ?? null,
    ],
  );
}

export async function applyResolveApproving(args: ResolveArgs, deps: ResolveDeps): Promise<ResolveApplyResult> {
  const report = await dryRunResolveApproving(args.id, deps);
  const refuse = (why: string): ResolveApplyResult => {
    deps.out(`APPLY REFUSED: ${why}. Nothing written.`);
    return { applied: false, refused: why, report };
  };
  if (!args.apply) return refuse("not an --apply run");
  if (report.refused) return refuse(report.refused);

  if (args.resolution === "found") {
    if (report.decision !== "A_found") return refuse(`the checks say ${report.verdict} (decision ${report.decision}), not found`);
    if (report.foundProjectId !== args.project) return refuse(`the checks found project ${report.foundProjectId}, not ${args.project}`);
    const res = await deps.finaliseFound(args.id, args.project!);
    if (!res.success) return refuse(`found could not be finalised: ${res.error ?? "unknown error"}`);
  } else if (args.resolution === "recreate") {
    if (report.decision !== "B_recreate") return refuse(`the checks say ${report.verdict} (decision ${report.decision}), not recreate`);
    const res = await deps.recreate(args.id);
    if (!res.success) {
      // The locked path may have written (a hold, or a create that ended without a project): record the attempt.
      await writeAudit(deps, args, report, "error", res.error);
      deps.out(`APPLY recreate did not succeed: ${res.error ?? "unknown error"}`);
      return { applied: false, refused: res.error ?? "recreate failed", report };
    }
  } else {
    return refuse("no --resolution");
  }

  await writeAudit(deps, args, report, "success");
  if (deps.alert) await clearRfpApprovingStuckAlert(args.id, { db: deps.db, recipient: deps.alert.recipient, send: deps.alert.send, now: deps.now });
  deps.out(`APPLIED ${args.resolution} for request ${args.id}.`);
  return { applied: true, report };
}
