import { beforeEach, describe, expect, it, vi } from "vitest";

const logMock = vi.hoisted(() => vi.fn());
const poolMock = vi.hoisted(() => ({ query: vi.fn(async () => ({ rows: [] })), connect: vi.fn() }));
vi.mock("../server/index.ts", () => ({ log: logMock }));
// The module imports pool from ../db and sendEmail from ../email-service at module load; stub both so
// the unit tests never touch a real DB/transport (we inject fakes per-call too).
vi.mock("../server/db.ts", () => ({ pool: poolMock }));
vi.mock("../server/email-service.ts", () => ({ sendEmail: vi.fn(async () => ({ success: true, provider: "gmail" })) }));

const {
  decidePushAlert,
  renderPushAlertEmail,
  recordPushOutcomeAndMaybeAlert,
} = await import("../server/sync/bidboard-crm-alert.ts");

const NOW = new Date("2026-06-18T22:00:00Z");
const MIN = 60_000;
const ago = (mins: number) => new Date(NOW.getTime() - mins * MIN);

describe("decidePushAlert (pure)", () => {
  const base = { now: NOW, realertMinutes: 60 };

  it("first failure → alert_failure, state failing", () => {
    expect(decidePushAlert({ ...base, pushOk: false, prevState: "ok", lastAlertedAt: null }))
      .toEqual({ action: "alert_failure", nextState: "failing" });
  });

  it("first-ever run that fails (no prior state) → alert_failure", () => {
    expect(decidePushAlert({ ...base, pushOk: false, prevState: null, lastAlertedAt: null }).action)
      .toBe("alert_failure");
  });

  it("repeated failure within the re-alert window → none (no spam)", () => {
    expect(decidePushAlert({ ...base, pushOk: false, prevState: "failing", lastAlertedAt: ago(10) }).action)
      .toBe("none");
  });

  it("repeated failure past the re-alert window → alert_failure", () => {
    expect(decidePushAlert({ ...base, pushOk: false, prevState: "failing", lastAlertedAt: ago(90) }).action)
      .toBe("alert_failure");
  });

  it("success after failing → alert_recovered, state ok", () => {
    expect(decidePushAlert({ ...base, pushOk: true, prevState: "failing", lastAlertedAt: ago(30) }))
      .toEqual({ action: "alert_recovered", nextState: "ok" });
  });

  it("success while already ok → none", () => {
    expect(decidePushAlert({ ...base, pushOk: true, prevState: "ok", lastAlertedAt: null }).action)
      .toBe("none");
  });
});

describe("renderPushAlertEmail (pure)", () => {
  it("failure email carries the error, http status, attempts and office", () => {
    const { subject, htmlBody } = renderPushAlertEmail({
      kind: "failure", office: "dallas", attempts: 3, status: 500,
      error: 'CRM responded 500: {"error":{"message":"Internal server error"}}',
      sourceFilename: "ProjectList.xlsx", now: NOW,
    });
    expect(subject.toLowerCase()).toMatch(/fail|down|error/);
    expect(subject.toLowerCase()).toContain("dallas");
    expect(htmlBody).toContain("500");
    expect(htmlBody).toContain("Internal server error");
    expect(htmlBody).toContain("3");
  });

  it("recovered email is clearly a recovery", () => {
    const { subject } = renderPushAlertEmail({ kind: "recovered", office: "dallas", now: NOW });
    expect(subject.toLowerCase()).toMatch(/recover|resumed|back/);
  });

  it("escapes HTML metacharacters in the office slug in the body", () => {
    const { htmlBody } = renderPushAlertEmail({ kind: "failure", office: "a<b>&\"c", attempts: 1, now: NOW });
    expect(htmlBody).toContain("a&lt;b&gt;&amp;&quot;c");
    expect(htmlBody).not.toContain("<b>");
  });
});

// In-memory fake of the alert-state table for the orchestrator tests.
function fakeDb() {
  const store = new Map<string, any>();
  return {
    store,
    query: vi.fn(async (text: string, params?: any[]) => {
      const t = text.toLowerCase();
      if (t.includes("select") && t.includes("bidboard_crm_push_alert_state")) {
        const row = store.get(params![0]);
        return { rows: row ? [row] : [] };
      }
      if (t.includes("insert into") && t.includes("bidboard_crm_push_alert_state")) {
        const [office_slug, state, last_alerted_at, last_success_at, last_error, updated_at] = params!;
        store.set(office_slug, { office_slug, state, last_alerted_at, last_success_at, last_error, updated_at });
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };
}

describe("recordPushOutcomeAndMaybeAlert (orchestrator)", () => {
  let send: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    send = vi.fn(async () => ({ success: true, provider: "gmail" }));
  });

  const run = (db: any, pushResult: any, now: Date) =>
    recordPushOutcomeAndMaybeAlert(
      { pushResult, officeSlug: "dallas", sourceFilename: "ProjectList.xlsx", now, realertMinutes: 60, recipient: "ops@trock.test" },
      { db, send }
    );

  it("emails on the first retry-exhausted failure and records 'failing'", async () => {
    const db = fakeDb();
    const res = await run(db, { ok: false, attempts: 3, status: 500, error: "CRM responded 500" }, NOW);
    expect(send).toHaveBeenCalledTimes(1);
    expect((res as any).action).toBe("alert_failure");
    expect(db.store.get("dallas").state).toBe("failing");
  });

  it("does NOT email again for a sustained outage within the window (no storm)", async () => {
    const db = fakeDb();
    await run(db, { ok: false, attempts: 3, status: 500, error: "x" }, NOW); // first alert
    send.mockClear();
    await run(db, { ok: false, attempts: 3, status: 500, error: "x" }, new Date(NOW.getTime() + 19 * MIN));
    await run(db, { ok: false, attempts: 3, status: 500, error: "x" }, new Date(NOW.getTime() + 38 * MIN));
    expect(send).not.toHaveBeenCalled();
  });

  it("re-alerts once the window elapses (≈hourly during a 24h outage)", async () => {
    const db = fakeDb();
    await run(db, { ok: false, attempts: 3, error: "x" }, NOW);
    send.mockClear();
    await run(db, { ok: false, attempts: 3, error: "x" }, new Date(NOW.getTime() + 75 * MIN));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends a recovery email when a push succeeds after a failure", async () => {
    const db = fakeDb();
    await run(db, { ok: false, attempts: 3, error: "x" }, NOW);
    send.mockClear();
    const res = await run(db, { ok: true, attempts: 1 }, new Date(NOW.getTime() + 20 * MIN));
    expect(send).toHaveBeenCalledTimes(1);
    expect((res as any).action).toBe("alert_recovered");
    expect(db.store.get("dallas").state).toBe("ok");
  });

  it("a healthy push while already ok sends nothing", async () => {
    const db = fakeDb();
    const res = await run(db, { ok: true, attempts: 1 }, NOW);
    expect(send).not.toHaveBeenCalled();
    expect((res as any).action).toBe("none");
  });

  it("a SKIPPED push (CRM sync not configured) never alerts", async () => {
    const db = fakeDb();
    const res = await run(db, { ok: false, skipped: true, attempts: 0 }, NOW);
    expect(send).not.toHaveBeenCalled();
    expect((res as any).skipped).toBe(true);
  });

  it("a failed send does NOT advance the throttle; the next cycle re-alerts (parity w/ heartbeat)", async () => {
    const db = fakeDb();
    send.mockResolvedValueOnce({ success: false, provider: "gmail" }); // first send fails
    await run(db, { ok: false, attempts: 3, error: "x" }, NOW);
    expect(db.store.get("dallas").last_alerted_at).toBeNull(); // throttle not advanced

    const retry = await run(db, { ok: false, attempts: 3, error: "x" }, new Date(NOW.getTime() + 19 * MIN));
    expect((retry as any).action).toBe("alert_failure"); // re-alerts next cycle, inside the window
  });

  it("is a full no-op when no recipient is configured (inert until BIDBOARD_CRM_ALERT_RECIPIENT set)", async () => {
    const db = fakeDb();
    const prev = process.env.BIDBOARD_CRM_ALERT_RECIPIENT;
    delete process.env.BIDBOARD_CRM_ALERT_RECIPIENT;
    try {
      const res = await recordPushOutcomeAndMaybeAlert(
        { pushResult: { ok: false, attempts: 3, error: "x" }, officeSlug: "dallas", now: NOW },
        { db, send }
      );
      expect(send).not.toHaveBeenCalled();
      expect(db.store.size).toBe(0); // no state written
      expect((res as any).action).toBe("none");
    } finally {
      if (prev !== undefined) process.env.BIDBOARD_CRM_ALERT_RECIPIENT = prev;
    }
  });

  it("an email-send failure does NOT throw (sync must continue) and state is still recorded", async () => {
    const db = fakeDb();
    send.mockRejectedValueOnce(new Error("gmail down"));
    await expect(run(db, { ok: false, attempts: 3, error: "x" }, NOW)).resolves.toBeTruthy();
    expect(db.store.get("dallas").state).toBe("failing");
  });

  it("a DB failure does NOT throw into the sync cycle", async () => {
    const db = { query: vi.fn(async () => { throw new Error("db down"); }) };
    await expect(run(db, { ok: false, attempts: 3, error: "x" }, NOW)).resolves.toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });

  // Production path (no injected db): a per-office advisory lock serializes overlapping sync entrypoints.
  function fakeLockedClient(got: boolean) {
    const store = new Map<string, any>();
    return {
      query: vi.fn(async (text: string, params?: any[]) => {
        const t = text.toLowerCase();
        if (t.includes("pg_try_advisory_lock")) return { rows: [{ got }] };
        if (t.includes("pg_advisory_unlock")) return { rows: [{}] };
        if (t.includes("select") && t.includes("bidboard_crm_push_alert_state")) {
          return { rows: store.has(params![0]) ? [store.get(params![0])] : [] };
        }
        if (t.includes("insert into") && t.includes("bidboard_crm_push_alert_state")) {
          store.set(params![0], { office_slug: params![0], state: params![1], last_alerted_at: null, last_success_at: null });
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
  }

  it("acquires the advisory lock and alerts when no db is injected (lock held)", async () => {
    const client = fakeLockedClient(true);
    poolMock.connect.mockResolvedValueOnce(client as any);
    const res = await recordPushOutcomeAndMaybeAlert(
      { pushResult: { ok: false, attempts: 3, status: 500, error: "x" }, officeSlug: "dallas", now: NOW, recipient: "ops@trock.test" },
      { send }
    );
    expect((res as any).action).toBe("alert_failure");
    expect(send).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls.some((c) => String(c[0]).includes("pg_advisory_unlock"))).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });

  it("skips (no send) when the advisory lock is already held by another run", async () => {
    const client = fakeLockedClient(false);
    poolMock.connect.mockResolvedValueOnce(client as any);
    const res = await recordPushOutcomeAndMaybeAlert(
      { pushResult: { ok: false, attempts: 3, status: 500, error: "x" }, officeSlug: "dallas", now: NOW, recipient: "ops@trock.test" },
      { send }
    );
    expect((res as any).action).toBe("none");
    expect(send).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalled();
  });

  it("a failed recovery send keeps state 'failing' and retries; a later success flips to ok", async () => {
    const db = fakeDb();
    await run(db, { ok: false, attempts: 3, error: "x" }, NOW); // failing
    send.mockClear();
    send.mockResolvedValueOnce({ success: false, provider: "gmail" }); // recovery email fails
    const failed = await run(db, { ok: true, attempts: 1 }, new Date(NOW.getTime() + 20 * MIN));
    expect((failed as any).action).toBe("alert_recovered");
    expect(db.store.get("dallas").state).toBe("failing"); // NOT flipped to ok

    const retried = await run(db, { ok: true, attempts: 1 }, new Date(NOW.getTime() + 40 * MIN));
    expect((retried as any).action).toBe("alert_recovered"); // retried
    expect(db.store.get("dallas").state).toBe("ok");
  });
});
