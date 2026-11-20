import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// Mail sign-in health (integration-health S2, CONTRACT ADDENDUM-1 ruling 1): each Outlook / Gmail token refresh leaves a
// record in automation_config `mail_auth_health` — the last OK and the last failure, per provider. A success keeps the last
// failure as evidence; the message is sanitised before it is stored; Outlook and Gmail never overwrite each other; a failed
// write never throws into the refresh. Plus the refresh paths themselves call it. Synthetic values only.

const { recordMailAuthOk, recordMailAuthFailure, mailAuthErrorCode, MAIL_AUTH_HEALTH_KEY } = await import("../server/health/mail-auth-health.ts");

let pg: PGlite;
let db: any;

beforeEach(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE automation_config (
      id serial PRIMARY KEY, key text NOT NULL UNIQUE, value jsonb NOT NULL, description text,
      is_active boolean NOT NULL DEFAULT true, updated_at timestamp DEFAULT now()
    );
  `);
  db = drizzle(pg);
});

const stored = async () =>
  (await pg.query<{ value: any }>(`SELECT value FROM automation_config WHERE key = $1`, [MAIL_AUTH_HEALTH_KEY])).rows[0]?.value;

const AADSTS_BODY =
  'Microsoft token refresh failed: {"error":"invalid_grant","error_description":"AADSTS50079: Due to a configuration change made by your administrator, you must enroll in multi-factor authentication. Contact mailbox.owner@example.test.","error_codes":[50079]}';

describe("mail_auth_health", () => {
  it("a success, then a failure, then a success: last_ok_at moves and the last failure stays as evidence", async () => {
    await recordMailAuthOk("outlook", { db, now: new Date("2026-11-13T10:00:00.000Z") });
    await recordMailAuthFailure("outlook", new Error(AADSTS_BODY), { db, now: new Date("2026-11-13T16:32:00.000Z") });
    await recordMailAuthOk("outlook", { db, now: new Date("2026-11-13T17:00:00.000Z") });
    expect(await stored()).toEqual({
      outlook: {
        last_ok_at: "2026-11-13T17:00:00.000Z",
        last_error: {
          code: "AADSTS50079",
          at: "2026-11-13T16:32:00.000Z",
          message_safe: expect.stringMatching(/^AADSTS50079: Due to a configuration change/),
        },
      },
    });
  });

  it("stores the message sanitised (no email address), capped at 200 characters", async () => {
    await recordMailAuthFailure("outlook", new Error(AADSTS_BODY), { db });
    const message = (await stored()).outlook.last_error.message_safe as string;
    expect(message).not.toContain("@example.test");
    expect(message.length).toBeLessThanOrEqual(200);
  });

  it("Outlook and Gmail subtrees are independent: neither write clobbers the other", async () => {
    await recordMailAuthFailure("gmail", new Error('Gmail token refresh failed: {"error":"invalid_grant","error_description":"Token has been expired or revoked."}'), {
      db,
      now: new Date("2026-11-13T09:00:00.000Z"),
    });
    await recordMailAuthOk("outlook", { db, now: new Date("2026-11-13T10:00:00.000Z") });
    expect(await stored()).toEqual({
      gmail: { last_error: { code: "invalid_grant", at: "2026-11-13T09:00:00.000Z", message_safe: "Token has been expired or revoked." } },
      outlook: { last_ok_at: "2026-11-13T10:00:00.000Z" },
    });
  });

  it("the error code: AADSTS first, then the OAuth error field, else refresh_failed (never a guess)", () => {
    expect(mailAuthErrorCode(AADSTS_BODY)).toBe("AADSTS50079");
    expect(mailAuthErrorCode('{"error":"invalid_client"}')).toBe("invalid_client");
    expect(mailAuthErrorCode("fetch failed: ECONNRESET")).toBe("refresh_failed");
  });

  it("a failed write is swallowed: neither function rejects", async () => {
    const broken = { execute: vi.fn(async () => { throw new Error("connection terminated"); }) };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(recordMailAuthOk("outlook", { db: broken })).resolves.toBeUndefined();
    await expect(recordMailAuthFailure("gmail", new Error("x"), { db: broken })).resolves.toBeUndefined();
    expect(broken.execute).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The refresh paths call it (microsoft.ts / gmail.ts), and a refresh's own result never depends on it.
// ---------------------------------------------------------------------------------------------------------------------

describe("token refresh paths record mail sign-in health", () => {
  const h = {
    configs: new Map<string, any>(),
    ok: vi.fn(async (..._args: unknown[]) => undefined),
    failure: vi.fn(async (..._args: unknown[]) => undefined),
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function load() {
    vi.resetModules();
    vi.doMock("../server/storage.ts", () => ({
      storage: {
        getAutomationConfig: vi.fn(async (key: string) => h.configs.get(key) ?? null),
        upsertAutomationConfig: vi.fn(async (row: any) => {
          h.configs.set(row.key, { value: row.value });
          return row;
        }),
      },
    }));
    vi.doMock("../server/db.ts", () => ({ db: {}, pool: { query: vi.fn() } }));
    vi.doMock("../server/health/mail-auth-health.ts", () => ({ recordMailAuthOk: h.ok, recordMailAuthFailure: h.failure }));
    return {
      microsoft: await import("../server/microsoft.ts"),
      gmail: await import("../server/gmail.ts"),
    };
  }

  beforeEach(() => {
    h.configs.clear();
    h.ok.mockClear();
    h.failure.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("MICROSOFT_CLIENT_ID", "client-id");
    vi.stubEnv("MICROSOFT_CLIENT_SECRET", "client-secret-placeholder");
    vi.stubEnv("GOOGLE_CLIENT_ID", "client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret-placeholder");
  });

  const expired = (extra: Record<string, unknown> = {}) => ({
    value: { accessToken: "AT-OLD", refreshToken: "RT-OLD", expiresAt: Date.now() - 1000, scope: "x", ...extra },
  });

  it("Outlook: a failed refresh records the failure and still returns null; a good one records OK and returns the tokens", async () => {
    const { microsoft } = await load();
    h.configs.set("microsoft_oauth", expired());
    vi.stubGlobal("fetch", vi.fn(async () => new Response(AADSTS_BODY.replace("Microsoft token refresh failed: ", ""), { status: 400 })));
    expect(await microsoft.getMicrosoftTokens()).toBeNull();
    expect(h.failure).toHaveBeenCalledTimes(1);
    expect(h.failure.mock.calls[0][0]).toBe("outlook");
    expect(String((h.failure.mock.calls[0][1] as Error).message)).toContain("AADSTS50079");
    expect(h.ok).not.toHaveBeenCalled();

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ access_token: "AT-NEW", expires_in: 3600, scope: "x" }), { status: 200 })));
    const tokens = await microsoft.getMicrosoftTokens();
    expect(tokens?.accessToken).toBe("AT-NEW");
    expect(h.ok).toHaveBeenCalledWith("outlook");
  });

  it("Gmail: the same pair of calls on its refresh path", async () => {
    const { gmail } = await load();
    h.configs.set("gmail_oauth", expired());
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 })));
    expect(await gmail.getGmailTokens()).toBeNull();
    expect(h.failure).toHaveBeenCalledWith("gmail", expect.any(Error));

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ access_token: "AT-NEW", expires_in: 3600 }), { status: 200 })));
    expect((await gmail.getGmailTokens())?.accessToken).toBe("AT-NEW");
    expect(h.ok).toHaveBeenCalledWith("gmail");
  });
});
