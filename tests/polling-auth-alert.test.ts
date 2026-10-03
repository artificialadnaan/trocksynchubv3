import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Procore polling auto-disabled itself on 2026-06-10 (auth_expired) and HubSpot polling on 06-05, and
// nobody noticed for months: the only trace was a console line and a flag. These tests pin the alert:
// one per disable event, to the ops recipient the other SyncHub alerts use, with a structured-log +
// audit-row fallback when no recipient is configured, wired into BOTH pollers' auth-expiry paths.
const mocks = vi.hoisted(() => ({
  storage: {
    getAutomationConfig: vi.fn(),
    getAutomationConfigs: vi.fn(),
    upsertAutomationConfig: vi.fn(),
    upsertAutomationConfigUnlessAuthDisabled: vi.fn(),
    patchAutomationConfig: vi.fn(),
    createAuditLog: vi.fn(),
    checkEmailDedupeKey: vi.fn(),
    createEmailSendLog: vi.fn(),
    getUser: vi.fn(),
  },
  sendEmail: vi.fn(),
  runFullProcoreSync: vi.fn(),
  runFullHubSpotSync: vi.fn(),
}));

vi.mock("../server/storage.ts", () => ({ storage: mocks.storage }));
vi.mock("../server/db.ts", () => ({ db: {}, pool: {} }));
vi.mock("../server/email-service.ts", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("../server/procore.ts", () => ({
  syncProcoreRoleAssignments: vi.fn(),
  syncProcoreRoleAssignmentsBatch: vi.fn(),
  runFullProcoreSync: mocks.runFullProcoreSync,
}));
vi.mock("../server/hubspot.ts", () => ({ updateHubSpotDealStage: vi.fn(), runFullHubSpotSync: mocks.runFullHubSpotSync }));
vi.mock("../server/bidboard-automation.ts", () => ({
  runBidBoardPolling: vi.fn(),
  getAutomationStatus: vi.fn(async () => ({ enabled: false, projectCount: 0, pendingPortfolioTransitions: 0 })),
  enableBidBoardAutomation: vi.fn(),
  manualSyncProject: vi.fn(),
  onBidBoardProjectCreated: vi.fn(),
  detectAndProcessNewProjects: vi.fn(),
}));
vi.mock("../server/playwright/bidboard.ts", () => ({ syncHubSpotClientToBidBoard: vi.fn() }));
vi.mock("../server/sync", () => ({ runBidBoardStageSync: vi.fn() }));
vi.mock("../server/hubspot-procore-sync.ts", () => ({ triggerPostSyncProcoreUpdates: vi.fn() }));
vi.mock("../server/deal-project-number.ts", () => ({ processNewDealWebhook: vi.fn() }));
vi.mock("../server/playwright/auth", () => ({ testLogin: vi.fn(), saveProcoreCredentials: vi.fn(), logout: vi.fn() }));
vi.mock("../server/playwright/portfolio", () => ({ runPortfolioTransition: vi.fn(), runFullPortfolioWorkflow: vi.fn() }));
vi.mock("../server/playwright/documents", () => ({
  syncHubSpotAttachmentsToBidBoard: vi.fn(),
  syncBidBoardDocumentsToPortfolio: vi.fn(),
}));
vi.mock("../server/playwright/browser", () => ({
  closeBrowser: vi.fn(),
  withBrowserLock: vi.fn((_name: string, fn: () => unknown) => fn()),
}));

const RECIPIENT = "ops-alerts@example.test";

/** automation_config + email_send_log backed by maps, so dedupe is observed, not stubbed. */
function backedStore(initial: Record<string, any> = {}) {
  const rows: Record<string, any> = { ...initial };
  const sentKeys = new Set<string>();
  mocks.storage.getAutomationConfig.mockImplementation(async (key: string) => (key in rows ? { key, value: rows[key] } : undefined));
  mocks.storage.getAutomationConfigs.mockImplementation(async () => Object.entries(rows).map(([key, value]) => ({ key, value })));
  mocks.storage.upsertAutomationConfig.mockImplementation(async (data: any) => {
    rows[data.key] = data.value;
    return data;
  });
  mocks.storage.upsertAutomationConfigUnlessAuthDisabled.mockImplementation(async (data: any) => {
    // Stands in for the conditional ON CONFLICT DO UPDATE (its real SQL is pinned by the PGlite test).
    if (rows[data.key]?.disabledReason === "auth_expired") return null;
    rows[data.key] = data.value;
    return data;
  });
  mocks.storage.checkEmailDedupeKey.mockImplementation(async (k: string) => sentKeys.has(k));
  mocks.storage.createEmailSendLog.mockImplementation(async (d: any) => {
    if (d.status === "sent") sentKeys.add(d.dedupeKey);
    return d;
  });
  return { rows, sentKeys };
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.storage.createAuditLog.mockResolvedValue({});
  mocks.sendEmail.mockResolvedValue({ success: true, provider: "gmail" });
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("recordPollingAuthExpiry", () => {
  it("disables the poller, audits, and emails the ops recipient with job, when, reason and how to re-enable", async () => {
    const { rows } = backedStore({ procore_polling: { enabled: true, intervalMinutes: 17 } });
    const { recordPollingAuthExpiry } = await import("../server/polling-auth-alert.ts");

    const out = await recordPollingAuthExpiry(
      { job: "procore_polling", error: "Request failed with status code 401" },
      { recipient: RECIPIENT, now: () => new Date("2026-06-10T08:00:00Z") },
    );

    expect(out).toEqual({ newEvent: true, disabledAt: "2026-06-10T08:00:00.000Z", persisted: true, alert: "sent" });
    expect(rows.procore_polling).toEqual({
      enabled: false,
      intervalMinutes: 17,
      disabledReason: "auth_expired",
      disabledAt: "2026-06-10T08:00:00.000Z",
      disabledError: "Request failed with status code 401",
    });

    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    const mail = mocks.sendEmail.mock.calls[0][0];
    expect(mail.to).toBe(RECIPIENT);
    expect(mail.bypassGlobalCc).toBe(true);
    expect(mail.subject).toMatch(/Procore polling DISABLED/);
    expect(mail.htmlBody).toContain("procore_polling");
    expect(mail.htmlBody).toContain("2026-06-10T08:00:00.000Z");
    expect(mail.htmlBody).toContain("auth_expired");
    expect(mail.htmlBody).toContain("POST /api/settings/polling/procore/enable");

    expect(mocks.storage.createAuditLog).toHaveBeenCalledTimes(1);
    expect(mocks.storage.createAuditLog.mock.calls[0][0]).toMatchObject({
      action: "polling_auto_disabled",
      entityType: "procore_polling",
      status: "error",
      category: "system",
    });
  });

  it("uses BIDBOARD_CRM_ALERT_RECIPIENT, the recipient the Procore sign-in and CRM push alerts use", async () => {
    vi.stubEnv("BIDBOARD_CRM_ALERT_RECIPIENT", `  ${RECIPIENT} `);
    backedStore({ hubspot_polling: { enabled: true, intervalMinutes: 11 } });
    const { recordPollingAuthExpiry } = await import("../server/polling-auth-alert.ts");

    const out = await recordPollingAuthExpiry({ job: "hubspot_polling", error: "EXPIRED_AUTHENTICATION" });
    expect(out.alert).toBe("sent");
    expect(mocks.sendEmail.mock.calls[0][0].to).toBe(RECIPIENT);
    expect(mocks.sendEmail.mock.calls[0][0].htmlBody).toContain("POST /api/settings/polling/hubspot/enable");
  });

  it("alerts ONCE per disable event: a repeat keeps the original disabledAt and sends nothing", async () => {
    const { rows } = backedStore({ procore_polling: { enabled: true, intervalMinutes: 17 } });
    const { recordPollingAuthExpiry } = await import("../server/polling-auth-alert.ts");
    const deps = { recipient: RECIPIENT };

    const first = await recordPollingAuthExpiry({ job: "procore_polling", error: "401" }, { ...deps, now: () => new Date("2026-06-10T08:00:00Z") });
    const second = await recordPollingAuthExpiry({ job: "procore_polling", error: "401" }, { ...deps, now: () => new Date("2026-06-10T09:30:00Z") });
    const third = await recordPollingAuthExpiry({ job: "procore_polling", error: "401" }, { ...deps, now: () => new Date("2026-06-11T09:30:00Z") });

    expect(first.alert).toBe("sent");
    expect(second).toEqual({ newEvent: false, disabledAt: "2026-06-10T08:00:00.000Z", persisted: true, alert: "already_sent" });
    expect(third.alert).toBe("already_sent");
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.storage.createAuditLog).toHaveBeenCalledTimes(1);
    expect(rows.procore_polling.disabledAt).toBe("2026-06-10T08:00:00.000Z");
  });

  it("a failed send is not banked: the next repeat of the SAME event retries the email", async () => {
    backedStore({ procore_polling: { enabled: true } });
    const { recordPollingAuthExpiry } = await import("../server/polling-auth-alert.ts");
    mocks.sendEmail.mockResolvedValueOnce({ success: false, provider: "gmail" });

    const first = await recordPollingAuthExpiry({ job: "procore_polling", error: "401" }, { recipient: RECIPIENT });
    const second = await recordPollingAuthExpiry({ job: "procore_polling", error: "401" }, { recipient: RECIPIENT });

    expect(first.alert).toBe("send_failed");
    expect(second.alert).toBe("sent");
    expect(second.disabledAt).toBe(first.disabledAt);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
  });

  it("after a re-enable, the next expiry is a NEW event and alerts again", async () => {
    const { rows } = backedStore({ procore_polling: { enabled: true } });
    const { recordPollingAuthExpiry } = await import("../server/polling-auth-alert.ts");

    await recordPollingAuthExpiry({ job: "procore_polling", error: "401" }, { recipient: RECIPIENT, now: () => new Date("2026-06-10T08:00:00Z") });
    rows.procore_polling = { enabled: true, intervalMinutes: 17 }; // what the re-enable endpoint writes
    const again = await recordPollingAuthExpiry({ job: "procore_polling", error: "401" }, { recipient: RECIPIENT, now: () => new Date("2026-10-01T08:00:00Z") });

    expect(again).toEqual({ newEvent: true, disabledAt: "2026-10-01T08:00:00.000Z", persisted: true, alert: "sent" });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
  });

  it("with no recipient: falls back to a structured error log + an error/system audit row, once", async () => {
    backedStore({ hubspot_polling: { enabled: true } });
    const { recordPollingAuthExpiry } = await import("../server/polling-auth-alert.ts");

    const a = await recordPollingAuthExpiry({ job: "hubspot_polling", error: "401 Unauthorized" }, { recipient: null });
    const b = await recordPollingAuthExpiry({ job: "hubspot_polling", error: "401 Unauthorized" }, { recipient: null });

    expect(a.alert).toBe("no_recipient");
    expect(b).toMatchObject({ newEvent: false, alert: "no_recipient" });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.storage.createAuditLog).toHaveBeenCalledTimes(1);
    expect(mocks.storage.createAuditLog.mock.calls[0][0]).toMatchObject({
      action: "polling_auto_disabled",
      entityType: "hubspot_polling",
      status: "error",
      category: "system",
      errorMessage: "401 Unauthorized",
    });
    const structured = errorSpy.mock.calls
      .map((c) => c[0])
      .filter((m) => typeof m === "string" && m.startsWith("{"))
      .map((m) => JSON.parse(m as string));
    expect(structured).toHaveLength(1);
    expect(structured[0]).toMatchObject({
      level: "error",
      event: "polling_auto_disabled",
      job: "hubspot_polling",
      reason: "auth_expired",
      emailRecipientConfigured: false,
    });
    expect(structured[0].reenable).toContain("/api/settings/polling/hubspot/enable");
  });

  it("a failed send schedules bounded retries of the SAME event, which never rewrite the row", async () => {
    const { rows } = backedStore({ procore_polling: { enabled: true, intervalMinutes: 17 } });
    const { recordPollingAuthExpiry, POLLING_ALERT_RETRY_DELAYS_MS } = await import("../server/polling-auth-alert.ts");
    mocks.sendEmail.mockResolvedValue({ success: false, provider: "gmail" });
    const scheduled: { fn: () => void; ms: number }[] = [];
    const scheduleRetry = (fn: () => void, ms: number) => void scheduled.push({ fn, ms });
    const deps = { recipient: RECIPIENT, now: () => new Date("2026-06-10T08:00:00Z"), scheduleRetry };

    const first = await recordPollingAuthExpiry({ job: "procore_polling", error: "401" }, deps);
    expect(first.alert).toBe("send_failed");
    expect(scheduled.map((s) => s.ms)).toEqual([POLLING_ALERT_RETRY_DELAYS_MS[0]]);
    const writes = mocks.storage.upsertAutomationConfig.mock.calls.length;

    // Each retry fails too, until the schedule runs out.
    for (let i = 0; i < POLLING_ALERT_RETRY_DELAYS_MS.length; i++) {
      scheduled[i]!.fn();
      await vi.waitFor(() => expect(mocks.sendEmail).toHaveBeenCalledTimes(i + 2));
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(scheduled.map((s) => s.ms)).toEqual([...POLLING_ALERT_RETRY_DELAYS_MS]);
    expect(mocks.storage.upsertAutomationConfig.mock.calls.length).toBe(writes);
    expect(rows.procore_polling.disabledAt).toBe("2026-06-10T08:00:00.000Z");
    expect(mocks.storage.createAuditLog).toHaveBeenCalledTimes(1);
  });

  it("a retry that succeeds banks the email once", async () => {
    backedStore({ hubspot_polling: { enabled: true } });
    const { recordPollingAuthExpiry } = await import("../server/polling-auth-alert.ts");
    mocks.sendEmail.mockResolvedValueOnce({ success: false, provider: "gmail" });
    const scheduled: (() => void)[] = [];
    await recordPollingAuthExpiry({ job: "hubspot_polling", error: "401" }, { recipient: RECIPIENT, scheduleRetry: (fn) => void scheduled.push(fn) });
    scheduled[0]!();
    await vi.waitFor(() => expect(mocks.storage.createEmailSendLog).toHaveBeenCalledTimes(1));
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
    expect(scheduled).toHaveLength(1);
  });

  it("an UNSAVED disable is not reported as durable: its own audit action, log event and email, and no rewrite later", async () => {
    const { rows } = backedStore({ procore_polling: { enabled: true, intervalMinutes: 17 } });
    mocks.storage.upsertAutomationConfig.mockRejectedValue(new Error("connection reset"));
    const { recordPollingAuthExpiry } = await import("../server/polling-auth-alert.ts");
    mocks.sendEmail.mockResolvedValueOnce({ success: false, provider: "gmail" });
    const scheduled: (() => void)[] = [];

    const out = await recordPollingAuthExpiry(
      { job: "procore_polling", error: "401" },
      { recipient: RECIPIENT, scheduleRetry: (fn) => void scheduled.push(fn) },
    );
    expect(out).toMatchObject({ newEvent: true, persisted: false, alert: "send_failed" });
    expect(rows.procore_polling).toEqual({ enabled: true, intervalMinutes: 17 });
    expect(mocks.storage.upsertAutomationConfig).toHaveBeenCalledTimes(3);
    expect(mocks.storage.createAuditLog.mock.calls.map((c) => c[0].action)).toEqual(["polling_auto_disable_not_saved"]);
    const structured = errorSpy.mock.calls
      .map((c) => c[0])
      .filter((m) => typeof m === "string" && m.startsWith("{"))
      .map((m) => JSON.parse(m as string));
    expect(structured.map((e) => [e.event, e.persisted])).toEqual([["polling_auto_disable_not_saved", false]]);

    // The retry resends the "not saved" alert only: it never writes the row, which an admin may have re-enabled.
    scheduled[0]!();
    await vi.waitFor(() => expect(mocks.storage.createEmailSendLog).toHaveBeenCalledTimes(1));
    expect(mocks.storage.upsertAutomationConfig).toHaveBeenCalledTimes(3);
    expect(mocks.storage.createAuditLog).toHaveBeenCalledTimes(1);
    const mail = mocks.sendEmail.mock.calls[1][0];
    expect(mail.subject).toMatch(/NOT saved/);
    expect(mail.htmlBody).toContain("next restart or deploy starts polling again");
    expect(mocks.storage.createEmailSendLog.mock.calls[0][0].dedupeKey).toMatch(/^polling_auto_disable_not_saved:procore_polling:/);
  });

  it("at boot, a saved disable whose email never went out is sent once; a banked or re-enabled one is not", async () => {
    const { sentKeys } = backedStore({
      procore_polling: { enabled: false, intervalMinutes: 17, disabledReason: "auth_expired", disabledAt: "2026-06-10T08:00:00.000Z", disabledError: "401 from Procore" },
      hubspot_polling: { enabled: true, intervalMinutes: 11 },
    });
    const { resendPendingPollingAlerts } = await import("../server/polling-auth-alert.ts");
    const deps = { recipient: RECIPIENT, now: () => new Date("2026-06-10T09:00:00Z") };

    await resendPendingPollingAlerts(deps);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendEmail.mock.calls[0][0].htmlBody).toContain("401 from Procore");
    expect(sentKeys.has("polling_auto_disabled:procore_polling:2026-06-10T08:00:00.000Z")).toBe(true);
    expect(mocks.storage.createAuditLog).not.toHaveBeenCalled();

    await resendPendingPollingAlerts(deps);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("a retry after an admin re-enable, or after a newer disable, is superseded: no email, no write", async () => {
    const { rows } = backedStore({ procore_polling: { enabled: true, intervalMinutes: 17 } });
    const { recordPollingAuthExpiry } = await import("../server/polling-auth-alert.ts");
    mocks.sendEmail.mockResolvedValueOnce({ success: false, provider: "gmail" });
    const scheduled: (() => void)[] = [];
    const deps = { recipient: RECIPIENT, now: () => new Date("2026-06-10T08:00:00Z"), scheduleRetry: (fn: () => void) => void scheduled.push(fn) };
    await recordPollingAuthExpiry({ job: "procore_polling", error: "401" }, deps);
    const writes = mocks.storage.upsertAutomationConfig.mock.calls.length;

    rows.procore_polling = { enabled: true, intervalMinutes: 17 }; // the admin re-enable
    const stale = recordPollingAuthExpiry({ job: "procore_polling", error: "401" }, { ...deps, retry: { attempt: 1, disabledAt: "2026-06-10T08:00:00.000Z", persisted: true } });
    await expect(stale).resolves.toMatchObject({ alert: "superseded", persisted: true });

    rows.procore_polling = { enabled: false, intervalMinutes: 17, disabledReason: "auth_expired", disabledAt: "2026-07-01T08:00:00.000Z" };
    const replaced = await recordPollingAuthExpiry({ job: "procore_polling", error: "401" }, { ...deps, retry: { attempt: 1, disabledAt: "2026-06-10T08:00:00.000Z", persisted: true } });
    expect(replaced.alert).toBe("superseded");

    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.storage.upsertAutomationConfig.mock.calls.length).toBe(writes);
  });

  it("the boot check is bound to the event it read: a re-enable in between leaves the row alone", async () => {
    const disabled = { enabled: false, intervalMinutes: 17, disabledReason: "auth_expired", disabledAt: "2026-06-10T08:00:00.000Z" };
    backedStore({});
    let reads = 0;
    // The boot scan reads the disabled row; by the time the resend reads it, an admin has re-enabled the job.
    mocks.storage.getAutomationConfig.mockImplementation(async (key: string) =>
      key === "procore_polling" ? { key, value: reads++ === 0 ? disabled : { enabled: true, intervalMinutes: 17 } } : undefined,
    );
    const { resendPendingPollingAlerts } = await import("../server/polling-auth-alert.ts");
    // Inside the resend window, so the only thing that stops the send is the re-enable.
    await resendPendingPollingAlerts({ recipient: RECIPIENT, now: () => new Date("2026-06-10T09:00:00Z") });
    expect(reads).toBe(2);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.storage.upsertAutomationConfig).not.toHaveBeenCalled();
    expect(mocks.storage.createAuditLog).not.toHaveBeenCalled();
  });

  it("a delivered email whose send log fails is NOT retried (the recipient already has it)", async () => {
    backedStore({ hubspot_polling: { enabled: true } });
    mocks.storage.createEmailSendLog.mockRejectedValue(new Error("db blip"));
    const { recordPollingAuthExpiry } = await import("../server/polling-auth-alert.ts");
    const scheduled: (() => void)[] = [];
    const out = await recordPollingAuthExpiry({ job: "hubspot_polling", error: "401" }, { recipient: RECIPIENT, scheduleRetry: (fn) => void scheduled.push(fn) });
    expect(out.alert).toBe("sent");
    expect(scheduled).toHaveLength(0);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.storage.createEmailSendLog).toHaveBeenCalledTimes(3);
  });

  it("a retry whose config read fails keeps retrying instead of dropping the alert as superseded", async () => {
    const { rows } = backedStore({ procore_polling: { enabled: true, intervalMinutes: 17 } });
    const { recordPollingAuthExpiry } = await import("../server/polling-auth-alert.ts");
    mocks.sendEmail.mockResolvedValueOnce({ success: false, provider: "gmail" });
    const scheduled: (() => void)[] = [];
    const deps = { recipient: RECIPIENT, now: () => new Date("2026-06-10T08:00:00Z"), scheduleRetry: (fn: () => void) => void scheduled.push(fn) };
    await recordPollingAuthExpiry({ job: "procore_polling", error: "401" }, deps);
    expect(scheduled).toHaveLength(1);

    // Retry 1: the read blips. Not superseded: the next retry is scheduled, and nothing is written.
    mocks.storage.getAutomationConfig.mockRejectedValueOnce(new Error("db blip"));
    scheduled[0]!();
    await vi.waitFor(() => expect(scheduled).toHaveLength(2));
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);

    // Retry 2: the read works, the row still holds the event, and the alert goes out once.
    scheduled[1]!();
    await vi.waitFor(() => expect(mocks.storage.createEmailSendLog).toHaveBeenCalledTimes(1));
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
    expect(rows.procore_polling.disabledAt).toBe("2026-06-10T08:00:00.000Z");
    expect(mocks.storage.upsertAutomationConfig).toHaveBeenCalledTimes(1);
  });

  it("a retry of an UNSAVED event is superseded once someone has saved the job off", async () => {
    const { rows } = backedStore({ procore_polling: { enabled: true, intervalMinutes: 17 } });
    const { recordPollingAuthExpiry } = await import("../server/polling-auth-alert.ts");
    const writes = mocks.storage.upsertAutomationConfig.mock.calls.length;
    rows.procore_polling = { enabled: false, intervalMinutes: 17 }; // turned off by hand after the unsaved disable
    const out = await recordPollingAuthExpiry(
      { job: "procore_polling", error: "401" },
      { recipient: RECIPIENT, retry: { attempt: 1, disabledAt: "2026-06-10T08:00:00.000Z", persisted: false } },
    );
    expect(out.alert).toBe("superseded");
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.storage.upsertAutomationConfig.mock.calls.length).toBe(writes);
  });

  it("an existing event older than the resend window is never resent (its dedupe row may have been cleaned up)", async () => {
    const old = { enabled: false, intervalMinutes: 17, disabledReason: "auth_expired", disabledAt: "2026-06-10T08:00:00.000Z" };
    const { rows } = backedStore({ procore_polling: { ...old }, hubspot_polling: { ...old, disabledAt: "not a date" } });
    const { recordPollingAuthExpiry, resendPendingPollingAlerts, POLLING_ALERT_RESEND_WINDOW_MS } = await import("../server/polling-auth-alert.ts");
    const late = () => new Date(Date.parse(old.disabledAt) + POLLING_ALERT_RESEND_WINDOW_MS + 60_000);

    // No email_send_log row (as after cleanupOldLogs' 90 days): neither the boot check nor a manual trigger sends.
    await resendPendingPollingAlerts({ recipient: RECIPIENT, now: late });
    const repeat = await recordPollingAuthExpiry({ job: "procore_polling", error: "401" }, { recipient: RECIPIENT, now: late });
    expect(repeat).toMatchObject({ newEvent: false, alert: "too_old", disabledAt: old.disabledAt });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.storage.checkEmailDedupeKey).not.toHaveBeenCalled();
    expect(rows.procore_polling).toEqual(old);

    // Just inside the window it is still resent, once.
    await resendPendingPollingAlerts({ recipient: RECIPIENT, now: () => new Date(Date.parse(old.disabledAt) + POLLING_ALERT_RESEND_WINDOW_MS - 60_000) });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendEmail.mock.calls[0][0].subject).toMatch(/Procore/);
  });

  it("a NEW event always alerts, whatever the age of the event it replaces", async () => {
    backedStore({ procore_polling: { enabled: true, intervalMinutes: 17 } });
    const { recordPollingAuthExpiry } = await import("../server/polling-auth-alert.ts");
    const out = await recordPollingAuthExpiry({ job: "procore_polling", error: "401" }, { recipient: RECIPIENT, now: () => new Date("2027-06-10T08:00:00Z") });
    expect(out).toMatchObject({ newEvent: true, alert: "sent" });
  });

  it("two sends of the same event racing each other deliver ONE email", async () => {
    backedStore({
      procore_polling: { enabled: false, intervalMinutes: 17, disabledReason: "auth_expired", disabledAt: "2026-06-10T08:00:00.000Z" },
    });
    const { recordPollingAuthExpiry } = await import("../server/polling-auth-alert.ts");
    let release!: () => void;
    mocks.sendEmail.mockImplementationOnce(() => new Promise((r) => (release = () => r({ success: true }))));
    const deps = { recipient: RECIPIENT, now: () => new Date("2026-06-10T09:00:00Z") };

    // A scheduled retry and a manual trigger hit the same event while the first send is still with the provider.
    const a = recordPollingAuthExpiry({ job: "procore_polling", error: "401" }, { ...deps, retry: { attempt: 1, disabledAt: "2026-06-10T08:00:00.000Z", persisted: true } });
    await vi.waitFor(() => expect(mocks.sendEmail).toHaveBeenCalledTimes(1));
    const b = await recordPollingAuthExpiry({ job: "procore_polling", error: "401" }, deps);
    release();
    expect((await a).alert).toBe("sent");
    expect(b.alert).toBe("already_sent");
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("a delivered email whose send log never banked is not sent again by a later repeat in the same process", async () => {
    backedStore({ hubspot_polling: { enabled: true } });
    mocks.storage.createEmailSendLog.mockRejectedValue(new Error("db blip"));
    const { recordPollingAuthExpiry } = await import("../server/polling-auth-alert.ts");
    const first = await recordPollingAuthExpiry({ job: "hubspot_polling", error: "401" }, { recipient: RECIPIENT });
    const repeat = await recordPollingAuthExpiry({ job: "hubspot_polling", error: "401" }, { recipient: RECIPIENT });
    expect(first.alert).toBe("sent");
    expect(repeat).toMatchObject({ newEvent: false, alert: "already_sent" });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("never throws, even when storage is down", async () => {
    mocks.storage.getAutomationConfig.mockRejectedValue(new Error("db down"));
    mocks.storage.upsertAutomationConfig.mockRejectedValue(new Error("db down"));
    mocks.storage.createAuditLog.mockRejectedValue(new Error("db down"));
    mocks.storage.checkEmailDedupeKey.mockRejectedValue(new Error("db down"));
    const { recordPollingAuthExpiry } = await import("../server/polling-auth-alert.ts");
    await expect(recordPollingAuthExpiry({ job: "procore_polling", error: "401" }, { recipient: RECIPIENT })).resolves.toMatchObject({
      newEvent: true,
    });
  });
});

// ── Wired into the real polling cycles ───────────────────────────────────────

function createFakeApp() {
  const routes: Record<string, any[]> = {};
  const record = (verb: string) =>
    vi.fn((path: string, ...handlers: any[]) => {
      routes[`${verb} ${path}`] = handlers;
    });
  return { routes, get: record("GET"), post: record("POST"), put: record("PUT"), patch: record("PATCH"), delete: record("DELETE") };
}

async function invokeRoute(handlers: any[], req: Record<string, unknown> = {}) {
  const res: any = { status: vi.fn(() => res), json: vi.fn() };
  let index = 0;
  const next: any = vi.fn(async (err?: unknown) => {
    if (err) throw err;
    const handler = handlers[index++];
    if (handler) return await handler(req, res, next);
  });
  await next();
  return res;
}

const passAuth = (_req: any, _res: any, next: any) => next();

describe("enable-all-automations → alert", () => {
  it("starts the SAME cycles as Settings: an expired token there disables both pollers and alerts", async () => {
    vi.useFakeTimers();
    try {
      vi.stubEnv("BIDBOARD_CRM_ALERT_RECIPIENT", RECIPIENT);
      vi.stubEnv("INTERNAL_API_SECRET", "test-internal-secret");
      const { rows } = backedStore({});
      mocks.runFullProcoreSync.mockRejectedValue(new Error("Request failed with status code 401"));
      mocks.runFullHubSpotSync.mockRejectedValue(new Error("EXPIRED_AUTHENTICATION"));
      const { registerSettingsRoutes } = await import("../server/routes/settings.ts");
      const app = createFakeApp();
      registerSettingsRoutes(app as any, passAuth);

      await invokeRoute(app.routes["POST /api/internal/enable-all-automations"], {
        body: {},
        headers: { "x-internal-secret": "test-internal-secret" },
      });
      await vi.advanceTimersByTimeAsync(91_000);
      expect(rows.hubspot_polling).toMatchObject({ enabled: false, disabledReason: "auth_expired" });
      expect(rows.procore_polling).toMatchObject({ enabled: false, disabledReason: "auth_expired" });
      expect(mocks.storage.createAuditLog.mock.calls.filter((c) => c[0].action === "polling_auto_disabled")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves an auth_expired job OFF: a shared secret is not an admin re-enable", async () => {
    vi.useFakeTimers();
    try {
      vi.stubEnv("INTERNAL_API_SECRET", "test-internal-secret");
      const disabled = { enabled: false, intervalMinutes: 17, disabledReason: "auth_expired", disabledAt: "2026-06-10T08:00:00.000Z" };
      const { rows } = backedStore({ procore_polling: { ...disabled }, hubspot_polling: { enabled: false, intervalMinutes: 11 } });
      mocks.runFullHubSpotSync.mockResolvedValue({});
      const { registerSettingsRoutes } = await import("../server/routes/settings.ts");
      const app = createFakeApp();
      registerSettingsRoutes(app as any, passAuth);

      const res = await invokeRoute(app.routes["POST /api/internal/enable-all-automations"], {
        body: {},
        headers: { "x-internal-secret": "test-internal-secret" },
      });
      // requireInternalSecret does not return next()'s promise, so the handler is still running here.
      await vi.advanceTimersByTimeAsync(91_000);
      const body = res.json.mock.calls[0][0];
      expect(body.automations.procore_polling).toMatch(/^skipped: auth_expired .*\/api\/settings\/polling\/procore\/enable/);
      expect(body.automations.hubspot_polling).toBe("enabled (15 min)");
      expect(rows.procore_polling).toEqual(disabled);
      expect(rows.hubspot_polling).toEqual({ enabled: true, intervalMinutes: 15 });
      expect(mocks.runFullProcoreSync).not.toHaveBeenCalled();
      expect(mocks.runFullHubSpotSync).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a disable that lands mid-request is not overwritten: the enable is conditional at write time", async () => {
    vi.useFakeTimers();
    try {
      vi.stubEnv("INTERNAL_API_SECRET", "test-internal-secret");
      const disabled = { enabled: false, intervalMinutes: 17, disabledReason: "auth_expired", disabledAt: "2026-06-10T08:00:00.000Z" };
      const { rows } = backedStore({ procore_polling: { enabled: true, intervalMinutes: 17 } });
      // Any read of procore_polling during the request sees the old, enabled row, and the polling cycle's
      // auth-expiry disable commits right after that read (before enable-all's write).
      const realGet = mocks.storage.getAutomationConfig.getMockImplementation()!;
      mocks.storage.getAutomationConfig.mockImplementation(async (key: string) => {
        const out = await realGet(key);
        if (key === "procore_polling") rows.procore_polling = { ...disabled };
        return out;
      });
      // And with no read at all, it commits once the request is under way.
      const realUpsert = mocks.storage.upsertAutomationConfig.getMockImplementation()!;
      mocks.storage.upsertAutomationConfig.mockImplementation(async (data: any) => {
        if (data.key === "hubspot_webhook_processing") rows.procore_polling = { ...disabled };
        return realUpsert(data);
      });
      mocks.runFullHubSpotSync.mockResolvedValue({});
      const { registerSettingsRoutes } = await import("../server/routes/settings.ts");
      const app = createFakeApp();
      registerSettingsRoutes(app as any, passAuth);

      const res = await invokeRoute(app.routes["POST /api/internal/enable-all-automations"], {
        body: {},
        headers: { "x-internal-secret": "test-internal-secret" },
      });
      await vi.advanceTimersByTimeAsync(91_000);
      expect(res.json.mock.calls[0][0].automations.procore_polling).toMatch(/^skipped: auth_expired/);
      expect(rows.procore_polling).toEqual(disabled);
      expect(mocks.runFullProcoreSync).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("polling cycles → alert", () => {
  it.each([
    ["procore_polling", "/api/automation/procore-polling/trigger", () => mocks.runFullProcoreSync, "Request failed with status code 401"],
    ["hubspot_polling", "/api/automation/polling/trigger", () => mocks.runFullHubSpotSync, "EXPIRED_AUTHENTICATION"],
  ] as const)("%s: an auth failure disables it and alerts once across repeated triggers", async (key, path, syncFn, message) => {
    vi.stubEnv("BIDBOARD_CRM_ALERT_RECIPIENT", RECIPIENT);
    const { rows } = backedStore({ [key]: { enabled: true, intervalMinutes: 20 } });
    syncFn().mockRejectedValue(new Error(message));
    const { registerSettingsRoutes } = await import("../server/routes/settings.ts");
    const app = createFakeApp();
    registerSettingsRoutes(app as any, passAuth);

    await invokeRoute(app.routes[`POST ${path}`]);
    await vi.waitFor(() => expect(mocks.sendEmail).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(mocks.storage.createEmailSendLog).toHaveBeenCalledTimes(1));
    expect(rows[key]).toMatchObject({ enabled: false, intervalMinutes: 20, disabledReason: "auth_expired" });
    const firstDisabledAt = rows[key].disabledAt;

    // A manual trigger against the same dead token is the same event.
    const reads = mocks.storage.getAutomationConfig.mock.calls.length;
    await invokeRoute(app.routes[`POST ${path}`]);
    await vi.waitFor(() => expect(syncFn()).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(mocks.storage.getAutomationConfig.mock.calls.length).toBeGreaterThan(reads));
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(rows[key].disabledAt).toBe(firstDisabledAt);
    expect(mocks.storage.createAuditLog.mock.calls.filter((c) => c[0].action === "polling_auto_disabled")).toHaveLength(1);
  });
});
