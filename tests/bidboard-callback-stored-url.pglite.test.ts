import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";

// CodeRabbit 4536104336 on #130 (a4 ruling + ADDENDUM-1). The callback worker checked only the CURRENT config before claiming,
// so a due row whose STORED target_url fails the v2 URL rule (non-local http) was claimed, refused at crmV2Headers, marked
// failed, and eventually dead: a lost CRM callback. The claim now admits only the rows its SQL predicate admits (a fail-closed
// mirror of crmUrlAllowed, bound as parameters); a row the SQL admits but the TS rule refuses is RELEASED unchanged; the
// rows the SQL excluded are counted after the claim, with ONE alert (deduped per the confirmed-delivery rule). Excluded and
// released rows keep status / attempts / next_attempt_at / target_url byte for byte; no stored URL is rewritten. PGlite runs
// the REAL worker SQL. Synthetic hosts only.

const dbHolder = vi.hoisted(() => ({ db: null as any }));
const alertMock = vi.hoisted(() => vi.fn(async (_code: string, _detail: Record<string, unknown>) => true));
vi.mock("../server/db.ts", () => ({ get db() { return dbHolder.db; } }));
vi.mock("../server/sync/rfp-core-alert.ts", () => ({ raiseRfpCoreAlert: alertMock }));
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));

const SECRET = "synthetic-callback-secret-0123456789abcdef"; // >= 32 bytes, synthetic
const VALID_URL = "https://crm-sales.ops-example.test/api/internal/bid-board-created";
/** The only rows where the claim's SQL admits a URL that crmUrlAllowed refuses (a4 ADDENDUM-3 (A)). Synthetic hosts. */
const SQL_ADMITS_TS_REFUSES = [
  "https://999.0.0.1/api/internal/bid-board-created",
  "https://crm.example.com:99999/api/internal/bid-board-created",
];
const DDL = `
  CREATE TABLE bidboard_callback_outbox (
    id serial PRIMARY KEY, source_system text NOT NULL, source_deal_id text NOT NULL, rfp_approval_request_id integer,
    payload jsonb NOT NULL, target_url text NOT NULL, status text NOT NULL DEFAULT 'pending',
    attempt_count integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 5, last_error text,
    last_attempt_at timestamp, next_attempt_at timestamp NOT NULL DEFAULT now(), created_at timestamp NOT NULL DEFAULT now(),
    sent_at timestamp
  );
`;

let pg: PGlite;
beforeEach(async () => {
  pg = new PGlite();
  await pg.exec(DDL);
  dbHolder.db = drizzle(pg);
  alertMock.mockClear();
  alertMock.mockResolvedValue(true);
  process.env.RFP_REQUEST_SYNC_SECRET = SECRET;
  process.env.TROCK_CRM_BASE_URL = "https://crm-sales.ops-example.test";
  (await import("../server/crm-signing-v2.ts")).resetCrmSigningRefusalsForTests();
}, 30000);

async function insertDue(id: number, targetUrl: string) {
  await pg.query(
    `INSERT INTO bidboard_callback_outbox (id, source_system, source_deal_id, rfp_approval_request_id, payload, target_url, next_attempt_at, created_at)
     VALUES ($1, 'trock_crm', $2, $1, $3::jsonb, $4, now() - interval '1 minute', now() - make_interval(secs => 60 - $1))`,
    [id, `crm-deal-${id}`, JSON.stringify({ sourceDealId: `crm-deal-${id}`, rfpApprovalRequestId: id, createdAt: "2026-11-11T00:00:00.000Z" }), targetUrl],
  );
}
/** The row's state as text, so a byte-for-byte comparison covers the timestamps too. */
async function rowState(id: number) {
  const r = await pg.query<any>(
    `SELECT status, attempt_count, last_error, last_attempt_at::text, next_attempt_at::text, target_url, sent_at::text FROM bidboard_callback_outbox WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

describe("CodeRabbit 4536104336 on #130: a stored target_url the v2 URL rule refuses is never claimed into failure", () => {
  it("parity: the claim's SQL predicate admits a subset of crmUrlAllowed, and the same set on the realistic cases (table)", async () => {
    const worker = await import("../server/sync/bidboard-callback-worker.ts");
    const { crmUrlAllowed } = await import("../server/crm-signing-v2.ts");
    expect(typeof (worker as any).callbackUrlAdmittedSql).toBe("function");
    // [url, TS admits, SQL admits]. SQL is stricter only where stated: userinfo, surrounding whitespace (TS trims; SQL does not),
    // and (CodeRabbit 4536816201, declined: fail-closed, the row stays pending unchanged with ONE alert) a bracketed IPv6 host.
    const cases: Array<[string | null, boolean, boolean]> = [
      ["https://crm-sales.ops-example.test/api/internal/bid-board-created", true, true],
      ["https://crm.example.com:8443/api/internal/bid-board-created", true, true],
      ["https://crm.example.com", true, true],
      ["HTTPS://CRM.EXAMPLE.COM/API/INTERNAL/BID-BOARD-CREATED", true, true],
      ["https://user:pw@crm.example.com/api/internal/bid-board-created", true, false],
      ["  https://crm.example.com/api/internal/bid-board-created  ", true, false],
      ["https://[::1]:3001/api/internal/bid-board-created", true, false],
      ["http://localhost/api/internal/bid-board-created", true, true],
      ["http://localhost:3001/api/internal/bid-board-created", true, true],
      ["HTTP://LOCALHOST:3001/api/internal/bid-board-created", true, true],
      ["http://127.0.0.1:3001/api/internal/bid-board-created", true, true],
      ["http://[::1]:3001/api/internal/bid-board-created", false, false],
      ["http://127x0x0x1/api/internal/bid-board-created", false, false],
      ["http://localhost.evil.test/api/internal/bid-board-created", false, false],
      ["http://localhost@evil.test/api/internal/bid-board-created", false, false],
      ["http://crm.example.test/api/internal/bid-board-created", false, false],
      ["ftp://crm.example.com/api/internal/bid-board-created", false, false],
      ["", false, false],
      [null, false, false],
      // Codex 4536463189 (a4 ADDENDUM-3 (A)): the declared gap. The SQL admits these https shapes, the URL parser refuses them
      // (an invalid IPv4 host; a port above 65535), so the worker RELEASES them after the claim and remembers the pair.
      [SQL_ADMITS_TS_REFUSES[0], false, true],
      [SQL_ADMITS_TS_REFUSES[1], false, true],
    ];
    const got: Array<[string | null, boolean, boolean]> = [];
    for (const [url] of cases) {
      const r: any = await dbHolder.db.execute(sql`SELECT ${(worker as any).callbackUrlAdmittedSql(sql`${url}::text`)} AS admitted`);
      const rows = Array.isArray(r) ? r : r.rows;
      got.push([url, crmUrlAllowed(url), rows[0].admitted === true]);
    }
    expect(got).toEqual(cases);
    for (const [url, ts, sqlAdmits] of got) {
      if (sqlAdmits && !SQL_ADMITS_TS_REFUSES.includes(url as string)) expect([url, ts]).toEqual([url, true]);
    }
  });

  it("refused stored URLs (non-local http, the 127x0x0x1 near miss) are NOT claimed: unchanged byte for byte, ONE alert across two ticks; the valid rows in the same pass are sent", async () => {
    await insertDue(1, "https://crm-sales.ops-example.test/api/internal/bid-board-created");
    await insertDue(2, "http://crm.example.test/api/internal/bid-board-created");
    await insertDue(3, "http://127x0x0x1/api/internal/bid-board-created");
    await insertDue(4, "http://127.0.0.1:3001/api/internal/bid-board-created");
    const before2 = await rowState(2);
    const before3 = await rowState(3);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const { processBidBoardCallbackOutbox } = await import("../server/sync/bidboard-callback-worker.ts");
    await processBidBoardCallbackOutbox({ fetchImpl: fetchMock as any, secret: SECRET });
    await processBidBoardCallbackOutbox({ fetchImpl: fetchMock as any, secret: SECRET });
    expect(fetchMock.mock.calls.map((c: any[]) => String(c[0])).sort()).toEqual([
      "http://127.0.0.1:3001/api/internal/bid-board-created",
      "https://crm-sales.ops-example.test/api/internal/bid-board-created",
    ]);
    expect((await rowState(1)).status).toBe("sent");
    expect((await rowState(4)).status).toBe("sent");
    expect(await rowState(2)).toEqual(before2);
    expect(await rowState(3)).toEqual(before3);
    expect(before2).toMatchObject({ status: "pending", attempt_count: 0, last_error: null, last_attempt_at: null });
    const refusals = alertMock.mock.calls.filter((c) => c[0] === "crm_signing_refused");
    expect(refusals).toHaveLength(1);
    expect(refusals[0][1]).toMatchObject({ reason: "url_refused" });
  });

  it("a row the SQL admits but the TS rule refuses (an invalid numeric host) is RELEASED: status, attempts, timestamps unchanged, never failed, ONE alert", async () => {
    await insertDue(5, "https://999.0.0.1/api/internal/bid-board-created");
    const before = await rowState(5);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const { processBidBoardCallbackOutbox } = await import("../server/sync/bidboard-callback-worker.ts");
    await processBidBoardCallbackOutbox({ fetchImpl: fetchMock as any, secret: SECRET });
    await processBidBoardCallbackOutbox({ fetchImpl: fetchMock as any, secret: SECRET });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await rowState(5)).toEqual(before);
    expect(alertMock.mock.calls.filter((c) => c[0] === "crm_signing_refused")).toHaveLength(1);
  });
});

// Codex 4536463189 on #130 (a4 ADDENDUM-2 / -3). Released rows were claimed again on the next tick: with >= `limit` of them the
// oldest due, every tick re-claimed the same rows and a later valid callback never went out. The worker now remembers each
// released (id, stored target_url) pair in-process and the claim skips a row while BOTH still match. Stored rows stay byte for
// byte. Each case uses its own ids, so pairs remembered by an earlier case never match.
describe("Codex 4536463189 on #130: released URL refusals never starve later callbacks", () => {
  const refusals = () => alertMock.mock.calls.filter((c) => c[0] === "crm_signing_refused");

  it("Codex repro: 5 released rows the oldest due + 1 valid row: the valid row is SENT within 2 ticks, the 5 stay unchanged, ONE alert", async () => {
    for (const id of [11, 12, 13, 14, 15]) await insertDue(id, SQL_ADMITS_TS_REFUSES[id % 2]);
    await insertDue(16, VALID_URL);
    const before = await Promise.all([11, 12, 13, 14, 15].map(rowState));
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const { processBidBoardCallbackOutbox } = await import("../server/sync/bidboard-callback-worker.ts");
    await processBidBoardCallbackOutbox({ fetchImpl: fetchMock as any, secret: SECRET });
    await processBidBoardCallbackOutbox({ fetchImpl: fetchMock as any, secret: SECRET });
    expect(fetchMock.mock.calls.map((c: any[]) => String(c[0]))).toEqual([VALID_URL]);
    expect((await rowState(16)).status).toBe("sent");
    expect(await Promise.all([11, 12, 13, 14, 15].map(rowState))).toEqual(before);
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0][1]).toMatchObject({ reason: "url_refused" });
  });

  it("(guard) the remembered rows keep the stored-URL alert armed: a later refused row raises no second alert, nothing changes", async () => {
    for (const id of [31, 32, 33, 34, 35]) await insertDue(id, SQL_ADMITS_TS_REFUSES[0]);
    const before = await Promise.all([31, 32, 33, 34, 35].map(rowState));
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const { processBidBoardCallbackOutbox } = await import("../server/sync/bidboard-callback-worker.ts");
    await processBidBoardCallbackOutbox({ fetchImpl: fetchMock as any, secret: SECRET });
    await processBidBoardCallbackOutbox({ fetchImpl: fetchMock as any, secret: SECRET });
    await insertDue(36, "http://crm.example.test/api/internal/bid-board-created");
    await processBidBoardCallbackOutbox({ fetchImpl: fetchMock as any, secret: SECRET });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await Promise.all([31, 32, 33, 34, 35].map(rowState))).toEqual(before);
    expect(refusals()).toHaveLength(1);
  });

  it("(guard, a4 ADDENDUM-3 (B)) a remembered row whose stored target_url is rewritten to a valid URL is SENT on the next tick", async () => {
    for (const id of [41, 42, 43, 44, 45]) await insertDue(id, SQL_ADMITS_TS_REFUSES[0]);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const { processBidBoardCallbackOutbox } = await import("../server/sync/bidboard-callback-worker.ts");
    await processBidBoardCallbackOutbox({ fetchImpl: fetchMock as any, secret: SECRET });
    const before = await Promise.all([42, 43, 44, 45].map(rowState));
    // The shape of rfp-approving's hold upsert (ON CONFLICT ... SET target_url = EXCLUDED.target_url, status = 'pending'):
    // the same row id now carries the corrected URL.
    await pg.query(`UPDATE bidboard_callback_outbox SET target_url = $1, status = 'pending' WHERE id = 41`, [VALID_URL]);
    await processBidBoardCallbackOutbox({ fetchImpl: fetchMock as any, secret: SECRET });
    expect(fetchMock.mock.calls.map((c: any[]) => String(c[0]))).toEqual([VALID_URL]);
    expect((await rowState(41)).status).toBe("sent");
    expect(await Promise.all([42, 43, 44, 45].map(rowState))).toEqual(before);
  });

  // Runs LAST: vi.resetModules() is the restart, so every later import in this file gets fresh in-process state.
  it("restart: the remembered pairs reset, the 5 released rows are found again, and the valid row is SENT within ceil(5 / 5) + 1 ticks", async () => {
    for (const id of [21, 22, 23, 24, 25]) await insertDue(id, SQL_ADMITS_TS_REFUSES[id % 2]);
    await insertDue(26, VALID_URL);
    const before = await Promise.all([21, 22, 23, 24, 25].map(rowState));
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const first = await import("../server/sync/bidboard-callback-worker.ts");
    await first.processBidBoardCallbackOutbox({ fetchImpl: fetchMock as any, secret: SECRET });
    vi.resetModules();
    const restarted = await import("../server/sync/bidboard-callback-worker.ts");
    expect(restarted).not.toBe(first);
    await restarted.processBidBoardCallbackOutbox({ fetchImpl: fetchMock as any, secret: SECRET });
    await restarted.processBidBoardCallbackOutbox({ fetchImpl: fetchMock as any, secret: SECRET });
    expect(fetchMock.mock.calls.map((c: any[]) => String(c[0]))).toEqual([VALID_URL]);
    expect((await rowState(26)).status).toBe("sent");
    expect(await Promise.all([21, 22, 23, 24, 25].map(rowState))).toEqual(before);
    // The alert dedupe is in-process too: ONE alert per process lifetime.
    expect(refusals()).toHaveLength(2);
  });
});
