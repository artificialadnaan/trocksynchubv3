/**
 * RFP Phase 2, S1b: the shared shape of the two one-deal / one-row operator CLIs (scripts/rfp-redrive-to-core.ts and
 * scripts/rfp-requeue-dead.ts), modelled on the S0b-2b resolver (scripts/rfp-resolve-approving.ts): the logic lives under
 * server/sync and takes (argv, deps); DRY-RUN by default, `--apply` writes; every check is printed; a refused run writes
 * nothing; an applied run writes its change + ONE audit_logs row in ONE transaction under the per-deal lock, then raises
 * ONE alert. Exit 0 = a dry-run whose checks all pass, or an applied change; 1 = refused; 2 = bad arguments.
 */
import os from "os";
import { sql } from "drizzle-orm";

export interface RfpCliCheck {
  key: string;
  ok: boolean;
  detail: string;
}

export interface RfpCliResult {
  code: 0 | 1 | 2;
  applied: boolean;
  refused?: string;
  checks: RfpCliCheck[];
  /** The row written (re-drive: the new rfp_core_create_outbox id) or flipped (requeue). */
  rowId?: number;
}

/** A drizzle database (node-postgres in production, PGlite in tests): `execute` + `transaction`. */
export type RfpCliDb = { execute: (q: any) => Promise<any>; transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T> };

export interface RfpCliDeps {
  /** Default: server/db's drizzle db. */
  db?: RfpCliDb;
  out?: (line: string) => void;
  /** Default: process.env. Only RFP_NONSERVICE_DESTINATION is read. */
  env?: NodeJS.ProcessEnv;
  /** The OS user running the process, recorded on the audit row beside the REQUIRED --actor (d9 Q3). Default: os.userInfo(). */
  osUser?: string;
  /** Reads an operator-supplied file (the re-drive's --approval-evidence JSON). Default: fs.promises.readFile(path, "utf8"). */
  readFile?: (path: string) => Promise<string>;
  /** The clock the evidence's decidedAt is checked against (d9, S1b r4). Default: the system clock. */
  now?: () => Date;
}

export async function cliDb(deps: RfpCliDeps): Promise<RfpCliDb> {
  return deps.db ?? ((await import("../db")).db as unknown as RfpCliDb);
}

export function cliOsUser(deps: RfpCliDeps): string {
  if (deps.osUser) return deps.osUser;
  try {
    return `os:${os.userInfo().username}`;
  } catch {
    return "os:unknown";
  }
}

/** --actor <name> (d9 Q3): REQUIRED, the person running it; trimmed, non-blank, one line, at most 200 characters. */
export function parseActorArg(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const actor = value.trim();
  if (actor === "" || actor.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(actor)) return null;
  return actor;
}

export function rowsOf(res: any): any[] {
  return Array.isArray(res) ? res : (res?.rows ?? []);
}

export function firstRow(res: any): any | undefined {
  return rowsOf(res)[0];
}

export function printChecks(out: (line: string) => void, checks: RfpCliCheck[]): void {
  for (const c of checks) out(`${c.ok ? "PASS" : "FAIL"} (${c.key}) ${c.detail}`);
}

/** The GO id as an a4 GO file names it: no spaces, no shell metacharacters. */
export const GO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/** ONE audit_logs row (shared/schema.ts auditLogs), inside the caller's transaction. Returns its id. */
export async function writeAuditInTx(
  tx: any,
  row: { action: string; entityType: string; entityId: string; source: string; details: Record<string, unknown> },
): Promise<number> {
  const inserted = firstRow(await tx.execute(sql`
    INSERT INTO audit_logs (action, entity_type, entity_id, source, status, details, category)
    VALUES (${row.action}, ${row.entityType}, ${row.entityId}, ${row.source}, 'success', ${JSON.stringify(row.details)}::jsonb, 'system')
    RETURNING id
  `));
  return Number(inserted.id);
}
