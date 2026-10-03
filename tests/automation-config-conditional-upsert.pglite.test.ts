import { beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// storage.upsertAutomationConfigUnlessAuthDisabled is what makes the polling admin gate atomic: the
// "is this row auth_expired?" check is evaluated by the ON CONFLICT DO UPDATE itself, so a disable that
// commits after a caller's own read cannot be overwritten. Run its ACTUAL SQL against real Postgres.
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

const seed = (key: string, value: unknown) =>
  pg.query(`INSERT INTO automation_config (key, value) VALUES ($1, $2::jsonb)`, [key, JSON.stringify(value)]);
const read = async (key: string) =>
  ((await pg.query<{ value: unknown }>(`SELECT value FROM automation_config WHERE key = $1`, [key])).rows[0]?.value);

const ENABLE = { key: "procore_polling", value: { enabled: true, intervalMinutes: 15 }, description: "Procore polling" };

describe("upsertAutomationConfigUnlessAuthDisabled (real Postgres)", () => {
  it("leaves an auth_expired row untouched and returns null", async () => {
    const disabled = { enabled: false, intervalMinutes: 17, disabledReason: "auth_expired", disabledAt: "2026-06-10T08:00:00.000Z" };
    await seed("procore_polling", disabled);
    expect(await storage.upsertAutomationConfigUnlessAuthDisabled(ENABLE)).toBeNull();
    expect(await read("procore_polling")).toEqual(disabled);
  });

  it("updates a row that is not auth-disabled (enabled, off by hand, or disabled for another reason)", async () => {
    for (const prior of [{ enabled: true, intervalMinutes: 17 }, { enabled: false }, { enabled: false, disabledReason: "manual" }]) {
      await pg.exec(`DELETE FROM automation_config`);
      await seed("procore_polling", prior);
      const out = await storage.upsertAutomationConfigUnlessAuthDisabled(ENABLE);
      expect(out?.value).toEqual(ENABLE.value);
      expect(await read("procore_polling")).toEqual(ENABLE.value);
    }
  });

  it("inserts when there is no row, and tolerates a non-object stored value", async () => {
    expect((await storage.upsertAutomationConfigUnlessAuthDisabled(ENABLE))?.value).toEqual(ENABLE.value);
    for (const odd of ["auth_expired", ["auth_expired"], 42]) {
      await pg.exec(`DELETE FROM automation_config`);
      await seed("procore_polling", odd);
      expect((await storage.upsertAutomationConfigUnlessAuthDisabled(ENABLE))?.value).toEqual(ENABLE.value);
    }
  });

  it("a disable committed after the caller's read still wins", async () => {
    await seed("procore_polling", { enabled: true, intervalMinutes: 17 });
    const sawEnabled = await read("procore_polling"); // the gate's read
    await pg.query(`UPDATE automation_config SET value = $1::jsonb WHERE key = 'procore_polling'`, [
      JSON.stringify({ enabled: false, intervalMinutes: 17, disabledReason: "auth_expired", disabledAt: "2026-10-02T00:00:00.000Z" }),
    ]);
    expect(sawEnabled).toMatchObject({ enabled: true });
    expect(await storage.upsertAutomationConfigUnlessAuthDisabled(ENABLE)).toBeNull();
    expect(await read("procore_polling")).toMatchObject({ enabled: false, disabledReason: "auth_expired" });
  });
});
