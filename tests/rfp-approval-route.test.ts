import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("RFP approval route", () => {
  let server: Server | undefined;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    vi.clearAllMocks();
  });

  it("returns immediately and processes approval in the background", async () => {
    const processRfpApproval = vi.fn();
    let finishApproval: ((value: { success: boolean; bidboardProjectId?: string }) => void) | undefined;
    processRfpApproval.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishApproval = resolve;
        }),
    );

    const storage = {
      getAutomationConfig: vi.fn().mockResolvedValue(null),
      getRfpApprovalRequestByToken: vi.fn().mockResolvedValue({
        id: 7,
        status: "pending",
        sourceSystem: "hubspot",
        sourceDealId: "321011207920",
        hubspotDealId: "321011207920",
        tokenExpiresAt: new Date(Date.now() + 60_000),
        dealData: {},
      }),
      updateRfpApprovalRequest: vi.fn(),
      getHubspotDealByHubspotId: vi.fn(),
      createAuditLog: vi.fn(),
    };

    vi.doMock("../server/storage.ts", () => ({ storage }));
    vi.doMock("../server/rfp-approval.ts", () => ({
      processRfpApproval,
      resolveRfpDescription: vi.fn(() => ""),
      isRfpApprovalRequestExpired: vi.fn(() => false),
      buildExpiredRfpMessage: vi.fn(() => "expired"),
      checkRfpApprovalSourceEligibility: vi.fn(async () => ({ eligible: true })),
      cancelIneligibleRfpApproval: vi.fn(),
      isAuthorizedRfpApprover: vi.fn(async () => true),
      // Mirrors the real canonical-type resolver the approve gate now calls (precedence: project_number
      // digit, then an edited project_types, then dealData.project_types, then '2').
      resolveEffectiveRfpProjectType: vi.fn((deal: any, edited?: any) => {
        const pn = (deal?.project_number ?? "") as string;
        const current = pn.match(/^DFW-(\d+)-/i)?.[1] ?? deal?.project_types ?? "";
        const submitted = edited?.project_types;
        let t = current || submitted || deal?.project_types || "2";
        if (submitted && submitted !== current) t = submitted;
        return t ? String(t) : null;
      }),
    }));

    const { registerRfpApprovalRoutes } = await import("../server/routes/rfp-approval.ts");

    const app = express();
    registerRfpApprovalRoutes(app);
    server = await new Promise<Server>((resolve) => {
      const created = app.listen(0, () => resolve(created));
    });

    const form = new FormData();
    form.append("editedFields", JSON.stringify({ dealname: "Queued Approval" }));
    form.append("approverEmail", "approver@trockgc.com");
    form.append("attachmentsOverride", "[]");

    const controller = new AbortController();
    const responsePromise = fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/rfp-approval/test-token/approve`,
      {
        method: "POST",
        body: form,
        signal: controller.signal,
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    let outcome:
      | { ok: true; response: Response; body: any }
      | { ok: false; error: unknown };

    try {
      const response = await Promise.race([
        responsePromise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 10)),
      ]);
      outcome = { ok: true, response, body: await response.json() };
    } catch (error) {
      controller.abort();
      outcome = { ok: false, error };
    }

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.response.status).toBe(202);
    expect(outcome.body).toMatchObject({
      success: true,
      queued: true,
    });
    expect(processRfpApproval).toHaveBeenCalledWith(
      "test-token",
      { dealname: "Queued Approval" },
      "approver@trockgc.com",
      { attachmentsOverride: [], newFiles: [] },
    );

    finishApproval?.({ success: true, bidboardProjectId: "BB-321" });
  });
});
