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
const priorRow = vi.hoisted(() => ({ payload: null as any, throws: false }));
vi.mock("../server/db.ts", () => ({
  db: {
    execute: vi.fn(async () => {
      if (priorRow.throws) throw new Error("connection terminated");
      return { rows: [{ payload: priorRow.payload }] };
    }),
  },
  pool: { query: vi.fn(async () => ({ rows: [] })) },
}));
vi.mock("../server/storage.ts", () => ({
  storage: { getRfpApprovalRequestById: vi.fn(async () => requestRow.current) },
}));
const buildMock = vi.hoisted(() => vi.fn(() => ({ ok: true, office: "dallas", body: {} })));
const replayMock = vi.hoisted(() => vi.fn(async () => "sent" as const));
vi.mock("../server/sync/service-rfp-core-outbox.ts", () => ({
  handOffServiceRfpApprovalToCore: handoffMock,
  buildServiceRfpApprovedBody: buildMock,
  replayServiceRfpPayload: replayMock,
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
  priorRow.payload = null;
  priorRow.throws = false;
  replayMock.mockClear();
  replayMock.mockResolvedValue('sent' as any);
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

  it("REPLAYS a stored payload verbatim instead of rebuilding it [Codex #83]", async () => {
    // Core keys idempotency on a semantic digest of the body, so rebuilding with the CURRENTLY deployed
    // builder means any mapping change since the original delivery yields a different digest — and a
    // recovery of a row that may already have committed then reads as a CORRECTION, re-entering the
    // newest-wins update path over an estimator's edits. Sending the stored bytes back is what makes the
    // retry recognisably the same delivery.
    priorRow.payload = { version: "trock.crm.service-rfp-approved.v1", office: "dallas", bid: { title: "as sent" } };

    const out = await redriveServiceRfpToCore(781);

    expect(out).toEqual({ ok: true, status: "sent" });
    expect(replayMock).toHaveBeenCalledTimes(1);
    expect((replayMock.mock.calls[0]![0] as any).payload).toEqual(priorRow.payload);
    // The rebuild path must NOT run: that is the whole point.
    expect(handoffMock).not.toHaveBeenCalled();
  });

  it("builds a fresh body when there is no prior delivery to replay", async () => {
    // A pre-POST refusal row stores only the reason, not a body — there is nothing to replay, so the
    // ordinary handoff builds one.
    priorRow.payload = null;
    await redriveServiceRfpToCore(781);
    expect(handoffMock).toHaveBeenCalledTimes(1);
    expect(replayMock).not.toHaveBeenCalled();
  });

  it("ABORTS when the prior payload cannot be read — inconclusive is not 'no prior delivery' [Codex #83]", async () => {
    // The asymmetry that decides this: if the read fails transiently and the upsert then succeeds, a
    // `dead` row from an ambiguous delivery is rebuilt with the request row's LATER approvedAt, Core
    // reads a newer semantic event, and estimator changes made after the original landed are overwritten.
    // Refusing costs one retry; guessing silently rewrites someone's work.
    priorRow.throws = true;
    const out = await redriveServiceRfpToCore(781);
    expect(out).toMatchObject({ ok: false, reason: "prior_delivery_unreadable" });
    expect(handoffMock).not.toHaveBeenCalled();
  });

  it("passes a DUPLICATE through rather than dressing it as success", async () => {
    // The upsert guard answers `duplicate` when the row already left — calling this on an approval that
    // already landed must report that, not claim a fresh delivery.
    handoffMock.mockResolvedValue({ status: "duplicate" } as any);
    const out = await redriveServiceRfpToCore(781);
    expect(out).toEqual({ ok: true, status: "duplicate" });
  });
});
