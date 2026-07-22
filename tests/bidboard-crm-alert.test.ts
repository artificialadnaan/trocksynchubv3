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

  it("a CHANGED diagnosis within the window → alert_failure (definitive kind not throttled)", () => {
    expect(
      decidePushAlert({ ...base, pushOk: false, prevState: "failing", lastAlertedAt: ago(10), prevKind: "unconfirmed", currentKind: "terminal_failure" }).action
    ).toBe("alert_failure");
  });

  it("the SAME diagnosis within the window → none (still throttled, no spam)", () => {
    expect(
      decidePushAlert({ ...base, pushOk: false, prevState: "failing", lastAlertedAt: ago(10), prevKind: "unconfirmed", currentKind: "unconfirmed" }).action
    ).toBe("none");
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
  it("terminal-failure email carries the error, http status, attempts and office — and does NOT claim a rollback", () => {
    const { subject, htmlBody } = renderPushAlertEmail({
      kind: "terminal_failure", office: "dallas", attempts: 3, status: 500,
      error: 'CRM responded 500: {"error":{"message":"Internal server error"}}',
      sourceFilename: "ProjectList.xlsx", now: NOW,
    });
    expect(subject.toLowerCase()).toMatch(/fail|down|error/);
    expect(subject.toLowerCase()).toContain("dallas");
    expect(htmlBody).toContain("500");
    expect(htmlBody).toContain("Internal server error");
    expect(htmlBody).toContain("3");
    // The false-rollback claim from the old copy must be gone.
    expect(htmlBody.toLowerCase()).not.toContain("rolls back");
    expect(htmlBody.toLowerCase()).not.toContain("rejected the push");
    expect(htmlBody.toLowerCase()).toContain("accepted");
  });

  it("unconfirmed email frames an ambiguous 502 as unresolved — explicitly NOT a rollback/data loss", () => {
    const { subject, htmlBody } = renderPushAlertEmail({
      kind: "unconfirmed", office: "dallas", attempts: 2, status: 502,
      error: "CRM responded 502: <gateway>", sourceFilename: "ProjectList.xlsx", now: NOW,
    });
    expect(subject.toLowerCase()).toMatch(/unconfirmed|ambiguous/);
    expect(htmlBody.toLowerCase()).toContain("not");
    expect(htmlBody.toLowerCase()).not.toContain("rolls back");
    expect(htmlBody.toLowerCase()).not.toContain("rejected the push");
    // Mentions the ambiguous/gateway nature so ops don't assume data loss.
    expect(htmlBody.toLowerCase()).toMatch(/ambiguous|502|in flight|could not confirm/);
  });

  it("request_rejected email names the 4xx rejection and does NOT claim a rollback", () => {
    const { subject, htmlBody } = renderPushAlertEmail({
      kind: "request_rejected", office: "dallas", attempts: 1, status: 401,
      error: "CRM responded 401", idempotencyKey: "abc123", now: NOW,
    });
    expect(subject.toLowerCase()).toMatch(/reject/);
    expect(htmlBody).toContain("401");
    expect(htmlBody.toLowerCase()).not.toContain("rolls back");
  });

  it("failure emails carry the idempotency key so ops can query the CRM status endpoint", () => {
    for (const kind of ["terminal_failure", "unconfirmed", "request_rejected"] as const) {
      const { htmlBody } = renderPushAlertEmail({ kind, office: "dallas", idempotencyKey: "key-xyz-789", now: NOW });
      expect(htmlBody).toContain("key-xyz-789");
    }
  });

  it("recovered email is clearly a recovery", () => {
    const { subject } = renderPushAlertEmail({ kind: "recovered", office: "dallas", now: NOW });
    expect(subject.toLowerCase()).toMatch(/recover|resumed|back/);
  });

  it("escapes HTML metacharacters in the office slug in the body", () => {
    const { htmlBody } = renderPushAlertEmail({ kind: "terminal_failure", office: "a<b>&\"c", attempts: 1, now: NOW });
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
        const [office_slug, state, last_alerted_at, last_alerted_kind, last_success_at, last_error, updated_at] = params!;
        store.set(office_slug, { office_slug, state, last_alerted_at, last_alerted_kind, last_success_at, last_error, updated_at });
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

  it("sends the ops alert with bypassGlobalCc so it goes only to the configured recipient", async () => {
    const db = fakeDb();
    await run(db, { ok: false, attempts: 3, status: 500, error: "x" }, NOW);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ to: "ops@trock.test", bypassGlobalCc: true });
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

  it("re-alerts INSIDE the throttle window when the diagnosis changes (unconfirmed → terminal_failure)", async () => {
    const db = fakeDb();
    // First: an ambiguous UNCONFIRMED failure → alerts and records kind 'unconfirmed'.
    await run(db, { ok: false, attempts: 3, idempotencyKey: "k" }, NOW);
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.store.get("dallas").last_alerted_kind).toBe("unconfirmed");
    // 10 min later (well inside the 60-min window) the probe now reports a TERMINAL failure — the definitive
    // diagnosis must NOT be suppressed behind the earlier ambiguous alert.
    await run(db, { ok: false, terminalFailure: true, attempts: 3, idempotencyKey: "k" }, new Date(NOW.getTime() + 10 * MIN));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].subject).toMatch(/FAILED \(processing\)/); // terminal_failure subject
    expect(db.store.get("dallas").last_alerted_kind).toBe("terminal_failure");
  });

  it("still throttles a REPEAT of the same diagnosis within the window", async () => {
    const db = fakeDb();
    await run(db, { ok: false, attempts: 3, idempotencyKey: "k" }, NOW);
    send.mockClear();
    await run(db, { ok: false, attempts: 3, idempotencyKey: "k" }, new Date(NOW.getTime() + 10 * MIN));
    expect(send).not.toHaveBeenCalled(); // same 'unconfirmed' kind → throttled
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

  it("a 502 later confirmed as processing/succeeded (ok:true, accepted:true) does NOT alert", async () => {
    const db = fakeDb();
    const res = await run(db, { ok: true, accepted: true, attempts: 1, ingestionStatus: "processing" }, NOW);
    expect(send).not.toHaveBeenCalled();
    expect((res as any).action).toBe("none");
  });

  it("a genuine TERMINAL processing failure alerts with terminal wording (no rollback claim)", async () => {
    const db = fakeDb();
    const res = await run(
      db,
      { ok: false, accepted: true, terminalFailure: true, attempts: 3, status: 502, error: "schema drift" },
      NOW
    );
    expect((res as any).action).toBe("alert_failure");
    expect(send).toHaveBeenCalledTimes(1);
    const body: string = send.mock.calls[0][0].htmlBody;
    expect(body.toLowerCase()).toContain("accepted");
    expect(body.toLowerCase()).not.toContain("rolls back");
    expect(db.store.get("dallas").state).toBe("failing");
  });

  it("an UNCONFIRMED ambiguous outcome (ok:false, accepted:false) alerts without claiming a rollback", async () => {
    const db = fakeDb();
    const res = await run(db, { ok: false, accepted: false, attempts: 2, status: 502, error: "gateway 502" }, NOW);
    expect((res as any).action).toBe("alert_failure");
    expect(send).toHaveBeenCalledTimes(1);
    const email = send.mock.calls[0][0];
    expect(email.subject.toLowerCase()).toMatch(/unconfirmed|ambiguous/);
    expect(email.htmlBody.toLowerCase()).not.toContain("rolls back");
  });

  it("a deterministic REJECTION (ok:false, rejected:true) alerts with request_rejected wording + the key", async () => {
    const db = fakeDb();
    const res = await run(
      db,
      { ok: false, accepted: false, rejected: true, attempts: 1, status: 401, error: "bad sig", idempotencyKey: "k1" },
      NOW
    );
    expect((res as any).action).toBe("alert_failure");
    expect(send).toHaveBeenCalledTimes(1);
    const email = send.mock.calls[0][0];
    expect(email.subject.toLowerCase()).toMatch(/reject/);
    expect(email.htmlBody).toContain("k1");
    expect(email.htmlBody.toLowerCase()).not.toContain("rolls back");
  });
});
