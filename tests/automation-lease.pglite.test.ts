import { beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// SyncHub #63: the role-polling rotation is owned by ONE replica via a lease row in automation_config. Run the
// ACTUAL lease SQL against real Postgres: acquire/renew/takeover/release, and the cursor write fenced by it.
const dbHolder = vi.hoisted(() => ({ db: null as any, pool: null as any }));
vi.mock("../server/db.ts", () => ({
  get db() {
    return dbHolder.db;
  },
  get pool() {
    return dbHolder.pool;
  },
}));

const { storage } = await import("../server/storage.ts");

let pg: PGlite;
const LEASE = "role_assignment_polling_lease";
const CURSOR = "role_assignment_polling_cursor";

beforeEach(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE automation_config (
      id SERIAL PRIMARY KEY,
      key text NOT NULL UNIQUE,
      value jsonb NOT NULL,
      description text,
      is_active boolean NOT NULL DEFAULT true,
      updated_at timestamp DEFAULT now()
    );
  `);
  dbHolder.pool = pg;
  dbHolder.db = drizzle(pg);
});

const read = async (key: string) =>
  ((await pg.query<{ value: any }>(`SELECT value FROM automation_config WHERE key = $1`, [key])).rows[0]?.value);
const expire = (key: string) =>
  pg.query(`UPDATE automation_config SET value = jsonb_set(value, '{expiresAt}', '1') WHERE key = $1`, [key]);

describe("tryAcquireAutomationLease (real Postgres)", () => {
  it("one owner at a time: the holder renews, another replica is refused until it expires", async () => {
    expect(await storage.tryAcquireAutomationLease(LEASE, "replica-a", 180_000)).toBe(true);
    expect(await storage.tryAcquireAutomationLease(LEASE, "replica-b", 180_000)).toBe(false);
    expect(await storage.tryAcquireAutomationLease(LEASE, "replica-a", 180_000)).toBe(true);
    expect((await read(LEASE)).owner).toBe("replica-a");

    await expire(LEASE);
    expect(await storage.tryAcquireAutomationLease(LEASE, "replica-b", 180_000)).toBe(true);
    expect(await storage.tryAcquireAutomationLease(LEASE, "replica-a", 180_000)).toBe(false);
    expect((await read(LEASE)).owner).toBe("replica-b");
  });

  it("expiry is on the database clock, in the future by the TTL", async () => {
    await storage.tryAcquireAutomationLease(LEASE, "replica-a", 180_000);
    const { rows } = await pg.query<{ now: string }>(`SELECT (extract(epoch from clock_timestamp()) * 1000)::bigint AS now`);
    const delta = Number((await read(LEASE)).expiresAt) - Number(rows[0].now);
    expect(delta).toBeGreaterThan(170_000);
    expect(delta).toBeLessThanOrEqual(180_000);
  });

  it("a junk row (non-object, or no numeric expiry) counts as expired, never as held", async () => {
    for (const junk of ["x", 42, [1], { owner: "ghost" }, { owner: "ghost", expiresAt: "9999999999999" }]) {
      await pg.exec(`DELETE FROM automation_config`);
      await pg.query(`INSERT INTO automation_config (key, value) VALUES ($1, $2::jsonb)`, [LEASE, JSON.stringify(junk)]);
      expect(await storage.tryAcquireAutomationLease(LEASE, "replica-a", 180_000)).toBe(true);
    }
  });

  it("release lets another replica take over at once; a non-owner cannot release it", async () => {
    await storage.tryAcquireAutomationLease(LEASE, "replica-a", 180_000);
    await storage.releaseAutomationLease(LEASE, "replica-b");
    expect(await storage.tryAcquireAutomationLease(LEASE, "replica-b", 180_000)).toBe(false);
    await storage.releaseAutomationLease(LEASE, "replica-a");
    expect(await storage.tryAcquireAutomationLease(LEASE, "replica-b", 180_000)).toBe(true);
  });
});

describe("patchAutomationConfigIfLeaseHeld (real Postgres)", () => {
  it("only the current holder moves the cursor; a replica that lost the lease writes nothing", async () => {
    await storage.tryAcquireAutomationLease(LEASE, "replica-a", 180_000);
    expect(await storage.patchAutomationConfigIfLeaseHeld(CURSOR, { batchCursor: 150 }, LEASE, "replica-a")).toBe(true);
    expect(await read(CURSOR)).toEqual({ batchCursor: 150 });

    // replica-b takes over; replica-a's slow, older batch finishes afterwards and must not rewind the cursor.
    await expire(LEASE);
    await storage.tryAcquireAutomationLease(LEASE, "replica-b", 180_000);
    expect(await storage.patchAutomationConfigIfLeaseHeld(CURSOR, { batchCursor: 200 }, LEASE, "replica-b")).toBe(true);
    expect(await storage.patchAutomationConfigIfLeaseHeld(CURSOR, { batchCursor: 100 }, LEASE, "replica-a")).toBe(false);
    expect(await read(CURSOR)).toEqual({ batchCursor: 200 });
  });

  it("an expired lease fences its own owner too, and no lease row means no write", async () => {
    expect(await storage.patchAutomationConfigIfLeaseHeld(CURSOR, { batchCursor: 5 }, LEASE, "replica-a")).toBe(false);
    expect(await read(CURSOR)).toBeUndefined();
    await storage.tryAcquireAutomationLease(LEASE, "replica-a", 180_000);
    await expire(LEASE);
    expect(await storage.patchAutomationConfigIfLeaseHeld(CURSOR, { batchCursor: 5 }, LEASE, "replica-a")).toBe(false);
  });

  it("merges into an existing cursor row (and replaces a non-object one)", async () => {
    await storage.tryAcquireAutomationLease(LEASE, "replica-a", 180_000);
    await pg.query(`INSERT INTO automation_config (key, value) VALUES ($1, $2::jsonb)`, [CURSOR, JSON.stringify({ batchCursor: 1, note: "kept" })]);
    await storage.patchAutomationConfigIfLeaseHeld(CURSOR, { batchCursor: 50 }, LEASE, "replica-a");
    expect(await read(CURSOR)).toEqual({ batchCursor: 50, note: "kept" });
    await pg.query(`UPDATE automation_config SET value = '7'::jsonb WHERE key = $1`, [CURSOR]);
    await storage.patchAutomationConfigIfLeaseHeld(CURSOR, { batchCursor: 60 }, LEASE, "replica-a");
    expect(await read(CURSOR)).toEqual({ batchCursor: 60 });
  });
});
