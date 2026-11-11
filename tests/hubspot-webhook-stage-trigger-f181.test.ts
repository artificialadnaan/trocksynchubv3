import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// F-181 (opened by a4 on d9's report; scope frozen by d9 + a4 11-11). SyncHub marked EVERY HubSpot webhook processed:
// webhooks.ts:111 declares hubspotProcessingError but nothing assigns it, and :181-188 only logs a stage-trigger throw. The
// replay (:1389-1445) never re-ran the stage trigger and read `event.objectType || ""`, so a real v3 deal event (HubSpot sends
// no objectType) replayed as a no-op and was marked processed. The pins:
// - a failed trigger marks the webhook failed. That is INTERNAL ONLY: HubSpot still gets 200 {received:true}, so it never
//   auto-retries into a duplicate create. It raises ONE windowed "hubspot-stage-trigger:" alert. A hold check that could not
//   run ((c) core_footprint_check_failed) is failed but not re-alerted: A3 already raised core_preflight_error;
// - REPLAYABLE fails closed: only positive pre-submit evidence (beforeSubmit with no projectId) or (c). Anything else is
//   "manual" (a project may exist), and the SHARED replay endpoint refuses it with 400 before touching the row. A failed
//   stage event with no prefix is manual too. Every other webhook kind replays as today;
// - a replay re-runs the trigger + today's deal syncs, never the stage-change email, and not after the deal moved on;
// - the RFP branch: only a createRfpApprovalRequest FAULT is failed (replayable); its refusals stay as today; the replay
//   honours HUBSPOT_RFP_TRIGGER_ENABLED;
// - the success path is byte-identical. Synthetic ids only.

const processDealStageChangeMock = vi.hoisted(() => vi.fn());
const createRfpApprovalRequestMock = vi.hoisted(() => vi.fn());
const recordPushMock = vi.hoisted(() => vi.fn());
const dbRows = vi.hoisted(() => ({ current: [] as any[] }));
const storageMock = vi.hoisted(() => ({
  checkIdempotencyKey: vi.fn(),
  createWebhookLog: vi.fn(),
  createIdempotencyKey: vi.fn(),
  createAuditLog: vi.fn(),
  updateWebhookLog: vi.fn(),
  getAutomationConfig: vi.fn(),
  getHubspotDealByHubspotId: vi.fn(),
  getSyncMappingByHubspotDealId: vi.fn(),
  getHubspotPipelines: vi.fn(),
}));

vi.mock("../server/db.ts", () => ({
  db: {
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => dbRows.current }) }) })),
    delete: vi.fn(),
  },
  pool: {},
}));
vi.mock("../server/storage.ts", () => ({ storage: storageMock }));
vi.mock("../server/hubspot-bidboard-trigger.ts", () => ({ processDealStageChange: processDealStageChangeMock }));
vi.mock("../server/rfp-approval.ts", () => ({ createRfpApprovalRequest: createRfpApprovalRequestMock }));
vi.mock("../server/sync/bidboard-crm-alert.ts", () => ({
  recordPushOutcomeAndMaybeAlert: recordPushMock,
  escapeHtml: (s: string) => s,
}));
vi.mock("../server/procore.ts", () => ({
  syncProcoreRoleAssignments: vi.fn(),
  fetchProcoreProjectDetail: vi.fn(),
}));
vi.mock("../server/hubspot.ts", () => ({
  updateHubSpotDealStage: vi.fn(),
  syncSingleHubSpotDeal: vi.fn(),
  syncSingleHubSpotContact: vi.fn(),
  syncSingleHubSpotCompany: vi.fn(),
}));
vi.mock("../server/email-notifications.ts", () => ({ sendStageChangeEmail: vi.fn() }));
vi.mock("../server/deal-project-number.ts", () => ({ processNewDealWebhook: vi.fn() }));
vi.mock("../server/hubspot-procore-sync.ts", () => ({ processHubspotWebhookForProcore: vi.fn() }));
vi.mock("../server/procore-hubspot-sync.ts", () => ({
  mapProcoreStageToHubspot: vi.fn(),
  resolveHubspotStageId: vi.fn(async (value: string) =>
    value === "rfp" ? { stageId: "rfp", stageName: "RFP" } : { stageId: value, stageName: "Estimating" }),
  findOrCreateMappingByProjectNumber: vi.fn(),
  getTerminalStageGuard: vi.fn(),
}));
vi.mock("../server/webhooks/procore-webhook.ts", () => ({
  handleProcoreProjectWebhook: vi.fn((_req: any, res: any) => res.status(200).json({ received: true })),
}));
vi.mock("../server/webhooks/migration-mode.ts", () => ({
  evaluateWebhookPortfolioPhase2Gate: vi.fn(),
  getWebhookMigrationModeConfig: vi.fn(async () => ({ enabled: false })),
  isMigrationMode: vi.fn(() => false),
  logWebhookSuppressedAction: vi.fn(),
}));
vi.mock("../server/routes/settings.ts", () => ({ recordWebhookRoleEvent: vi.fn() }));
vi.mock("../server/procore-rate-limiter.ts", () => ({ markProjectWebhookUpdated: vi.fn() }));
vi.mock("../server/services/reconciliation/guardrails.ts", () => ({ detectFieldDrift: vi.fn() }));

const LIVE_ID = 41;
const ROW_ID = 77;
const DEAL = "9181";
const STAGE = "estimating_f181";

/** A HubSpot v3 deal-stage event: HubSpot sends no objectType. */
function stageEvent(over: Record<string, unknown> = {}) {
  return {
    eventId: 9181001,
    subscriptionType: "deal.propertyChange",
    objectId: 9181,
    propertyName: "dealstage",
    propertyValue: STAGE,
    changeSource: "CRM_UI",
    ...over,
  };
}

function failedRow(over: Record<string, unknown> = {}) {
  return {
    id: ROW_ID,
    source: "hubspot",
    status: "failed",
    payload: stageEvent(),
    retryCount: 0,
    maxRetries: 3,
    errorMessage: "replayable: synthetic earlier failure",
    ...over,
  };
}

async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const { registerWebhookRoutes } = await import("../server/routes/webhooks.ts");
  const app = express();
  app.use(express.json());
  registerWebhookRoutes(app);
  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Webhook test server did not bind");
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

async function postHubspot(event: Record<string, unknown>) {
  return withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/webhooks/hubspot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    return { status: res.status, body: await res.json() };
  });
}

async function replay(id = ROW_ID) {
  return withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/webhooks/replay/${id}`, { method: "POST" });
    return { status: res.status, body: await res.json() };
  });
}

/** The last terminal mark (processed / failed) written for a webhook log. */
function finalMark(id: number) {
  const marks = storageMock.updateWebhookLog.mock.calls.filter(([cid, data]: any[]) => cid === id && (data?.status === "processed" || data?.status === "failed"));
  return marks.length ? marks[marks.length - 1][1] : undefined;
}

function createFailed(result: Record<string, unknown>) {
  return { triggered: true, result: { success: false, projectName: "Synthetic Deal", ...result } };
}

beforeEach(async () => {
  vi.clearAllMocks();
  delete process.env.HUBSPOT_RFP_TRIGGER_ENABLED;
  dbRows.current = [];
  storageMock.checkIdempotencyKey.mockResolvedValue(false);
  storageMock.createWebhookLog.mockResolvedValue({ id: LIVE_ID });
  storageMock.createIdempotencyKey.mockResolvedValue({ id: 1 });
  storageMock.createAuditLog.mockResolvedValue({ id: 1 });
  storageMock.updateWebhookLog.mockResolvedValue({ id: LIVE_ID });
  storageMock.getAutomationConfig.mockResolvedValue({ value: { enabled: true } });
  storageMock.getHubspotDealByHubspotId.mockResolvedValue({ dealStageName: "Qualified", dealStage: STAGE });
  storageMock.getSyncMappingByHubspotDealId.mockResolvedValue(null);
  storageMock.getHubspotPipelines.mockResolvedValue([]);
  processDealStageChangeMock.mockResolvedValue({ triggered: true, result: { success: true, projectId: "900181" } });
  createRfpApprovalRequestMock.mockResolvedValue({ success: true, token: "token-f181" });
  recordPushMock.mockResolvedValue({ action: "alert", sent: true });
});

afterEach(() => {
  delete process.env.HUBSPOT_RFP_TRIGGER_ENABLED;
});

describe("F-181 live webhook: a failed deal-stage trigger is visible, never silently processed", () => {
  it("a thrown trigger ⇒ failed as manual (no pre-submit evidence); HubSpot still gets 200 {received:true}", async () => {
    processDealStageChangeMock.mockRejectedValue(new Error("synthetic driver crash"));
    const res = await postHubspot(stageEvent());
    expect(res).toEqual({ status: 200, body: { received: true } });
    expect(finalMark(LIVE_ID)).toMatchObject({ status: "failed", errorMessage: expect.stringMatching(/^manual: .*synthetic driver crash/) });
  });

  it("a thrown trigger raises ONE windowed hubspot-stage-trigger alert naming the deal", async () => {
    processDealStageChangeMock.mockRejectedValue(new Error("synthetic driver crash"));
    await postHubspot(stageEvent());
    expect(recordPushMock).toHaveBeenCalledTimes(1);
    const [args] = recordPushMock.mock.calls[0];
    expect(args).toMatchObject({ officeSlug: expect.stringMatching(/^hubspot-stage-trigger:/), signatureChanged: false, pushResult: { ok: false } });
    expect(args.pushResult.error).toContain(DEAL);
    expect(args.pushResult.error).toContain("synthetic driver crash");
  });

  it("a create that failed before the submit (beforeSubmit, no projectId) ⇒ failed as replayable, alerted once", async () => {
    processDealStageChangeMock.mockResolvedValue(createFailed({ error: "Failed to log in to Procore", beforeSubmit: true }));
    const res = await postHubspot(stageEvent());
    expect(res).toEqual({ status: 200, body: { received: true } });
    expect(finalMark(LIVE_ID)).toMatchObject({ status: "failed", errorMessage: expect.stringMatching(/^replayable: .*Failed to log in to Procore/) });
    expect(recordPushMock).toHaveBeenCalledTimes(1);
  });

  it("an indeterminate create ('Could not confirm project creation', bidboard.ts:1944) ⇒ failed as manual, alerted once", async () => {
    processDealStageChangeMock.mockResolvedValue(createFailed({ error: "Could not confirm project creation" }));
    const res = await postHubspot(stageEvent());
    expect(res).toEqual({ status: 200, body: { received: true } });
    expect(finalMark(LIVE_ID)).toMatchObject({ status: "failed", errorMessage: expect.stringMatching(/^manual: a project may exist.*Could not confirm project creation/) });
    expect(recordPushMock).toHaveBeenCalledTimes(1);
  });

  it("a failure that carries a projectId is manual even when beforeSubmit is claimed (fail closed)", async () => {
    processDealStageChangeMock.mockResolvedValue(createFailed({ error: "synthetic client fill failure", projectId: "900181", beforeSubmit: true }));
    await postHubspot(stageEvent());
    expect(finalMark(LIVE_ID)).toMatchObject({ status: "failed", errorMessage: expect.stringMatching(/^manual: a project may exist/) });
  });

  it("(c) core_footprint_check_failed ⇒ failed as replayable, NOT re-alerted (A3 already raised core_preflight_error)", async () => {
    processDealStageChangeMock.mockResolvedValue({ triggered: false, reason: "core_footprint_check_failed" });
    const res = await postHubspot(stageEvent());
    expect(res).toEqual({ status: 200, body: { received: true } });
    expect(finalMark(LIVE_ID)).toMatchObject({ status: "failed", errorMessage: expect.stringMatching(/^replayable: /) });
    expect(recordPushMock).not.toHaveBeenCalled();
  });

  it("an alert that fails cannot change the outcome: still 200 and failed", async () => {
    processDealStageChangeMock.mockRejectedValue(new Error("synthetic driver crash"));
    recordPushMock.mockRejectedValue(new Error("synthetic alert store down"));
    const res = await postHubspot(stageEvent());
    expect(res).toEqual({ status: 200, body: { received: true } });
    expect(finalMark(LIVE_ID)).toMatchObject({ status: "failed" });
  });

  it("(guard) a successful create is processed exactly as today, with no alert", async () => {
    const res = await postHubspot(stageEvent());
    expect(res).toEqual({ status: 200, body: { received: true } });
    expect(processDealStageChangeMock).toHaveBeenCalledWith(DEAL, STAGE);
    expect(storageMock.updateWebhookLog.mock.calls).toEqual([
      [LIVE_ID, { status: "processing" }],
      [LIVE_ID, { status: "processed", processedAt: expect.any(Date), errorMessage: null }],
    ]);
    expect(recordPushMock).not.toHaveBeenCalled();
  });

  it.each(["automation_disabled", "stage_not_configured_for_trigger", "bidboard_project_already_exists", "cross_destination_hold"])(
    "(guard) a trigger that did nothing by design (%s) is processed as today, with no alert",
    async (reason) => {
      processDealStageChangeMock.mockResolvedValue({ triggered: false, reason });
      await postHubspot(stageEvent());
      expect(finalMark(LIVE_ID)).toEqual({ status: "processed", processedAt: expect.any(Date), errorMessage: null });
      expect(recordPushMock).not.toHaveBeenCalled();
    },
  );
});

describe("F-181 live webhook, the RFP stage branch: only a createRfpApprovalRequest fault is failed", () => {
  it("a fault ⇒ failed as replayable, alerted once; HubSpot still gets 200 {received:true}", async () => {
    createRfpApprovalRequestMock.mockResolvedValue({ success: false, error: "synthetic HubSpot fetch timeout", fault: true });
    const res = await postHubspot(stageEvent({ propertyValue: "rfp" }));
    expect(res).toEqual({ status: 200, body: { received: true } });
    expect(createRfpApprovalRequestMock).toHaveBeenCalledWith(DEAL);
    expect(finalMark(LIVE_ID)).toMatchObject({ status: "failed", errorMessage: expect.stringMatching(/^replayable: .*synthetic HubSpot fetch timeout/) });
    expect(recordPushMock).toHaveBeenCalledTimes(1);
  });

  it("(guard) a refusal (a project-number collision, no fault) stays processed, with no alert", async () => {
    createRfpApprovalRequestMock.mockResolvedValue({ success: false, error: "Project DFW-2-91810-zz already has a pending approval request" });
    await postHubspot(stageEvent({ propertyValue: "rfp" }));
    expect(finalMark(LIVE_ID)).toEqual({ status: "processed", processedAt: expect.any(Date), errorMessage: null });
    expect(recordPushMock).not.toHaveBeenCalled();
  });

  it("(guard) an existing pending request (success with its token) stays processed", async () => {
    await postHubspot(stageEvent({ propertyValue: "rfp" }));
    expect(finalMark(LIVE_ID)).toEqual({ status: "processed", processedAt: expect.any(Date), errorMessage: null });
  });

  it("(guard) the kill switch (HUBSPOT_RFP_TRIGGER_ENABLED=false) never calls it and never marks the webhook failed", async () => {
    process.env.HUBSPOT_RFP_TRIGGER_ENABLED = "false";
    const res = await postHubspot(stageEvent({ propertyValue: "rfp" }));
    expect(res.status).toBe(200);
    expect(createRfpApprovalRequestMock).not.toHaveBeenCalled();
    expect(storageMock.updateWebhookLog.mock.calls.some(([, data]: any[]) => data?.status === "failed")).toBe(false);
  });
});

describe("F-181 replay (POST /api/webhooks/replay/:id)", () => {
  it("a replayable stage failure re-runs the trigger once plus today's deal syncs, never the stage-change email", async () => {
    dbRows.current = [failedRow()];
    const { syncSingleHubSpotDeal } = await import("../server/hubspot.ts");
    const { processHubspotWebhookForProcore } = await import("../server/hubspot-procore-sync.ts");
    const { sendStageChangeEmail } = await import("../server/email-notifications.ts");
    const { logWebhookSuppressedAction } = await import("../server/webhooks/migration-mode.ts");
    const res = await replay();
    expect(res.status).toBe(200);
    expect(processDealStageChangeMock).toHaveBeenCalledTimes(1);
    expect(processDealStageChangeMock).toHaveBeenCalledWith(DEAL, STAGE);
    expect(syncSingleHubSpotDeal).toHaveBeenCalledWith(DEAL);
    expect(processHubspotWebhookForProcore).toHaveBeenCalledWith("deal.propertyChange", "deal", DEAL);
    expect(sendStageChangeEmail).not.toHaveBeenCalled();
    expect(logWebhookSuppressedAction).not.toHaveBeenCalled();
    expect(finalMark(ROW_ID)).toMatchObject({ status: "processed", errorMessage: null });
  });

  it("a replay whose trigger fails again stays failed with the new reason (500)", async () => {
    dbRows.current = [failedRow()];
    processDealStageChangeMock.mockResolvedValue(createFailed({ error: "Failed to log in to Procore", beforeSubmit: true }));
    const res = await replay();
    expect(res.status).toBe(500);
    expect(processDealStageChangeMock).toHaveBeenCalledTimes(1);
    expect(finalMark(ROW_ID)).toMatchObject({ status: "failed", errorMessage: expect.stringMatching(/^replayable: .*Failed to log in to Procore/) });
  });

  it("a replay that hits an indeterminate create stays failed as manual, so it cannot be replayed again", async () => {
    dbRows.current = [failedRow()];
    processDealStageChangeMock.mockResolvedValue(createFailed({ error: "Could not confirm project creation" }));
    const res = await replay();
    expect(res.status).toBe(500);
    expect(finalMark(ROW_ID)).toMatchObject({ status: "failed", errorMessage: expect.stringMatching(/^manual: a project may exist/) });
  });

  it("a manual stage failure is refused server-side (400) before the row is touched, with 0 create calls", async () => {
    dbRows.current = [failedRow({ errorMessage: "manual: a project may exist; synthetic earlier failure" })];
    const res = await replay();
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/manual: a project may exist/);
    expect(processDealStageChangeMock).not.toHaveBeenCalled();
    expect(storageMock.updateWebhookLog).not.toHaveBeenCalled();
  });

  it("a failed stage event with NO prefix is treated as manual (fail closed): 400, row untouched", async () => {
    dbRows.current = [failedRow({ errorMessage: "synthetic legacy failure" })];
    const res = await replay();
    expect(res.status).toBe(400);
    expect(processDealStageChangeMock).not.toHaveBeenCalled();
    expect(storageMock.updateWebhookLog).not.toHaveBeenCalled();
  });

  it("a stage replay after the deal moved on (read after the replay's deal sync) does not re-run the trigger, and is processed", async () => {
    dbRows.current = [failedRow()];
    storageMock.getHubspotDealByHubspotId.mockResolvedValue({ dealStageName: "Closed Lost", dealStage: "closedlost" });
    const { syncSingleHubSpotDeal } = await import("../server/hubspot.ts");
    const res = await replay();
    expect(res.status).toBe(200);
    expect(String(res.body.message)).toMatch(/stage moved on/);
    expect(syncSingleHubSpotDeal).toHaveBeenCalledWith(DEAL);
    expect(processDealStageChangeMock).not.toHaveBeenCalled();
    expect(finalMark(ROW_ID)).toMatchObject({ status: "processed" });
  });

  it("an RFP-fault replay re-runs createRfpApprovalRequest once", async () => {
    dbRows.current = [failedRow({ payload: stageEvent({ propertyValue: "rfp" }), errorMessage: "replayable: synthetic HubSpot fetch timeout" })];
    const res = await replay();
    expect(res.status).toBe(200);
    expect(createRfpApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(createRfpApprovalRequestMock).toHaveBeenCalledWith(DEAL);
    expect(processDealStageChangeMock).not.toHaveBeenCalled();
    expect(finalMark(ROW_ID)).toMatchObject({ status: "processed", errorMessage: null });
  });

  it("an RFP replay honours HUBSPOT_RFP_TRIGGER_ENABLED=false: 400, no state change, no request", async () => {
    process.env.HUBSPOT_RFP_TRIGGER_ENABLED = "false";
    dbRows.current = [failedRow({ payload: stageEvent({ propertyValue: "rfp" }), errorMessage: "replayable: synthetic HubSpot fetch timeout" })];
    const res = await replay();
    expect(res.status).toBe(400);
    expect(createRfpApprovalRequestMock).not.toHaveBeenCalled();
    expect(storageMock.updateWebhookLog).not.toHaveBeenCalled();
  });

  it("(guard) a non-stage webhook replays exactly as today: a failed Procore project update re-fetches the project", async () => {
    dbRows.current = [{
      id: ROW_ID,
      source: "procore",
      status: "failed",
      payload: { resource_name: "Projects", event_type: "update", project_id: 918101 },
      retryCount: 0,
      maxRetries: 3,
      errorMessage: "manual: a synthetic message that only the stage gate reads",
    }];
    const { fetchProcoreProjectDetail } = await import("../server/procore.ts");
    const res = await replay();
    expect(res.status).toBe(200);
    expect(fetchProcoreProjectDetail).toHaveBeenCalledWith("918101");
    expect(storageMock.updateWebhookLog.mock.calls).toEqual([
      [ROW_ID, { status: "processing", retryCount: 1, errorMessage: null }],
      [ROW_ID, { status: "processed", processedAt: expect.any(Date), errorMessage: null }],
    ]);
  });
});
