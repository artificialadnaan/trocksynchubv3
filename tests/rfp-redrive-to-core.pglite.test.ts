import crypto from "crypto";
import express from "express";
import { readFileSync } from "fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// S1b: the ONE-DEAL operator re-drive (REDRIVE-DESIGN.r2 001ab3ba §1–§7; d9's 11-10 rulings) on the REAL S0 enqueue + the
// real 0023 / 0027 migrations (PGlite). Exactly one deal, a GO and an --actor, dry by default; preconditions (a)
// procore-done command, (b) no Core row for the event in ANY status and none live for the deal, (c)
// RFP_NONSERVICE_DESTINATION=core with the Core receiver flag attested by the GO (never probed), (d) non-service +
// CRM-format; --apply = ONE pending row with payload.operatorRedrive + ONE audit_logs row + the alert
// rfp_operator_redrive_applied, the command row untouched; a replay is refused by (b); then the S1 sender sends it despite
// the expected Procore footprint.
// r2 (d9's rulings on the S1b open questions):
//   Q1 --office dallas|atlanta / --approval-kind vote: equal to the stored E1 value where one exists, REQUIRED where it is
//      absent, the office matching the number's prefix; stored in payload.operatorRedrive and printed "attested by GO";
//      the S1 sender fills them from payload.operatorRedrive ONLY for a re-drive row whose E1 lacks them;
//   Q2 S0: a CRM re-post of the procore-done command whose event has an operatorRedrive Core row ⇒ a NO-OP replay: the
//      CRM gets the done branch's answer (the route's 202, no callback row), nothing is re-queued or changed, ONE alert;
//   Q3 a REQUIRED --actor, recorded on the audit row with the OS user.
// r3 (d9 ruling A): the pre-PR-B E1's missing `approval` block is supplied as ATTESTED evidence, --approval-evidence <json
//      file> = {roundEventId, approvals, rejections, invitedVoterCount, decidedAt, source:"<path> <sha256>"}: REQUIRED only
//      where the stored E1 lacks the block, REFUSED where it has one (the stored block wins); approvals ≥ 2, rejections < 2,
//      invited ≥ approvals + rejections, a path + a 64-hex sha; the source is recorded as attested, never opened. Stored in
//      payload.operatorRedrive.approval; the S1 sender sends it as E2's `approval` (source NOT on the wire: Core's contract
//      has no field for it) ONLY for a re-drive row whose E1 lacks the block. Core stays strict.
// r4 (d9 on the r3 questions): a stored block with a null roundEventId stays "present" (no change); when --source-event-id
//      is crm:rfp-vote:approved:<round> the evidence roundEventId must EQUAL <round> (any other form: nothing to compare,
//      printed, not refused); 2000-01-01T00:00:00Z ≤ decidedAt ≤ now (an injectable clock), as Core checks.
// Synthetic data only (I7): a synthetic DFW- number shaped like a real pre-PR-B approval, never a real deal's; a fake round
// id (round-syn-1, matching the synthetic event id), path and sha for the evidence; a fixed synthetic clock.
const dbHolder = vi.hoisted(() => ({ db: null as any }));
const alertMock = vi.hoisted(() => vi.fn(async (_code: string, _detail: Record<string, unknown>) => {}));
const fetchSpy = vi.hoisted(() => vi.fn());
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));
vi.mock("../server/db.ts", () => ({ get db() { return dbHolder.db; }, get pool() { return undefined; } }));
vi.mock("../server/playwright/bidboard.ts", () => ({ createBidBoardProjectFromDeal: vi.fn() }));
vi.mock("../server/rfp-approval.ts", () => ({
  checkRfpApprovalSourceEligibility: vi.fn(async () => ({ eligible: true })),
  buildSourceDealUrl: vi.fn(() => null),
  normalizedDealData: vi.fn(() => ({})),
  createRfpApprovalRequestFromNormalizedInput: vi.fn(),
  processRfpApproval: vi.fn(),
}));
vi.mock("../server/storage.ts", () => ({ storage: { getAutomationConfig: vi.fn(async () => ({ value: { companyId: "42" } })) } }));
vi.mock("../server/hubspot.ts", () => ({
  getHubSpotClient: vi.fn(), getAccessToken: vi.fn(),
  getDealOwnerInfo: vi.fn(async () => ({ ownerName: "", ownerEmail: "" })),
  updateHubSpotDeal: vi.fn(), updateHubSpotDealStage: vi.fn(), syncSingleHubSpotDeal: vi.fn(),
}));
vi.mock("../server/email-service.ts", () => ({ sendEmail: vi.fn(async () => ({ success: true })), renderTemplate: vi.fn() }));
vi.mock("../server/procore-hubspot-sync.ts", () => ({ resolveHubspotStageId: vi.fn() }));
vi.mock("../server/sync/rfp-core-alert.ts", () => ({ raiseRfpCoreAlert: alertMock }));
vi.mock("../server/lib/fetch-with-timeout.ts", () => ({ fetchWithTimeout: fetchSpy }));

const { enqueueBidboardCreateCommand } = await import("../server/sync/bidboard-create-worker.ts");
const { runRedriveToCore } = await import("../server/sync/rfp-redrive-to-core.ts");
const { processRfpCoreCreateOutbox, resetRfpCoreSenderStateForTests } = await import("../server/sync/rfp-core-sender.ts");
const { processRfpCoreFollowupOutbox, resetRfpCoreFollowupStateForTests } = await import("../server/sync/rfp-core-followup.ts");

const DDL_0023 = readFileSync(new URL("../migrations/0023_create_bidboard_create_outbox.sql", import.meta.url), "utf8");
const DDL_0027 = readFileSync(new URL("../migrations/0027_rfp_core_routing.sql", import.meta.url), "utf8");
/** The test schema's copy of shared/schema.ts auditLogs (an existing table; the CLI adds no DB object). */
const AUDIT_DDL = `
  CREATE TABLE audit_logs (
    id serial PRIMARY KEY, action text NOT NULL, entity_type text NOT NULL, entity_id text, source text NOT NULL,
    destination text, status text NOT NULL, details jsonb, error_message text, duration_ms integer, user_id varchar,
    idempotency_key text, category text NOT NULL DEFAULT 'system', created_at timestamp DEFAULT now()
  );
`;

const DEAL = "00000000-0000-4000-8000-0000000000a1";
const OTHER_DEAL = "00000000-0000-4000-8000-0000000000a2";
const COMPANY = "00000000-0000-4000-8000-0000000000c1";
const BID = "00000000-0000-4000-8000-0000000000b1";
const KEY = "crm:rfp-vote:approved:round-syn-1";
const OTHER_KEY = "crm:rfp-vote:approved:round-syn-2";
/** r4: the CLI's injected clock (the evidence's decidedAt must not be after it). */
const CLOCK = new Date("2026-11-10T12:00:00.000Z");
const GO = "A4-GO-SYN-REDRIVE-0001";
const ACTOR = "Synthetic Operator";
const OS_USER = "os:synthetic-runner";
/** A synthetic number shaped like a real pre-PR-B approval's (DFW, type 2, five digits, a suffix). */
const PRE_PRB_NUMBER = "DFW-2-40001-syn";
const CORE_ENV = { RFP_NONSERVICE_DESTINATION: "core" } as NodeJS.ProcessEnv;
const CRM_SECRET = "synthetic-crm-internal-secret";
const CORE_BASE = "https://core.example.test";
const CRM_BASE = "https://crm.example.test";
const E2_DALLAS_URL = `${CORE_BASE}/webhooks/crm/dallas/rfp-bid-create/v1`;
const ENV_KEYS = ["RFP_NONSERVICE_DESTINATION", "RFP_BID_CREATE_INGRESS_SECRET_CURRENT", "CORE_INGRESS_BASE_URL", "TROCK_CRM_BASE_URL", "RFP_REQUEST_SYNC_SECRET"];
const savedEnv: Record<string, string | undefined> = {};
/** r3: the attested vote evidence (synthetic: a fake round id, path and an obviously fake sha). */
const EVIDENCE_FILE = "/synthetic/ops/approval-evidence.syn.json";
const SOURCE_PATH = "synthetic/evidence/vote-log.syn.json";
const SOURCE_SHA = "deadbeef".repeat(8);
const EVIDENCE = {
  roundEventId: "round-syn-1", approvals: 2, rejections: 0, invitedVoterCount: 3, decidedAt: "2026-01-15T16:00:00.000Z",
  source: `${SOURCE_PATH} ${SOURCE_SHA}`,
};
const EVIDENCE_ON_WIRE = { roundEventId: "round-syn-1", approvals: 2, rejections: 0, invitedVoterCount: 3, decidedAt: "2026-01-15T16:00:00.000Z" };
/** The files the CLI may read (only the --approval-evidence file; never the evidence's own source path). */
let files: Record<string, string> = {};
const readFileFake = vi.fn(async (path: string) => {
  if (!(path in files)) throw new Error(`ENOENT: no such file ${path}`);
  return files[path]!;
});

let pg: PGlite;
beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE bidboard_callback_outbox (
      id serial PRIMARY KEY, source_system text NOT NULL, source_deal_id text NOT NULL,
      rfp_approval_request_id integer NOT NULL, payload jsonb NOT NULL, target_url text NOT NULL,
      status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE sync_mappings (
      id serial PRIMARY KEY, source_system text NOT NULL DEFAULT 'hubspot', source_deal_id text NOT NULL, bidboard_project_id text
    );
    ${AUDIT_DDL}
  `);
  await pg.exec(DDL_0023);
  await pg.exec(DDL_0027);
  dbHolder.db = drizzle(pg);
}, 30000);
afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await pg?.close?.();
});
beforeEach(async () => {
  await reset();
});
async function reset() {
  await pg.exec(`DELETE FROM rfp_core_followup_outbox; DELETE FROM rfp_core_create_outbox; DELETE FROM bidboard_create_outbox;
                 DELETE FROM bidboard_callback_outbox; DELETE FROM sync_mappings; DELETE FROM audit_logs;`);
  alertMock.mockReset();
  fetchSpy.mockReset();
  for (const k of ENV_KEYS) delete process.env[k];
  resetRfpCoreSenderStateForTests();
  resetRfpCoreFollowupStateForTests();
  files = { [EVIDENCE_FILE]: JSON.stringify(EVIDENCE) };
  readFileFake.mockClear();
}
/** The S1 sender / follow-up configuration (the CLI itself reads only RFP_NONSERVICE_DESTINATION, from deps.env). */
function senderEnv() {
  process.env.RFP_NONSERVICE_DESTINATION = "core";
  process.env.RFP_BID_CREATE_INGRESS_SECRET_CURRENT = "synthetic-rfp-bid-create-secret-0123456789";
  process.env.CORE_INGRESS_BASE_URL = CORE_BASE;
  process.env.TROCK_CRM_BASE_URL = CRM_BASE;
  process.env.RFP_REQUEST_SYNC_SECRET = CRM_SECRET;
}

function e1(o: Record<string, any> = {}, deal: Record<string, any> = {}): any {
  return {
    sourceSystem: "trock_crm", sourceDealId: DEAL, sourceEventId: KEY, decision: "approved", approvalKind: "vote", office: "dallas",
    approval: { roundEventId: "round-syn-1", approvals: 2, rejections: 0, invitedVoterCount: 3, decidedAt: "2026-11-01T15:00:00.000Z" },
    attachments: [],
    ...o,
    deal: {
      name: "Synthetic Tower Reroof", projectNumber: "DFW-2-12345-ab", projectType: "2", amount: 1000, estimator: "Pat Example",
      companyId: COMPANY, companyName: "Synthetic Builders LLC", contactName: "Sam Synthetic",
      clientEmail: "sam@example.test", clientPhone: null, propertyId: null,
      address: { street: "1 Example St", city: "Dallas", state: "TX", zip: "75001", country: "US" },
      description: null, dueDate: null, workflowRoute: "normal",
      ...deal,
    },
  };
}
/** The shape an approval decided BEFORE CRM PR-B has: no office, no approvalKind, no vote evidence. */
function e1PrePrb(deal: Record<string, any> = {}): any {
  const body = e1({}, { projectNumber: PRE_PRB_NUMBER, ...deal });
  delete body.office;
  delete body.approvalKind;
  delete body.approval;
  return body;
}
/** The approval as it is today: routed to Procore by S0 (setting unset), then created there (the worker's `done`). */
async function seedProcore(input: any = e1(), status = "done") {
  delete process.env.RFP_NONSERVICE_DESTINATION;
  await enqueueBidboardCreateCommand(input);
  if (status !== "pending") {
    await pg.query(`UPDATE bidboard_create_outbox SET status = $1, processed_at = NOW() WHERE source_event_id = $2`, [status, input.sourceEventId]);
  }
  return (await pg.query<any>(`SELECT * FROM bidboard_create_outbox WHERE source_event_id = $1`, [input.sourceEventId])).rows[0];
}
async function insertCore(commandId: number, o: { key?: string; deal?: string; status: string; payload?: unknown }) {
  await pg.query(
    `INSERT INTO rfp_core_create_outbox (command_id, source_system, source_deal_id, source_event_id, project_number, status, payload)
     VALUES ($1, 'trock_crm', $2, $3, 'DFW-2-12345-ab', $4, $5::jsonb)`,
    [commandId, o.deal ?? DEAL, o.key ?? KEY, o.status, o.payload === undefined ? null : JSON.stringify(o.payload)],
  );
}
const ARGS = (...extra: string[]) => ["--deal", DEAL, "--source-event-id", KEY, "--go", GO, "--actor", ACTOR, ...extra];
async function run(argv: string[], env: NodeJS.ProcessEnv = CORE_ENV) {
  const lines: string[] = [];
  const res = await runRedriveToCore(argv, {
    db: dbHolder.db, out: (l: string) => lines.push(l), env, osUser: OS_USER, readFile: readFileFake, now: () => CLOCK,
  } as any);
  return { res, text: lines.join("\n") };
}
const count = async (table: string) => Number((await pg.query<any>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
const counts = async () => ({
  core: await count("rfp_core_create_outbox"), audit: await count("audit_logs"), commands: await count("bidboard_create_outbox"),
  callbacks: await count("bidboard_callback_outbox"), followups: await count("rfp_core_followup_outbox"),
});
const commandSnapshot = async (key = KEY) =>
  (await pg.query<any>(
    `SELECT id, status, destination, approval_kind, payload, processed_at, stamped_at, attempt_count FROM bidboard_create_outbox WHERE source_event_id = $1`,
    [key],
  )).rows[0];
const coreRowsFor = async (key = KEY) =>
  (await pg.query<any>(`SELECT id, status, attempt_count, payload, e2_ever_sent, next_attempt_at FROM rfp_core_create_outbox WHERE source_event_id = $1`, [key])).rows;
const alertCodes = () => alertMock.mock.calls.map((c) => c[0]);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const receipt = (result = "created") => ({
  version: "trock.crm.rfp-bid-create.v1", result, coreBidId: BID, boardStage: { code: "in-progress", status: "invited" },
  createdAt: "2026-11-10T12:00:01.000Z", warnings: [],
});
/** The CRM's re-post of an approval, through the REAL create-from-rfp route (signed, the production body parsers). */
async function repost(body: any): Promise<{ status: number; body: any }> {
  process.env.RFP_REQUEST_SYNC_SECRET = CRM_SECRET;
  const { registerRfpRequestRoutes } = await import("../server/routes/rfp-requests.ts");
  const { mountJsonBodyParsers } = await import("../server/json-body.ts");
  const app = express();
  mountJsonBodyParsers(app);
  registerRfpRequestRoutes(app);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const port = (server.address() as any).port;
  try {
    const raw = JSON.stringify(body);
    const res = await fetch(`http://127.0.0.1:${port}/api/bid-board/create-from-rfp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rfp-request-signature": `sha256=${crypto.createHmac("sha256", CRM_SECRET).update(raw).digest("hex")}` },
      body: raw,
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

describe("arguments: exactly one deal, a GO, an --actor, no bulk mode", () => {
  it("no --go ⇒ exit 2, nothing written, no alert", async () => {
    await seedProcore();
    const before = await counts();
    const { res } = await run(["--deal", DEAL, "--source-event-id", KEY, "--actor", ACTOR, "--apply"]);
    expect(res).toMatchObject({ code: 2, applied: false });
    expect(res.refused).toContain("--go");
    expect(await counts()).toEqual(before);
    expect(alertCodes()).toEqual([]);
  });
  it("two --deal, no --deal, a list or a non-id ⇒ exit 2, nothing written", async () => {
    await seedProcore();
    const before = await counts();
    const variants: Array<[string, string[]]> = [
      ["two deals", ["--deal", DEAL, "--deal", OTHER_DEAL, "--source-event-id", KEY, "--go", GO, "--actor", ACTOR, "--apply"]],
      ["no deal", ["--source-event-id", KEY, "--go", GO, "--actor", ACTOR, "--apply"]],
      ["a comma list", ["--deal", `${DEAL},${OTHER_DEAL}`, "--source-event-id", KEY, "--go", GO, "--actor", ACTOR, "--apply"]],
      ["not an id", ["--deal", "all", "--source-event-id", KEY, "--go", GO, "--actor", ACTOR, "--apply"]],
    ];
    for (const [label, argv] of variants) {
      const { res } = await run(argv);
      expect(res.code, label).toBe(2);
      expect(res.applied, label).toBe(false);
    }
    expect(await counts()).toEqual(before);
    expect(alertCodes()).toEqual([]);
  });
  it("(Q3) --actor missing or blank ⇒ exit 2, nothing written", async () => {
    await seedProcore();
    const before = await counts();
    const variants: Array<[string, string[]]> = [
      ["missing", ["--deal", DEAL, "--source-event-id", KEY, "--go", GO, "--apply"]],
      ["blank", ["--deal", DEAL, "--source-event-id", KEY, "--go", GO, "--actor", "   ", "--apply"]],
      ["empty", ["--deal", DEAL, "--source-event-id", KEY, "--go", GO, "--actor", "", "--apply"]],
    ];
    for (const [label, argv] of variants) {
      const { res } = await run(argv);
      expect(res.code, label).toBe(2);
      expect(res.refused, label).toContain("--actor");
    }
    expect(await counts()).toEqual(before);
    expect(alertCodes()).toEqual([]);
  });
});

describe("preconditions: each printed; any false ⇒ refused, nothing written", () => {
  it("a dry run with every precondition true prints (a)–(d) and the GO-attested Core flag, writes nothing, exits 0", async () => {
    await seedProcore();
    const before = await counts();
    const cmd = await commandSnapshot();
    const { res, text } = await run(ARGS());
    expect(res).toMatchObject({ code: 0, applied: false });
    for (const key of ["a", "b", "c", "d"]) expect(text, key).toContain(`PASS (${key})`);
    expect(text).toContain(`Core receiver flag: attested by GO ${GO}`);
    expect(text).toContain("DRY-RUN");
    expect(await counts()).toEqual(before);
    expect(await commandSnapshot()).toEqual(cmd);
    expect(alertCodes()).toEqual([]);
  });
  it("(a) a command row that is not procore + done (pending / failed / processing / superseded / needs_manual / core-stamped / missing / another deal / not approved) ⇒ refused", async () => {
    const cases: Array<[string, () => Promise<unknown>, string[]?]> = [
      ["procore pending", () => seedProcore(e1(), "pending")],
      ["procore failed", () => seedProcore(e1(), "failed")],
      ["procore processing", () => seedProcore(e1(), "processing")],
      ["procore superseded", () => seedProcore(e1(), "superseded")],
      ["procore needs_manual", () => seedProcore(e1(), "needs_manual")],
      ["core-stamped", async () => { process.env.RFP_NONSERVICE_DESTINATION = "core"; await enqueueBidboardCreateCommand(e1()); }],
      ["no command row", async () => undefined],
      ["the event belongs to another deal", () => seedProcore(e1({ sourceDealId: OTHER_DEAL }))],
      ["decision not approved", async () => {
        await seedProcore();
        await pg.query(`UPDATE bidboard_create_outbox SET payload = jsonb_set(payload, '{decision}', '"rejected"') WHERE source_event_id = $1`, [KEY]);
      }],
    ];
    for (const [label, seed] of cases) {
      await reset();
      await seed();
      const before = await counts();
      const { res, text } = await run(ARGS("--apply"));
      expect(res.code, label).toBe(1);
      expect(text, label).toContain("FAIL (a)");
      expect(await counts(), label).toEqual(before);
      expect(alertCodes(), label).toEqual([]);
    }
  });
  it("(b) a LIVE Core row for the deal (pending / sending / sent / held_cross_destination, another event) ⇒ refused", async () => {
    for (const status of ["pending", "sending", "sent", "held_cross_destination"]) {
      await reset();
      const cmd = await seedProcore();
      await insertCore(cmd.id, { key: OTHER_KEY, status });
      const before = await counts();
      const { res, text } = await run(ARGS("--apply"));
      expect(res.code, status).toBe(1);
      expect(text, status).toContain("FAIL (b)");
      expect(await counts(), status).toEqual(before);
    }
  });
  it("(b) ANY Core row for the event, in any status (refused / dead / failed included) ⇒ refused", async () => {
    for (const status of ["refused", "dead", "failed", "sent"]) {
      await reset();
      const cmd = await seedProcore();
      await insertCore(cmd.id, { key: KEY, status });
      const before = await counts();
      const { res, text } = await run(ARGS("--apply"));
      expect(res.code, status).toBe(1);
      expect(text, status).toContain("FAIL (b)");
      expect(await counts(), status).toEqual(before);
    }
  });
  it("(c) RFP_NONSERVICE_DESTINATION not core ⇒ refused; the Core receiver flag is only attested by the GO, never probed", async () => {
    await seedProcore();
    const before = await counts();
    for (const env of [{}, { RFP_NONSERVICE_DESTINATION: "procore" }] as NodeJS.ProcessEnv[]) {
      const { res, text } = await run(ARGS("--apply"), env);
      expect(res.code, JSON.stringify(env)).toBe(1);
      expect(text, JSON.stringify(env)).toContain("FAIL (c)");
      expect(text, JSON.stringify(env)).toContain(`Core receiver flag: attested by GO ${GO}`);
    }
    expect(await counts()).toEqual(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("(d) a service deal (effective digit 4) or a non-CRM-format number ⇒ refused", async () => {
    const cases: Array<[string, any]> = [
      ["service number", e1({}, { projectNumber: "DFW-4-12345-ab", projectType: "4" })],
      ["service type, no digit in the number", e1({}, { projectNumber: "SYN-0042", projectType: "4" })],
      ["short number", e1({}, { projectNumber: "DFW-2-1234-ab" })],
      ["historical number", e1({}, { projectNumber: "2023-0042" })],
    ];
    for (const [label, input] of cases) {
      await reset();
      await seedProcore(input);
      const before = await counts();
      const { res, text } = await run(ARGS("--apply"));
      expect(res.code, label).toBe(1);
      expect(text, label).toContain("FAIL (d)");
      expect(await counts(), label).toEqual(before);
    }
  });
});

describe("(Q1) --office / --approval-kind for an approval whose stored E1 lacks them", () => {
  it("a pre-PR-B E1 (no office, approvalKind or approval) + --office dallas --approval-kind vote + valid --approval-evidence ⇒ applied, each printed as attested; E2 goes to the dallas path with office dallas, approvalKind vote and the evidence as `approval` (no source on the wire)", async () => {
    await seedProcore(e1PrePrb());
    const { res, text } = await run(ARGS("--office", "dallas", "--approval-kind", "vote", "--approval-evidence", EVIDENCE_FILE, "--apply"));
    expect(res).toMatchObject({ code: 0, applied: true });
    expect(text).toContain(`office dallas (attested by GO ${GO})`);
    expect(text).toContain(`approvalKind vote (attested by GO ${GO})`);
    for (const key of ["approval", "approval.parse", "approval.shape", "approval.round", "approval.decidedAt", "approval.votes", "approval.invited", "approval.source"]) {
      expect(text, key).toContain(`PASS (${key})`);
    }
    expect(text).toContain("roundEventId round-syn-1 = the round in crm:rfp-vote:approved:round-syn-1");
    expect(text).toContain(`approval evidence: attested by GO ${GO} (source ${SOURCE_PATH} ${SOURCE_SHA.slice(0, 8)})`);
    expect(readFileFake.mock.calls.map((c) => c[0])).toEqual([EVIDENCE_FILE]);
    expect((await coreRowsFor())[0].payload).toEqual({
      operatorRedrive: { reason: "operator_redrive", go: GO, office: "dallas", approvalKind: "vote", approval: EVIDENCE },
    });
    const audit = (await pg.query<any>(`SELECT details FROM audit_logs`)).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({ before: { e1Approval: null }, after: { payload: { operatorRedrive: { approval: EVIDENCE } } } });
    senderEnv();
    const fetchImpl = vi.fn(async (_url: string, _init: any) => json(201, receipt()));
    await processRfpCoreCreateOutbox({ fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe(E2_DALLAS_URL);
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body).toMatchObject({
      office: "dallas", approvalKind: "vote", sourceEventId: KEY, crmDealId: DEAL, deal: { projectNumber: PRE_PRB_NUMBER },
    });
    expect(body.approval).toEqual(EVIDENCE_ON_WIRE);
    expect((await coreRowsFor())[0].status).toBe("sent");
  });
  it("the same pre-PR-B row with NO --office / --approval-kind ⇒ refused: each is required where the stored E1 lacks it", async () => {
    await seedProcore(e1PrePrb());
    const before = await counts();
    const { res, text } = await run(ARGS("--apply"));
    expect(res).toMatchObject({ code: 1, applied: false });
    expect(text).toContain("FAIL (office)");
    expect(text).toContain("FAIL (kind)");
    expect(await counts()).toEqual(before);
    const onlyOffice = await run(ARGS("--office", "dallas", "--apply"));
    expect(onlyOffice.res.code).toBe(1);
    expect(onlyOffice.text).toContain("FAIL (kind)");
    expect(await counts()).toEqual(before);
  });
  it("an argument that conflicts with a stored value ⇒ refused (stored office dallas vs --office atlanta; stored kind override vs --approval-kind vote, or no arg)", async () => {
    const cases: Array<[string, any, string[], string]> = [
      ["office conflict", e1(), ["--office", "atlanta"], "FAIL (office)"],
      ["kind conflict", e1({ approvalKind: "override", approval: undefined }), ["--approval-kind", "vote"], "FAIL (kind)"],
      ["stored override, no arg", e1({ approvalKind: "override", approval: undefined }), [], "FAIL (kind)"],
    ];
    for (const [label, input, extra, fail] of cases) {
      await reset();
      await seedProcore(input);
      const before = await counts();
      const { res, text } = await run(ARGS(...extra, "--apply"));
      expect(res.code, label).toBe(1);
      expect(text, label).toContain(fail);
      expect(await counts(), label).toEqual(before);
    }
  });
  it("an --office that does not match the number's prefix (DFW ⇒ dallas, ATL ⇒ atlanta) ⇒ refused", async () => {
    const cases: Array<[string, any, string]> = [
      ["DFW number, --office atlanta", e1PrePrb(), "atlanta"],
      ["ATL number, --office dallas", e1PrePrb({ projectNumber: "ATL-2-40002-syn" }), "dallas"],
    ];
    for (const [label, input, office] of cases) {
      await reset();
      await seedProcore(input);
      const before = await counts();
      const { res, text } = await run(ARGS("--office", office, "--approval-kind", "vote", "--apply"));
      expect(res.code, label).toBe(1);
      expect(text, label).toContain("FAIL (office)");
      expect(await counts(), label).toEqual(before);
    }
  });
  it("the S1 sender fills office / approvalKind from payload.operatorRedrive for a re-drive row whose E1 lacks them; E4 and N1 carry that office", async () => {
    const cmd = await seedProcore(e1PrePrb());
    await insertCore(cmd.id, {
      key: KEY, status: "pending",
      payload: { operatorRedrive: { reason: "operator_redrive", go: GO, office: "dallas", approvalKind: "vote" } },
    });
    senderEnv();
    const calls: Array<{ url: string; body: any }> = [];
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      if (url === E2_DALLAS_URL) return json(201, receipt());
      if (url.endsWith("/api/internal/core-bid-created")) return json(200, { result: "stale" });
      return json(200, { result: "recorded" });
    });
    await processRfpCoreCreateOutbox({ fetchImpl });
    expect(calls.map((c) => c.url)).toEqual([E2_DALLAS_URL]);
    expect(calls[0]!.body).toMatchObject({ office: "dallas", approvalKind: "vote" });
    await processRfpCoreFollowupOutbox({ fetchImpl });
    expect(calls.find((c) => c.url.endsWith("/api/internal/core-bid-created"))?.body).toMatchObject({ office: "dallas", approvalKind: "vote" });
    expect(calls.find((c) => c.url.endsWith("/api/internal/rfp-core-notice"))?.body).toMatchObject({ kind: "core_bid_orphan", office: "dallas" });
  });
  it("(pin) a row WITHOUT the re-drive marker (no go) whose E1 lacks an office is still office_not_supported at send: payload office ignored", async () => {
    const input = e1();
    delete input.office;
    process.env.RFP_NONSERVICE_DESTINATION = "core";
    await enqueueBidboardCreateCommand(input); // an ordinary core-stamped row
    await pg.query(`UPDATE rfp_core_create_outbox SET payload = $1::jsonb WHERE source_event_id = $2`, [
      JSON.stringify({ operatorRedrive: { reason: "operator_redrive", office: "dallas", approvalKind: "vote" } }), KEY,
    ]);
    senderEnv();
    const fetchImpl = vi.fn(async (_url: string, _init: any) => json(201, receipt()));
    await processRfpCoreCreateOutbox({ fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await coreRowsFor())[0]).toMatchObject({ status: "refused" });
    expect((await pg.query<any>(`SELECT refusal_reason FROM rfp_core_create_outbox`)).rows[0].refusal_reason).toBe("office_not_supported");
  });
});

describe("--apply", () => {
  it("writes exactly ONE pending row (the original source_event_id, payload.operatorRedrive) + ONE audit_logs row (actor + OS user) + ONE alert; the command row is unchanged; no network call", async () => {
    const cmd = await seedProcore();
    const before = await counts();
    const snapshot = await commandSnapshot();
    const { res } = await run(ARGS("--apply"));
    expect(res).toMatchObject({ code: 0, applied: true });
    const core = (await pg.query<any>(`SELECT * FROM rfp_core_create_outbox`)).rows;
    expect(core).toHaveLength(1);
    expect(core[0]).toMatchObject({
      command_id: cmd.id, source_system: "trock_crm", source_deal_id: DEAL, source_event_id: KEY, status: "pending",
      attempt_count: 0, e2_ever_sent: false,
      payload: { operatorRedrive: { reason: "operator_redrive", go: GO, office: "dallas", approvalKind: "vote" } },
    });
    expect(res.rowId).toBe(core[0].id);
    const audit = (await pg.query<any>(`SELECT * FROM audit_logs`)).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "rfp_operator_redrive", entity_type: "rfp_core_create_outbox", entity_id: String(core[0].id), status: "success" });
    expect(audit[0].details).toMatchObject({
      actor: ACTOR, osUser: OS_USER, go: GO, deal: DEAL, sourceEventId: KEY,
      before: { command: { destination: "procore", status: "done" } },
      after: { coreId: core[0].id, status: "pending", payload: { operatorRedrive: { reason: "operator_redrive", go: GO, office: "dallas", approvalKind: "vote" } } },
    });
    expect(alertCodes()).toEqual(["rfp_operator_redrive_applied"]);
    expect(alertMock.mock.calls[0]![1]).toMatchObject({ go: GO, actor: ACTOR, sourceDealId: DEAL, sourceEventId: KEY, coreId: core[0].id });
    expect(await commandSnapshot()).toEqual(snapshot);
    expect(await counts()).toEqual({ ...before, core: before.core + 1, audit: before.audit + 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("a replay of --apply ⇒ refused by (b): still ONE row, ONE audit row, ONE alert", async () => {
    await seedProcore();
    const first = await run(ARGS("--apply"));
    expect(first.res.code).toBe(0);
    const second = await run(ARGS("--apply"));
    expect(second.res).toMatchObject({ code: 1, applied: false });
    expect(second.text).toContain("FAIL (b)");
    expect(await count("rfp_core_create_outbox")).toBe(1);
    expect(await count("audit_logs")).toBe(1);
    expect(alertCodes()).toEqual(["rfp_operator_redrive_applied"]);
  });
  it("then the normal S1 path: the sender sends the re-drive row despite the deal's expected Procore footprint", async () => {
    await seedProcore();
    await pg.query(`INSERT INTO sync_mappings (source_system, source_deal_id, bidboard_project_id) VALUES ('trock_crm', $1, '900001')`, [DEAL]);
    const { res } = await run(ARGS("--apply"));
    expect(res.code).toBe(0);
    process.env.RFP_NONSERVICE_DESTINATION = "core";
    process.env.RFP_BID_CREATE_INGRESS_SECRET_CURRENT = "synthetic-rfp-bid-create-secret-0123456789";
    process.env.CORE_INGRESS_BASE_URL = "https://core.example.test";
    process.env.TROCK_CRM_BASE_URL = "https://crm.example.test";
    const fetchImpl = vi.fn(async (_url: string, _init: any) => new Response(JSON.stringify({
      version: "trock.crm.rfp-bid-create.v1", result: "replay", coreBidId: "00000000-0000-4000-8000-0000000000b1",
      boardStage: { code: "in-progress", status: "invited" }, createdAt: "2026-11-10T12:00:01.000Z", warnings: [],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await processRfpCoreCreateOutbox({ fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await pg.query<any>(`SELECT status FROM rfp_core_create_outbox`)).rows).toEqual([{ status: "sent" }]);
    expect(alertCodes()).not.toContain("cross_destination_hold");
    expect((await commandSnapshot()).status).toBe("done");
  });
});

describe("(Q2) S0: a CRM re-post of the procore-done command after a re-drive ⇒ a no-op replay", () => {
  it("with an operatorRedrive Core row for the event: the route answers 202 exactly as the done branch does, no callback row, the command stays done, the Core row is unchanged and still sends, ONE alert", async () => {
    // The control: the same done-branch re-post for another deal WITHOUT a re-drive row (today's answer + re-queue).
    await seedProcore(e1({ sourceDealId: OTHER_DEAL, sourceEventId: OTHER_KEY }));
    const control = await repost(e1({ sourceDealId: OTHER_DEAL, sourceEventId: OTHER_KEY }));
    const cmd = await seedProcore();
    await insertCore(cmd.id, {
      key: KEY, status: "pending",
      payload: { operatorRedrive: { reason: "operator_redrive", go: GO, office: "dallas", approvalKind: "vote" } },
    });
    const commandBefore = await commandSnapshot();
    const coreBefore = await coreRowsFor();
    const callbacksBefore = await count("bidboard_callback_outbox");
    alertMock.mockReset();
    process.env.RFP_NONSERVICE_DESTINATION = "core";
    const ours = await repost(e1());
    expect(ours.status).toBe(control.status);
    expect(ours.status).toBe(202);
    expect(ours.body).toEqual({ ...control.body, sourceDealId: DEAL });
    expect(await count("bidboard_callback_outbox")).toBe(callbacksBefore);
    expect(await commandSnapshot()).toEqual(commandBefore);
    expect(await coreRowsFor()).toEqual(coreBefore);
    expect(alertCodes()).toEqual(["redrive_repost_replayed"]);
    senderEnv();
    const fetchImpl = vi.fn(async (_url: string, _init: any) => json(201, receipt()));
    await processRfpCoreCreateOutbox({ fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await coreRowsFor())[0].status).toBe("sent");
  });
  it("end to end through the CLI: a pre-PR-B approval re-driven with --office / --approval-kind, then the CRM re-posts it ⇒ the same no-op replay, and E2 still goes out", async () => {
    await seedProcore(e1PrePrb());
    const { res } = await run(ARGS("--office", "dallas", "--approval-kind", "vote", "--approval-evidence", EVIDENCE_FILE, "--apply"));
    expect(res.code).toBe(0);
    const commandBefore = await commandSnapshot();
    const coreBefore = await coreRowsFor();
    alertMock.mockReset();
    process.env.RFP_NONSERVICE_DESTINATION = "core";
    const answer = await repost(e1PrePrb());
    expect(answer).toEqual({ status: 202, body: { success: true, queued: true, sourceDealId: DEAL, projectNumber: PRE_PRB_NUMBER } });
    expect(await commandSnapshot()).toEqual(commandBefore);
    expect(await coreRowsFor()).toEqual(coreBefore);
    expect(alertCodes()).toEqual(["redrive_repost_replayed"]);
    senderEnv();
    const fetchImpl = vi.fn(async (_url: string, _init: any) => json(201, receipt()));
    await processRfpCoreCreateOutbox({ fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body)).toMatchObject({ office: "dallas", approvalKind: "vote" });
  });
});

describe("(r3, d9 ruling A) --approval-evidence: the pre-PR-B approval block as attested evidence; Core stays strict", () => {
  const PRE = () => ARGS("--office", "dallas", "--approval-kind", "vote");
  it("the same pre-PR-B row WITHOUT --approval-evidence ⇒ refused: the evidence is required where the stored E1 has no approval block", async () => {
    await seedProcore(e1PrePrb());
    const before = await counts();
    const { res, text } = await run([...PRE(), "--apply"]);
    expect(res).toMatchObject({ code: 1, applied: false });
    expect(text).toContain("FAIL (approval)");
    expect(await counts()).toEqual(before);
    expect(alertCodes()).toEqual([]);
  });
  it("bad evidence ⇒ refused, each check printed: approvals 1 / rejections 2 / invited too few / roundEventId null / an extra key / a non-ISO decidedAt / no sha / a short sha / bad JSON / an unreadable file", async () => {
    const bad = (o: Record<string, unknown>) => JSON.stringify({ ...EVIDENCE, ...o });
    const cases: Array<[string, string | null, string]> = [
      ["approvals 1", bad({ approvals: 1 }), "FAIL (approval.votes)"],
      ["rejections 2", bad({ approvals: 2, rejections: 2, invitedVoterCount: 5 }), "FAIL (approval.votes)"],
      ["invited too few", bad({ approvals: 2, rejections: 1, invitedVoterCount: 2 }), "FAIL (approval.invited)"],
      ["roundEventId null", bad({ roundEventId: null }), "FAIL (approval.shape)"],
      ["an extra key", bad({ note: "synthetic" }), "FAIL (approval.shape)"],
      ["decidedAt not ISO", bad({ decidedAt: "15/01/2026" }), "FAIL (approval.shape)"],
      ["no sha", bad({ source: SOURCE_PATH }), "FAIL (approval.source)"],
      ["a short sha", bad({ source: `${SOURCE_PATH} deadbeef` }), "FAIL (approval.source)"],
      ["bad JSON", "{ not json", "FAIL (approval.parse)"],
      ["an unreadable file", null, "FAIL (approval.parse)"],
    ];
    for (const [label, content, fail] of cases) {
      await reset();
      if (content === null) delete files[EVIDENCE_FILE];
      else files[EVIDENCE_FILE] = content;
      await seedProcore(e1PrePrb());
      const before = await counts();
      const { res, text } = await run([...PRE(), "--approval-evidence", EVIDENCE_FILE, "--apply"]);
      expect(res.code, label).toBe(1);
      expect(text, label).toContain(fail);
      expect(await counts(), label).toEqual(before);
      expect(alertCodes(), label).toEqual([]);
    }
  });
  it("evidence given when the stored E1 already HAS an approval block ⇒ refused (the stored block wins; never replaced or compared)", async () => {
    await seedProcore();
    const before = await counts();
    const { res, text } = await run(ARGS("--approval-evidence", EVIDENCE_FILE, "--apply"));
    expect(res).toMatchObject({ code: 1, applied: false });
    expect(text).toContain("FAIL (approval)");
    expect(await counts()).toEqual(before);
  });
  it("the S1 sender sends payload.operatorRedrive.approval as E2's `approval` for a re-drive row whose E1 lacks the block; the source never goes on the wire", async () => {
    const input = e1();
    delete input.approval;
    const cmd = await seedProcore(input);
    await insertCore(cmd.id, {
      key: KEY, status: "pending",
      payload: { operatorRedrive: { reason: "operator_redrive", go: GO, office: "dallas", approvalKind: "vote", approval: EVIDENCE } },
    });
    senderEnv();
    const fetchImpl = vi.fn(async (_url: string, _init: any) => json(201, receipt()));
    await processRfpCoreCreateOutbox({ fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body.approval).toEqual(EVIDENCE_ON_WIRE);
    expect(JSON.stringify(body)).not.toContain(SOURCE_SHA);
    expect((await coreRowsFor())[0].status).toBe("sent");
  });
  it("(pin) an ORDINARY core-stamped row whose E1 lacks the approval block is still sent as S1a sends it, approval: null (buildRfpBidCreateBody maps a missing block to null), never filled from a payload approval", async () => {
    const input = e1();
    delete input.approval;
    process.env.RFP_NONSERVICE_DESTINATION = "core";
    await enqueueBidboardCreateCommand(input); // an ordinary core-stamped row (vote, dallas, no approval block)
    await pg.query(`UPDATE rfp_core_create_outbox SET payload = $1::jsonb WHERE source_event_id = $2`, [
      JSON.stringify({ operatorRedrive: { reason: "operator_redrive", office: "dallas", approvalKind: "vote", approval: EVIDENCE } }), KEY,
    ]);
    senderEnv();
    const fetchImpl = vi.fn(async (_url: string, _init: any) => json(201, receipt()));
    await processRfpCoreCreateOutbox({ fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body).approval).toBeNull();
  });
});

describe("(r4, d9 on the r3 questions) the evidence round must match the event id; decidedAt within [2000-01-01, now]", () => {
  const PRE = (key = KEY) => ["--deal", DEAL, "--source-event-id", key, "--go", GO, "--actor", ACTOR,
    "--office", "dallas", "--approval-kind", "vote", "--approval-evidence", EVIDENCE_FILE, "--apply"];
  it("an evidence roundEventId that does not equal the round in crm:rfp-vote:approved:<round> ⇒ refused, 0 rows written", async () => {
    files[EVIDENCE_FILE] = JSON.stringify({ ...EVIDENCE, roundEventId: "round-syn-9" });
    await seedProcore(e1PrePrb());
    const before = await counts();
    const { res, text } = await run(PRE());
    expect(res).toMatchObject({ code: 1, applied: false });
    expect(text).toContain("FAIL (approval.round)");
    expect(await counts()).toEqual(before);
    expect(await count("rfp_core_create_outbox")).toBe(0);
    expect(await count("audit_logs")).toBe(0);
    expect(alertCodes()).toEqual([]);
  });
  it("an event id of any other form ⇒ nothing to compare (printed, not refused): it applies when everything else is valid", async () => {
    const otherForm = "crm:rfp-approval:syn-legacy-1";
    await seedProcore({ ...e1PrePrb(), sourceEventId: otherForm });
    const { res, text } = await run(PRE(otherForm));
    expect(res).toMatchObject({ code: 0, applied: true });
    expect(text).toContain("PASS (approval.round)");
    expect(text).toContain("nothing to compare");
    expect((await coreRowsFor(otherForm))[0].payload.operatorRedrive.approval).toEqual(EVIDENCE);
  });
  it("decidedAt in 1999 ⇒ refused, 0 rows written (Core refuses an event before 2000)", async () => {
    files[EVIDENCE_FILE] = JSON.stringify({ ...EVIDENCE, decidedAt: "1999-12-31T23:59:59.000Z" });
    await seedProcore(e1PrePrb());
    const before = await counts();
    const { res, text } = await run(PRE());
    expect(res.code).toBe(1);
    expect(text).toContain("FAIL (approval.decidedAt)");
    expect(await counts()).toEqual(before);
  });
  it("decidedAt in the future (the injected clock + 1 day) ⇒ refused, 0 rows written", async () => {
    files[EVIDENCE_FILE] = JSON.stringify({ ...EVIDENCE, decidedAt: new Date(CLOCK.getTime() + 24 * 60 * 60 * 1000).toISOString() });
    await seedProcore(e1PrePrb());
    const before = await counts();
    const { res, text } = await run(PRE());
    expect(res.code).toBe(1);
    expect(text).toContain("FAIL (approval.decidedAt)");
    expect(await counts()).toEqual(before);
  });
});
