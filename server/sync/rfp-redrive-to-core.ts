/**
 * RFP Phase 2, S1b: the ONE-DEAL operator re-drive (REDRIVE-DESIGN.r2 001ab3ba; d9's 11-10 rulings, and the S1b r2 rulings
 * Q1–Q3). Sends an approval that was already routed to Procore (and created there) to Core, through the normal S1 path.
 * Driven by scripts/rfp-redrive-to-core.ts; every `--apply` is its own a4 GO naming the deal.
 *
 *   --deal <crm deal id> --source-event-id <the existing approval's id> --go <a4 GO id> --actor <name>
 *   [--office dallas|atlanta] [--approval-kind vote] [--approval-evidence <json file>] [--apply]
 *
 * Exactly ONE deal; no bulk mode. DRY-RUN by default: it prints every precondition and writes nothing. ANY false ⇒ refused,
 * nothing written:
 *   (a) the deal's create COMMAND row for that source_event_id: decision approved, destination 'procore', and the Procore
 *       worker's TERMINAL SUCCESS status `done` (markCreateCommandDone, bidboard-create-worker.ts). Its Procore footprint is
 *       EXPECTED and never touched;
 *   (b) NO rfp_core_create_outbox row for that source_event_id in ANY status, and none live for the deal (pending /
 *       sending / sent / held_cross_destination);
 *   (c) RFP_NONSERVICE_DESTINATION=core. The Core receiver flag is NOT probed (d9 ruling 2): it is attested by the GO;
 *   (d) non-service (the effective type digit ≠ 4) and a CRM-format number (rfp-destination.ts, contract §2 (d) / (e));
 *   (office) d9 Q1: the stored E1 office (dallas | atlanta) or, where the E1 has none (an approval decided before CRM PR-B),
 *       `--office`, REQUIRED then; a given `--office` must EQUAL a stored one and be an office the Core path serves. It is the
 *       CRM office that HOLDS the deal, NOT the number's prefix (owner dcd308cf: DFW / ATL are prefixes in one system); an
 *       attested office prints "attested by GO <id>";
 *   (kind) d9 Q1: the stored approval kind (the command stamp, else E1's) or, where there is none, `--approval-kind vote`,
 *       REQUIRED then; a given one must EQUAL a stored one, and only a vote goes to Core (I1);
 *   (approval) d9 ruling A (S1b r3): the stored E1 `approval` block or, where the E1 has none (decided before PR-B),
 *       `--approval-evidence <json file>`, REQUIRED then and REFUSED when the E1 has a block (the stored block wins; never
 *       replaced or compared). The file is exactly {roundEventId (a non-empty string), approvals, rejections,
 *       invitedVoterCount (integers), decidedAt (ISO), source ("<path> <64-hex sha256>")}, with approvals ≥ 2,
 *       rejections < 2 and invitedVoterCount ≥ approvals + rejections; each check is printed. The CLI never opens or hashes
 *       `source`: it is recorded as attested ("approval evidence: attested by GO <id> (source <path> <sha8>)").
 *       r4 (d9): when --source-event-id is crm:rfp-vote:approved:<round>, roundEventId must EQUAL <round> (any other form:
 *       nothing to compare, printed); 2000-01-01T00:00:00Z ≤ decidedAt ≤ now, as Core's parser checks (an injectable clock).
 * `--apply`, in ONE transaction under the per-deal lock `rfp_create:<deal>` (lockRfpCreateDeal), re-checks every
 * precondition and then:
 *   - INSERTs ONE pending rfp_core_create_outbox row with the ORIGINAL source_event_id and
 *     payload {"operatorRedrive":{"reason":"operator_redrive","go","office","approvalKind","approval"?}} (the existing
 *     nullable jsonb; no schema change). The S1 sender uses that office / approvalKind / approval ONLY where the stored E1
 *     lacks them (the evidence's `source` never goes to Core);
 *   - writes ONE audit_logs row: the REQUIRED --actor (d9 Q3) + the OS user, the GO, before / after;
 *   - and, after commit, raises the alert rfp_operator_redrive_applied (d9 ruling 3).
 * The command row is NOT re-stamped (it stays procore). No Procore call. The S1 sender then skips its Procore-footprint hold
 * for this row only (payload.operatorRedrive.go + a procore-done command), and S0 answers a later CRM re-post of the same
 * approval as a no-op replay (d9 Q2, bidboard-create-worker.ts handleReattempt).
 */
import { promises as fs } from "fs";
import { sql } from "drizzle-orm";
import { raiseRfpCoreAlert } from "./rfp-core-alert";
import { resolveRfpBidCreateOffice } from "./rfp-core-wire";
import { lockRfpCreateDeal, readCreateCommandForEvent } from "./rfp-create-lock";
import { CRM_FORMAT_PROJECT_NUMBER_RE, effectiveTypeDigit } from "./rfp-destination";
import {
  GO_ID_RE,
  cliDb,
  cliOsUser,
  firstRow,
  parseActorArg,
  printChecks,
  rowsOf,
  writeAuditInTx,
  type RfpCliCheck,
  type RfpCliDeps,
  type RfpCliResult,
} from "./rfp-operator-cli";
import { operatorRedrivePayload, type OperatorRedriveApproval } from "./rfp-operator-redrive";

export type { RfpCliCheck, RfpCliDeps, RfpCliResult } from "./rfp-operator-cli";

export const REDRIVE_USAGE =
  "usage: rfp-redrive-to-core.ts --deal <crm deal id> --source-event-id <approval source_event_id> --go <a4 GO id> " +
  "--actor <name> [--office dallas|atlanta] [--approval-kind vote] [--approval-evidence <json file>] [--apply]";

/** The Procore worker's terminal SUCCESS status (bidboard-create-worker.ts markCreateCommandDone). */
export const PROCORE_TERMINAL_SUCCESS_STATUS = "done";
/** A Core create row in one of these is live for its deal (§2 / REDRIVE-DESIGN.r2 §2 b). */
export const LIVE_CORE_CREATE_STATUSES = ["pending", "sending", "sent", "held_cross_destination"] as const;
/** LEGACY (owner 2026-11-13, dcd308cf): the office a number's prefix was once assumed to name. No check uses it; a prefix is a
 *  market in one shared system, not the CRM office that holds the deal. */
export const NUMBER_PREFIX_OFFICE: Record<string, string> = { DFW: "dallas", ATL: "atlanta" };

const DEAL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RedriveArgs = {
  deal: string;
  sourceEventId: string;
  go: string;
  actor: string;
  office?: "dallas" | "atlanta";
  approvalKind?: "vote";
  /** d9 ruling A: the path of the attested vote-evidence JSON (REQUIRED only where the stored E1 has no approval block). */
  approvalEvidence?: string;
  apply: boolean;
};

export function parseRedriveArgs(argv: string[]): RedriveArgs | { error: string } {
  const err = (error: string) => ({ error });
  let deal: string | undefined;
  let sourceEventId: string | undefined;
  let go: string | undefined;
  let actor: string | undefined;
  let office: RedriveArgs["office"];
  let approvalKind: RedriveArgs["approvalKind"];
  let approvalEvidence: string | undefined;
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--deal") {
      if (deal !== undefined) return err("exactly one --deal (no bulk mode)");
      const v = argv[++i];
      if (!v || !DEAL_ID_RE.test(v)) return err("--deal needs ONE CRM deal id (a uuid)");
      deal = v.toLowerCase();
    } else if (a === "--source-event-id") {
      if (sourceEventId !== undefined) return err("exactly one --source-event-id");
      const v = argv[++i];
      if (!v || v.trim() !== v || v.length > 200) return err("--source-event-id needs the approval's source_event_id");
      sourceEventId = v;
    } else if (a === "--go") {
      if (go !== undefined) return err("exactly one --go");
      const v = argv[++i];
      if (!v || !GO_ID_RE.test(v)) return err("--go needs the a4 GO id");
      go = v;
    } else if (a === "--actor") {
      if (actor !== undefined) return err("exactly one --actor");
      const v = parseActorArg(argv[++i]);
      if (!v) return err("--actor needs the name of the person running this (not blank)");
      actor = v;
    } else if (a === "--office") {
      if (office !== undefined) return err("exactly one --office");
      const v = argv[++i];
      if (v !== "dallas" && v !== "atlanta") return err("--office must be dallas or atlanta");
      office = v;
    } else if (a === "--approval-kind") {
      if (approvalKind !== undefined) return err("exactly one --approval-kind");
      const v = argv[++i];
      if (v !== "vote") return err("--approval-kind must be vote (only a 2-of-3 vote goes to Core)");
      approvalKind = v;
    } else if (a === "--approval-evidence") {
      if (approvalEvidence !== undefined) return err("exactly one --approval-evidence");
      const v = argv[++i];
      if (!v || v.trim() === "") return err("--approval-evidence needs the path of the evidence JSON file");
      approvalEvidence = v;
    } else if (a === "--apply") {
      if (apply) return err("--apply given twice");
      apply = true;
    } else {
      return err(`unknown argument ${a}`);
    }
  }
  if (!deal) return err("--deal is required (exactly one deal)");
  if (!sourceEventId) return err("--source-event-id is required");
  if (!go) return err("--go is required (the a4 GO naming this deal)");
  if (!actor) return err("--actor is required (who runs this; recorded on the audit row)");
  return {
    deal, sourceEventId, go, actor, apply,
    ...(office ? { office } : {}), ...(approvalKind ? { approvalKind } : {}), ...(approvalEvidence ? { approvalEvidence } : {}),
  };
}

/** The evidence file as read (once, before any check), or why it could not be read. */
type EvidenceFile = { path: string; text?: string; error?: string };

async function readEvidence(path: string, deps: RfpCliDeps): Promise<EvidenceFile> {
  try {
    const text = await (deps.readFile ?? ((p: string) => fs.readFile(p, "utf8")))(path);
    return { path, text };
  } catch (e: any) {
    return { path, error: e?.message ?? String(e) };
  }
}

const EVIDENCE_KEYS = ["roundEventId", "approvals", "rejections", "invitedVoterCount", "decidedAt", "source"];
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
/** The vote round in a CRM vote source_event_id (rfp-enqueue.ts's round key), when it has that form. */
const VOTE_EVENT_ROUND_RE = /^crm:rfp-vote:approved:(.+)$/;
/** Core's lower bound on an event time (crm-ingress/wire.ts eventTime: year ≥ 2000). */
const MIN_DECIDED_AT_MS = Date.UTC(2000, 0, 1);
/** "<path> <64-hex sha256>": a path (it may hold spaces), one space, the hash. */
const EVIDENCE_SOURCE_RE = /^(\S(?:.*\S)?) ([0-9a-fA-F]{64})$/;
const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** d9 ruling A (+ r4): the strict evidence checks, each its own printed line; the evidence when they all pass. */
function checkEvidence(
  e: EvidenceFile, go: string, sourceEventId: string, now: Date,
): { checks: RfpCliCheck[]; approval: OperatorRedriveApproval | null } {
  const checks: RfpCliCheck[] = [];
  let parsed: unknown;
  if (e.error !== undefined) {
    checks.push({ key: "approval.parse", ok: false, detail: `cannot read ${e.path}: ${e.error}` });
    return { checks, approval: null };
  }
  try {
    parsed = JSON.parse(e.text ?? "");
  } catch {
    parsed = undefined;
  }
  if (!isPlainObject(parsed)) {
    checks.push({ key: "approval.parse", ok: false, detail: `${e.path} does not parse as a JSON object` });
    return { checks, approval: null };
  }
  checks.push({ key: "approval.parse", ok: true, detail: `${e.path} parses as a JSON object` });
  const o = parsed;
  const shape: string[] = [];
  const extra = Object.keys(o).filter((k) => !EVIDENCE_KEYS.includes(k));
  const missing = EVIDENCE_KEYS.filter((k) => !(k in o));
  if (extra.length > 0) shape.push(`unexpected key(s) ${extra.join(", ")}`);
  if (missing.length > 0) shape.push(`missing key(s) ${missing.join(", ")}`);
  if (!(typeof o.roundEventId === "string" && o.roundEventId.trim() !== "")) shape.push("roundEventId must be a non-empty string (not null)");
  for (const k of ["approvals", "rejections", "invitedVoterCount"]) if (!isCount(o[k])) shape.push(`${k} must be a non-negative integer`);
  if (!(typeof o.decidedAt === "string" && ISO_INSTANT_RE.test(o.decidedAt) && Number.isFinite(Date.parse(o.decidedAt)))) {
    shape.push("decidedAt must be an ISO timestamp with a zone");
  }
  if (typeof o.source !== "string") shape.push("source must be a string");
  checks.push({
    key: "approval.shape",
    ok: shape.length === 0,
    detail: shape.length === 0 ? "exactly {roundEventId, approvals, rejections, invitedVoterCount, decidedAt, source}, typed" : shape.join("; "),
  });
  // r4 (d9 (2)): the evidence must be the evidence of THIS approval's round, when the event id names one.
  const round = VOTE_EVENT_ROUND_RE.exec(sourceEventId)?.[1] ?? null;
  if (round === null) {
    checks.push({
      key: "approval.round",
      ok: true,
      detail: `source_event_id ${sourceEventId} is not crm:rfp-vote:approved:<round>: nothing to compare`,
    });
  } else {
    const same = typeof o.roundEventId === "string" && o.roundEventId === round;
    checks.push({
      key: "approval.round",
      ok: same,
      detail: same
        ? `roundEventId ${o.roundEventId} = the round in ${sourceEventId}`
        : `roundEventId ${JSON.stringify(o.roundEventId ?? null)} ≠ the round ${round} in ${sourceEventId}`,
    });
  }
  // r4 (d9 (3)): 2000-01-01T00:00:00Z ≤ decidedAt ≤ now, as Core's parser bounds an event time.
  const decidedMs = typeof o.decidedAt === "string" && ISO_INSTANT_RE.test(o.decidedAt) ? Date.parse(o.decidedAt) : Number.NaN;
  const inRange = Number.isFinite(decidedMs) && decidedMs >= MIN_DECIDED_AT_MS && decidedMs <= now.getTime();
  checks.push({
    key: "approval.decidedAt",
    ok: inRange,
    detail: `decidedAt ${JSON.stringify(o.decidedAt ?? null)} ${inRange ? "is" : "must be"} within [2000-01-01T00:00:00Z, now ${now.toISOString()}]`,
  });
  const a = o.approvals;
  const r = o.rejections;
  const n = o.invitedVoterCount;
  const votesOk = isCount(a) && isCount(r) && a >= 2 && r < 2;
  checks.push({
    key: "approval.votes",
    ok: votesOk,
    detail: `approvals ${JSON.stringify(a ?? null)} (needs ≥ 2), rejections ${JSON.stringify(r ?? null)} (needs < 2)`,
  });
  const invitedOk = isCount(a) && isCount(r) && isCount(n) && n >= a + r;
  checks.push({
    key: "approval.invited",
    ok: invitedOk,
    detail: `invitedVoterCount ${JSON.stringify(n ?? null)} (needs ≥ approvals + rejections)`,
  });
  const m = typeof o.source === "string" ? EVIDENCE_SOURCE_RE.exec(o.source) : null;
  checks.push({
    key: "approval.source",
    ok: Boolean(m),
    detail: m
      ? `approval evidence: attested by GO ${go} (source ${m[1]} ${m[2].slice(0, 8)})`
      : `source ${JSON.stringify(o.source ?? null)} must be "<path> <64-hex sha256>" (recorded as attested; never opened)`,
  });
  if (!checks.every((c) => c.ok)) return { checks, approval: null };
  return {
    checks,
    approval: {
      roundEventId: o.roundEventId as string, approvals: a as number, rejections: r as number,
      invitedVoterCount: n as number, decidedAt: o.decidedAt as string, source: o.source as string,
    },
  };
}

interface RedriveFacts {
  command: any | undefined;
  coreRowsForEvent: Array<{ id: number; status: string; source_deal_id: string }>;
  liveCoreRowsForDeal: Array<{ id: number; status: string; source_event_id: string }>;
}

async function readFacts(ex: any, args: RedriveArgs, forUpdate: boolean): Promise<RedriveFacts> {
  const command = await readCreateCommandForEvent(ex, args.sourceEventId, forUpdate);
  const coreRowsForEvent = rowsOf(await ex.execute(sql`
    SELECT id, status, source_deal_id FROM rfp_core_create_outbox WHERE source_event_id = ${args.sourceEventId} ORDER BY id
  `));
  const live = sql.raw(LIVE_CORE_CREATE_STATUSES.map((s) => `'${s}'`).join(", ")); // a fixed internal set
  const liveCoreRowsForDeal = rowsOf(await ex.execute(sql`
    SELECT id, status, source_event_id FROM rfp_core_create_outbox
     WHERE source_deal_id = ${args.deal} AND status IN (${live}) ORDER BY id
  `));
  return { command, coreRowsForEvent, liveCoreRowsForDeal };
}

interface Evaluation {
  checks: RfpCliCheck[];
  office: string | null;
  approvalKind: string | null;
  /** The attested evidence (only where the stored E1 has no approval block), else null. */
  approval: OperatorRedriveApproval | null;
  /** The stored E1 approval block, for the audit row's `before`. */
  e1Approval: Record<string, unknown> | null;
}

function evaluate(f: RedriveFacts, args: RedriveArgs, env: NodeJS.ProcessEnv, evidence: EvidenceFile | null, now: Date): Evaluation {
  const c = f.command;
  const payload = (c?.payload ?? {}) as any;
  const deal = (payload.deal ?? {}) as any;
  const aProblems: string[] = [];
  if (!c) aProblems.push("no create command row for that source_event_id");
  else {
    if (String(c.source_deal_id) !== args.deal) aProblems.push(`the command row belongs to deal ${c.source_deal_id}, not ${args.deal}`);
    if (payload.decision !== "approved") aProblems.push(`decision is ${JSON.stringify(payload.decision ?? null)}, not "approved"`);
    if (c.destination !== "procore") aProblems.push(`destination is ${c.destination}, not procore`);
    if (c.status !== PROCORE_TERMINAL_SUCCESS_STATUS) aProblems.push(`status is ${c.status}, not the terminal success status ${PROCORE_TERMINAL_SUCCESS_STATUS}`);
  }
  const a: RfpCliCheck = {
    key: "a",
    ok: aProblems.length === 0,
    detail: aProblems.length === 0
      ? `command row ${c.id}: decision approved, destination procore, status ${c.status} (the Procore project exists; its footprint is expected)`
      : `command row: ${aProblems.join("; ")}`,
  };
  const bProblems: string[] = [];
  if (f.coreRowsForEvent.length > 0) {
    bProblems.push(`rfp_core_create_outbox already has ${f.coreRowsForEvent.map((r) => `row ${r.id} (${r.status})`).join(", ")} for that source_event_id`);
  }
  if (f.liveCoreRowsForDeal.length > 0) {
    bProblems.push(`the deal has a live Core create: ${f.liveCoreRowsForDeal.map((r) => `row ${r.id} (${r.status}, ${r.source_event_id})`).join(", ")}`);
  }
  const b: RfpCliCheck = {
    key: "b",
    ok: bProblems.length === 0,
    detail: bProblems.length === 0
      ? "no rfp_core_create_outbox row for that source_event_id in any status, none live for the deal"
      : `${bProblems.join("; ")}; a re-arm of an existing row follows contract §2, not this tool`,
  };
  const setting = env.RFP_NONSERVICE_DESTINATION;
  const cc: RfpCliCheck = {
    key: "c",
    ok: setting === "core",
    detail: setting === "core"
      ? `RFP_NONSERVICE_DESTINATION=core; Core receiver flag: attested by GO ${args.go}`
      : `RFP_NONSERVICE_DESTINATION is ${JSON.stringify(setting ?? null)}, not core; Core receiver flag: attested by GO ${args.go}`,
  };
  const digit = c ? effectiveTypeDigit({ projectNumber: deal.projectNumber ?? null, projectType: deal.projectType ?? null }) : null;
  const number = typeof deal.projectNumber === "string" ? deal.projectNumber : null;
  const dProblems: string[] = [];
  if (!c) dProblems.push("no command row to read the deal from");
  else {
    if (digit === "4") dProblems.push("a service deal (effective type digit 4) keeps its own path");
    if (!number || !CRM_FORMAT_PROJECT_NUMBER_RE.test(number)) dProblems.push(`project number ${JSON.stringify(number)} is not CRM-format`);
  }
  const d: RfpCliCheck = {
    key: "d",
    ok: dProblems.length === 0,
    detail: dProblems.length === 0 ? `non-service (type digit ${digit}), CRM-format number ${number}` : dProblems.join("; "),
  };

  // (office) d9 Q1: the stored E1 office, or --office where the E1 has none: the CRM office that HOLDS the deal, attested by the GO.
  const storedOffice = typeof payload.office === "string" && payload.office.trim() !== "" ? payload.office.trim() : null;
  const officeProblems: string[] = [];
  let office: string | null = null;
  let officeSource = "";
  if (!c) officeProblems.push("no command row to read the office from");
  else if (storedOffice) {
    if (!resolveRfpBidCreateOffice(storedOffice)) officeProblems.push(`the stored E1 office ${storedOffice} is not served by the Core path (dallas | atlanta)`);
    else if (args.office && args.office !== storedOffice) officeProblems.push(`--office ${args.office} conflicts with the stored E1 office ${storedOffice}`);
    else {
      office = storedOffice;
      officeSource = args.office ? "stored E1; --office matches" : "stored E1";
    }
  } else if (!args.office) {
    officeProblems.push("the stored E1 has no office (decided before CRM PR-B): --office dallas|atlanta is required");
  } else {
    office = args.office;
    officeSource = `attested by GO ${args.go}`;
  }
  // NOT the number's prefix (owner 2026-11-13, dcd308cf): DFW / ATL are project-number PREFIXES in one shared system, so an
  // ATL-numbered deal can sit in the CRM's dallas office, and the CRM answers the link callback only from the office that holds
  // the deal. The old prefix rule (ATL ⇒ atlanta) was a legacy assumption; an --office need only be one the Core path serves.
  if (c && args.office && !resolveRfpBidCreateOffice(args.office)) {
    officeProblems.push(`--office ${args.office} is not served by the Core path (dallas | atlanta)`);
  }
  if (officeProblems.length > 0) office = null;
  const officeCheck: RfpCliCheck = {
    key: "office",
    ok: officeProblems.length === 0,
    detail: officeProblems.length === 0 ? `office ${office} (${officeSource})` : officeProblems.join("; "),
  };

  // (kind) d9 Q1: the stored kind (the command stamp, else E1's), or --approval-kind vote where there is none.
  const storedKind = c?.approval_kind === "vote" || c?.approval_kind === "override"
    ? String(c.approval_kind)
    : payload.approvalKind === "vote" || payload.approvalKind === "override" ? String(payload.approvalKind) : null;
  const kindProblems: string[] = [];
  let approvalKind: string | null = null;
  let kindSource = "";
  if (!c) kindProblems.push("no command row to read the approval kind from");
  else if (storedKind) {
    if (args.approvalKind && args.approvalKind !== storedKind) kindProblems.push(`--approval-kind ${args.approvalKind} conflicts with the stored approval kind ${storedKind}`);
    else if (storedKind !== "vote") kindProblems.push(`the stored approval kind is ${storedKind}: only a 2-of-3 vote goes to Core (I1)`);
    else {
      approvalKind = storedKind;
      kindSource = args.approvalKind ? "stored; --approval-kind matches" : "stored";
    }
  } else if (!args.approvalKind) {
    kindProblems.push("no stored approval kind (decided before CRM PR-B): --approval-kind vote is required");
  } else {
    approvalKind = args.approvalKind;
    kindSource = `attested by GO ${args.go}`;
  }
  const kindCheck: RfpCliCheck = {
    key: "kind",
    ok: kindProblems.length === 0,
    detail: kindProblems.length === 0 ? `approvalKind ${approvalKind} (${kindSource})` : kindProblems.join("; "),
  };
  // (approval) d9 ruling A: the stored block, or the attested evidence where the E1 has none.
  const e1Approval = isPlainObject(payload.approval) ? payload.approval : null;
  const approvalChecks: RfpCliCheck[] = [];
  let approval: OperatorRedriveApproval | null = null;
  if (!c) {
    approvalChecks.push({ key: "approval", ok: false, detail: "no command row to read the approval block from" });
  } else if (e1Approval) {
    approvalChecks.push(evidence
      ? {
          key: "approval",
          ok: false,
          detail: `the stored E1 already has an approval block (round ${JSON.stringify(e1Approval.roundEventId ?? null)}): ` +
            "--approval-evidence is refused (the stored block is the evidence; it is never replaced)",
        }
      : { key: "approval", ok: true, detail: `approval: the stored E1 block (round ${JSON.stringify(e1Approval.roundEventId ?? null)})` });
  } else if (!evidence) {
    approvalChecks.push({
      key: "approval",
      ok: false,
      detail: "the stored E1 has no approval block (decided before CRM PR-B): --approval-evidence <json file> is required",
    });
  } else {
    approvalChecks.push({ key: "approval", ok: true, detail: `the stored E1 has no approval block: the evidence in ${evidence.path}` });
    const checked = checkEvidence(evidence, args.go, args.sourceEventId, now);
    approvalChecks.push(...checked.checks);
    approval = checked.approval;
  }
  return { checks: [a, b, cc, d, officeCheck, kindCheck, ...approvalChecks], office, approvalKind, approval, e1Approval };
}

/** The testable main: (argv, deps) ⇒ the exit code and what it found / did. */
export async function runRedriveToCore(argv: string[], deps: RfpCliDeps = {}): Promise<RfpCliResult> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const parsed = parseRedriveArgs(argv);
  if ("error" in parsed) {
    out(`rfp-redrive-to-core: ${parsed.error}\n${REDRIVE_USAGE}`);
    return { code: 2, applied: false, refused: parsed.error, checks: [] };
  }
  const args = parsed;
  const env = deps.env ?? process.env;
  const db = await cliDb(deps);
  const osUser = cliOsUser(deps);
  out(`re-drive deal ${args.deal}, source_event_id ${args.sourceEventId}, GO ${args.go}, actor ${args.actor} (${osUser}) (${args.apply ? "APPLY" : "dry-run"})`);
  // The evidence file is read ONCE (the under-lock re-check reuses it); its own `source` path is never opened.
  const evidence = args.approvalEvidence ? await readEvidence(args.approvalEvidence, deps) : null;
  const now = (deps.now ?? (() => new Date()))();
  const first = evaluate(await readFacts(db, args, false), args, env, evidence, now);
  const checks = first.checks;
  printChecks(out, checks);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    const why = failed.map((c) => `(${c.key}) ${c.detail}`).join(" | ");
    out(`REFUSED: ${why}. Nothing written.`);
    return { code: 1, applied: false, refused: why, checks };
  }
  if (!args.apply) {
    const payload = operatorRedrivePayload({ go: args.go, office: first.office!, approvalKind: first.approvalKind!, approval: first.approval });
    out(
      "DRY-RUN: --apply would INSERT ONE pending rfp_core_create_outbox row (the original source_event_id, " +
        `payload ${JSON.stringify(payload)}) + ONE audit_logs row, then alert rfp_operator_redrive_applied. ` +
        "The command row stays procore. Nothing written.",
    );
    return { code: 0, applied: false, checks };
  }

  const state: { refusal?: string; applied?: { coreId: number; auditId: number; commandId: number; payload: unknown } } = {};
  await db.transaction(async (tx: any) => {
    await lockRfpCreateDeal(tx, args.deal);
    // Re-checked under the lock: a concurrent create for the deal either committed first (refused here) or waits.
    const facts = await readFacts(tx, args, true);
    const again = evaluate(facts, args, env, evidence, now);
    const bad = again.checks.filter((c) => !c.ok);
    if (bad.length > 0) {
      state.refusal = bad.map((c) => `(${c.key}) ${c.detail}`).join(" | ");
      return;
    }
    const command = facts.command;
    const payload = operatorRedrivePayload({ go: args.go, office: again.office!, approvalKind: again.approvalKind!, approval: again.approval });
    const inserted = firstRow(await tx.execute(sql`
      INSERT INTO rfp_core_create_outbox (command_id, source_system, source_deal_id, source_event_id, project_number, payload, status)
      VALUES (${command.id}, ${command.source_system}, ${command.source_deal_id}, ${command.source_event_id},
              ${command.project_number ?? (command.payload?.deal?.projectNumber ?? null)}, ${JSON.stringify(payload)}::jsonb, 'pending')
      RETURNING id
    `));
    const coreId = Number(inserted.id);
    const auditId = await writeAuditInTx(tx, {
      action: "rfp_operator_redrive",
      entityType: "rfp_core_create_outbox",
      entityId: String(coreId),
      source: "rfp-redrive-to-core",
      details: {
        actor: args.actor,
        osUser,
        go: args.go,
        deal: args.deal,
        sourceEventId: args.sourceEventId,
        commandId: command.id,
        attested: { office: args.office ?? null, approvalKind: args.approvalKind ?? null, approvalEvidence: again.approval },
        before: {
          command: { destination: command.destination, status: command.status }, e1Approval: again.e1Approval,
          coreRowsForEvent: [], liveCoreRowsForDeal: [],
        },
        after: { coreId, status: "pending", payload, command: { destination: command.destination, status: command.status } },
      },
    });
    state.applied = { coreId, auditId, commandId: Number(command.id), payload };
  });
  const applied = state.applied;
  if (state.refusal || !applied) {
    out(`APPLY REFUSED (re-checked under the per-deal lock): ${state.refusal ?? "unknown"}. Nothing written.`);
    return { code: 1, applied: false, refused: state.refusal ?? "unknown", checks };
  }
  await raiseRfpCoreAlert("rfp_operator_redrive_applied", {
    go: args.go, actor: args.actor, osUser, sourceDealId: args.deal, sourceEventId: args.sourceEventId, coreId: applied.coreId,
    commandId: applied.commandId, auditId: applied.auditId, payload: applied.payload,
  });
  out(`APPLIED: rfp_core_create_outbox row ${applied.coreId} pending (operatorRedrive, GO ${args.go}); audit_logs row ${applied.auditId}.`);
  return { code: 0, applied: true, checks, rowId: applied.coreId };
}
