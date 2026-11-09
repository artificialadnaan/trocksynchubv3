import { readFileSync } from "fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { is, SQL } from "drizzle-orm";
import { getTableConfig, PgDialect, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../shared/schema";

// S0b-2a (d9 + a4 ruling, 2026-11-09): SyncHub's migration run executes `npm run db:push` = `drizzle-kit push --force` with no
// tablesFilter (Dockerfile:69, package.json), which DROPS any table / column / index / constraint that shared/schema.ts does not
// declare. Every object 0027 creates must therefore be declared in schema.ts, byte-aligned with the SQL. This file applies the
// real migrations to a REAL postgres and compares what they create with drizzle's getTableConfig: columns (type, nullability,
// default), indexes (name, uniqueness) and CHECK / FK constraints (name). rfp_approval_requests is compared on its indexes and
// unique constraints only (its base table predates the hand-applied migrations; 0021's two partial indexes are included, since
// a forced push drops undeclared indexes too). A4 binds this file into every SyncHub merge-tip gate.
// REAL postgres (the runner's throwaway postgres:18, DATABASE_URL), one fresh database per run. LIVE=1 without DATABASE_URL FAILS
// here; it never skips.
const LIVE = process.env.LIVE === "1";
const BASE_URL = process.env.DATABASE_URL;
if (LIVE && !BASE_URL) throw new Error("LIVE=1 needs DATABASE_URL (a real postgres): refusing to skip the schema parity tests");

const migration = (file: string) => readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");

let admin: pg.Client;
let pool: pg.Pool;
const DB_NAME = `s0b2_parity_${process.pid}_${Date.now()}`;
const q = (text: string, params: unknown[] = []) => pool.query(text, params);

/** Teardown: pool.end() can resolve before the server has closed its sessions; DROP … WITH (FORCE) would then kill them and the
 *  late 57P01 surfaces as an unhandled error. Wait (bounded) until the database has no sessions first. */
async function waitNoSessions(name: string) {
  for (let i = 0; i < 100; i++) {
    const n = Number((await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1`, [name])).rows[0].n);
    if (n === 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}
beforeAll(async () => {
  if (!BASE_URL) return;
  admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  const url = new URL(BASE_URL);
  url.pathname = `/${DB_NAME}`;
  pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  pool.on("error", () => {});
  // The base tables as production has them before the hand-applied migrations: rfp_approval_requests as drizzle pushed it
  // (its token unique constraint carries drizzle's name), and the callback outbox 0023 alters.
  await q(`
    CREATE TABLE rfp_approval_requests (
      id serial PRIMARY KEY, source_system text NOT NULL DEFAULT 'hubspot', source_deal_id text NOT NULL, source_event_id text,
      project_number text, hubspot_deal_id text, token text NOT NULL, token_expires_at timestamp,
      status text NOT NULL DEFAULT 'pending', deal_data jsonb NOT NULL, edited_fields jsonb, approved_attachments jsonb,
      approved_by text, approved_at timestamp, declined_by text, declined_at timestamp, bidboard_project_id text,
      created_at timestamp DEFAULT now(),
      CONSTRAINT rfp_approval_requests_token_unique UNIQUE (token)
    );
    CREATE INDEX idx_rfp_approval_project_number ON rfp_approval_requests(project_number);
    CREATE TABLE bidboard_callback_outbox (
      id serial PRIMARY KEY, source_system text NOT NULL, source_deal_id text NOT NULL,
      rfp_approval_request_id integer NOT NULL, payload jsonb NOT NULL, target_url text NOT NULL,
      status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  for (const file of ["0021_extend_pending_unique_indexes_to_override_approving.sql", "0023_create_bidboard_create_outbox.sql", "0027_rfp_core_routing.sql"]) {
    await q(migration(file));
  }
}, 60000);
afterAll(async () => {
  if (!BASE_URL) return;
  await pool?.end();
  if (admin) await waitNoSessions(DB_NAME);
  await admin?.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await admin?.end();
});

type Col = { name: string; type: string; notNull: boolean; default: string | null };
const dialect = new PgDialect();

function drizzleTable(sqlName: string): PgTable | undefined {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable) && getTableConfig(value).name === sqlName) return value;
  }
  return undefined;
}
function normType(t: string): string {
  if (t === "serial") return "integer";
  if (t === "timestamp") return "timestamp without time zone";
  return t;
}
function normDbDefault(d: string | null): string | null {
  if (d == null) return null;
  if (d.startsWith("nextval(")) return "nextval";
  const quoted = d.match(/^'(.*)'::[a-z ]+$/);
  return quoted ? quoted[1] : d;
}
function drizzleColumns(table: PgTable): Col[] {
  return getTableConfig(table).columns
    .map((c: any) => ({
      name: c.name,
      type: normType(c.getSQLType()),
      notNull: c.columnType === "PgSerial" ? true : Boolean(c.notNull),
      default: c.columnType === "PgSerial" ? "nextval"
        : c.default === undefined ? null
        : is(c.default, SQL) ? dialect.sqlToQuery(c.default).sql
        : String(c.default),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
async function dbColumns(table: string): Promise<Col[]> {
  const r = await q(
    `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return r.rows
    .map((c) => ({ name: c.column_name, type: c.data_type, notNull: c.is_nullable === "NO", default: normDbDefault(c.column_default) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
function drizzleIndexes(table: PgTable): string[] {
  const cfg = getTableConfig(table);
  const out = cfg.indexes.map((i: any) => `${i.config.name}${i.config.unique ? " UNIQUE" : ""}`);
  for (const u of cfg.uniqueConstraints) out.push(`${u.getName()} UNIQUE`);
  for (const c of cfg.columns as any[]) if (c.isUnique) out.push(`${c.uniqueName} UNIQUE`);
  return out.sort();
}
async function dbIndexes(table: string): Promise<string[]> {
  const r = await q(
    `SELECT i.relname AS name, x.indisunique AS uniq FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
      WHERE t.oid = to_regclass($1) AND NOT x.indisprimary`,
    [`public.${table}`],
  );
  return r.rows.map((x) => `${x.name}${x.uniq ? " UNIQUE" : ""}`).sort();
}
function drizzleConstraints(table: PgTable): string[] {
  const cfg = getTableConfig(table);
  return [
    ...cfg.checks.map((c: any) => `CHECK ${c.name}`),
    ...cfg.foreignKeys.map((f: any) => `FK ${f.getName()}`),
  ].sort();
}
async function dbConstraints(table: string): Promise<string[]> {
  const r = await q(
    `SELECT conname, contype FROM pg_constraint WHERE conrelid = to_regclass($1) AND contype IN ('c', 'f')`,
    [`public.${table}`],
  );
  return r.rows.map((c) => `${c.contype === "c" ? "CHECK" : "FK"} ${c.conname}`).sort();
}

describe("schema.ts declares every object the hand-applied migrations create (drizzle-kit push --force drops the rest)", () => {
  for (const table of ["bidboard_create_outbox", "rfp_core_create_outbox", "rfp_core_followup_outbox", "rfp_approval_approving"]) {
    it(`${table}: same columns (type, nullability, default), indexes and CHECK / FK constraints`, async () => {
      const declared = drizzleTable(table);
      expect(declared, `shared/schema.ts declares no pgTable("${table}")`).toBeDefined();
      if (!declared) return;
      expect(drizzleColumns(declared)).toEqual(await dbColumns(table));
      expect(drizzleIndexes(declared)).toEqual(await dbIndexes(table));
      expect(drizzleConstraints(declared)).toEqual(await dbConstraints(table));
    });
  }
  it("rfp_approval_requests: every index and unique constraint (0021's two, the project-number index, the token unique, 0027's two wider ones) is declared", async () => {
    const declared = drizzleTable("rfp_approval_requests");
    expect(declared, `shared/schema.ts declares no pgTable("rfp_approval_requests")`).toBeDefined();
    if (!declared) return;
    expect(drizzleIndexes(declared)).toEqual(await dbIndexes("rfp_approval_requests"));
  });
  it("the comparison sees the migrations' objects (a guard on the harness itself)", async () => {
    expect((await dbColumns("rfp_core_create_outbox")).map((c) => c.name)).toContain("e2_ever_sent");
    expect((await dbColumns("bidboard_create_outbox")).map((c) => c.name)).toContain("destination");
    expect(await dbIndexes("rfp_approval_requests")).toContain("idx_rfp_approval_live_source_deal UNIQUE");
    expect(await dbConstraints("rfp_approval_approving")).toContain("FK rfp_approval_approving_request_id_rfp_approval_requests_id_fk");
  });
});
