import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// H3 (security rotation, 2026-10-22): ENCRYPTION_KEY can be split from SESSION_SECRET without ever making the saved Procore web password unreadable.
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));
vi.mock("../server/db.ts", () => ({ db: {}, pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock("../server/email-service.ts", () => ({ sendEmail: vi.fn(async () => ({ success: true, provider: "gmail" })) }));
vi.mock("../server/storage.ts", () => ({ storage: { getAutomationConfig: vi.fn(async () => null) } }));
vi.mock("../server/playwright/browser.ts", () => ({
  getPage: vi.fn(), saveSession: vi.fn(), clearSession: vi.fn(), closeBrowser: vi.fn(), withRetry: vi.fn(), randomDelay: vi.fn(),
  takeScreenshot: vi.fn(), waitForNavigation: vi.fn(), withBrowserLock: vi.fn(async (_n: string, fn: () => Promise<unknown>) => fn()),
}));

const { encryptPassword, decryptPassword } = await import("../server/playwright/auth.ts");

const OLD_SESSION = "session-secret-old-aaaaaaaaaaaaaaaaaaaa";
const NEW_SESSION = "session-secret-new-bbbbbbbbbbbbbbbbbbbb";
const KEY = "dedicated-encryption-key-cccccccccccc";

describe("Procore web password key: ENCRYPTION_KEY with the SESSION_SECRET fallback", () => {
  const prior = { e: process.env.ENCRYPTION_KEY, s: process.env.SESSION_SECRET };
  beforeEach(() => { delete process.env.ENCRYPTION_KEY; process.env.SESSION_SECRET = OLD_SESSION; });
  afterEach(() => {
    if (prior.e === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = prior.e;
    if (prior.s === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = prior.s;
  });

  it("with no ENCRYPTION_KEY nothing changes: sealed and opened under SESSION_SECRET", () => {
    expect(decryptPassword(encryptPassword("pw-1"))).toBe("pw-1");
  });

  it("a password sealed under SESSION_SECRET still opens after ENCRYPTION_KEY is set to a DIFFERENT value (the fallback), and after SESSION_SECRET is rotated only if ENCRYPTION_KEY equals the old value", () => {
    const sealed = encryptPassword("pw-2");
    process.env.ENCRYPTION_KEY = KEY; // a new dedicated key: the old ciphertext falls back to SESSION_SECRET
    expect(decryptPassword(sealed)).toBe("pw-2");
    // The step-1 recipe: ENCRYPTION_KEY first equals the current SESSION_SECRET, then SESSION_SECRET rotates alone.
    process.env.ENCRYPTION_KEY = OLD_SESSION;
    process.env.SESSION_SECRET = NEW_SESSION;
    expect(decryptPassword(sealed)).toBe("pw-2");
  });

  it("new passwords are sealed with ENCRYPTION_KEY and no longer depend on SESSION_SECRET", () => {
    process.env.ENCRYPTION_KEY = KEY;
    const sealed = encryptPassword("pw-3");
    process.env.SESSION_SECRET = NEW_SESSION; // rotated independently
    expect(decryptPassword(sealed)).toBe("pw-3");
    delete process.env.SESSION_SECRET; // and ENCRYPTION_KEY alone is enough
    expect(decryptPassword(sealed)).toBe("pw-3");
  });

  it("a ciphertext under neither key throws (the tag check), instead of returning garbage", () => {
    const sealed = encryptPassword("pw-4");
    process.env.ENCRYPTION_KEY = KEY;
    process.env.SESSION_SECRET = NEW_SESSION; // the sealing secret is gone from both
    expect(() => decryptPassword(sealed)).toThrow();
  });
});
