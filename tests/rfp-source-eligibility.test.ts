import crypto from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// SIGNING-HARDENING r1: a refused send raises ONE visible alert (server/crm-signing-v2.ts → rfp-core-alert).
const signingAlertMock = vi.hoisted(() => vi.fn(async (_code: string, _detail: Record<string, unknown>) => {}));
vi.mock("../server/sync/rfp-core-alert.ts", () => ({ raiseRfpCoreAlert: signingAlertMock }));
/** ≥ 32 bytes: the SyncHub → CRM signing floor. Synthetic. */
const ELIGIBILITY_SECRET = "synthetic-eligibility-secret-0123456789ab";

const requestRow = vi.hoisted(() => ({ current: undefined as any }));
const auditRows = vi.hoisted(() => [] as any[]);
const updateRows = vi.hoisted(() => [] as any[]);
const sendEmailMock = vi.hoisted(() => vi.fn(async () => ({ success: true })));
const createBidBoardMock = vi.hoisted(() => vi.fn(async () => ({ success: true, projectId: "BB-1" })));
const hubspotFetchMode = vi.hoisted(() => ({ stage: "RFP", missing: false, stall: false, throw502With404Text: false }));
const getByIdCalls = vi.hoisted(() => [] as unknown[][]);
const hubspotPipelinesMock = vi.hoisted(() => vi.fn(async () => [
  {
    hubspotId: "default",
    stages: [
      { stageId: "appointmentscheduled", label: "RFP" },
      { stageId: "qualifiedtobuy", label: "Estimating" },
    ],
  },
]));

// S0b-2a: processRfpApproval's P3 claim (per-deal lock + Core footprint, CONTRACT v2.2 §10) runs on a real database with
// 0027 applied (tests/rfp-approving-claim.pg.test.ts, tests/rfp-approval-p3.pg.test.ts). This file's database is a stub, so
// the claim reports 0027 absent ("legacy") and today's path runs, exactly as on a database without 0027.
vi.mock("../server/sync/rfp-approving.ts", () => ({
  RFP_APPROVING_STATUS: "approving",
  claimRfpRequestForCreate: vi.fn(async () => ({ outcome: "legacy" })),
  markRfpApprovingSubmitted: vi.fn(async () => {}),
}));

vi.mock("../server/storage.ts", () => ({
  storage: {
    getRfpApprovalRequestByToken: vi.fn(async () => requestRow.current),
    updateRfpApprovalRequest: vi.fn(async (_id: number, data: any) => {
      updateRows.push(data);
      requestRow.current = { ...requestRow.current, ...data };
      return requestRow.current;
    }),
    createAuditLog: vi.fn(async (row: any) => {
      auditRows.push(row);
      return { id: auditRows.length, ...row };
    }),
    getHubspotPipelines: hubspotPipelinesMock,
  },
}));

vi.mock("../server/hubspot.ts", () => ({
  getHubSpotClient: vi.fn(async () => ({
    crm: {
      deals: {
        basicApi: {
          getById: vi.fn(async (...args: unknown[]) => {
            getByIdCalls.push(args);
            if (hubspotFetchMode.stall) return new Promise(() => {});
            if (hubspotFetchMode.throw502With404Text) {
              const error: any = new Error("Bad gateway (upstream said 404 at /crm/v3/objects/deals; request id 4041)");
              error.code = 502;
              error.statusCode = 502;
              throw error;
            }
            if (hubspotFetchMode.missing) {
              const error: any = new Error("not found");
              error.code = 404;
              error.statusCode = 404;
              throw error;
            }
            return {
              properties: {
                dealname: "HubSpot Deal",
                project_number: "DFW-2-10001",
                project_types: "2",
                dealstage: hubspotFetchMode.stage,
                pipeline: "default",
              },
              associations: {},
            };
          }),
        },
      },
    },
  })),
  getAccessToken: vi.fn(async () => "token"),
  getDealOwnerInfo: vi.fn(async () => ({ ownerName: "Owner", ownerEmail: "owner@trockgc.com" })),
  updateHubSpotDeal: vi.fn(async () => ({ success: true })),
  updateHubSpotDealStage: vi.fn(async () => ({ success: true })),
  syncSingleHubSpotDeal: vi.fn(async () => undefined),
}));

vi.mock("../server/lib/fetch-with-timeout.ts", () => ({
  fetchWithTimeout: vi.fn(async () => ({ ok: false })),
}));

vi.mock("../server/procore-hubspot-sync.ts", () => ({
  resolveHubspotStageId: vi.fn(async () => ({ stageId: "stage-1", stageName: "Estimating" })),
}));

vi.mock("../server/email-service.ts", () => ({
  sendEmail: sendEmailMock,
  renderTemplate: vi.fn(),
}));

vi.mock("../server/index.ts", () => ({
  log: vi.fn(),
}));

vi.mock("../server/playwright/bidboard.ts", () => ({
  createBidBoardProjectFromDeal: createBidBoardMock,
}));

function makeRequest(overrides: Partial<any> = {}) {
  return {
    id: 10,
    token: "token-1",
    status: "pending",
    sourceSystem: "hubspot",
    sourceDealId: "hs-1",
    hubspotDealId: "hs-1",
    projectNumber: "DFW-2-10001",
    tokenExpiresAt: new Date(Date.now() + 60_000),
    dealData: {
      dealname: "Source Deal",
      project_number: "DFW-2-10001",
      project_types: "2",
      dealstage: "RFP",
      proposalId: "P-1",
    },
    ...overrides,
  };
}

describe("RFP source eligibility check", () => {
  beforeEach(() => {
    vi.resetModules();
    auditRows.length = 0;
    updateRows.length = 0;
    sendEmailMock.mockClear();
    createBidBoardMock.mockClear();
    hubspotPipelinesMock.mockClear();
    hubspotPipelinesMock.mockResolvedValue([
      {
        hubspotId: "default",
        stages: [
          { stageId: "appointmentscheduled", label: "RFP" },
          { stageId: "qualifiedtobuy", label: "Estimating" },
        ],
      },
    ]);
    hubspotFetchMode.stage = "RFP";
    hubspotFetchMode.missing = false;
    hubspotFetchMode.stall = false;
    hubspotFetchMode.throw502With404Text = false;
    delete process.env.RFP_ELIGIBILITY_TIMEOUT_MS;
    getByIdCalls.length = 0;
    requestRow.current = makeRequest();
    process.env.TROCK_CRM_BASE_URL = "https://crm.example.com";
    process.env.RFP_REQUEST_SYNC_SECRET = ELIGIBILITY_SECRET;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ stage: "opportunity" }), { status: 200, headers: { "content-type": "application/json" } })));
  });

  it("the HubSpot eligibility check reads ONLY dealstage and pipeline: no associations, no company/contact/attachment calls (Codex P1 on SyncHub #114)", async () => {
    const { checkRfpApprovalSourceEligibility } = await import("../server/rfp-approval.ts");

    const result = await checkRfpApprovalSourceEligibility(makeRequest());

    expect(result.eligible).toBe(true);
    expect(getByIdCalls).toHaveLength(1);
    expect(getByIdCalls[0]).toEqual(["hs-1", ["dealstage", "pipeline"]]);
  });

  it("proceeds when the HubSpot deal exists and remains RFP eligible", async () => {
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    const result = await processRfpApproval("token-1", {}, "approver@trockgc.com", { attachmentsOverride: [], newFiles: [] });

    expect(result).toMatchObject({ success: true, bidboardProjectId: "BB-1" });
    expect(createBidBoardMock).toHaveBeenCalledTimes(1);
  });

  it("uses edited dealname in the post-approval status email", async () => {
    requestRow.current = makeRequest({
      dealData: {
        ...makeRequest().dealData,
        dealname: "jasonn ranches",
      },
    });
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    const result = await processRfpApproval("token-1", { dealname: "test" }, "approver@trockgc.com", { attachmentsOverride: [], newFiles: [] });

    expect(result).toMatchObject({ success: true, bidboardProjectId: "BB-1" });
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      subject: expect.stringContaining("test"),
      htmlBody: expect.stringContaining(">test<"),
    }));
    expect(sendEmailMock.mock.calls[0][0].subject).not.toContain("jasonn ranches");
    expect(sendEmailMock.mock.calls[0][0].htmlBody).not.toContain("jasonn ranches");
  });

  it.each([{}, { dealname: null as any }])("falls back to stored dealname in the post-approval status email when edited dealname is not set", async (editedFields) => {
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    const result = await processRfpApproval("token-1", editedFields, "approver@trockgc.com", { attachmentsOverride: [], newFiles: [] });

    expect(result).toMatchObject({ success: true, bidboardProjectId: "BB-1" });
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      subject: expect.stringContaining("Source Deal"),
      htmlBody: expect.stringContaining(">Source Deal<"),
    }));
  });

  it("resolves HubSpot stage IDs to labels before checking RFP eligibility", async () => {
    hubspotFetchMode.stage = "appointmentscheduled";
    const { checkRfpApprovalSourceEligibility } = await import("../server/rfp-approval.ts");

    const result = await checkRfpApprovalSourceEligibility(makeRequest());

    expect(result).toMatchObject({ eligible: true, exists: true, stage: "appointmentscheduled" });
    expect(hubspotPipelinesMock).toHaveBeenCalledTimes(1);
  });

  it("rejects HubSpot stage IDs whose resolved labels are not RFP eligible", async () => {
    hubspotFetchMode.stage = "closedwon";
    hubspotPipelinesMock.mockResolvedValue([
      {
        hubspotId: "default",
        stages: [{ stageId: "closedwon", label: "Closed Won" }],
      },
    ]);
    const { checkRfpApprovalSourceEligibility } = await import("../server/rfp-approval.ts");

    const result = await checkRfpApprovalSourceEligibility(makeRequest());

    expect(result).toMatchObject({
      eligible: false,
      exists: true,
      reason: expect.stringContaining("Closed Won (closedwon)"),
    });
  });

  it("falls back to direct stage matching when a HubSpot stage ID is unknown", async () => {
    hubspotFetchMode.stage = "foo";
    hubspotPipelinesMock.mockResolvedValue([{ hubspotId: "default", stages: [] }]);
    const { checkRfpApprovalSourceEligibility } = await import("../server/rfp-approval.ts");

    const result = await checkRfpApprovalSourceEligibility(makeRequest());

    expect(result).toMatchObject({
      eligible: false,
      exists: true,
      reason: expect.stringContaining("foo"),
    });
  });

  it("cancels when the HubSpot deal was deleted", async () => {
    hubspotFetchMode.missing = true;
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    const result = await processRfpApproval("token-1", {}, "approver@trockgc.com", { attachmentsOverride: [], newFiles: [] });

    expect(result).toMatchObject({ success: false, error: "source_ineligible", statusCode: 409 });
    expect(updateRows[0]).toMatchObject({ status: "cancelled_source_ineligible" });
    expect(createBidBoardMock).not.toHaveBeenCalled();
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: "approver@trockgc.com",
      subject: "RFP approval cancelled — source deal no longer eligible",
    }));
    expect(auditRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "rfp_approval_attempt",
        status: "failed",
        details: expect.objectContaining({ outcome: "cancelled_source_ineligible" }),
      }),
    ]));
  });

  it("cancels when the HubSpot deal moved out of an eligible stage", async () => {
    hubspotFetchMode.stage = "closedlost";
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    const result = await processRfpApproval("token-1", {}, "approver@trockgc.com", { attachmentsOverride: [], newFiles: [] });

    expect(result).toMatchObject({ success: false, error: "source_ineligible", statusCode: 409 });
    expect(createBidBoardMock).not.toHaveBeenCalled();
  });

  it("proceeds when the CRM deal exists and remains opportunity", async () => {
    requestRow.current = makeRequest({ sourceSystem: "trock_crm", sourceDealId: "crm-1", hubspotDealId: null });
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    const result = await processRfpApproval("token-1", {}, "approver@trockgc.com", { attachmentsOverride: [], newFiles: [] });

    expect(result).toMatchObject({ success: true, bidboardProjectId: "BB-1" });
    expect(createBidBoardMock).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://crm.example.com/api/internal/deals/eligibility-check",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-rfp-request-signature": expect.stringMatching(/^sha256=/),
          "x-signature-version": "2",
        }),
        body: JSON.stringify({ sourceDealId: "crm-1" }),
      })
    );
  });

  it("(SIGNING-HARDENING r1) checkCrmDealEligibility signs v2 over its path; a secret under 32 bytes or an http base ⇒ nothing sent, fail-open, ONE alert each; localhost / 127.0.0.1 allowed", async () => {
    const { checkCrmDealEligibility } = await import("../server/rfp-source-eligibility.ts");
    (await import("../server/crm-signing-v2.ts")).resetCrmSigningRefusalsForTests();
    signingAlertMock.mockReset();
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();
    await checkCrmDealEligibility("crm-1", { now: () => new Date(1767225600 * 1000) } as any);
    const [, init] = fetchMock.mock.calls[0] as any[];
    const bodyHash = crypto.createHash("sha256").update(String(init.body)).digest("hex");
    expect(init.headers["x-signature-version"]).toBe("2");
    expect(init.headers["x-signature-timestamp"]).toBe("1767225600");
    expect(init.headers["x-rfp-request-signature"]).toBe(
      `sha256=${crypto.createHmac("sha256", ELIGIBILITY_SECRET).update(`v2\nPOST\n/api/internal/deals/eligibility-check\n1767225600\n${bodyHash}`).digest("hex")}`,
    );
    fetchMock.mockClear();
    for (let i = 0; i < 2; i++) {
      process.env.RFP_REQUEST_SYNC_SECRET = "s".repeat(31);
      process.env.TROCK_CRM_BASE_URL = "https://crm.example.com";
      expect(await checkCrmDealEligibility("crm-1")).toEqual({ exists: true, stage: null, checkFailed: true });
      process.env.RFP_REQUEST_SYNC_SECRET = ELIGIBILITY_SECRET;
      process.env.TROCK_CRM_BASE_URL = "http://crm.example.test";
      expect(await checkCrmDealEligibility("crm-1")).toEqual({ exists: true, stage: null, checkFailed: true });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(signingAlertMock.mock.calls.map((c) => [c[0], c[1].signer, c[1].reason])).toEqual([
      ["crm_signing_refused", "deals_eligibility_check", "secret_short"],
      ["crm_signing_refused", "deals_eligibility_check", "url_refused"],
    ]);
    for (const base of ["http://localhost:3001", "http://127.0.0.1:3001"]) {
      fetchMock.mockClear();
      process.env.TROCK_CRM_BASE_URL = base;
      await checkCrmDealEligibility("crm-1");
      expect((fetchMock.mock.calls[0] as any[])?.[0], base).toBe(`${base}/api/internal/deals/eligibility-check`);
      expect((fetchMock.mock.calls[0] as any[])[1].headers["x-signature-version"], base).toBe("2");
    }
    process.env.TROCK_CRM_BASE_URL = "https://crm.example.com";
  });

  it("cancels when the CRM deal was deleted", async () => {
    requestRow.current = makeRequest({ sourceSystem: "trock_crm", sourceDealId: "crm-1", hubspotDealId: null });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    const result = await processRfpApproval("token-1", {}, "approver@trockgc.com", { attachmentsOverride: [], newFiles: [] });

    expect(result).toMatchObject({ success: false, error: "source_ineligible", statusCode: 409 });
    expect(createBidBoardMock).not.toHaveBeenCalled();
  });

  it("cancels when the CRM stage changed", async () => {
    requestRow.current = makeRequest({ sourceSystem: "trock_crm", sourceDealId: "crm-1", hubspotDealId: null });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ stage: "lost" }), { status: 200, headers: { "content-type": "application/json" } })));
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    const result = await processRfpApproval("token-1", {}, "approver@trockgc.com", { attachmentsOverride: [], newFiles: [] });

    expect(result).toMatchObject({ success: false, error: "source_ineligible", statusCode: 409 });
    expect(createBidBoardMock).not.toHaveBeenCalled();
  });

  it.each([401, 429])("a CRM %i is a FAILED check (fail-open), never \"deal no longer exists\" (Codex P1 on SyncHub #114)", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status })));
    const { checkRfpApprovalSourceEligibility } = await import("../server/rfp-approval.ts");
    const result = await checkRfpApprovalSourceEligibility(makeRequest({ sourceSystem: "trock_crm", sourceDealId: "crm-1", hubspotDealId: null }));
    expect(result).toMatchObject({ eligible: true, checkFailed: true });
  });

  it("proceeds on CRM network errors because eligibility is a fail-open safety guard", async () => {
    requestRow.current = makeRequest({ sourceSystem: "trock_crm", sourceDealId: "crm-1", hubspotDealId: null });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    const result = await processRfpApproval("token-1", {}, "approver@trockgc.com", { attachmentsOverride: [], newFiles: [] });

    expect(result).toMatchObject({ success: true, bidboardProjectId: "BB-1" });
    expect(createBidBoardMock).toHaveBeenCalledTimes(1);
  });

  // Codex round 3 on SyncHub #114, simplified per the churn rule: EVERY eligibility check has one fail-open deadline,
  // and a CRM answer without a usable stage is a FAILED check, never "out of Opportunity".
  it.each([
    ["an empty body", ""],
    ["malformed JSON", "{not json"],
    ["no stage", JSON.stringify({ ok: true })],
  ])("a CRM 200 with %s is a FAILED check (fail-open), never ineligible", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
    const { checkRfpApprovalSourceEligibility } = await import("../server/rfp-approval.ts");
    const result = await checkRfpApprovalSourceEligibility(makeRequest({ sourceSystem: "trock_crm", sourceDealId: "crm-1", hubspotDealId: null }));
    expect(result).toMatchObject({ eligible: true, checkFailed: true });
  });

  it("a STALLED CRM request fails open at the deadline instead of hanging the digest", async () => {
    process.env.RFP_ELIGIBILITY_TIMEOUT_MS = "50";
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const { checkRfpApprovalSourceEligibility } = await import("../server/rfp-approval.ts");
    const result = await checkRfpApprovalSourceEligibility(makeRequest({ sourceSystem: "trock_crm", sourceDealId: "crm-1", hubspotDealId: null }));
    expect(result).toMatchObject({ eligible: true, checkFailed: true });
  }, 2_000);

  it("a STALLED HubSpot lookup fails open at the deadline instead of hanging the digest", async () => {
    process.env.RFP_ELIGIBILITY_TIMEOUT_MS = "50";
    hubspotFetchMode.stall = true;
    const { checkRfpApprovalSourceEligibility } = await import("../server/rfp-approval.ts");
    const result = await checkRfpApprovalSourceEligibility(makeRequest());
    expect(result).toMatchObject({ eligible: true, checkFailed: true });
  }, 2_000);

  // Codex round 4 on SyncHub #114: a HubSpot stage the cache cannot resolve (or no dealstage at all) proves nothing.
  // The approve gate's answer is unchanged (pinned above), but the result says UNRESOLVED so the digest and the
  // cleanup preview keep the row instead of treating it as having left RFP.
  it("an unknown HubSpot stage id is flagged stageUnresolved", async () => {
    hubspotFetchMode.stage = "custom-stage-99";
    hubspotPipelinesMock.mockResolvedValue([{ hubspotId: "default", stages: [] }]);
    const { checkRfpApprovalSourceEligibility } = await import("../server/rfp-approval.ts");
    const result = await checkRfpApprovalSourceEligibility(makeRequest());
    expect(result).toMatchObject({ eligible: false, stageUnresolved: true });
  });

  it("a HubSpot deal with NO dealstage is flagged stageUnresolved", async () => {
    hubspotFetchMode.stage = "";
    const { checkRfpApprovalSourceEligibility } = await import("../server/rfp-approval.ts");
    const result = await checkRfpApprovalSourceEligibility(makeRequest());
    expect(result).toMatchObject({ eligible: false, stageUnresolved: true });
  });

  it("a RESOLVED non-RFP HubSpot stage is NOT flagged unresolved (a real ineligibility)", async () => {
    hubspotFetchMode.stage = "closedwon";
    hubspotPipelinesMock.mockResolvedValue([{ hubspotId: "default", stages: [{ stageId: "closedwon", label: "Closed Won" }] }]);
    const { checkRfpApprovalSourceEligibility } = await import("../server/rfp-approval.ts");
    const result = await checkRfpApprovalSourceEligibility(makeRequest());
    expect(result.eligible).toBe(false);
    expect(result.stageUnresolved).toBeFalsy();
  });

  it("a HubSpot 502 whose MESSAGE mentions 404 is a failed check, never 'deal no longer exists' (CodeRabbit on #114)", async () => {
    hubspotFetchMode.throw502With404Text = true;
    const { checkRfpApprovalSourceEligibility } = await import("../server/rfp-approval.ts");
    const result = await checkRfpApprovalSourceEligibility(makeRequest());
    expect(result).toMatchObject({ eligible: true, exists: true, checkFailed: true });
  });
});
