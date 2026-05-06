import { describe, expect, it, vi } from "vitest";

type SourceSystem = "hubspot" | "trock_crm";
type RfpStatus = "pending" | "approved" | "declined" | "cancelled_source_ineligible";

interface RfpRequest {
  id: number;
  sourceSystem: SourceSystem;
  sourceDealId: string;
  sourceEventId: string;
  projectNumber: string;
  token: string;
  status: RfpStatus;
  tokenExpiresAt: Date | null;
  bidboardProjectId?: string | null;
}

interface CrmDeal {
  id: string;
  stage: string;
  projectNumber: string;
  rfpApprovalStatus: string | null;
  rfpApprovalRequestId?: number | null;
  rfpApprovalToken?: string | null;
  rfpConflictReason?: string | null;
  rfpConflictWith?: Record<string, unknown> | null;
  rfpLastAttemptError?: string | null;
  procoreBidId?: string | null;
  procoreCompanyId?: string | null;
  isBidBoardOwned: boolean;
  bidBoardLinkedAt?: Date | null;
}

interface Job {
  id: number;
  dealId: string;
  jobType: "rfp_request_delivery";
  status: "pending" | "completed" | "dead";
  attempts: number;
  maxAttempts: number;
  payload: any;
  lastError?: string | null;
}

class MultiSourceRfpHarness {
  crmDeals: CrmDeal[] = [];
  jobs: Job[] = [];
  rfpRequests: RfpRequest[] = [];
  bidboardCallbacks: Array<{ id: number; status: "pending" | "sent" | "dead"; payload: any; attempts: number }> = [];
  emails: Array<{ type: string; to: string; subject: string; body?: string }> = [];
  auditLogs: Array<Record<string, unknown>> = [];
  hubspotStageUpdates: Array<{ dealId: string; stage: string }> = [];
  eligibilityCalls: string[] = [];
  bidboardCreates: Array<{ sourceDealId: string; projectNumber: string }> = [];
  pendingProjectNumberIndexEnabled = true;
  nextRequestId = 1;
  nextJobId = 1;
  nextBidboardId = 100;
  syncHubStatuses: number[] = [];
  crmCallbackStatuses: number[] = [];

  createCrmDeal(overrides: Partial<CrmDeal> = {}) {
    const deal: CrmDeal = {
      id: overrides.id ?? `crm-deal-${this.crmDeals.length + 1}`,
      stage: overrides.stage ?? "lead",
      projectNumber: overrides.projectNumber ?? `PN-${this.crmDeals.length + 1}`,
      rfpApprovalStatus: overrides.rfpApprovalStatus ?? null,
      isBidBoardOwned: overrides.isBidBoardOwned ?? false,
      ...overrides,
    };
    this.crmDeals.push(deal);
    return deal;
  }

  moveCrmDealToOpportunity(dealId: string) {
    const deal = this.mustFindDeal(dealId);
    deal.stage = "opportunity";
    deal.rfpApprovalStatus = "pending_outbox";
    this.jobs.push({
      id: this.nextJobId++,
      dealId,
      jobType: "rfp_request_delivery",
      status: "pending",
      attempts: 0,
      maxAttempts: 8,
      payload: this.buildNormalizedPayload(deal),
    });
  }

  async runCrmWorker(job = this.jobs.find((item) => item.status === "pending")) {
    if (!job) return;
    const deal = this.mustFindDeal(job.dealId);
    job.attempts += 1;
    const status = this.syncHubStatuses.length > 0 ? this.syncHubStatuses.shift()! : 201;
    if (status >= 500 || status === 401 || status === 422) {
      job.lastError = `SyncHub returned ${status}`;
      if (job.attempts >= job.maxAttempts) job.status = "dead";
      return;
    }

    const result = await this.postRfpRequest(job.payload.body);
    if (result.status === 201 || result.status === 200) {
      deal.rfpApprovalRequestId = result.body.requestId;
      deal.rfpApprovalToken = result.body.token;
      deal.rfpApprovalStatus = "pending";
      job.status = "completed";
      return;
    }

    if (result.status === 409) {
      deal.rfpApprovalStatus = "conflict";
      deal.rfpConflictReason = result.body.error;
      deal.rfpConflictWith = result.body.conflict;
      job.status = "completed";
      return;
    }

    job.lastError = `SyncHub returned ${result.status}`;
    if (job.attempts >= job.maxAttempts) job.status = "dead";
  }

  sweepDeadJobs() {
    for (const job of this.jobs.filter((item) => item.status === "dead" && !item.payload.dealHandled)) {
      const deal = this.mustFindDeal(job.dealId);
      deal.rfpApprovalStatus = "send_failed";
      deal.rfpLastAttemptError = job.lastError ?? "RFP request delivery failed permanently";
      job.payload.dealHandled = true;
    }
  }

  retryDeadJob(dealId: string) {
    const deadJob = this.jobs.find((job) => job.dealId === dealId && job.status === "dead");
    if (!deadJob) throw new Error("dead job not found");
    this.jobs.push({
      id: this.nextJobId++,
      dealId,
      jobType: "rfp_request_delivery",
      status: "pending",
      attempts: 0,
      maxAttempts: 8,
      payload: { ...deadJob.payload, dealHandled: undefined },
    });
    const deal = this.mustFindDeal(dealId);
    deal.rfpApprovalStatus = "pending_outbox";
    deal.rfpLastAttemptError = null;
  }

  async postRfpRequest(input: any) {
    const existingEvent = this.rfpRequests.find((row) => row.sourceSystem === input.sourceSystem && row.sourceEventId === input.sourceEventId);
    if (existingEvent) {
      return { status: 200, body: { requestId: existingEvent.id, token: existingEvent.token, status: existingEvent.status } };
    }

    const pending = this.rfpRequests.find((row) => row.projectNumber === input.deal.projectNumber && row.status === "pending");
    if (pending) return this.pendingCollision(pending);

    const approved = this.rfpRequests.find((row) => row.projectNumber === input.deal.projectNumber && row.status === "approved");
    if (approved) {
      return {
        status: 409,
        body: {
          error: "Bid Board project already created for this project_number",
          conflict: {
            requestId: approved.id,
            sourceSystem: approved.sourceSystem,
            sourceDealId: approved.sourceDealId,
            bidboardProjectId: approved.bidboardProjectId,
          },
        },
      };
    }

    await Promise.resolve();
    const conflictingInsert = this.rfpRequests.find((row) => row.projectNumber === input.deal.projectNumber && row.status === "pending");
    if (this.pendingProjectNumberIndexEnabled && conflictingInsert) return this.pendingCollision(conflictingInsert);

    const request: RfpRequest = {
      id: this.nextRequestId++,
      sourceSystem: input.sourceSystem,
      sourceDealId: input.sourceDealId,
      sourceEventId: input.sourceEventId,
      projectNumber: input.deal.projectNumber,
      token: `token-${this.nextRequestId}`,
      status: "pending",
      tokenExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    };
    this.rfpRequests.push(request);
    this.emails.push({ type: "review", to: "reviewer@trockgc.com", subject: "RFP Review Required", body: input.deal.name });
    return { status: 201, body: { requestId: request.id, token: request.token, status: request.status } };
  }

  async approve(token: string) {
    const request = this.mustFindRequestByToken(token);
    if (request.tokenExpiresAt && Date.now() > request.tokenExpiresAt.getTime()) {
      this.auditLogs.push({ action: "rfp_approval_attempt", outcome: "expired", requestId: request.id });
      return { status: 410, body: { success: false, error: "expired" } };
    }

    if (request.sourceSystem === "trock_crm") {
      this.eligibilityCalls.push(request.sourceDealId);
      const deal = this.crmDeals.find((item) => item.id === request.sourceDealId);
      if (!deal || deal.stage !== "opportunity") {
        request.status = "cancelled_source_ineligible";
        this.auditLogs.push({ action: "rfp_approval_attempt", outcome: "cancelled_source_ineligible", requestId: request.id });
        this.emails.push({ type: "cancelled", to: "approver@trockgc.com", subject: "RFP approval cancelled — source deal no longer eligible" });
        return { status: 409, body: { success: false, error: "source_ineligible" } };
      }
    }

    const bidboardProjectId = String(this.nextBidboardId++);
    request.status = "approved";
    request.bidboardProjectId = bidboardProjectId;
    this.bidboardCreates.push({ sourceDealId: request.sourceDealId, projectNumber: request.projectNumber });
    if (request.sourceSystem === "trock_crm") {
      this.bidboardCallbacks.push({
        id: this.bidboardCallbacks.length + 1,
        status: "pending",
        attempts: 0,
        payload: {
          sourceDealId: request.sourceDealId,
          rfpApprovalRequestId: request.id,
          bidboardProjectId,
          projectNumber: request.projectNumber,
          procoreCompanyId: "598134325683880",
          createdAt: new Date().toISOString(),
        },
      });
    } else {
      this.hubspotStageUpdates.push({ dealId: request.sourceDealId, stage: "approved" });
    }
    return { status: 200, body: { success: true, bidboardProjectId } };
  }

  decline(token: string) {
    const request = this.mustFindRequestByToken(token);
    if (request.tokenExpiresAt && Date.now() > request.tokenExpiresAt.getTime()) {
      this.auditLogs.push({ action: "rfp_decline_attempt", outcome: "expired", requestId: request.id });
      return { status: 410, body: { success: false, error: "expired" } };
    }
    request.status = "declined";
    this.auditLogs.push({ action: "rfp_decline_attempt", outcome: "declined", requestId: request.id });
    return { status: 200, body: { success: true } };
  }

  runCallbackWorker() {
    const callback = this.bidboardCallbacks.find((item) => item.status === "pending");
    if (!callback) return;
    callback.attempts += 1;
    const status = this.crmCallbackStatuses.length > 0 ? this.crmCallbackStatuses.shift()! : 200;
    if (status !== 200) {
      if (callback.attempts >= 5) callback.status = "dead";
      return;
    }
    const deal = this.mustFindDeal(callback.payload.sourceDealId);
    deal.procoreBidId = callback.payload.bidboardProjectId;
    deal.procoreCompanyId = callback.payload.procoreCompanyId;
    deal.isBidBoardOwned = true;
    deal.rfpApprovalStatus = "approved";
    deal.bidBoardLinkedAt = new Date();
    callback.status = "sent";
  }

  insertRfp(overrides: Partial<RfpRequest>) {
    const request: RfpRequest = {
      id: this.nextRequestId++,
      sourceSystem: overrides.sourceSystem ?? "hubspot",
      sourceDealId: overrides.sourceDealId ?? "hs-deal-1",
      sourceEventId: overrides.sourceEventId ?? `seed-${this.nextRequestId}`,
      projectNumber: overrides.projectNumber ?? "SEEDED-1",
      token: overrides.token ?? `token-${this.nextRequestId}`,
      status: overrides.status ?? "pending",
      tokenExpiresAt: overrides.tokenExpiresAt === undefined ? new Date(Date.now() + 60_000) : overrides.tokenExpiresAt,
      bidboardProjectId: overrides.bidboardProjectId ?? null,
    };
    this.rfpRequests.push(request);
    return request;
  }

  private buildNormalizedPayload(deal: CrmDeal) {
    return {
      dealId: deal.id,
      syncHubUrl: "https://synchub.example.com/api/rfp-requests",
      body: {
        sourceSystem: "trock_crm",
        sourceDealId: deal.id,
        sourceEventId: `crm:event:${deal.id}:opportunity`,
        deal: {
          name: `Deal ${deal.id}`,
          projectNumber: deal.projectNumber,
          projectType: "4",
          amount: 100000,
        },
        attachments: [],
      },
    };
  }

  private pendingCollision(row: RfpRequest) {
    return {
      status: 409,
      body: {
        error: `RFP already in flight for project_number=${row.projectNumber} from source=${row.sourceSystem}`,
        conflict: {
          requestId: row.id,
          sourceSystem: row.sourceSystem,
          sourceDealId: row.sourceDealId,
          status: row.status,
        },
      },
    };
  }

  private mustFindDeal(dealId: string) {
    const deal = this.crmDeals.find((item) => item.id === dealId);
    if (!deal) throw new Error(`deal ${dealId} not found`);
    return deal;
  }

  private mustFindRequestByToken(token: string) {
    const request = this.rfpRequests.find((item) => item.token === token);
    if (!request) throw new Error(`request ${token} not found`);
    return request;
  }
}

describe("RFP multi-source end-to-end integration harness", () => {
  it("A. completes the full CRM-source path through callback hard-linking", async () => {
    const h = new MultiSourceRfpHarness();
    const deal = h.createCrmDeal({ id: "crm-a", projectNumber: "CRM-A" });

    h.moveCrmDealToOpportunity(deal.id);
    expect(h.jobs).toMatchObject([{ jobType: "rfp_request_delivery", status: "pending" }]);
    await h.runCrmWorker();
    const request = h.rfpRequests.find((row) => row.sourceSystem === "trock_crm");
    expect(request).toMatchObject({ sourceDealId: "crm-a", status: "pending" });
    expect(h.emails.find((email) => email.type === "review")?.body).toContain("Deal crm-a");

    const approved = await h.approve(request!.token);
    expect(approved.status).toBe(200);
    expect(h.eligibilityCalls).toEqual(["crm-a"]);
    expect(h.bidboardCreates).toHaveLength(1);
    expect(h.bidboardCallbacks).toHaveLength(1);

    h.runCallbackWorker();
    expect(deal).toMatchObject({
      procoreBidId: "100",
      procoreCompanyId: "598134325683880",
      isBidBoardOwned: true,
      rfpApprovalStatus: "approved",
    });
    expect(deal.bidBoardLinkedAt).toBeInstanceOf(Date);
  });

  it("B. completes the full HubSpot-source path without CRM callback", async () => {
    const h = new MultiSourceRfpHarness();
    const request = h.insertRfp({
      sourceSystem: "hubspot",
      sourceDealId: "hs-b",
      sourceEventId: "hubspot:event:1",
      projectNumber: "HS-B",
    });

    const approved = await h.approve(request.token);

    expect(approved.status).toBe(200);
    expect(h.bidboardCreates).toHaveLength(1);
    expect(h.bidboardCallbacks).toHaveLength(0);
    expect(h.hubspotStageUpdates).toEqual([{ dealId: "hs-b", stage: "approved" }]);
  });

  it("C. surfaces a CRM conflict for a cross-source pending collision", async () => {
    const h = new MultiSourceRfpHarness();
    h.insertRfp({ sourceSystem: "hubspot", sourceDealId: "hs-c", projectNumber: "XYZ-123", status: "pending" });
    const deal = h.createCrmDeal({ id: "crm-c", projectNumber: "XYZ-123" });

    h.moveCrmDealToOpportunity(deal.id);
    await h.runCrmWorker();

    expect(deal.rfpApprovalStatus).toBe("conflict");
    expect(deal.rfpConflictReason).toContain("RFP already in flight");
    expect(deal.rfpConflictWith).toMatchObject({ sourceSystem: "hubspot" });
    expect(h.rfpRequests.filter((row) => row.projectNumber === "XYZ-123" && row.status === "pending")).toHaveLength(1);
  });

  it("D. surfaces a CRM conflict for a cross-source approved collision", async () => {
    const h = new MultiSourceRfpHarness();
    h.insertRfp({ sourceSystem: "hubspot", sourceDealId: "hs-d", projectNumber: "ABC-789", status: "approved", bidboardProjectId: "111" });
    const deal = h.createCrmDeal({ id: "crm-d", projectNumber: "ABC-789" });

    h.moveCrmDealToOpportunity(deal.id);
    await h.runCrmWorker();

    expect(deal.rfpApprovalStatus).toBe("conflict");
    expect(deal.rfpConflictWith).toMatchObject({ bidboardProjectId: "111" });
  });

  it("E. relies on the pending project_number unique index under concurrent load", async () => {
    const h = new MultiSourceRfpHarness();
    const request = (sourceSystem: SourceSystem, sourceDealId: string) => ({
      sourceSystem,
      sourceDealId,
      sourceEventId: `${sourceSystem}:${sourceDealId}`,
      deal: { name: sourceDealId, projectNumber: "RACE-1", projectType: "4", amount: null },
      attachments: [],
    });

    const indexed = await Promise.all([
      h.postRfpRequest(request("hubspot", "hs-race")),
      h.postRfpRequest(request("trock_crm", "crm-race")),
    ]);
    expect(indexed.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(h.rfpRequests.filter((row) => row.projectNumber === "RACE-1" && row.status === "pending")).toHaveLength(1);

    const withoutIndex = new MultiSourceRfpHarness();
    withoutIndex.pendingProjectNumberIndexEnabled = false;
    const unindexed = await Promise.all([
      withoutIndex.postRfpRequest(request("hubspot", "hs-race")),
      withoutIndex.postRfpRequest(request("trock_crm", "crm-race")),
    ]);
    expect(unindexed.map((result) => result.status).sort()).toEqual([201, 201]);
    expect(withoutIndex.rfpRequests.filter((row) => row.projectNumber === "RACE-1" && row.status === "pending")).toHaveLength(2);
  });

  it("F. rejects expired approve and decline attempts and writes audit logs", async () => {
    const h = new MultiSourceRfpHarness();
    const approveRequest = h.insertRfp({ token: "expired-approve", tokenExpiresAt: new Date(Date.now() - 1000) });
    const declineRequest = h.insertRfp({ token: "expired-decline", tokenExpiresAt: new Date(Date.now() - 1000), projectNumber: "EXPIRED-2" });

    expect(await h.approve(approveRequest.token)).toMatchObject({ status: 410, body: { error: "expired" } });
    expect(h.decline(declineRequest.token)).toMatchObject({ status: 410, body: { error: "expired" } });
    expect(h.auditLogs.map((log) => log.outcome)).toEqual(["expired", "expired"]);
  });

  it("G. cancels approval when the CRM source deal is no longer eligible", async () => {
    const h = new MultiSourceRfpHarness();
    const deal = h.createCrmDeal({ id: "crm-g", projectNumber: "CRM-G", stage: "opportunity" });
    const request = h.insertRfp({ sourceSystem: "trock_crm", sourceDealId: deal.id, projectNumber: "CRM-G" });
    deal.stage = "lost";

    const result = await h.approve(request.token);

    expect(result).toMatchObject({ status: 409, body: { error: "source_ineligible" } });
    expect(request.status).toBe("cancelled_source_ineligible");
    expect(h.bidboardCreates).toHaveLength(0);
    expect(h.bidboardCallbacks).toHaveLength(0);
    expect(h.emails.find((email) => email.type === "cancelled")?.subject).toContain("source deal no longer eligible");
  });

  it("H. allows a re-bid after a declined request", async () => {
    const h = new MultiSourceRfpHarness();
    h.insertRfp({ projectNumber: "REBID-1", status: "declined" });
    const deal = h.createCrmDeal({ id: "crm-h", projectNumber: "REBID-1" });

    h.moveCrmDealToOpportunity(deal.id);
    await h.runCrmWorker();

    expect(h.rfpRequests.filter((row) => row.projectNumber === "REBID-1" && row.status === "pending")).toHaveLength(1);
    expect(deal.rfpApprovalStatus).toBe("pending");
  });

  it("I. allows a re-bid after a source-ineligible cancellation", async () => {
    const h = new MultiSourceRfpHarness();
    h.insertRfp({ projectNumber: "REBID-2", status: "cancelled_source_ineligible" });
    const deal = h.createCrmDeal({ id: "crm-i", projectNumber: "REBID-2" });

    h.moveCrmDealToOpportunity(deal.id);
    await h.runCrmWorker();

    expect(h.rfpRequests.filter((row) => row.projectNumber === "REBID-2" && row.status === "pending")).toHaveLength(1);
    expect(deal.rfpApprovalStatus).toBe("pending");
  });

  it("J. recovers worker delivery after transient SyncHub failures", async () => {
    const h = new MultiSourceRfpHarness();
    h.syncHubStatuses = [503, 503, 503];
    const deal = h.createCrmDeal({ id: "crm-j", projectNumber: "CRM-J" });
    h.moveCrmDealToOpportunity(deal.id);

    for (let i = 0; i < 4; i++) await h.runCrmWorker(h.jobs[0]);

    expect(h.jobs[0]).toMatchObject({ status: "completed", attempts: 4 });
    expect(deal).toMatchObject({ rfpApprovalStatus: "pending", rfpApprovalToken: expect.any(String) });
  });

  it("K. marks permanent worker delivery failure dead and updates the deal", async () => {
    const h = new MultiSourceRfpHarness();
    h.syncHubStatuses = Array(8).fill(401);
    const deal = h.createCrmDeal({ id: "crm-k", projectNumber: "CRM-K" });
    h.moveCrmDealToOpportunity(deal.id);

    for (let i = 0; i < 8; i++) await h.runCrmWorker(h.jobs[0]);
    h.sweepDeadJobs();

    expect(h.jobs[0]).toMatchObject({ status: "dead", attempts: 8 });
    expect(deal.rfpApprovalStatus).toBe("send_failed");
    expect(deal.rfpLastAttemptError).toContain("401");
  });

  it("L. creates a fresh job from the retry button after permanent failure", async () => {
    const h = new MultiSourceRfpHarness();
    h.syncHubStatuses = Array(8).fill(401);
    const deal = h.createCrmDeal({ id: "crm-l", projectNumber: "CRM-L" });
    h.moveCrmDealToOpportunity(deal.id);
    for (let i = 0; i < 8; i++) await h.runCrmWorker(h.jobs[0]);
    h.sweepDeadJobs();

    h.retryDeadJob(deal.id);

    expect(h.jobs[0]).toMatchObject({ status: "dead", attempts: 8 });
    expect(h.jobs[1]).toMatchObject({ status: "pending", attempts: 0 });
    expect(deal.rfpApprovalStatus).toBe("pending_outbox");
  });
});
