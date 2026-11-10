import { readFileSync } from "fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// S1b: the Requeue CLI (CONTRACT v2.4 §10 "Requeue CLI"; d9's 11-10 ruling 1) on the REAL S0 enqueue + the real 0023 / 0027
// migrations (PGlite). --outbox create|followup, exactly one --id, a REQUIRED --destination equal to the command row's
// stamp; dry by default, --apply needs --go. create: only a dead E2 row; followup: only a dead crm_link (E4) or crm_notice
// (N1); link_refused and core_confirm (E5, never dead) are refused, as is every non-dead status. Apply = S0's re-arm reset
// EXACTLY (compared with a real S0 re-post) + ONE audit_logs row + the alert rfp_requeue_applied; a replay is refused.
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
const ACTOR = "ops:synthetic-tester";

let pg: PGlite;
let savedSetting: string | undefined;
beforeAll(async () => {
  savedSetting = process.env.RFP_NONSERVICE_DESTINATION;
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE bidboard_callback_outbox (
      id serial PRIMARY KEY, source_system text NOT NULL, source_deal_id text NOT NULL,
      rfp_approval_request_id integer NOT NULL, payload jsonb NOT NULL, target_url text NOT NULL,
      status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now()
    );
    ${AUDIT_DDL}
  `);
  await pg.exec(DDL_0023);
  await pg.exec(DDL_0027);
  dbHolder.db = drizzle(pg);
}, 30000);
afterAll(async () => {
  if (savedSetting === undefined) delete process.env.RFP_NONSERVICE_DESTINATION;
  else process.env.RFP_NONSERVICE_DESTINATION = savedSetting;
  await pg?.close?.();
});
beforeEach(async () => {
  await reset();
});
async function reset() {
  await pg.exec(`DELETE FROM rfp_core_followup_outbox; DELETE FROM rfp_core_create_outbox; DELETE FROM bidboard_create_outbox;
                 DELETE FROM bidboard_callback_outbox; DELETE FROM audit_logs;`);
  alertMock.mockReset();
  process.env.RFP_NONSERVICE_DESTINATION = "core";
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
  const res = await runRequeueDead(argv, { db: dbHolder.db, out: (l: string) => lines.push(l), actor: ACTOR });
  return { res, text: lines.join("\n") };
}
const createRow = async (id: number) => (await pg.query<any>(`SELECT * FROM rfp_core_create_outbox WHERE id = $1`, [id])).rows[0];
const followupRow = async (id: number) => (await pg.query<any>(`SELECT * FROM rfp_core_followup_outbox WHERE id = $1`, [id])).rows[0];
const auditRows = async () => (await pg.query<any>(`SELECT * FROM audit_logs ORDER BY id`)).rows;
const alertCodes = () => alertMock.mock.calls.map((c) => c[0]);
const APPLY = (outbox: string, id: number, destination = "core") => ["--outbox", outbox, "--id", String(id), "--destination", destination, "--apply", "--go", GO];

describe("arguments", () => {
  it("a missing or doubled --id ⇒ exit 2, nothing written", async () => {
    const id = await seedCore("dead");
    for (const argv of [
      ["--outbox", "create", "--destination", "core", "--apply", "--go", GO],
      ["--outbox", "create", "--id", String(id), "--id", String(id), "--destination", "core", "--apply", "--go", GO],
      ["--outbox", "create", "--id", "0", "--destination", "core"],
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
      ["--outbox", "e4", "--id", String(id), "--destination", "core"],
      ["--id", String(id), "--destination", "core"],
      ["--outbox", "create", "--id", String(id)],
      ["--outbox", "create", "--id", String(id), "--destination", "hubspot"],
    ]) {
      const { res } = await run(argv);
      expect(res.code, argv.join(" ")).toBe(2);
    }
    expect((await createRow(id)).status).toBe("dead");
  });
  it("--apply without --go ⇒ exit 2, nothing written, no alert", async () => {
    const id = await seedCore("dead");
    const { res } = await run(["--outbox", "create", "--id", String(id), "--destination", "core", "--apply"]);
    expect(res).toMatchObject({ code: 2, applied: false });
    expect(res.refused).toContain("--go");
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
    const { res, text } = await run(["--outbox", "create", "--id", String(id), "--destination", "core"]);
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
    expect(audit[0].details).toMatchObject({ actor: ACTOR, go: GO, outbox: "create", id, destination: "core", before: { status: "dead" }, after: { status: "pending" } });
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
