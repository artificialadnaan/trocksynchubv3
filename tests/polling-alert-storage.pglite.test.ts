import { beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// The SQL behind the polling alert's two shared guards, against real Postgres:
// - upsertAutomationConfigIfVersion: the auth-expiry disable is a compare-and-set on the row version (updated_at)
//   the failing cycle started with, evaluated by the ON CONFLICT DO UPDATE itself;
// - claimEmailSend / settleEmailSend: the email_send_log dedupe row is claimed BEFORE a send, so a second replica
//   cannot send the same event, and a failed send can be claimed again.
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
    CREATE TABLE email_send_log (
      id SERIAL PRIMARY KEY,
      template_key text NOT NULL,
      recipient_email text NOT NULL,
      recipient_name text,
      subject text NOT NULL,
      dedupe_key text NOT NULL UNIQUE,
      status text NOT NULL DEFAULT 'sent',
      error_message text,
      metadata jsonb,
      sent_at timestamp DEFAULT now(),
      created_at timestamp DEFAULT now()
    );
  `);
  dbHolder.pool = pg;
  dbHolder.db = drizzle(pg);
});

const DISABLE = { key: "procore_polling", value: { enabled: false, disabledReason: "auth_expired" }, description: "Procore polling" };
const read = async (key: string) => ((await pg.query<{ value: unknown }>(`SELECT value FROM automation_config WHERE key = $1`, [key])).rows[0]?.value);

describe("upsertAutomationConfigIfVersion (real Postgres)", () => {
  it("writes while the row is still at the version read, and refuses once it has changed", async () => {
    await pg.query(`INSERT INTO automation_config (key, value) VALUES ('procore_polling', '{"enabled": true}')`);
    const started = await storage.getAutomationConfigVersion("procore_polling");
    expect(started).not.toBe("absent");

    // An admin re-enables (any write bumps updated_at) after the cycle read its version.
    await storage.upsertAutomationConfig({ key: "procore_polling", value: { enabled: true, intervalMinutes: 17 }, description: "x" });
    expect(await storage.upsertAutomationConfigIfVersion(DISABLE, started)).toBeNull();
    expect(await read("procore_polling")).toEqual({ enabled: true, intervalMinutes: 17 });

    // Read afresh, the same write goes through.
    const now = await storage.getAutomationConfigVersion("procore_polling");
    expect((await storage.upsertAutomationConfigIfVersion(DISABLE, now))?.value).toEqual(DISABLE.value);
    expect(await read("procore_polling")).toEqual(DISABLE.value);
  });

  it("'absent' inserts only while there is still no row", async () => {
    expect(await storage.getAutomationConfigVersion("procore_polling")).toBe("absent");
    expect((await storage.upsertAutomationConfigIfVersion(DISABLE, "absent"))?.value).toEqual(DISABLE.value);
    expect(await storage.upsertAutomationConfigIfVersion({ ...DISABLE, value: { enabled: true } }, "absent")).toBeNull();
    expect(await read("procore_polling")).toEqual(DISABLE.value);
  });
});

describe("bumpAutomationConfigVersion (real Postgres)", () => {
  it("moves the version without touching the value, so a cycle's compare-and-set from before no longer matches", async () => {
    await pg.query(`INSERT INTO automation_config (key, value) VALUES ('procore_polling', '{"enabled": true}')`);
    const started = await storage.getAutomationConfigVersion("procore_polling");
    await new Promise((r) => setTimeout(r, 5));
    await storage.bumpAutomationConfigVersion("procore_polling");
    expect(await storage.getAutomationConfigVersion("procore_polling")).not.toBe(started);
    expect(await read("procore_polling")).toEqual({ enabled: true });
    expect(await storage.upsertAutomationConfigIfVersion(DISABLE, started)).toBeNull();
  });

  it("is a no-op without a row", async () => {
    await storage.bumpAutomationConfigVersion("hubspot_polling");
    expect(await storage.getAutomationConfigVersion("hubspot_polling")).toBe("absent");
  });
});

describe("claimEmailSend / settleEmailSend (real Postgres)", () => {
  const ALERT = { templateKey: "polling_auto_disabled_alert", recipientEmail: "ops@example.test", subject: "s", dedupeKey: "polling_auto_disabled:procore_polling:2026-06-10T08:00:00.000Z", metadata: { job: "procore_polling" } };
  const status = async () => (await pg.query<{ status: string }>(`SELECT status FROM email_send_log WHERE dedupe_key = $1`, [ALERT.dedupeKey])).rows[0]?.status;

  it("one claim per event: a second claimant (another replica) gets none while the first is sending", async () => {
    const id = await storage.claimEmailSend(ALERT, 30);
    expect(id).toEqual(expect.any(Number));
    expect(await status()).toBe("sending");
    expect(await storage.claimEmailSend(ALERT, 30)).toBeNull();
  });

  it("a delivered send is never claimed again; a failed one can be", async () => {
    const id = (await storage.claimEmailSend(ALERT, 30))!;
    await storage.settleEmailSend(id, { status: "failed", error: "smtp 421" });
    expect(await status()).toBe("failed");
    expect(await storage.checkEmailDedupeKey(ALERT.dedupeKey)).toBe(false);

    const again = (await storage.claimEmailSend(ALERT, 30))!;
    expect(again).toBe(id);
    await storage.settleEmailSend(again, { status: "sent" });
    expect(await status()).toBe("sent");
    expect(await storage.checkEmailDedupeKey(ALERT.dedupeKey)).toBe(true);
    expect(await storage.claimEmailSend(ALERT, 30)).toBeNull();
  });

  it("a stale 'sending' claim (a sender that died) can be claimed again; a fresh one cannot", async () => {
    await storage.claimEmailSend(ALERT, 30);
    await pg.query(`UPDATE email_send_log SET created_at = now() - interval '31 minutes' WHERE dedupe_key = $1`, [ALERT.dedupeKey]);
    expect(await storage.claimEmailSend(ALERT, 30)).toEqual(expect.any(Number));
    expect(await storage.claimEmailSend(ALERT, 30)).toBeNull();
  });
});
