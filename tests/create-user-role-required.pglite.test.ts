import { beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// storage.createUser must never rely on the users.role column default, which is still "admin" in production (left
// as is so no existing account changes). The role is required and written explicitly; real Postgres (PGlite) with
// production's column default proves an omitted role cannot mint an admin.
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
    CREATE TABLE users (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      username text NOT NULL UNIQUE,
      password text NOT NULL,
      role text NOT NULL DEFAULT 'admin'
    );
  `);
  dbHolder.pool = pg;
  dbHolder.db = drizzle(pg);
});

describe("storage.createUser role", () => {
  it("writes the given role, never the column default", async () => {
    const user = await storage.createUser({ username: "staff", password: "pw-123456", role: "user" });
    expect(user.role).toBe("user");
    expect((await pg.query<{ role: string }>(`SELECT role FROM users WHERE username = 'staff'`)).rows[0]?.role).toBe("user");
  });

  it.each([undefined, "", "   "])("refuses a missing or blank role (%j) and writes nothing", async (role) => {
    await expect(storage.createUser({ username: "x", password: "pw-123456", role } as any)).rejects.toThrow(/role is required/);
    expect((await pg.query(`SELECT count(*)::int AS n FROM users`)).rows[0]).toEqual({ n: 0 });
  });
});
