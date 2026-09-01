// =============================================================================
// Re-driving a Core delivery that never landed.
//
// The behaviour that matters is not "it retries" — it is WHAT IT REFUSES. A re-drive reaches an
// already-approved request, which is the one state every other entry point declines to touch, so the
// gates here are the only thing standing between an operator recovery and a second bid on a job that
// already has one. `bid` has no deleted_at, so a duplicate card could not be removed.
// =============================================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

const handoffMock = vi.hoisted(() => vi.fn(async () => ({ status: "sent" as const })));
const requestRow = vi.hoisted(() => ({ current: null as any }));

vi.mock("../server/index.ts", () => ({ log: vi.fn() }));
vi.mock("../server/storage.ts", () => ({
  storage: { getRfpApprovalRequestById: vi.fn(async () => requestRow.current) },
}));
const buildMock = vi.hoisted(() => vi.fn(() => ({ ok: true, office: "dallas", body: {} })));
vi.mock("../server/sync/service-rfp-core-outbox.ts", () => ({
  handOffServiceRfpApprovalToCore: handoffMock,
  buildServiceRfpApprovedBody: buildMock,
}));

const { redriveServiceRfpToCore } = await import("../server/sync/service-rfp-core-redrive.ts");

/** An approved, CRM-sourced SERVICE request — the only shape a re-drive may act on. */
function approvedService(overrides: Record<string, unknown> = {}) {
  return {
    id: 781,
    status: "approved",
    sourceSystem: "trock_crm",
    sourceDealId: "f98fc727-76dc-4487-8209-ee53743b9bfc",
    projectNumber: "ATL-4-24326-ae",
    approvedAt: "2026-08-31T18:15:03.843Z",
    editedFields: {},
    dealData: { project_number: "ATL-4-24326-ae", project_types: "4", company_name: "RPM Investments" },
    ...overrides,
  };
}

beforeEach(() => {
  handoffMock.mockClear();
  buildMock.mockClear();
  buildMock.mockReturnValue({ ok: true, office: "dallas", body: {} } as any);
  handoffMock.mockResolvedValue({ status: "sent" } as any);
  requestRow.current = approvedService();
});

describe("re-driving a service RFP to Core", () => {
  it("re-invokes the handoff with the SAME inputs the approval used", async () => {
    const out = await redriveServiceRfpToCore(781);

    expect(out).toEqual({ ok: true, status: "sent" });
    const arg = handoffMock.mock.calls[0]![0] as any;
    expect(arg.rfpRequestId).toBe(781);
    expect(arg.sourceDealId).toBe("f98fc727-76dc-4487-8209-ee53743b9bfc");
    expect(arg.projectNumber).toBe("ATL-4-24326-ae");
    // approvedAt is Core's newest-wins ordering key and is carried through, NOT re-stamped: moving it
    // would make a recovery outrank an edit somebody made in between.
    expect(arg.approvedAt.toISOString()).toBe("2026-08-31T18:15:03.843Z");
  });

  it("REFUSES a pending request — that one still has its ordinary approval path", async () => {
    requestRow.current = approvedService({ status: "pending" });
    const out = await redriveServiceRfpToCore(781);
    // Delivering here would put the job in Core before the approval ever completed.
    expect(out).toMatchObject({ ok: false, reason: "not_approved" });
    expect(handoffMock).not.toHaveBeenCalled();
  });

  it("REFUSES a declined request, for the same reason", async () => {
    requestRow.current = approvedService({ status: "declined" });
    const out = await redriveServiceRfpToCore(781);
    expect(out).toMatchObject({ ok: false, reason: "not_approved" });
    expect(handoffMock).not.toHaveBeenCalled();
  });

  it("REFUSES a hubspot-sourced request — Core stores uuid identities it cannot supply", async () => {
    requestRow.current = approvedService({ sourceSystem: "hubspot" });
    const out = await redriveServiceRfpToCore(781);
    expect(out).toMatchObject({ ok: false, reason: "not_trock_crm" });
    expect(handoffMock).not.toHaveBeenCalled();
  });

  it("REFUSES a non-service job — the service pipeline is the only destination", async () => {
    requestRow.current = approvedService({
      projectNumber: "DFW-2-11111-aa",
      dealData: { project_number: "DFW-2-11111-aa", project_types: "2" },
    });
    const out = await redriveServiceRfpToCore(781);
    expect(out).toMatchObject({ ok: false, reason: "not_service" });
    expect(handoffMock).not.toHaveBeenCalled();
  });

  it("REFUSES an id that names nothing", async () => {
    requestRow.current = null;
    const out = await redriveServiceRfpToCore(999999);
    expect(out).toMatchObject({ ok: false, reason: "not_found" });
    expect(handoffMock).not.toHaveBeenCalled();
  });

  it("names an UNBUILDABLE payload instead of returning the misleading `duplicate` [Codex #83]", async () => {
    // dealData is the snapshot taken when the request was created and is never refreshed, so a refusal
    // for missing CRM uuids rebuilds identically after the CRM is fixed. Without this the conflict
    // handler answers `duplicate`, which reads as "already delivered" and sends an operator to the wrong
    // place — this case genuinely needs the approval re-issued, and must say so.
    buildMock.mockReturnValue({ ok: false, reason: "missing_crm_identity", detail: "no crm_company_id" } as any);
    const out = await redriveServiceRfpToCore(781);
    expect(out).toMatchObject({ ok: false, reason: "unbuildable" });
    expect(out).toMatchObject({ detail: expect.stringContaining("missing_crm_identity") });
    expect(handoffMock).not.toHaveBeenCalled();
  });

  it("RECOMPUTES the project number from the approved type, not the stale column [Codex #83]", async () => {
    // The approver changed the type to service; processRfpApproval rewrote the number before its own
    // handoff but persisted only the type, so the column still holds the pre-approval number. Sending
    // that would have Core and the approval disagree about which job this is.
    requestRow.current = approvedService({
      projectNumber: "DFW-2-24326-ae",
      editedFields: { project_types: "4" },
      dealData: { project_number: "DFW-2-24326-ae", project_types: "2" },
    });
    await redriveServiceRfpToCore(781);
    const arg = handoffMock.mock.calls[0]![0] as any;
    expect(arg.projectNumber).toBe("DFW-4-24326-ae");
  });

  it("passes a DUPLICATE through rather than dressing it as success", async () => {
    // The upsert guard answers `duplicate` when the row already left — calling this on an approval that
    // already landed must report that, not claim a fresh delivery.
    handoffMock.mockResolvedValue({ status: "duplicate" } as any);
    const out = await redriveServiceRfpToCore(781);
    expect(out).toEqual({ ok: true, status: "duplicate" });
  });
});
