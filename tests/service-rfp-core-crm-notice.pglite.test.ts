import { readFileSync } from "fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// #125 review, against the REAL outbox DDL and the drain's actual SQL:
//   - the refusal instant is computed in SQL: last_attempt_at is `timestamp` WITHOUT time zone, holding the session
//     zone's wall clock, so a JS parse of it is off by however far the session zone is from the Node process's;
//   - settle and reschedule match the GENERATION they claimed (last_attempt_at): an older callback still in flight
//     when a re-drive drew a newer refusal must neither settle nor delay that newer one.
const dbHolder = vi.hoisted(() => ({ db: null as any }));
vi.mock("../server/db.ts", () => ({
  get db() {
    return dbHolder.db;
  },
}));
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));
vi.mock("../server/sync/service-rfp-core-alert.ts", () => ({ recordServiceRfpCrmNoticeOutcome: vi.fn(async () => undefined) }));

const DDL = readFileSync(new URL("../migrations/0025_create_service_rfp_core_outbox.sql", import.meta.url), "utf8");
const CRM_DEAL_ID = "9f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const deps = (status: number) => ({
  fetchImpl: vi.fn(async () => new Response("{}", { status })) as any,
  secret: "crm-callback-secret",
  targetUrl: "https://crm.example.com/api/internal/core-rfp-handoff",
});

let pg: PGlite;

beforeEach(async () => {
  pg = new PGlite();
  // A session zone far from any Node process zone (UTC+14), so a process-local parse cannot happen to agree.
  await pg.exec(`SET TimeZone = 'Pacific/Kiritimati'`);
  await pg.exec(DDL);
  dbHolder.db = drizzle(pg);
  vi.resetModules();
});

async function parkRefusal(): Promise<number> {
  const res = await pg.query(
    `INSERT INTO service_rfp_core_outbox
       (source_system, source_deal_id, rfp_request_id, payload, status, attempt_count, last_status_code, last_error, last_attempt_at, next_attempt_at)
     VALUES ('trock_crm', $1, 77, $2::jsonb, 'crm_notify_refused', 1, 409, 'Core refused the approval: live_project', NOW(), NOW() - interval '1 minute')
     RETURNING id`,
    [CRM_DEAL_ID, JSON.stringify({ office: "dallas", rfp: { requestId: 77 }, deal: { id: CRM_DEAL_ID } })],
  );
  return Number((res.rows[0] as any).id);
}

/** An operator re-drive that drew ANOTHER Core refusal while the first notice was in flight. */
async function newerRefusal(id: number): Promise<void> {
  await pg.query(
    `UPDATE service_rfp_core_outbox
        SET status = 'crm_notify_refused', attempt_count = 2, last_attempt_at = NOW() + interval '3 seconds',
            next_attempt_at = NOW() - interval '1 minute'
      WHERE id = $1`,
    [id],
  );
}

const row = async (id: number) =>
  (await pg.query(`SELECT status, attempt_count, (next_attempt_at <= NOW()) AS due FROM service_rfp_core_outbox WHERE id = $1`, [id])).rows[0] as any;

describe("CRM notice drain against the real outbox (#125)", () => {
  it("signs the true refusal instant, whatever the session zone", async () => {
    await parkRefusal();
    const { claimCrmNoticeRows, crmNoticeForRow } = await import("../server/sync/service-rfp-core-crm-notice.ts");
    const [claimed] = await claimCrmNoticeRows();
    const notice = crmNoticeForRow(claimed);
    expect(notice).not.toBeNull();
    expect(Math.abs(new Date(notice!.occurredAt).getTime() - Date.now())).toBeLessThan(60_000);
  });

  it("an older notice that lands after a newer refusal does not settle it", async () => {
    const id = await parkRefusal();
    const { claimCrmNoticeRows, notifyCrmForRow } = await import("../server/sync/service-rfp-core-crm-notice.ts");
    const [claimed] = await claimCrmNoticeRows();
    await newerRefusal(id);

    expect(await notifyCrmForRow(claimed, deps(200))).toBe("sent");

    expect(await row(id)).toEqual({ status: "crm_notify_refused", attempt_count: 2, due: true });
  });

  it("an older notice's retry does not delay a newer refusal", async () => {
    const id = await parkRefusal();
    const { claimCrmNoticeRows, notifyCrmForRow } = await import("../server/sync/service-rfp-core-crm-notice.ts");
    const [claimed] = await claimCrmNoticeRows();
    await newerRefusal(id);

    expect(await notifyCrmForRow(claimed, deps(503))).toBe("retrying");

    expect(await row(id)).toEqual({ status: "crm_notify_refused", attempt_count: 2, due: true });
  });

  it("still settles its own generation", async () => {
    const id = await parkRefusal();
    const { claimCrmNoticeRows, notifyCrmForRow } = await import("../server/sync/service-rfp-core-crm-notice.ts");
    const [claimed] = await claimCrmNoticeRows();

    expect(await notifyCrmForRow(claimed, deps(200))).toBe("sent");

    expect((await row(id)).status).toBe("failed");
  });
});
