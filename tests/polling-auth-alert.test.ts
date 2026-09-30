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

    expect(out).toEqual({ newEvent: true, disabledAt: "2026-06-10T08:00:00.000Z", alert: "sent" });
    expect(rows.procore_polling).toEqual({
      enabled: false,
      intervalMinutes: 17,
      disabledReason: "auth_expired",
      disabledAt: "2026-06-10T08:00:00.000Z",
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
    expect(second).toEqual({ newEvent: false, disabledAt: "2026-06-10T08:00:00.000Z", alert: "already_sent" });
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

    expect(again).toEqual({ newEvent: true, disabledAt: "2026-10-01T08:00:00.000Z", alert: "sent" });
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
    await invokeRoute(app.routes[`POST ${path}`]);
    await vi.waitFor(() => expect(mocks.storage.checkEmailDedupeKey).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(rows[key].disabledAt).toBe(firstDisabledAt);
    expect(mocks.storage.createAuditLog.mock.calls.filter((c) => c[0].action === "polling_auto_disabled")).toHaveLength(1);
  });
});
