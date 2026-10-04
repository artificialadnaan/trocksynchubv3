import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Route-level coverage of the approve/decline authorization wiring, recipient-bound since #47: the approver is the
// SIGNED recipient of the review link (server/rfp-recipient-link.ts), never a typed address. Mirrors
// tests/rfp-approval-route.test.ts: fully mock ../server/rfp-approval and drive the route's
// 403/202/audit behavior off a controllable isAuthorizedRfpApprover stub. (The real authz logic
// is covered in tests/rfp-approver-authz.test.ts.)

const requestRow = vi.hoisted(() => ({ current: undefined as any }));
const auditRows = vi.hoisted(() => [] as any[]);
const authorize = vi.hoisted(() => vi.fn(async () => true));
const processRfpApprovalMock = vi.hoisted(() => vi.fn(async () => ({ success: true, bidboardProjectId: "BB-1" })));
const processRfpDeclineMock = vi.hoisted(() => vi.fn(async () => ({ success: true })));

vi.mock("../server/storage.ts", () => ({
  storage: {
    getUser: vi.fn(async () => undefined),
    getRfpApprovalRequestByToken: vi.fn(async () => requestRow.current),
    updateRfpApprovalRequest: vi.fn(async (_id: number, data: any) => ({ ...requestRow.current, ...data })),
    createRfpApprovalEdit: vi.fn(async (row: any) => row),
    getHubspotDealByHubspotId: vi.fn(async () => undefined),
    getAutomationConfig: vi.fn(async () => null),
    createAuditLog: vi.fn(async (row: any) => {
      auditRows.push(row);
      return { id: auditRows.length, ...row };
    }),
  },
}));

vi.mock("../server/rfp-approval.ts", async () => {
  // Use the REAL canonical-type resolver (the dependency-free source of truth in constants.ts) so the
  // route's baseline/created gate is exercised against the exact derivation the processor uses — and
  // can't drift from an inline copy if the canonical-type rules change again.
  const { resolveEffectiveRfpProjectType } = await import("../server/constants.ts");
  return {
    processRfpApproval: processRfpApprovalMock,
    processRfpDecline: processRfpDeclineMock,
    resolveRfpDescription: vi.fn(() => ""),
    isRfpApprovalRequestExpired: vi.fn(() => false),
    buildExpiredRfpMessage: vi.fn(() => "expired"),
    checkRfpApprovalSourceEligibility: vi.fn(async () => ({ eligible: true })),
    cancelIneligibleRfpApproval: vi.fn(),
    isAuthorizedRfpApprover: authorize,
    resolveEffectiveRfpProjectType,
  };
});

function makeRequest(overrides: Partial<any> = {}) {
  return {
    id: 42,
    token: "tok-authz",
    status: "pending",
    sourceSystem: "hubspot",
    sourceDealId: "hs-42",
    hubspotDealId: "hs-42",
    projectNumber: "DFW-4-42001",
    tokenExpiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(Date.now() - 60_000),
    dealData: { dealname: "Service Job", project_number: "DFW-4-42001", project_types: "4", attachments: [], description: "Scope" },
    ...overrides,
  };
}

async function withApp(fn: (baseUrl: string) => Promise<void>) {
  const { registerRfpApprovalRoutes } = await import("../server/routes/rfp-approval.ts");
  const app = express();
  app.use(express.json());
  registerRfpApprovalRoutes(app);
  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server");
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

const SECRET = "test-session-secret-fixture";
const TOKEN = "tok-authz";
const link = async (email: string, opts: { token?: string; secret?: string } = {}) => {
  const { signRecipientLink } = await import("../server/rfp-recipient-link.ts");
  return signRecipientLink(opts.token ?? TOKEN, email, opts.secret ?? SECRET);
};
async function approve(baseUrl: string, fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries({ editedFields: JSON.stringify({}), ...fields })) form.append(k, v);
  const res = await fetch(`${baseUrl}/api/rfp-approval/${TOKEN}/approve`, { method: "POST", body: form });
  return { status: res.status, body: await res.json() };
}
async function decline(baseUrl: string, payload: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/api/rfp-approval/${TOKEN}/decline`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

describe("RFP approve/decline: the signed recipient is the approver (#47)", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.SESSION_SECRET = SECRET;
    auditRows.length = 0;
    authorize.mockReset();
    authorize.mockResolvedValue(true);
    processRfpApprovalMock.mockClear();
    processRfpDeclineMock.mockClear();
    requestRow.current = makeRequest();
  });

  it("refuses an approve with no recipient link, even with a typed approver email (403, nothing processed)", async () => {
    await withApp(async (baseUrl) => {
      const { status, body } = await approve(baseUrl, { approverEmail: "cburling@trockgc.com" });
      expect(status).toBe(403);
      expect(body).toMatchObject({ success: false, error: "recipient_link_required" });
      expect(processRfpApprovalMock).not.toHaveBeenCalled();
    });
  });

  it("refuses a forged link, and a link signed for another RFP", async () => {
    await withApp(async (baseUrl) => {
      expect((await approve(baseUrl, { recipientLink: await link("cburling@trockgc.com", { secret: "other" }) })).status).toBe(403);
      expect((await approve(baseUrl, { recipientLink: await link("cburling@trockgc.com", { token: "tok-other" }) })).status).toBe(403);
      expect((await approve(baseUrl, { recipientLink: "Y2J1cmxpbmc.bm90LWEtbWFj" })).status).toBe(403);
      expect(processRfpApprovalMock).not.toHaveBeenCalled();
    });
  });

  it("approves AS the signed recipient, with no live-config read for the routed type (the send-time snapshot)", async () => {
    authorize.mockResolvedValue(false); // the live config no longer lists them: the snapshot still holds
    await withApp(async (baseUrl) => {
      const { status, body } = await approve(baseUrl, {
        recipientLink: await link("cburling@trockgc.com"),
        approverEmail: "someone-else@trockgc.com", // ignored
      });
      expect(status).toBe(202);
      expect(body).toMatchObject({ success: true, queued: true });
      await vi.waitFor(() => expect(processRfpApprovalMock).toHaveBeenCalledTimes(1));
      expect(processRfpApprovalMock.mock.calls[0]![2]).toBe("cburling@trockgc.com");
      expect(authorize).not.toHaveBeenCalled();
    });
  });

  it("a FORWARDED link acts as its original recipient (delegation), never as whoever forwards or types", async () => {
    await withApp(async (baseUrl) => {
      const forwarded = await link("approver@trockgc.com");
      await approve(baseUrl, { recipientLink: forwarded, approverEmail: "attacker@example.test" });
      await vi.waitFor(() => expect(processRfpApprovalMock).toHaveBeenCalledTimes(1));
      expect(processRfpApprovalMock.mock.calls[0]![2]).toBe("approver@trockgc.com");
    });
  });

  it("an EDITED type the RFP was not routed by is still checked live, and refused (403, audited) when not authorized", async () => {
    requestRow.current = makeRequest({
      projectNumber: "DFW-2-42001",
      dealData: { dealname: "Reno Job", project_number: "DFW-2-42001", project_types: "2", attachments: [], description: "Scope" },
    });
    authorize.mockImplementation(async (_email: string, projectType?: string | null) => projectType === "2");
    await withApp(async (baseUrl) => {
      const { status, body } = await approve(baseUrl, {
        recipientLink: await link("sgibson@trockgc.com"),
        editedFields: JSON.stringify({ project_types: "4" }),
      });
      expect(status).toBe(403);
      expect(body).toMatchObject({ success: false, error: "unauthorized_approver" });
      expect(authorize).toHaveBeenCalledWith("sgibson@trockgc.com", "4", "hubspot");
      expect(processRfpApprovalMock).not.toHaveBeenCalled();
      expect(auditRows.at(-1)).toMatchObject({
        action: "rfp_approval_attempt",
        status: "failed",
        details: expect.objectContaining({ outcome: "unauthorized_approver", approverEmail: "sgibson@trockgc.com" }),
      });
    });
  });

  it("an edit within live authority passes", async () => {
    requestRow.current = makeRequest({
      projectNumber: "DFW-2-42001",
      dealData: { dealname: "Reno Job", project_number: "DFW-2-42001", project_types: "2", attachments: [], description: "Scope" },
    });
    authorize.mockResolvedValue(true);
    await withApp(async (baseUrl) => {
      const { status } = await approve(baseUrl, { recipientLink: await link("dual@trockgc.com"), editedFields: JSON.stringify({ project_types: "4" }) });
      expect(status).toBe(202);
      await vi.waitFor(() => expect(processRfpApprovalMock).toHaveBeenCalledTimes(1));
    });
  });

  it("decline: no or forged link is 403; a signed link declines AS its recipient", async () => {
    await withApp(async (baseUrl) => {
      expect((await decline(baseUrl, { declinerEmail: "cburling@trockgc.com" })).status).toBe(403);
      expect((await decline(baseUrl, { recipientLink: await link("cburling@trockgc.com", { secret: "other" }) })).status).toBe(403);
      expect(processRfpDeclineMock).not.toHaveBeenCalled();
      const ok = await decline(baseUrl, { recipientLink: await link("cburling@trockgc.com"), declinerEmail: "x@example.test" });
      expect(ok.status).toBe(200);
      expect(processRfpDeclineMock).toHaveBeenCalledWith(TOKEN, "cburling@trockgc.com");
    });
  });

  it("the review page: no or forged link is 403 'out of date'; a signed one shows who is acting, read-only", async () => {
    await withApp(async (baseUrl) => {
      const bare = await fetch(`${baseUrl}/rfp-review/${TOKEN}`);
      expect(bare.status).toBe(403);
      expect(await bare.text()).toContain("out of date");
      const forged = await fetch(`${baseUrl}/rfp-review/${TOKEN}?r=${await link("a@trockgc.com", { secret: "other" })}`);
      expect(forged.status).toBe(403);
      const r = await link("cburling@trockgc.com");
      const page = await fetch(`${baseUrl}/rfp-review/${TOKEN}?r=${r}`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('value="cburling@trockgc.com" readonly');
      expect(html).toContain(`const RECIPIENT_LINK = "${r}"`);
      expect(html).not.toContain("fd.append('approverEmail'");
    });
  });

  it("reset needs a signed-in admin (it had no auth: any link holder could re-open an approved RFP)", async () => {
    requestRow.current = makeRequest({ status: "approved" });
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/rfp-approval/${TOKEN}/reset`, { method: "POST" });
      expect(res.status).toBe(401);
      const { storage } = await import("../server/storage.ts");
      expect(storage.updateRfpApprovalRequest).not.toHaveBeenCalled();
    });
  });
});
