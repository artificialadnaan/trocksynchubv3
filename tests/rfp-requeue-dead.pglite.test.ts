import { readFileSync } from "fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// S1b: the Requeue CLI (CONTRACT v2.4 §10 "Requeue CLI"; d9's 11-10 ruling 1) on the REAL S0 enqueue + the real 0023 / 0027
// migrations (PGlite). --outbox create|followup, exactly one --id, a REQUIRED --destination equal to the command row's
// stamp; dry by default, --apply needs --go. create: only a dead E2 row; followup: only a dead crm_link (E4) or crm_notice
// (N1); link_refused and core_confirm (E5, never dead) are refused, as is every non-dead status. Apply = S0's re-arm reset
// EXACTLY (compared with a real S0 re-post) + ONE audit_logs row + the alert rfp_requeue_applied; a replay is refused.
// r2 (d9 Q3): a REQUIRED --actor, recorded on the audit row with the OS user. r2 (d9 Q4, a pin): a requeued dead E2 for a
// deal with a Procore footprint is held_cross_destination at send (alert + F1) by the sender's under-lock check.
// Synthetic data only (I7).
const dbHolder = vi.hoisted(() => ({ db: null as any }));
const alertMock = vi.hoisted(() => vi.fn(async (_code: string, _detail: Record<string, unknown>) => {}));
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

const { enqueueBidboardCreateCommand } = await import("../server/sync/bidboard-create-worker.ts");
const { runRequeueDead } = await import("../server/sync/rfp-requeue-dead.ts");
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
const DEAL_2 = "00000000-0000-4000-8000-0000000000a2";
const KEY = "crm:rfp-vote:approved:round-7";
const KEY_2 = "crm:rfp-vote:approved:round-9";
const GO = "A4-GO-SYN-REQUEUE-0001";
const ACTOR = "Synthetic Operator";
const OS_USER = "os:synthetic-runner";
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
                 DELETE FROM bidboard_callback_outbox; DELETE FROM audit_logs; DELETE FROM sync_mappings;`);
  alertMock.mockReset();
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RFP_NONSERVICE_DESTINATION = "core";
  resetRfpCoreSenderStateForTests();
}

function e1(deal = DEAL, key = KEY): any {
  return {
    sourceSystem: "trock_crm", sourceDealId: deal, sourceEventId: key, decision: "approved", approvalKind: "vote", office: "dallas",
    approval: { roundEventId: "round-7", approvals: 2, rejections: 0, invitedVoterCount: 3, decidedAt: "2026-11-01T15:00:00.000Z" },
    deal: {
      name: "Synthetic Tower Reroof", projectNumber: "DFW-2-12345-ab", projectType: "2", amount: 1000, estimator: "Pat Example",
      companyId: "00000000-0000-4000-8000-0000000000c1", companyName: "Synthetic Builders LLC", contactName: "Sam Synthetic",
      clientEmail: "sam@example.test", clientPhone: null, propertyId: null,
      address: { street: "1 Example St", city: "Dallas", state: "TX", zip: "75001", country: "US" },
      description: null, dueDate: null, workflowRoute: "normal",
    },
    attachments: [],
  };
}
/** A core-stamped create (the real S0 enqueue under setting core), its Core row then set to `status` as the sender would. */
async function seedCore(status: string, deal = DEAL, key = KEY): Promise<number> {
  await enqueueBidboardCreateCommand(e1(deal, key));
  const r = await pg.query<any>(
    `UPDATE rfp_core_create_outbox
        SET status = $1, attempt_count = 6, e2_ever_sent = true, last_error = 'Core rfp-bid-create returned 503',
            last_status_code = 503, last_attempt_at = NOW(), next_attempt_at = NOW() + interval '1 day'
      WHERE source_event_id = $2 RETURNING id`,
    [status, key],
  );
  return r.rows[0].id as number;
}
/** A sent create with one follow-up row of `kind` in `status` (E4 / E5 / N1 as the follow-up worker would leave it). */
async function seedFollowup(kind: string, status: string, noticeKind = ""): Promise<number> {
  const createId = await seedCore("sent");
  await pg.query(`UPDATE rfp_core_create_outbox SET core_bid_id = '00000000-0000-4000-8000-0000000000b1', last_error = NULL WHERE id = $1`, [createId]);
  const payload = kind === "crm_notice"
    ? { kind: noticeKind, noticeId: `rfp-core-notice:rfp_core_followup_outbox:900:${noticeKind}`, reason: "stale" }
    : { sourceEventId: KEY };
  const r = await pg.query<any>(
    `INSERT INTO rfp_core_followup_outbox (create_id, kind, notice_kind, notice_id, payload, status, attempt_count, last_error, last_status_code)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, 6, 'CRM returned 503', 503) RETURNING id`,
    [createId, kind, noticeKind, kind === "crm_notice" ? (payload as any).noticeId : null, JSON.stringify(payload), status],
  );
  return r.rows[0].id as number;
}
async function run(argv: string[]) {
  const lines: string[] = [];
  const res = await runRequeueDead(argv, { db: dbHolder.db, out: (l: string) => lines.push(l), osUser: OS_USER } as any);
  return { res, text: lines.join("\n") };
}
const createRow = async (id: number) => (await pg.query<any>(`SELECT * FROM rfp_core_create_outbox WHERE id = $1`, [id])).rows[0];
const followupRow = async (id: number) => (await pg.query<any>(`SELECT * FROM rfp_core_followup_outbox WHERE id = $1`, [id])).rows[0];
const auditRows = async () => (await pg.query<any>(`SELECT * FROM audit_logs ORDER BY id`)).rows;
const alertCodes = () => alertMock.mock.calls.map((c) => c[0]);
const APPLY = (outbox: string, id: number, destination = "core") =>
  ["--outbox", outbox, "--id", String(id), "--destination", destination, "--actor", ACTOR, "--apply", "--go", GO];
const f1Errors = async () =>
  (await pg.query<any>(`SELECT payload FROM bidboard_callback_outbox WHERE payload->>'status' = 'failed' ORDER BY id`)).rows.map((r) => r.payload.error);
function senderEnv() {
  process.env.RFP_NONSERVICE_DESTINATION = "core";
  process.env.RFP_BID_CREATE_INGRESS_SECRET_CURRENT = "synthetic-rfp-bid-create-secret-0123456789";
  process.env.CORE_INGRESS_BASE_URL = "https://core.example.test";
  process.env.TROCK_CRM_BASE_URL = "https://crm.example.test";
}

describe("arguments", () => {
  it("a missing or doubled --id ⇒ exit 2, nothing written", async () => {
    const id = await seedCore("dead");
    for (const argv of [
      ["--outbox", "create", "--destination", "core", "--actor", ACTOR, "--apply", "--go", GO],
      ["--outbox", "create", "--id", String(id), "--id", String(id), "--destination", "core", "--actor", ACTOR, "--apply", "--go", GO],
      ["--outbox", "create", "--id", "0", "--destination", "core", "--actor", ACTOR],
    ]) {
      const { res } = await run(argv);
      expect(res.code, argv.join(" ")).toBe(2);
    }
    expect((await createRow(id)).status).toBe("dead");
    expect(await auditRows()).toEqual([]);
  });
  it("a bad or missing --outbox, or a missing / bad --destination ⇒ exit 2", async () => {
    const id = await seedCore("dead");
    for (const argv of [
      ["--outbox", "e4", "--id", String(id), "--destination", "core", "--actor", ACTOR],
      ["--id", String(id), "--destination", "core", "--actor", ACTOR],
      ["--outbox", "create", "--id", String(id), "--actor", ACTOR],
      ["--outbox", "create", "--id", String(id), "--destination", "hubspot", "--actor", ACTOR],
    ]) {
      const { res } = await run(argv);
      expect(res.code, argv.join(" ")).toBe(2);
    }
    expect((await createRow(id)).status).toBe("dead");
  });
  it("--apply without --go ⇒ exit 2, nothing written, no alert", async () => {
    const id = await seedCore("dead");
    const { res } = await run(["--outbox", "create", "--id", String(id), "--destination", "core", "--actor", ACTOR, "--apply"]);
    expect(res).toMatchObject({ code: 2, applied: false });
    expect(res.refused).toContain("--go");
    expect((await createRow(id)).status).toBe("dead");
    expect(await auditRows()).toEqual([]);
    expect(alertCodes()).toEqual([]);
  });
  it("(Q3) --actor missing or blank ⇒ exit 2, nothing written, no alert", async () => {
    const id = await seedCore("dead");
    for (const argv of [
      ["--outbox", "create", "--id", String(id), "--destination", "core", "--apply", "--go", GO],
      ["--outbox", "create", "--id", String(id), "--destination", "core", "--actor", "  ", "--apply", "--go", GO],
      ["--outbox", "create", "--id", String(id), "--destination", "core"],
    ]) {
      const { res } = await run(argv);
      expect(res.code, argv.join(" ")).toBe(2);
      expect(res.refused, argv.join(" ")).toContain("--actor");
    }
    expect((await createRow(id)).status).toBe("dead");
    expect(await auditRows()).toEqual([]);
    expect(alertCodes()).toEqual([]);
  });
});

describe("checks: any false ⇒ refused, nothing written", () => {
  it("a --destination that is not the command row's stamp ⇒ refused", async () => {
    const id = await seedCore("dead");
    const { res, text } = await run(APPLY("create", id, "procore"));
    expect(res.code).toBe(1);
    expect(text).toContain("FAIL (destination)");
    expect((await createRow(id))).toMatchObject({ status: "dead", attempt_count: 6 });
    expect(await auditRows()).toEqual([]);
    expect(alertCodes()).toEqual([]);
  });
  it("create: every non-dead status (pending / sending / sent / refused / failed / held_cross_destination) ⇒ refused", async () => {
    for (const status of ["pending", "sending", "sent", "refused", "failed", "held_cross_destination"]) {
      await reset();
      const id = await seedCore(status);
      const { res, text } = await run(APPLY("create", id));
      expect(res.code, status).toBe(1);
      expect(text, status).toContain("FAIL (status)");
      expect((await createRow(id)).status, status).toBe(status);
      expect(await auditRows(), status).toEqual([]);
    }
  });
  it("followup: a link_refused E4 ⇒ refused (a person resolves it)", async () => {
    const id = await seedFollowup("crm_link", "link_refused");
    const { res, text } = await run(APPLY("followup", id));
    expect(res.code).toBe(1);
    expect(text).toContain("link_refused is never requeued");
    expect((await followupRow(id)).status).toBe("link_refused");
    expect(await auditRows()).toEqual([]);
  });
  it("followup: an E5 core_confirm ⇒ refused in ANY status (it never dead-letters)", async () => {
    for (const status of ["dead", "pending"]) {
      await reset();
      const id = await seedFollowup("core_confirm", status);
      const { res, text } = await run(APPLY("followup", id));
      expect(res.code, status).toBe(1);
      expect(text, status).toContain("FAIL (kind)");
      expect((await followupRow(id)).status, status).toBe(status);
    }
  });
  it("followup: every non-dead E4 / N1 status ⇒ refused; no such row ⇒ refused", async () => {
    const cases: Array<[string, string, string]> = [
      ["crm_link", "pending", ""], ["crm_link", "sending", ""], ["crm_link", "sent", ""], ["crm_link", "failed", ""],
      ["crm_link", "orphan_stale", ""], ["crm_notice", "sent", "core_bid_orphan"], ["crm_notice", "failed", "core_bid_orphan"],
    ];
    for (const [kind, status, noticeKind] of cases) {
      await reset();
      const id = await seedFollowup(kind, status, noticeKind);
      const { res, text } = await run(APPLY("followup", id));
      expect(res.code, `${kind} ${status}`).toBe(1);
      expect(text, `${kind} ${status}`).toContain("FAIL (status)");
      expect((await followupRow(id)).status, `${kind} ${status}`).toBe(status);
    }
    await reset();
    const missing = await run(APPLY("followup", 424242));
    expect(missing.res.code).toBe(1);
    expect(missing.text).toContain("FAIL (row)");
    expect(await auditRows()).toEqual([]);
  });
  it("a dry run prints each check and writes nothing", async () => {
    const id = await seedCore("dead");
    const { res, text } = await run(["--outbox", "create", "--id", String(id), "--destination", "core", "--actor", ACTOR]);
    expect(res).toMatchObject({ code: 0, applied: false });
    for (const key of ["row", "destination", "status"]) expect(text, key).toContain(`PASS (${key})`);
    expect(text).toContain("DRY-RUN");
    expect(await createRow(id)).toMatchObject({ status: "dead", attempt_count: 6, last_error: "Core rfp-bid-create returned 503" });
    expect(await auditRows()).toEqual([]);
    expect(alertCodes()).toEqual([]);
  });
});

describe("--apply", () => {
  it("create: flips exactly ONE dead row to pending with S0's re-arm reset + ONE audit row + ONE alert", async () => {
    const id = await seedCore("dead");
    const other = await seedCore("dead", DEAL_2, KEY_2);
    const before = await createRow(id);
    const { res } = await run(APPLY("create", id));
    expect(res).toMatchObject({ code: 0, applied: true, rowId: id });
    const after = await createRow(id);
    expect(after).toMatchObject({
      status: "pending", attempt_count: 0, last_error: null, refusal_reason: null, project_number: before.project_number,
      e2_ever_sent: true, source_event_id: KEY,
    });
    expect(new Date(after.next_attempt_at).getTime()).toBeLessThan(new Date(before.next_attempt_at).getTime());
    expect((await createRow(other)).status).toBe("dead");
    const audit = await auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "rfp_requeue_dead", entity_type: "rfp_core_create_outbox", entity_id: String(id), status: "success" });
    expect(audit[0].details).toMatchObject({
      actor: ACTOR, osUser: OS_USER, go: GO, outbox: "create", id, destination: "core", before: { status: "dead" }, after: { status: "pending" },
    });
    expect(alertCodes()).toEqual(["rfp_requeue_applied"]);
    expect(alertMock.mock.calls[0]![1]).toMatchObject({ go: GO, outbox: "create", id });
  });
  it("create: the reset is S0's re-arm reset EXACTLY (compared with a real CRM re-post of an identical dead row)", async () => {
    const viaCli = await seedCore("dead");
    const viaS0 = await seedCore("dead", DEAL_2, KEY_2);
    const { res } = await run(APPLY("create", viaCli));
    expect(res.code).toBe(0);
    await enqueueBidboardCreateCommand(e1(DEAL_2, KEY_2)); // S0 §2 RE-ARM (stamp core = ROUTE NOW, not yet sent)
    const pick = (r: any) => ({
      status: r.status, attempt_count: r.attempt_count, last_error: r.last_error, refusal_reason: r.refusal_reason,
      project_number: r.project_number, e2_ever_sent: r.e2_ever_sent, last_status_code: r.last_status_code,
      core_bid_id: r.core_bid_id, payload: r.payload, due: new Date(r.next_attempt_at).getTime() <= Date.now() + 1000,
    });
    expect(pick(await createRow(viaCli))).toEqual(pick(await createRow(viaS0)));
  });
  it("followup: a dead E4 and a dead N1 ⇒ pending (N1's noticeId and stored body untouched) + an audit row + an alert each", async () => {
    const e4 = await seedFollowup("crm_link", "dead");
    const r1 = await run(APPLY("followup", e4));
    expect(r1.res).toMatchObject({ code: 0, applied: true });
    expect(await followupRow(e4)).toMatchObject({ status: "pending", attempt_count: 0, last_error: null });
    await reset();
    const n1 = await seedFollowup("crm_notice", "dead", "core_bid_orphan");
    const before = await followupRow(n1);
    const r2 = await run(APPLY("followup", n1));
    expect(r2.res).toMatchObject({ code: 0, applied: true });
    const after = await followupRow(n1);
    expect(after).toMatchObject({ status: "pending", attempt_count: 0, last_error: null, notice_id: before.notice_id, payload: before.payload });
    expect(await auditRows()).toHaveLength(1);
    expect(alertCodes()).toEqual(["rfp_requeue_applied"]);
  });
  it("a replay on the now-pending row ⇒ refused: still ONE audit row and ONE alert", async () => {
    const id = await seedCore("dead");
    expect((await run(APPLY("create", id))).res.code).toBe(0);
    const replay = await run(APPLY("create", id));
    expect(replay.res).toMatchObject({ code: 1, applied: false });
    expect(replay.text).toContain("FAIL (status)");
    expect(await auditRows()).toHaveLength(1);
    expect(alertCodes()).toEqual(["rfp_requeue_applied"]);
  });
});

describe("(Q4) a requeued dead E2 for a deal with a Procore footprint is held at send", () => {
  it("(pin) the sender's under-lock check holds a re-armed (S0 reset shape) dead E2 when the deal has a Procore footprint: held_cross_destination + alert + F1, nothing sent", async () => {
    const id = await seedCore("dead");
    await pg.query(
      `UPDATE rfp_core_create_outbox SET status = 'pending', attempt_count = 0, next_attempt_at = NOW(), last_error = NULL, refusal_reason = NULL WHERE id = $1`,
      [id],
    );
    await pg.query(`INSERT INTO sync_mappings (source_system, source_deal_id, bidboard_project_id) VALUES ('trock_crm', $1, '900031')`, [DEAL]);
    senderEnv();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 201 }));
    await processRfpCoreCreateOutbox({ fetchImpl: fetchImpl as any });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await createRow(id)).toMatchObject({ status: "held_cross_destination" });
    expect(alertCodes()).toContain("cross_destination_hold");
    expect(await f1Errors()).toEqual(["cross_destination_hold"]);
  });
  it("end to end: requeue a dead E2 through the CLI, the deal has gained a Procore footprint ⇒ the sender holds it (held + alert + F1), nothing sent", async () => {
    const id = await seedCore("dead");
    await pg.query(`INSERT INTO sync_mappings (source_system, source_deal_id, bidboard_project_id) VALUES ('trock_crm', $1, '900032')`, [DEAL]);
    const { res } = await run(APPLY("create", id));
    expect(res).toMatchObject({ code: 0, applied: true });
    expect((await createRow(id)).status).toBe("pending");
    senderEnv();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 201 }));
    await processRfpCoreCreateOutbox({ fetchImpl: fetchImpl as any });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await createRow(id)).toMatchObject({ status: "held_cross_destination" });
    expect(alertCodes()).toEqual(["rfp_requeue_applied", "cross_destination_hold"]);
    expect(await f1Errors()).toEqual(["cross_destination_hold"]);
  });
});
