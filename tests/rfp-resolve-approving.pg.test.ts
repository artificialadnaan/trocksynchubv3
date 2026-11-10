import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

// S0b-2b (runbook r5 §3 + §5; d9 Q8 + the S0b-2b rulings QA / QB / QC): the reviewed resolver for a request STUCK in
// `approving` (server/sync/rfp-resolve-approving.ts, driven by scripts/rfp-resolve-approving.ts), plus what it needs from the
// approval path: the claim RECORDS the original approval's inputs and whether the pre-create steps succeeded (d9 QA (a)), so
// `recreate` can replay exactly them, create step only, under the lock (QA (b)), and refuses when they are not recorded (QA (c)).
//   - dry-run by default, exactly one --id; refuses a row that is not approving, younger than 30 min, or has no side-table row;
//   - read-only Procore checks on the STORED token (expired ⇒ error, never a refresh): (i) number, (ii) name, (iii) address /
//     client within started_at ± 2 h; every call + hit printed; a hit with no created time, or no address AND no client ⇒ error;
//   - found = exactly one by number and no different id from (ii) / (iii); a different id ⇒ ambiguous;
//   - recreate only on zero hits + submit_at NULL + no footprint elsewhere + inputs recorded + pre-create steps recorded;
//   - found finalises with NO Procore write; ambiguous / refused writes nothing; an apply writes one audit row and clears the alert.
// REAL postgres (the runner's throwaway postgres:18, DATABASE_URL), one fresh database per run. LIVE=1 without DATABASE_URL FAILS
// here; it never skips. The environment's DATABASE_URL points at an unroutable sentinel, so an un-mocked db import fails loudly.
// Synthetic data only (I7).
const LIVE = process.env.LIVE === "1";
const BASE_URL = process.env.DATABASE_URL;
if (LIVE && !BASE_URL) throw new Error("LIVE=1 needs DATABASE_URL (a real postgres): refusing to skip the S0b-2b resolver tests");
const SENTINEL_DATABASE_URL = "postgres://s0b2-real-db-must-not-be-used.invalid:5432/sentinel";
process.env.DATABASE_URL = SENTINEL_DATABASE_URL;

const dbHolder = vi.hoisted(() => ({ db: null as any, pool: null as any }));
const alertMock = vi.hoisted(() => vi.fn(async (_code: string, _detail: Record<string, unknown>) => {}));
const createMock = vi.hoisted(() => vi.fn(async (..._args: any[]): Promise<any> => ({ success: true, projectId: "900333" })));
const hubspotUpdateMock = vi.hoisted(() => vi.fn(async (..._args: any[]): Promise<any> => ({ success: true })));
const hubspotStageMock = vi.hoisted(() => vi.fn(async (..._args: any[]): Promise<any> => ({ success: true })));
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));
vi.mock("../server/db.ts", () => ({ get db() { return dbHolder.db; }, get pool() { return dbHolder.pool; } }));
vi.mock("../server/playwright/bidboard.ts", () => ({ createBidBoardProjectFromDeal: createMock }));
vi.mock("../server/hubspot.ts", () => ({
  getHubSpotClient: vi.fn(),
  getAccessToken: vi.fn(async () => "synthetic-token"),
  getDealOwnerInfo: vi.fn(async () => ({ ownerName: "", ownerEmail: "" })),
  updateHubSpotDeal: hubspotUpdateMock,
  updateHubSpotDealStage: hubspotStageMock,
  syncSingleHubSpotDeal: vi.fn(async () => undefined),
}));
vi.mock("../server/procore-hubspot-sync.ts", () => ({ resolveHubspotStageId: vi.fn(async () => ({ stageId: "s-1", stageName: "Estimating" })) }));
vi.mock("../server/email-service.ts", () => ({ sendEmail: vi.fn(async () => ({ success: true })), renderTemplate: vi.fn(), GLOBAL_CC_RECIPIENTS: [] }));
vi.mock("../server/lib/fetch-with-timeout.ts", () => ({ fetchWithTimeout: vi.fn(async () => new Response("", { status: 200 })) }));
vi.mock("../server/rfp-source-eligibility.ts", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  checkRfpApprovalSourceEligibility: vi.fn(async () => ({ eligible: true })),
  checkCrmDealEligibility: vi.fn(async () => ({ eligible: true })),
}));
vi.mock("../server/sync/bidboard-callback-worker.ts", () => ({
  buildBidBoardCreatedCallbackTargetUrl: () => "https://crm.example.test/api/internal/bid-board-created",
  buildRfpDeclinedCallbackTargetUrl: () => "https://crm.example.test/api/internal/rfp-declined",
}));
vi.mock("../server/sync/service-rfp-core-outbox.ts", () => ({ handOffServiceRfpApprovalToCore: vi.fn(async () => undefined) }));
vi.mock("../server/sync/rfp-core-alert.ts", () => ({ raiseRfpCoreAlert: alertMock }));

const { storage } = await import("../server/storage.ts");
const { processRfpApproval, finaliseApprovingFound, recreateApprovingRequest } = await import("../server/rfp-approval.ts");
const { parseResolveArgs, dryRunResolveApproving, applyResolveApproving } = await import("../server/sync/rfp-resolve-approving.ts");
const { runRfpApprovingStuckSweep, RFP_APPROVING_STUCK_KEY_PREFIX } = await import("../server/sync/rfp-approving-stuck.ts");

const migration = (file: string) => readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");
const BASE_DDL = `
  CREATE TABLE rfp_approval_requests (
    id serial PRIMARY KEY, source_system text NOT NULL DEFAULT 'hubspot', source_deal_id text NOT NULL, source_event_id text,
    project_number text, hubspot_deal_id text, token text NOT NULL, token_expires_at timestamp,
    status text NOT NULL DEFAULT 'pending', deal_data jsonb NOT NULL, edited_fields jsonb, approved_attachments jsonb,
    approved_by text, approved_at timestamp, declined_by text, declined_at timestamp, bidboard_project_id text,
    created_at timestamp DEFAULT now(),
    CONSTRAINT rfp_approval_requests_token_unique UNIQUE (token)
  );
  CREATE TABLE sync_mappings (
    id serial PRIMARY KEY, source_system text NOT NULL DEFAULT 'hubspot', source_deal_id text NOT NULL, hubspot_deal_id text,
    hubspot_company_id text, procore_project_id text, procore_company_id text, companycam_project_id text, hubspot_deal_name text,
    procore_project_name text, procore_project_number text, bidboard_project_id text, bidboard_project_name text,
    portfolio_project_id text, portfolio_project_name text, project_phase text DEFAULT 'bidboard', sent_to_portfolio_at timestamp,
    last_sync_at timestamp, last_sync_status text DEFAULT 'pending', last_sync_direction text, metadata jsonb,
    created_at timestamp DEFAULT now()
  );
  CREATE TABLE bidboard_callback_outbox (
    id serial PRIMARY KEY, source_system text NOT NULL, source_deal_id text NOT NULL, rfp_approval_request_id integer,
    payload jsonb NOT NULL, target_url text NOT NULL, status text NOT NULL DEFAULT 'pending',
    attempt_count integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 5, last_error text,
    last_attempt_at timestamp, next_attempt_at timestamp NOT NULL DEFAULT now(), created_at timestamp NOT NULL DEFAULT now(),
    sent_at timestamp
  );
  CREATE UNIQUE INDEX idx_bidboard_callback_outbox_rfp_request ON bidboard_callback_outbox(rfp_approval_request_id);
  CREATE TABLE audit_logs (
    id serial PRIMARY KEY, action text NOT NULL, entity_type text NOT NULL, entity_id text, source text NOT NULL,
    destination text, status text NOT NULL, details jsonb, error_message text, duration_ms integer, user_id varchar,
    idempotency_key text, category text NOT NULL DEFAULT 'system', created_at timestamp DEFAULT now()
  );
`;

let admin: pg.Client;
let pool: pg.Pool;
let tempDir = "";
const DB_NAME = `s0b2b_resolve_${process.pid}_${Date.now()}`;
const sql = (text: string, params: unknown[] = []) => pool.query(text, params);

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
  pool = new pg.Pool({ connectionString: url.toString(), max: 8 });
  pool.on("error", () => {});
  await sql(BASE_DDL);
  for (const file of ["0021_extend_pending_unique_indexes_to_override_approving.sql", "0023_create_bidboard_create_outbox.sql", "0027_rfp_core_routing.sql"]) {
    await sql(migration(file));
  }
  dbHolder.pool = pool;
  dbHolder.db = drizzle(pool);
  tempDir = mkdtempSync(join(tmpdir(), "s0b2b-resolve-"));
  process.env.TEMP_DIR = tempDir; // processRfpApproval stores uploaded attachments here until the create finishes
}, 60000);
afterAll(async () => {
  process.env.DATABASE_URL = BASE_URL; // the sentinel must not outlive this file in a reused worker
  delete process.env.TEMP_DIR;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  if (!BASE_URL) return;
  await pool?.end();
  if (admin) await waitNoSessions(DB_NAME);
  await admin?.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await admin?.end();
});

const send = vi.fn(async (_m: { to: string; subject: string; htmlBody: string }) => ({ success: true }));
const RECIPIENT = "ops-alerts@example.test";
beforeEach(async () => {
  if (!BASE_URL) return;
  await sql(`TRUNCATE rfp_core_followup_outbox, rfp_core_create_outbox, bidboard_create_outbox, bidboard_callback_outbox,
                      sync_mappings, audit_logs, rfp_approval_approving, rfp_approval_requests RESTART IDENTITY CASCADE`);
  await sql(`DROP TABLE IF EXISTS bidboard_crm_push_alert_state`);
  alertMock.mockReset();
  createMock.mockReset();
  createMock.mockResolvedValue({ success: true, projectId: "900333" });
  hubspotUpdateMock.mockReset();
  hubspotUpdateMock.mockResolvedValue({ success: true });
  hubspotStageMock.mockReset();
  hubspotStageMock.mockResolvedValue({ success: true });
  send.mockReset();
  send.mockResolvedValue({ success: true });
  vi.spyOn(storage, "createAuditLog").mockResolvedValue({} as any);
  vi.spyOn(storage, "getAutomationConfig").mockResolvedValue({ value: { companyId: "42" } } as any);
  process.env.TROCK_CRM_BASE_URL = "https://crm.example.test";
  process.env.RFP_REQUEST_SYNC_SECRET = "synthetic-secret";
});

const DEAL = "00000000-0000-4000-8000-0000000008b1";
const HS_DEAL = "910000009";
const NUMBER = "DFW-2-80001-ab";
const NAME = "Synthetic Resolve Deal";
const ADDRESS = "100 Synthetic Way";
const CLIENT = "Synthetic Client LLC";
const APPROVER = "approver@example.test";
const RECORDED = {
  approved_by: APPROVER,
  edited_fields: { dealname: NAME },
  approved_attachments: { override: null },
  force: false,
};
let tokenSeq = 0;

/** A request (default: `approving`, started 90 min ago, submit_at NULL, inputs + pre-create steps recorded). */
async function seed(o: {
  status?: string;
  minutesAgo?: number | null;
  submitted?: boolean;
  recorded?: Partial<Record<keyof typeof RECORDED, unknown>> | null;
  hubspotDone?: boolean;
  dealData?: Record<string, unknown>;
  system?: "trock_crm" | "hubspot";
} = {}) {
  const token = `synthetic-resolve-token-${++tokenSeq}`;
  const dealData = o.dealData ?? { dealname: NAME, project_number: NUMBER, project_types: "2", address: ADDRESS, company_name: CLIENT };
  const system = o.system ?? "trock_crm";
  const deal = system === "hubspot" ? HS_DEAL : DEAL;
  const r = await sql(
    `INSERT INTO rfp_approval_requests (source_system, source_deal_id, project_number, hubspot_deal_id, token, token_expires_at, status, deal_data)
     VALUES ($1, $2, $3, $4, $5, now() + interval '7 days', $6, $7::jsonb) RETURNING id`,
    [system, deal, NUMBER, system === "hubspot" ? deal : null, token, o.status ?? "approving", JSON.stringify(dealData)],
  );
  const id = r.rows[0].id as number;
  const minutesAgo = o.minutesAgo === undefined ? 90 : o.minutesAgo;
  if (minutesAgo !== null) {
    const rec = o.recorded === null ? { approved_by: null, edited_fields: null, approved_attachments: null, force: null } : { ...RECORDED, ...(o.recorded ?? {}) };
    await sql(
      `INSERT INTO rfp_approval_approving (request_id, started_at, submit_at, approved_by, edited_fields, approved_attachments, force, hubspot_done_at)
       VALUES ($1, now() - make_interval(mins => $2), CASE WHEN $3 THEN now() - make_interval(mins => $2 - 1) END, $4, $5::jsonb, $6::jsonb, $7,
               CASE WHEN $8 THEN now() - make_interval(mins => $2 + 1) END)`,
      [id, minutesAgo, o.submitted ?? false, rec.approved_by,
        rec.edited_fields == null ? null : JSON.stringify(rec.edited_fields),
        rec.approved_attachments == null ? null : JSON.stringify(rec.approved_attachments), rec.force, o.hubspotDone ?? true],
    );
  }
  return { id, token };
}

type Hit = { id: number; project_number?: string | null; name?: string | null; created_at?: string | null };
/** A read-only Procore stub: the projects search answers by its filters[search] term; every call is recorded. */
function procoreStub(byTerm: Record<string, Hit[]>, o: { failTerm?: string } = {}) {
  const calls: string[] = [];
  const tokens: string[] = [];
  const get = vi.fn(async (url: string, accessToken: string) => {
    calls.push(url);
    tokens.push(accessToken);
    const term = new URL(url).searchParams.get("filters[search]") ?? "";
    if (o.failTerm !== undefined && term === o.failTerm) return { status: 500, data: { error: "synthetic" } };
    return { status: 200, data: byTerm[term] ?? [] };
  });
  return { get, calls, tokens };
}
function deps(procore: ReturnType<typeof procoreStub>, o: { token?: { accessToken: string | null; expiresAt: Date | null } | undefined } = {}) {
  const lines: string[] = [];
  const token = "token" in o ? o.token : { accessToken: "synthetic-procore-token", expiresAt: new Date(Date.now() + 60 * 60_000) };
  return {
    lines,
    d: {
      db: pool,
      readStoredToken: vi.fn(async () => token),
      procoreGet: procore.get,
      procoreBaseUrl: "https://procore.example.test",
      companyId: "42",
      out: (line: string) => lines.push(line),
      finaliseFound: finaliseApprovingFound,
      recreate: recreateApprovingRequest,
      alert: { recipient: RECIPIENT, send },
    },
  };
}
const terms = (calls: string[]) => calls.map((u) => new URL(u).searchParams.get("filters[search]"));
/** Everything a resolve may write, as one comparable snapshot. */
async function writable() {
  const q = async (t: string) => (await sql(t)).rows;
  return {
    requests: await q(`SELECT id, status, bidboard_project_id, approved_by FROM rfp_approval_requests ORDER BY id`),
    approving: await q(`SELECT request_id, submit_at FROM rfp_approval_approving ORDER BY request_id`),
    mappings: await q(`SELECT source_deal_id, bidboard_project_id FROM sync_mappings ORDER BY id`),
    callbacks: await q(`SELECT rfp_approval_request_id, payload FROM bidboard_callback_outbox ORDER BY id`),
    audit: await q(`SELECT action FROM audit_logs ORDER BY id`),
  };
}
/** An ISO instant `minutes` after the request's started_at. Computed in SQL (the column is a UTC wall-clock `timestamp`), so the
 *  runner's Node time zone can't shift the ± 2 h window. */
const inWindow = async (id: number, minutes = 5) =>
  new Date(Number((await sql(`SELECT (extract(epoch FROM started_at) * 1000)::bigint + $2::bigint * 60000 AS ms FROM rfp_approval_approving WHERE request_id = $1`, [id, minutes])).rows[0].ms)).toISOString();

describe("parseResolveArgs: dry-run by default, exactly one --id", () => {
  it("--id alone ⇒ a dry-run", () => {
    expect(parseResolveArgs(["--id", "7"])).toEqual({ id: 7, apply: false });
  });
  it("--apply needs --resolution; found needs --project", () => {
    expect(parseResolveArgs(["--id", "7", "--apply", "--resolution", "found", "--project", "900222"])).toEqual({ id: 7, apply: true, resolution: "found", project: "900222" });
    expect(parseResolveArgs(["--id", "7", "--apply", "--resolution", "recreate"])).toEqual({ id: 7, apply: true, resolution: "recreate" });
  });
  for (const argv of [
    [],
    ["--id"],
    ["--id", "x"],
    ["--id", "7", "--id", "8"],
    ["--id", "7", "--apply"],
    ["--id", "7", "--apply", "--resolution", "found"],
    ["--id", "7", "--apply", "--resolution", "recreate", "--project", "900222"],
    ["--id", "7", "--apply", "--resolution", "reset"],
    ["--id", "7", "--force"],
  ]) {
    it(`refuses ${JSON.stringify(argv)}`, () => {
      expect(parseResolveArgs(argv)).toEqual({ error: expect.any(String) });
    });
  }
});

describe.skipIf(!BASE_URL)("dry-run refusals: only an approving row older than 30 min, proven by its side-table row", () => {
  for (const [label, o, reason] of [
    ["a pending row", { status: "pending" }, /approving/],
    ["an approving row 20 min old", { minutesAgo: 20 }, /30 min/],
    ["an approving row with no rfp_approval_approving row (age unknown; d9 QB)", { minutesAgo: null }, /age/],
  ] as const) {
    it(`${label} ⇒ refused before any Procore call; nothing written`, async () => {
      const { id } = await seed(o as any);
      const procore = procoreStub({});
      const { d } = deps(procore);
      const before = await writable();
      const report = await dryRunResolveApproving(id, d as any);
      expect(report.refused ?? "").toMatch(reason);
      expect(report.decision).toBe("C_stop");
      expect(procore.get).not.toHaveBeenCalled();
      expect(await writable()).toEqual(before);
    });
  }
});

describe.skipIf(!BASE_URL)("dry-run Procore checks (read-only, stored token, every call and hit printed)", () => {
  it("one project by number, the same id by name and address ⇒ found (A); the four searches are number, name, address, client", async () => {
    const { id } = await seed();
    const hit = { id: 900222, project_number: NUMBER, name: NAME, created_at: await inWindow(id) };
    const procore = procoreStub({ [NUMBER]: [hit], [NAME]: [hit], [ADDRESS]: [hit] });
    const { d, lines } = deps(procore);
    const report = await dryRunResolveApproving(id, d as any);
    expect(report).toMatchObject({ verdict: "found", decision: "A_found", foundProjectId: "900222" });
    expect(terms(procore.calls)).toEqual([NUMBER, NAME, ADDRESS, CLIENT]);
    expect(procore.tokens).toEqual(Array(4).fill("synthetic-procore-token"));
    expect(report.procoreCalls).toHaveLength(4);
    const printed = lines.join("\n");
    for (const call of report.procoreCalls) expect(printed).toContain(call);
    expect(printed).toContain("900222");
    expect(printed).toContain(hit.created_at);
    expect(printed).toMatch(/submit_at: NULL/);
  });

  it("a number match plus a DIFFERENT id by name ⇒ ambiguous (C), never found", async () => {
    const { id } = await seed();
    const created = await inWindow(id);
    const procore = procoreStub({
      [NUMBER]: [{ id: 900222, project_number: NUMBER, name: NAME, created_at: created }],
      [NAME]: [{ id: 900223, project_number: "DFW-2-80009-zz", name: NAME, created_at: created }],
    });
    const report = await dryRunResolveApproving(id, deps(procore).d as any);
    expect(report).toMatchObject({ verdict: "ambiguous", decision: "C_stop" });
    expect(report.foundProjectId).toBeUndefined();
  });

  it("a different id by address INSIDE started_at ± 2 h ⇒ ambiguous; the same different id created 6 h earlier is outside the window ⇒ found", async () => {
    const { id } = await seed();
    const number = [{ id: 900222, project_number: NUMBER, name: NAME, created_at: await inWindow(id) }];
    const near = procoreStub({ [NUMBER]: number, [ADDRESS]: [{ id: 900224, project_number: null, name: "Other", created_at: await inWindow(id, 60) }] });
    expect((await dryRunResolveApproving(id, deps(near).d as any)).verdict).toBe("ambiguous");
    const far = procoreStub({ [NUMBER]: number, [ADDRESS]: [{ id: 900224, project_number: null, name: "Other", created_at: await inWindow(id, -360) }] });
    expect((await dryRunResolveApproving(id, deps(far).d as any)).verdict).toBe("found");
  });

  it("two projects with the number ⇒ ambiguous", async () => {
    const { id } = await seed();
    const created = await inWindow(id);
    const procore = procoreStub({ [NUMBER]: [
      { id: 900222, project_number: NUMBER, name: NAME, created_at: created },
      { id: 900225, project_number: NUMBER, name: NAME, created_at: created },
    ] });
    expect((await dryRunResolveApproving(id, deps(procore).d as any)).verdict).toBe("ambiguous");
  });

  it("zero hits + submit_at NULL + no footprint + inputs and pre-create steps recorded ⇒ not_found_no_submit (B); field names printed, no values", async () => {
    const { id } = await seed();
    const { d, lines } = deps(procoreStub({}));
    const report = await dryRunResolveApproving(id, d as any);
    expect(report).toMatchObject({ verdict: "not_found_no_submit", decision: "B_recreate", footprint: [], preCreateStepsRecorded: true });
    expect(report.recordedInputs).toEqual(["approved_by", "edited_fields", "approved_attachments", "force"]);
    const printed = lines.join("\n");
    expect(printed).toMatch(/pre-create steps: recorded/);
    expect(printed).toContain("approved_by");
    expect(printed).not.toContain(APPROVER);
  });

  it("zero hits but submit_at SET ⇒ not_found_after_submit (C)", async () => {
    const { id } = await seed({ submitted: true });
    expect(await dryRunResolveApproving(id, deps(procoreStub({})).d as any)).toMatchObject({ verdict: "not_found_after_submit", decision: "C_stop" });
  });

  it("an address / client hit with no created time ⇒ (iii) error (C), never an empty result", async () => {
    const { id } = await seed();
    const procore = procoreStub({ [CLIENT]: [{ id: 900226, project_number: null, name: "Other", created_at: null }] });
    expect(await dryRunResolveApproving(id, deps(procore).d as any)).toMatchObject({ verdict: "error", decision: "C_stop" });
  });

  it("no address AND no client on the deal ⇒ (iii) error (C) (d9 QC)", async () => {
    const { id } = await seed({ dealData: { dealname: NAME, project_number: NUMBER, project_types: "2" } });
    expect(await dryRunResolveApproving(id, deps(procoreStub({})).d as any)).toMatchObject({ verdict: "error", decision: "C_stop" });
  });

  it("a Procore search that fails ⇒ error (C)", async () => {
    const { id } = await seed();
    expect(await dryRunResolveApproving(id, deps(procoreStub({}, { failTerm: NAME })).d as any)).toMatchObject({ verdict: "error", decision: "C_stop" });
  });

  for (const [label, token] of [
    ["an EXPIRED stored token", { accessToken: "synthetic-procore-token", expiresAt: new Date(Date.now() - 60_000) }],
    ["no stored token", undefined],
  ] as const) {
    it(`${label} ⇒ error before any Procore call (it never refreshes)`, async () => {
      const { id } = await seed();
      const procore = procoreStub({});
      const { d, lines } = deps(procore, { token: token as any });
      const report = await dryRunResolveApproving(id, d as any);
      expect(report).toMatchObject({ verdict: "error", decision: "C_stop" });
      expect(procore.get).not.toHaveBeenCalled();
      expect(lines.join("\n")).toMatch(/token/i);
    });
  }

  it("the resolver never reaches a refreshing token path (no getAccessToken / getProcoreClient / refresh in its source)", () => {
    for (const file of ["../server/sync/rfp-resolve-approving.ts", "../scripts/rfp-resolve-approving.ts"]) {
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(src).not.toMatch(/getAccessToken|getProcoreClient|refreshAccessToken|refresh_token|oauth\/token/);
    }
    const script = readFileSync(new URL("../scripts/rfp-resolve-approving.ts", import.meta.url), "utf8");
    expect(script).toMatch(/parseResolveArgs/);
    expect(script).toMatch(/applyResolveApproving|dryRunResolveApproving/);
    expect(script).toMatch(/getOAuthToken\("procore"\)/);
  });
});

describe.skipIf(!BASE_URL)("dry-run: recreate needs no footprint elsewhere, the inputs recorded and the pre-create steps recorded", () => {
  it("a sync mapping for the deal ⇒ C", async () => {
    const { id } = await seed();
    await sql(`INSERT INTO sync_mappings (source_system, source_deal_id, bidboard_project_id) VALUES ('trock_crm', $1, '900227')`, [DEAL]);
    const report = await dryRunResolveApproving(id, deps(procoreStub({})).d as any);
    expect(report.footprint).toContain("sync_mapping");
    expect(report.decision).toBe("C_stop");
  });

  it("a bidboard_create_outbox row for the deal ⇒ C", async () => {
    const { id } = await seed();
    await sql(
      `INSERT INTO bidboard_create_outbox (source_system, source_deal_id, source_event_id, project_number, payload, status, destination)
       VALUES ('trock_crm', $1, 'synthetic-evt-1', $2, '{}'::jsonb, 'pending', 'procore')`,
      [DEAL, NUMBER],
    );
    const report = await dryRunResolveApproving(id, deps(procoreStub({})).d as any);
    expect(report.footprint.length).toBeGreaterThan(0);
    expect(report.decision).toBe("C_stop");
  });

  it("a Core row for the deal ⇒ C", async () => {
    const { id } = await seed();
    const cmd = await sql(
      `INSERT INTO bidboard_create_outbox (source_system, source_deal_id, source_event_id, project_number, payload, status, destination)
       VALUES ('trock_crm', $1, 'synthetic-evt-2', $2, '{}'::jsonb, 'routed_core', 'core') RETURNING id`,
      [DEAL, NUMBER],
    );
    await sql(
      `INSERT INTO rfp_core_create_outbox (command_id, source_system, source_deal_id, source_event_id, project_number, status, e2_ever_sent)
       VALUES ($1, 'trock_crm', $2, 'synthetic-evt-2', $3, 'sent', true)`,
      [cmd.rows[0].id, DEAL, NUMBER],
    );
    const report = await dryRunResolveApproving(id, deps(procoreStub({})).d as any);
    expect(report.footprint).toContain("core:sent");
    expect(report.decision).toBe("C_stop");
  });

  it("the original approval's inputs NOT recorded ⇒ C, printed as 'original approval inputs not recorded' (d9 QA (c))", async () => {
    const { id } = await seed({ recorded: null });
    const { d, lines } = deps(procoreStub({}));
    const report = await dryRunResolveApproving(id, d as any);
    expect(report.recordedInputs).toEqual([]);
    expect(report.decision).toBe("C_stop");
    expect(lines.join("\n")).toMatch(/original approval inputs not recorded/);
  });

  it("the pre-create steps NOT recorded (hubspot_done_at NULL) ⇒ C, printed as 'pre-create steps: not recorded' (d9 QA (b))", async () => {
    const { id } = await seed({ hubspotDone: false });
    const { d, lines } = deps(procoreStub({}));
    const report = await dryRunResolveApproving(id, d as any);
    expect(report).toMatchObject({ preCreateStepsRecorded: false, decision: "C_stop" });
    expect(lines.join("\n")).toMatch(/pre-create steps: not recorded/);
  });

  it("a dry-run writes nothing", async () => {
    const { id } = await seed();
    const before = await writable();
    await dryRunResolveApproving(id, deps(procoreStub({})).d as any);
    expect(await writable()).toEqual(before);
  });
});

describe.skipIf(!BASE_URL)("--apply", () => {
  it("found: approved + bidboard_project_id, the sync mapping and the created callback; NO Procore write, no create; one audit row; the alert clears", async () => {
    const { id } = await seed();
    await runRfpApprovingStuckSweep({ db: pool, recipient: RECIPIENT, send });
    expect(send).toHaveBeenCalledTimes(1);
    const hit = { id: 900222, project_number: NUMBER, name: NAME, created_at: await inWindow(id) };
    const procore = procoreStub({ [NUMBER]: [hit] });
    const res = await applyResolveApproving({ id, apply: true, resolution: "found", project: "900222" }, deps(procore).d as any);
    expect(res.applied).toBe(true);
    const after = await writable();
    expect(after.requests).toEqual([{ id, status: "approved", bidboard_project_id: "900222", approved_by: APPROVER }]);
    expect(after.mappings).toEqual([{ source_deal_id: DEAL, bidboard_project_id: "900222" }]);
    expect(after.callbacks).toEqual([{ rfp_approval_request_id: id, payload: expect.objectContaining({ status: "created", bidboardProjectId: "900222" }) }]);
    expect(after.audit).toEqual([{ action: "rfp_resolve_approving" }]);
    expect(createMock).not.toHaveBeenCalled();
    expect(terms(procore.calls)).toEqual([NUMBER, NAME, ADDRESS, CLIENT]);
    expect(procore.calls.every((u) => new URL(u).pathname === "/rest/v1.1/companies/42/projects")).toBe(true);
    expect((await sql(`SELECT state FROM bidboard_crm_push_alert_state WHERE office_slug = $1`, [`${RFP_APPROVING_STUCK_KEY_PREFIX}${id}`])).rows[0]?.state).toBe("ok");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("found with a --project that is NOT the one the checks found ⇒ refused, nothing written", async () => {
    const { id } = await seed();
    const procore = procoreStub({ [NUMBER]: [{ id: 900222, project_number: NUMBER, name: NAME, created_at: await inWindow(id) }] });
    const { d } = deps(procore);
    expect((await dryRunResolveApproving(id, d as any)).verdict).toBe("found");
    const before = await writable();
    const res = await applyResolveApproving({ id, apply: true, resolution: "found", project: "900299" }, d as any);
    expect(res).toMatchObject({ applied: false, refused: expect.any(String) });
    expect(await writable()).toEqual(before);
  });

  it("ambiguous ⇒ found and recreate are both refused; nothing written", async () => {
    const { id } = await seed();
    const created = await inWindow(id);
    const procore = procoreStub({
      [NUMBER]: [{ id: 900222, project_number: NUMBER, name: NAME, created_at: created }],
      [NAME]: [{ id: 900223, project_number: null, name: NAME, created_at: created }],
    });
    const { d } = deps(procore);
    expect((await dryRunResolveApproving(id, d as any)).verdict).toBe("ambiguous");
    const before = await writable();
    for (const args of [{ id, apply: true, resolution: "found" as const, project: "900222" }, { id, apply: true, resolution: "recreate" as const }]) {
      const res = await applyResolveApproving(args, d as any);
      expect(res).toMatchObject({ applied: false, refused: expect.any(String) });
    }
    expect(await writable()).toEqual(before);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("recreate (B), HubSpot-sourced: ONE create with exactly the recorded inputs and NO HubSpot write (create step only); the row ends approved; one audit row", async () => {
    const { id } = await seed({ system: "hubspot", recorded: { edited_fields: { dealname: "Synthetic Resolve Deal (edited)" } } });
    const res = await applyResolveApproving({ id, apply: true, resolution: "recreate" }, deps(procoreStub({})).d as any);
    expect(res.applied).toBe(true);
    expect(createMock).toHaveBeenCalledTimes(1);
    const args = createMock.mock.calls[0][0];
    expect(args).toMatchObject({ sourceSystem: "hubspot", sourceDealId: HS_DEAL });
    expect(args.options.editedFieldsOverride).toMatchObject({ dealname: "Synthetic Resolve Deal (edited)" });
    expect(hubspotUpdateMock).not.toHaveBeenCalled();
    expect(hubspotStageMock).not.toHaveBeenCalled();
    const after = await writable();
    expect(after.requests).toEqual([{ id, status: "approved", bidboard_project_id: "900333", approved_by: APPROVER }]);
    expect(after.audit).toEqual([{ action: "rfp_resolve_approving" }]);
  });

  it("recreate when the checks say C (submit_at set) ⇒ refused: no create, nothing written", async () => {
    const { id } = await seed({ submitted: true });
    const before = await writable();
    const res = await applyResolveApproving({ id, apply: true, resolution: "recreate" }, deps(procoreStub({})).d as any);
    expect(res).toMatchObject({ applied: false, refused: expect.any(String) });
    expect(createMock).not.toHaveBeenCalled();
    expect(await writable()).toEqual(before);
  });
});

describe.skipIf(!BASE_URL)("recreateApprovingRequest guards (the create step under the lock; d9 QA (b) / (c))", () => {
  it("the inputs not recorded ⇒ refused 'original approval inputs not recorded'; no create; the row stays approving", async () => {
    const { id } = await seed({ recorded: { approved_by: null } });
    const res = await recreateApprovingRequest(id);
    expect(res).toMatchObject({ success: false, error: expect.stringMatching(/original approval inputs not recorded/) });
    expect(createMock).not.toHaveBeenCalled();
    expect((await writable()).requests[0].status).toBe("approving");
  });

  it("hubspot_done_at NULL ⇒ refused; no create", async () => {
    const { id } = await seed({ hubspotDone: false });
    expect(await recreateApprovingRequest(id)).toMatchObject({ success: false, error: expect.stringMatching(/pre-create steps/) });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("a recorded UPLOADED attachment (its bytes are gone) ⇒ refused; no create", async () => {
    const { id } = await seed({ recorded: { approved_attachments: { override: [{ name: "synthetic-upload.pdf", _new: true }] } } });
    expect(await recreateApprovingRequest(id)).toMatchObject({ success: false, error: expect.stringMatching(/uploaded attachment/) });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("a Procore footprint that appeared after the dry-run (a sync mapping) ⇒ refused under the lock; no create", async () => {
    const { id } = await seed();
    await sql(`INSERT INTO sync_mappings (source_system, source_deal_id, bidboard_project_id) VALUES ('trock_crm', $1, '900228')`, [DEAL]);
    expect(await recreateApprovingRequest(id)).toMatchObject({ success: false, error: expect.stringMatching(/footprint/) });
    expect(createMock).not.toHaveBeenCalled();
    expect((await writable()).requests[0].status).toBe("approving");
  });

  it("a Core footprint ⇒ no create; the request is held_cross_destination (as on the normal path)", async () => {
    const { id } = await seed();
    const cmd = await sql(
      `INSERT INTO bidboard_create_outbox (source_system, source_deal_id, source_event_id, project_number, payload, status, destination)
       VALUES ('trock_crm', $1, 'synthetic-evt-3', $2, '{}'::jsonb, 'routed_core', 'core') RETURNING id`,
      [DEAL, NUMBER],
    );
    await sql(
      `INSERT INTO rfp_core_create_outbox (command_id, source_system, source_deal_id, source_event_id, project_number, status, e2_ever_sent)
       VALUES ($1, 'trock_crm', $2, 'synthetic-evt-3', $3, 'sent', true)`,
      [cmd.rows[0].id, DEAL, NUMBER],
    );
    expect((await recreateApprovingRequest(id)).success).toBe(false);
    expect(createMock).not.toHaveBeenCalled();
    expect((await writable()).requests[0].status).toBe("held_cross_destination");
  });
});

describe.skipIf(!BASE_URL)("processRfpApproval records the original approval's inputs with the claim (d9 QA (a))", () => {
  const sideRow = async (id: number) =>
    (await sql(`SELECT approved_by, edited_fields, approved_attachments, force, hubspot_done_at IS NOT NULL AS hubspot_done FROM rfp_approval_approving WHERE request_id = $1`, [id])).rows[0];

  it("email path: approved_by, edited_fields, approved_attachments {override:null}, force false and hubspot_done_at are set by the time the create starts", async () => {
    const { id, token } = await seed({ status: "pending", minutesAgo: null, dealData: { dealname: NAME, project_number: NUMBER, project_types: "2" } });
    let seen: any;
    createMock.mockImplementationOnce(async () => {
      seen = await sideRow(id);
      return { success: true, projectId: "900334" };
    });
    await processRfpApproval(token, { dealname: "Synthetic Resolve Deal (edited)" }, APPROVER);
    expect(seen).toEqual({
      approved_by: APPROVER,
      edited_fields: { dealname: "Synthetic Resolve Deal (edited)" },
      approved_attachments: { override: null },
      force: false,
      hubspot_done: true,
    });
  });

  it("an attachments override is recorded by name / url, an uploaded file as _new (no bytes)", async () => {
    const { id, token } = await seed({ status: "pending", minutesAgo: null, dealData: { dealname: NAME, project_number: NUMBER, project_types: "2" } });
    let seen: any;
    createMock.mockImplementationOnce(async () => {
      seen = await sideRow(id);
      return { success: true, projectId: "900335" };
    });
    await processRfpApproval(token, {}, APPROVER, {
      attachmentsOverride: [{ name: "synthetic-a.pdf", url: "https://files.example.test/synthetic-a.pdf" }] as any,
      newFiles: [{ originalname: "synthetic-new.pdf", buffer: Buffer.from("synthetic"), mimetype: "application/pdf", size: 9 }] as any,
    });
    expect(seen?.approved_attachments).toEqual({
      override: [
        { name: "synthetic-a.pdf", url: "https://files.example.test/synthetic-a.pdf", _new: false },
        { name: "synthetic-new.pdf", _new: true },
      ],
    });
  });

  it("a HubSpot field update that FAILS ⇒ hubspot_done_at stays NULL (recreate will refuse); the create itself proceeds as today", async () => {
    const r = await sql(
      `INSERT INTO rfp_approval_requests (source_system, source_deal_id, project_number, hubspot_deal_id, token, token_expires_at, status, deal_data)
       VALUES ('hubspot', '910000008', $1, '910000008', 'synthetic-resolve-hs-token', now() + interval '7 days', 'pending', $2::jsonb) RETURNING id`,
      [NUMBER, JSON.stringify({ dealname: NAME, project_number: NUMBER, project_types: "2" })],
    );
    const id = r.rows[0].id as number;
    hubspotUpdateMock.mockResolvedValue({ success: false, message: "synthetic failure" });
    let seen: any;
    createMock.mockImplementationOnce(async () => {
      seen = await sideRow(id);
      return { success: true, projectId: "900336" };
    });
    await processRfpApproval("synthetic-resolve-hs-token", { dealname: "Synthetic Resolve Deal (edited)" }, APPROVER);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(seen).toMatchObject({ approved_by: APPROVER, hubspot_done: false });
  });

  it("override path (force): force true is recorded", async () => {
    const { id, token } = await seed({ status: "override_approving", minutesAgo: null, dealData: { dealname: NAME, project_number: NUMBER, project_types: "2" } });
    let seen: any;
    createMock.mockImplementationOnce(async () => {
      seen = await sideRow(id);
      return { success: true, projectId: "900337" };
    });
    await processRfpApproval(token, {}, APPROVER, { force: true });
    expect(seen).toMatchObject({ approved_by: APPROVER, force: true });
  });
});

// S0b-2b red 2 (d9 QC ruling, 2026-11-10): recreate never renews the Procore token, not even through the server's locked
// path. It refuses unless the STORED token outlives the create step: its 30 min bound (an approving row older than that reads
// as stuck) + 5 min, never under 15 min. A short token means wait for the server's own renewal, then retry.
const { RECREATE_MIN_TOKEN_MS } = await import("../server/sync/rfp-resolve-approving.ts");
const { fetchWithTimeout: fetchMock } = await import("../server/lib/fetch-with-timeout.ts");
/** Token renewals reach Procore's oauth/token endpoint through fetchWithTimeout (mocked above): count them. */
const renewCalls = () => vi.mocked(fetchMock).mock.calls.filter(([u]) => String(u).includes("oauth/token")).length;
const tokenLeft = (ms: number) => ({ token: { accessToken: "synthetic-procore-token", expiresAt: new Date(Date.now() + ms) } });

describe.skipIf(!BASE_URL)("recreate needs a stored token that outlives the create step (d9 QC: never renew)", () => {
  it("the threshold is the create step's 30 min bound + 5 min, and never under 15 min", () => {
    expect(RECREATE_MIN_TOKEN_MS).toBe(35 * 60_000);
    expect(RECREATE_MIN_TOKEN_MS).toBeGreaterThanOrEqual(15 * 60_000);
  });

  it("below the threshold ⇒ refused 'token too short to recreate without refresh': no create, nothing written, 0 renewals", async () => {
    const { id } = await seed({ system: "hubspot" });
    const before = await writable();
    const renewalsBefore = renewCalls();
    const res = await applyResolveApproving({ id, apply: true, resolution: "recreate" }, deps(procoreStub({}), tokenLeft(20 * 60_000)).d as any);
    expect(res).toMatchObject({ applied: false, refused: expect.stringMatching(/token too short to recreate without refresh/) });
    expect(createMock).not.toHaveBeenCalled();
    expect(await writable()).toEqual(before);
    expect(renewCalls()).toBe(renewalsBefore);
  });

  it("above the threshold ⇒ recreate proceeds: ONE create, the row ends approved, 0 renewals", async () => {
    const { id } = await seed({ system: "hubspot" });
    const renewalsBefore = renewCalls();
    const res = await applyResolveApproving({ id, apply: true, resolution: "recreate" }, deps(procoreStub({}), tokenLeft(40 * 60_000)).d as any);
    expect(res.applied).toBe(true);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect((await writable()).requests).toEqual([{ id, status: "approved", bidboard_project_id: "900333", approved_by: APPROVER }]);
    expect(renewCalls()).toBe(renewalsBefore);
  });

  it("the dry-run prints the minutes left on the stored token, never the token itself", async () => {
    const { id } = await seed();
    const { d, lines } = deps(procoreStub({}), tokenLeft(20 * 60_000));
    await dryRunResolveApproving(id, d as any);
    const printed = lines.join("\n");
    expect(printed).toMatch(/Procore token: (19|20) min left/);
    expect(printed).not.toContain("synthetic-procore-token");
  });

  it("source pin: the recreate path calls no renewal function, and the resolver refuses a short token before it", () => {
    const approval = readFileSync(new URL("../server/rfp-approval.ts", import.meta.url), "utf8");
    const start = approval.indexOf("export async function recreateApprovingRequest");
    expect(start).toBeGreaterThan(-1);
    const end = approval.indexOf("\nexport ", start + 1);
    const body = approval.slice(start, end === -1 ? undefined : end);
    expect(body).not.toMatch(/getAccessToken|getProcoreClient|refreshAccessToken|refresh_token|oauth\/token/);
    const resolver = readFileSync(new URL("../server/sync/rfp-resolve-approving.ts", import.meta.url), "utf8");
    const recreateBranch = resolver.slice(resolver.indexOf('args.resolution === "recreate"'));
    expect(recreateBranch.indexOf("RECREATE_MIN_TOKEN_MS")).toBeGreaterThan(-1);
    expect(recreateBranch.indexOf("RECREATE_MIN_TOKEN_MS")).toBeLessThan(recreateBranch.indexOf("deps.recreate("));
    expect(resolver).toMatch(/token too short to recreate without refresh/);
  });
});
