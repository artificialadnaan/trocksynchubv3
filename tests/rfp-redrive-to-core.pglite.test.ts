import { readFileSync } from "fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// S1b: the ONE-DEAL operator re-drive (REDRIVE-DESIGN.r2 001ab3ba §1–§7; d9's 11-10 rulings) on the REAL S0 enqueue + the
// real 0023 / 0027 migrations (PGlite). Exactly one deal, a GO, dry by default; preconditions (a) procore-done command,
// (b) no Core row for the event in ANY status and none live for the deal, (c) RFP_NONSERVICE_DESTINATION=core with the
// Core receiver flag attested by the GO (never probed), (d) non-service + CRM-format; --apply = ONE pending row with
// payload.operatorRedrive + ONE audit_logs row + the alert rfp_operator_redrive_applied, the command row untouched; a replay
// is refused by (b); then the S1 sender sends it despite the expected Procore footprint. Synthetic data only (I7).
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
}));
vi.mock("../server/storage.ts", () => ({ storage: { getAutomationConfig: vi.fn(async () => ({ value: { companyId: "42" } })) } }));
vi.mock("../server/sync/rfp-core-alert.ts", () => ({ raiseRfpCoreAlert: alertMock }));
vi.mock("../server/lib/fetch-with-timeout.ts", () => ({ fetchWithTimeout: fetchSpy }));

const { enqueueBidboardCreateCommand } = await import("../server/sync/bidboard-create-worker.ts");
const { runRedriveToCore } = await import("../server/sync/rfp-redrive-to-core.ts");
const { processRfpCoreCreateOutbox, resetRfpCoreSenderStateForTests } = await import("../server/sync/rfp-core-sender.ts");

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
const KEY = "crm:rfp-vote:approved:round-7";
const OTHER_KEY = "crm:rfp-vote:approved:round-8";
const GO = "A4-GO-SYN-REDRIVE-0001";
const ACTOR = "ops:synthetic-tester";
const CORE_ENV = { RFP_NONSERVICE_DESTINATION: "core" } as NodeJS.ProcessEnv;
const ENV_KEYS = ["RFP_NONSERVICE_DESTINATION", "RFP_BID_CREATE_INGRESS_SECRET_CURRENT", "CORE_INGRESS_BASE_URL", "TROCK_CRM_BASE_URL", "RFP_REQUEST_SYNC_SECRET"];
const savedEnv: Record<string, string | undefined> = {};

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
}

function e1(o: Record<string, any> = {}, deal: Record<string, any> = {}): any {
  return {
    sourceSystem: "trock_crm", sourceDealId: DEAL, sourceEventId: KEY, decision: "approved", approvalKind: "vote", office: "dallas",
    approval: { roundEventId: "round-7", approvals: 2, rejections: 0, invitedVoterCount: 3, decidedAt: "2026-11-01T15:00:00.000Z" },
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
/** The approval as it is today: routed to Procore by S0 (setting unset), then created there (the worker's `done`). */
async function seedProcore(input: any = e1(), status = "done") {
  delete process.env.RFP_NONSERVICE_DESTINATION;
  await enqueueBidboardCreateCommand(input);
  if (status !== "pending") {
    await pg.query(`UPDATE bidboard_create_outbox SET status = $1, processed_at = NOW() WHERE source_event_id = $2`, [status, input.sourceEventId]);
  }
  return (await pg.query<any>(`SELECT * FROM bidboard_create_outbox WHERE source_event_id = $1`, [input.sourceEventId])).rows[0];
}
async function insertCore(commandId: number, o: { key?: string; deal?: string; status: string }) {
  await pg.query(
    `INSERT INTO rfp_core_create_outbox (command_id, source_system, source_deal_id, source_event_id, project_number, status)
     VALUES ($1, 'trock_crm', $2, $3, 'DFW-2-12345-ab', $4)`,
    [commandId, o.deal ?? DEAL, o.key ?? KEY, o.status],
  );
}
const ARGS = (...extra: string[]) => ["--deal", DEAL, "--source-event-id", KEY, "--go", GO, ...extra];
async function run(argv: string[], env: NodeJS.ProcessEnv = CORE_ENV) {
  const lines: string[] = [];
  const res = await runRedriveToCore(argv, { db: dbHolder.db, out: (l: string) => lines.push(l), env, actor: ACTOR });
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
const alertCodes = () => alertMock.mock.calls.map((c) => c[0]);

describe("arguments: exactly one deal, a GO, no bulk mode", () => {
  it("no --go ⇒ exit 2, nothing written, no alert", async () => {
    await seedProcore();
    const before = await counts();
    const { res } = await run(["--deal", DEAL, "--source-event-id", KEY, "--apply"]);
    expect(res).toMatchObject({ code: 2, applied: false });
    expect(res.refused).toContain("--go");
    expect(await counts()).toEqual(before);
    expect(alertCodes()).toEqual([]);
  });
  it("two --deal, no --deal, a list or a non-id ⇒ exit 2, nothing written", async () => {
    await seedProcore();
    const before = await counts();
    const variants: Array<[string, string[]]> = [
      ["two deals", ["--deal", DEAL, "--deal", OTHER_DEAL, "--source-event-id", KEY, "--go", GO, "--apply"]],
      ["no deal", ["--source-event-id", KEY, "--go", GO, "--apply"]],
      ["a comma list", ["--deal", `${DEAL},${OTHER_DEAL}`, "--source-event-id", KEY, "--go", GO, "--apply"]],
      ["not an id", ["--deal", "all", "--source-event-id", KEY, "--go", GO, "--apply"]],
    ];
    for (const [label, argv] of variants) {
      const { res } = await run(argv);
      expect(res.code, label).toBe(2);
      expect(res.applied, label).toBe(false);
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

describe("--apply", () => {
  it("writes exactly ONE pending row (the original source_event_id, payload.operatorRedrive) + ONE audit_logs row + ONE alert; the command row is unchanged; no network call", async () => {
    const cmd = await seedProcore();
    const before = await counts();
    const snapshot = await commandSnapshot();
    const { res } = await run(ARGS("--apply"));
    expect(res).toMatchObject({ code: 0, applied: true });
    const core = (await pg.query<any>(`SELECT * FROM rfp_core_create_outbox`)).rows;
    expect(core).toHaveLength(1);
    expect(core[0]).toMatchObject({
      command_id: cmd.id, source_system: "trock_crm", source_deal_id: DEAL, source_event_id: KEY, status: "pending",
      attempt_count: 0, e2_ever_sent: false, payload: { operatorRedrive: { reason: "operator_redrive", go: GO } },
    });
    expect(res.rowId).toBe(core[0].id);
    const audit = (await pg.query<any>(`SELECT * FROM audit_logs`)).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "rfp_operator_redrive", entity_type: "rfp_core_create_outbox", entity_id: String(core[0].id), status: "success" });
    expect(audit[0].details).toMatchObject({
      actor: ACTOR, go: GO, deal: DEAL, sourceEventId: KEY,
      before: { command: { destination: "procore", status: "done" } },
      after: { coreId: core[0].id, status: "pending", payload: { operatorRedrive: { reason: "operator_redrive", go: GO } } },
    });
    expect(alertCodes()).toEqual(["rfp_operator_redrive_applied"]);
    expect(alertMock.mock.calls[0]![1]).toMatchObject({ go: GO, sourceDealId: DEAL, sourceEventId: KEY, coreId: core[0].id });
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
