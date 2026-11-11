/**
 * RFP Phase 2, S1b: the Requeue CLI (CONTRACT v2.4 §10 "Requeue CLI"; d9's 11-10 ruling 1). Puts ONE dead outbox row back on
 * its schedule. Driven by scripts/rfp-requeue-dead.ts; every `--apply` is its own a4 GO naming the id.
 *
 *   --outbox create|followup --id <row id> --destination procore|core --actor <name> [--apply --go <a4 GO id>]
 *
 * DRY-RUN by default (prints every check, writes nothing); `--apply` needs `--go`. `--actor` is REQUIRED (d9 Q3, S1b r2) and
 * is recorded on the audit row with the OS user. Exactly one `--id`. `--destination` is
 * REQUIRED and must equal the stamp on the row's create COMMAND row (the command the Core create points at), else refused.
 *   - create:   only a `dead` rfp_core_create_outbox row (an E2 that exhausted its schedule) ⇒ pending.
 *   - followup: only a `dead` crm_link (E4) or crm_notice (N1) row ⇒ pending. core_confirm (E5) is refused: it never
 *               dead-letters (§7). link_refused is refused: a person resolves it (§2). Every other status is refused.
 * The reset is S0's re-arm reset exactly (rfp-core-rearm.ts, shared with bidboard-create-worker.ts handleReattempt). The E2
 * sender re-checks the Procore footprint under the per-deal lock before it sends, as for any re-armed row.
 * `--apply`: ONE transaction under the per-deal lock (re-checks, the flip, ONE audit_logs row), then the alert
 * rfp_requeue_applied.
 */
import { sql } from "drizzle-orm";
import { raiseRfpCoreAlert } from "./rfp-core-alert";
import { coreCreateRearmSet, coreFollowupRearmSet } from "./rfp-core-rearm";
import { lockRfpCreateDeal, readCreateCommandForUpdate } from "./rfp-create-lock";
import {
  GO_ID_RE,
  cliDb,
  cliOsUser,
  firstRow,
  parseActorArg,
  printChecks,
  writeAuditInTx,
  type RfpCliCheck,
  type RfpCliDeps,
  type RfpCliResult,
} from "./rfp-operator-cli";

export type { RfpCliCheck, RfpCliDeps, RfpCliResult } from "./rfp-operator-cli";

export const REQUEUE_USAGE =
  "usage: rfp-requeue-dead.ts --outbox create|followup --id <row id> --destination procore|core --actor <name> [--apply --go <a4 GO id>]";

export type RequeueArgs = {
  outbox: "create" | "followup";
  id: number;
  destination: "procore" | "core";
  actor: string;
  apply: boolean;
  go?: string;
};

export function parseRequeueArgs(argv: string[]): RequeueArgs | { error: string } {
  const err = (error: string) => ({ error });
  let outbox: RequeueArgs["outbox"] | undefined;
  let id: number | undefined;
  let destination: RequeueArgs["destination"] | undefined;
  let apply = false;
  let go: string | undefined;
  let actor: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--outbox") {
      if (outbox !== undefined) return err("--outbox given twice");
      const v = argv[++i];
      if (v !== "create" && v !== "followup") return err("--outbox must be create or followup");
      outbox = v;
    } else if (a === "--id") {
      if (id !== undefined) return err("exactly one --id");
      const v = argv[++i];
      if (!v || !/^[1-9]\d*$/.test(v)) return err("--id needs a positive integer row id");
      id = Number(v);
    } else if (a === "--destination") {
      if (destination !== undefined) return err("--destination given twice");
      const v = argv[++i];
      if (v !== "procore" && v !== "core") return err("--destination must be procore or core");
      destination = v;
    } else if (a === "--apply") {
      if (apply) return err("--apply given twice");
      apply = true;
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
    } else {
      return err(`unknown argument ${a}`);
    }
  }
  if (!outbox) return err("--outbox create|followup is required");
  if (id === undefined) return err("--id is required (exactly one)");
  if (!destination) return err("--destination procore|core is required (it must equal the command row's stamp)");
  if (!actor) return err("--actor is required (who runs this; recorded on the audit row)");
  if (apply && !go) return err("--apply needs --go (the a4 GO naming this id)");
  return { outbox, id, destination, actor, apply, ...(go ? { go } : {}) };
}

interface RequeueFacts {
  row: any | undefined;
  create: any | undefined;
  command: any | undefined;
}

async function readFacts(ex: any, args: RequeueArgs): Promise<RequeueFacts> {
  if (args.outbox === "create") {
    const row = firstRow(await ex.execute(sql`SELECT * FROM rfp_core_create_outbox WHERE id = ${args.id} FOR UPDATE`));
    const command = row ? await readCreateCommandForUpdate(ex, Number(row.command_id)) : undefined;
    return { row, create: row, command };
  }
  const row = firstRow(await ex.execute(sql`SELECT * FROM rfp_core_followup_outbox WHERE id = ${args.id} FOR UPDATE`));
  const create = row
    ? firstRow(await ex.execute(sql`SELECT * FROM rfp_core_create_outbox WHERE id = ${row.create_id} FOR UPDATE`))
    : undefined;
  const command = create ? await readCreateCommandForUpdate(ex, Number(create.command_id)) : undefined;
  return { row, create, command };
}

function evaluate(f: RequeueFacts, args: RequeueArgs): RfpCliCheck[] {
  const table = args.outbox === "create" ? "rfp_core_create_outbox" : "rfp_core_followup_outbox";
  const checks: RfpCliCheck[] = [];
  checks.push({
    key: "row",
    ok: Boolean(f.row && f.create && f.command),
    detail: f.row
      ? `${table} row ${args.id}${args.outbox === "followup" ? ` (kind ${f.row.kind}${f.row.notice_kind ? `:${f.row.notice_kind}` : ""})` : ""}: status ${f.row.status}, attempts ${f.row.attempt_count}`
      : `no ${table} row ${args.id}`,
  });
  if (!f.row || !f.create || !f.command) return checks;
  checks.push({
    key: "destination",
    ok: f.command.destination === args.destination,
    detail: f.command.destination === args.destination
      ? `--destination ${args.destination} = the command row's stamp`
      : `--destination ${args.destination} ≠ the command row's stamp ${f.command.destination}`,
  });
  if (args.outbox === "followup") {
    const kind = String(f.row.kind);
    checks.push({
      key: "kind",
      ok: kind === "crm_link" || kind === "crm_notice",
      detail: kind === "core_confirm"
        ? "core_confirm (E5) never dead-letters (§7): it retries every 2 h by itself; nothing to requeue"
        : kind === "crm_link" || kind === "crm_notice" ? `kind ${kind}` : `kind ${kind} is not requeueable`,
    });
  }
  const status = String(f.row.status);
  checks.push({
    key: "status",
    ok: status === "dead",
    detail: status === "dead"
      ? "dead (its schedule is exhausted)"
      : status === "link_refused"
        ? "link_refused is never requeued: a person resolves it (§2)"
        : `status ${status} is not dead; only a dead row is requeued`,
  });
  return checks;
}

/** The testable main: (argv, deps) ⇒ the exit code and what it found / did. */
export async function runRequeueDead(argv: string[], deps: RfpCliDeps = {}): Promise<RfpCliResult> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const parsed = parseRequeueArgs(argv);
  if ("error" in parsed) {
    out(`rfp-requeue-dead: ${parsed.error}\n${REQUEUE_USAGE}`);
    return { code: 2, applied: false, refused: parsed.error, checks: [] };
  }
  const args = parsed;
  const db = await cliDb(deps);
  out(`requeue ${args.outbox} row ${args.id}, --destination ${args.destination} (${args.apply ? `APPLY, GO ${args.go}` : "dry-run"})`);
  const first = await readFacts(db, args);
  const checks = evaluate(first, args);
  printChecks(out, checks);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    const why = failed.map((c) => `(${c.key}) ${c.detail}`).join(" | ");
    out(`REFUSED: ${why}. Nothing written.`);
    return { code: 1, applied: false, refused: why, checks };
  }
  if (!args.apply) {
    out(`DRY-RUN: --apply --go <GO> would set row ${args.id} pending with S0's re-arm reset + ONE audit_logs row, then alert rfp_requeue_applied. Nothing written.`);
    return { code: 0, applied: false, checks };
  }

  const actor = args.actor;
  const osUser = cliOsUser(deps);
  const state: { refusal?: string; auditId?: number; before?: Record<string, unknown>; dealId?: string } = {};
  // The deal, for the per-deal lock (advisory first, rows after: the S0 / sender order).
  const dealId = String(first.create.source_deal_id);
  await db.transaction(async (tx: any) => {
    await lockRfpCreateDeal(tx, dealId);
    const facts = await readFacts(tx, args);
    const bad = evaluate(facts, args).filter((c) => !c.ok);
    if (bad.length > 0) {
      state.refusal = bad.map((c) => `(${c.key}) ${c.detail}`).join(" | ");
      return;
    }
    const before = { status: facts.row.status, attemptCount: facts.row.attempt_count, lastError: facts.row.last_error ?? null };
    if (args.outbox === "create") {
      await tx.execute(sql`
        UPDATE rfp_core_create_outbox SET ${coreCreateRearmSet(facts.row.project_number ?? null)}
         WHERE id = ${args.id} AND status = 'dead'
      `);
    } else {
      await tx.execute(sql`
        UPDATE rfp_core_followup_outbox SET ${coreFollowupRearmSet()}
         WHERE id = ${args.id} AND status = 'dead' AND kind IN ('crm_link', 'crm_notice')
      `);
    }
    state.before = before;
    state.dealId = dealId;
    state.auditId = await writeAuditInTx(tx, {
      action: "rfp_requeue_dead",
      entityType: args.outbox === "create" ? "rfp_core_create_outbox" : "rfp_core_followup_outbox",
      entityId: String(args.id),
      source: "rfp-requeue-dead",
      details: {
        actor,
        osUser,
        go: args.go,
        outbox: args.outbox,
        id: args.id,
        destination: args.destination,
        kind: args.outbox === "followup" ? facts.row.kind : "e2_create",
        sourceDealId: dealId,
        sourceEventId: facts.create.source_event_id,
        before,
        after: { status: "pending", attemptCount: 0, lastError: null },
      },
    });
  });
  if (state.refusal || state.auditId === undefined) {
    out(`APPLY REFUSED (re-checked under the per-deal lock): ${state.refusal ?? "unknown"}. Nothing written.`);
    return { code: 1, applied: false, refused: state.refusal ?? "unknown", checks };
  }
  await raiseRfpCoreAlert("rfp_requeue_applied", {
    go: args.go, actor, osUser, outbox: args.outbox, id: args.id, destination: args.destination, sourceDealId: dealId,
    before: state.before, auditId: state.auditId,
  });
  out(`APPLIED: ${args.outbox} row ${args.id} pending (S0 re-arm reset); audit_logs row ${state.auditId}.`);
  return { code: 0, applied: true, checks, rowId: args.id };
}
