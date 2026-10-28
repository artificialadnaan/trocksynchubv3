import crypto from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// D-5: how Core answered an approved service RFP (a 409 refusal, or an acceptance) is told to the CRM over its signed
// /api/internal/core-rfp-handoff callback, riding the outbox row the answer was recorded on. The DB layer is one
// `db.execute` spy, the CRM an injected fetch, and the ops alerter a spy.
const dbExecuteMock = vi.hoisted(() => vi.fn());
const alertMock = vi.hoisted(() => vi.fn(async () => ({ action: "alert_failure" })));
vi.mock("../server/db.ts", () => ({ db: { execute: dbExecuteMock } }));
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));
vi.mock("../server/sync/service-rfp-core-alert.ts", () => ({ recordServiceRfpCrmNoticeOutcome: alertMock }));

const SECRET = "crm-callback-secret";
const TARGET = "https://crm.example.com/api/internal/core-rfp-handoff";
const CRM_DEAL_ID = "9f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const REFUSED_AT = "2026-10-27T15:00:00.000Z";
const SENT_AT = "2026-10-27T16:00:00.000Z";

function refusedRow(fields: Record<string, unknown> = {}) {
  return {
    id: 501,
    source_system: "trock_crm",
    source_deal_id: CRM_DEAL_ID,
    rfp_request_id: 77,
    status: "crm_notify_refused",
    attempt_count: 2,
    last_status_code: 409,
    last_error: "Core refused the approval: live_project",
    last_attempt_at: REFUSED_AT,
    sent_at: null,
    created_at: "2026-10-27T14:59:00.000Z",
    payload: { office: "dallas", rfp: { requestId: 77 }, deal: { id: CRM_DEAL_ID } },
    // What the claim computes in SQL (the instants, and the generation it settles on).
    last_attempt_at_ms: Date.parse(REFUSED_AT),
    sent_at_ms: null,
    generation: "2026-10-27 15:00:00.123456",
    ...fields,
  };
}

function acceptedRow(fields: Record<string, unknown> = {}) {
  return refusedRow({ status: "crm_notify_accepted", last_status_code: 201, last_error: null, attempt_count: 3, last_attempt_at: SENT_AT, sent_at: SENT_AT, last_attempt_at_ms: Date.parse(SENT_AT), sent_at_ms: Date.parse(SENT_AT), ...fields });
}

function statements(): string[] {
  return dbExecuteMock.mock.calls.map((call) => JSON.stringify(call[0]));
}

function respond(status: number, body = "{}") {
  return vi.fn(async () => new Response(body, { status }));
}

const deps = (fetchImpl: unknown, extra: Record<string, unknown> = {}) => ({ fetchImpl: fetchImpl as any, secret: SECRET, targetUrl: TARGET, ...extra });

beforeEach(() => {
  vi.resetModules();
  dbExecuteMock.mockReset();
  dbExecuteMock.mockResolvedValue({ rows: [] });
  alertMock.mockClear();
});

async function load() {
  return import("../server/sync/service-rfp-core-crm-notice.ts");
}

describe("postCoreHandoffToCrm", () => {
  it("POSTs the event signed with the shared HMAC over the exact bytes", async () => {
    const { postCoreHandoffToCrm } = await load();
    const fetchImpl = respond(200, JSON.stringify({ success: true }));
    const payload = { event: "refused" as const, office: "dallas", sourceDealId: CRM_DEAL_ID, rfpApprovalRequestId: 77, occurredAt: REFUSED_AT, attempt: 2, reason: "live_project" };

    expect(await postCoreHandoffToCrm(payload, deps(fetchImpl))).toEqual({ kind: "sent", status: 200 });
    const [url, init] = fetchImpl.mock.calls[0] as any[];
    expect(url).toBe(TARGET);
    expect(JSON.parse(init.body)).toEqual(payload);
    expect(init.headers["x-rfp-request-signature"]).toBe(
      `sha256=${crypto.createHmac("sha256", SECRET).update(init.body).digest("hex")}`,
    );
  });

  it("builds the CRM URL from TROCK_CRM_BASE_URL", async () => {
    const { buildCoreHandoffCallbackTargetUrl } = await load();
    expect(buildCoreHandoffCallbackTargetUrl("https://crm.example.com/")).toBe(TARGET);
    expect(buildCoreHandoffCallbackTargetUrl("")).toBeNull();
  });

  it.each([500, 503, 429, 408])("treats a CRM %s as retryable", async (status) => {
    const { postCoreHandoffToCrm, crmNoticeForRow } = await load();
    expect((await postCoreHandoffToCrm(crmNoticeForRow(refusedRow())!, deps(respond(status)))).kind).toBe("retryable");
  });

  it.each([400, 401, 404, 409, 422])("treats a CRM %s as terminal", async (status) => {
    const { postCoreHandoffToCrm, crmNoticeForRow } = await load();
    expect((await postCoreHandoffToCrm(crmNoticeForRow(refusedRow())!, deps(respond(status)))).kind).toBe("terminal");
  });

  it("treats a network failure, and a missing URL or secret, as retryable (never a throw)", async () => {
    const { postCoreHandoffToCrm, crmNoticeForRow } = await load();
    const body = crmNoticeForRow(refusedRow())!;
    const down = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect((await postCoreHandoffToCrm(body, deps(down))).kind).toBe("retryable");
    expect((await postCoreHandoffToCrm(body, deps(down, { targetUrl: null }))).kind).toBe("retryable");
    expect((await postCoreHandoffToCrm(body, deps(down, { secret: "" }))).kind).toBe("retryable");
    expect(down).toHaveBeenCalledTimes(1);
  });
});

describe("postCoreHandoffToCrm bounds (#125 review)", () => {
  // A body that never ends, but errors when the request's signal aborts, as a real fetch body does.
  function stalledBodyFetch(status: number) {
    return vi.fn(async (_url: string, init: RequestInit) => {
      const body = new ReadableStream({
        start(controller) {
          init.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
        },
      });
      return new Response(body, { status });
    });
  }

  it("never follows a redirect: the signed POST is sent with redirect 'error'", async () => {
    const { postCoreHandoffToCrm, crmNoticeForRow } = await load();
    const fetchImpl = respond(200);
    await postCoreHandoffToCrm(crmNoticeForRow(refusedRow())!, deps(fetchImpl));
    expect((fetchImpl.mock.calls[0] as any[])[1].redirect).toBe("error");
  });

  it("does not wait on a 2xx body", async () => {
    const { postCoreHandoffToCrm, crmNoticeForRow } = await load();
    const outcome = await Promise.race([
      postCoreHandoffToCrm(crmNoticeForRow(refusedRow())!, deps(stalledBodyFetch(200))),
      new Promise((resolve) => setTimeout(() => resolve("stalled"), 1_000)),
    ]);
    expect(outcome).toEqual({ kind: "sent", status: 200 });
  });

  it("bounds a stalled error body with its own deadline, then treats the answer by its status", async () => {
    vi.useFakeTimers();
    try {
      const { postCoreHandoffToCrm, crmNoticeForRow, CRM_CALLBACK_DEADLINE_MS } = await load();
      const fetchImpl = stalledBodyFetch(503);
      const done = postCoreHandoffToCrm(crmNoticeForRow(refusedRow())!, deps(fetchImpl));
      await vi.advanceTimersByTimeAsync(CRM_CALLBACK_DEADLINE_MS + 100);
      const outcome = await Promise.race([done, Promise.resolve("still waiting")]);
      expect(outcome).toEqual(expect.objectContaining({ kind: "retryable", status: 503 }));
      expect(((fetchImpl.mock.calls[0] as any[])[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("crmNoticeForRow (the signed body)", () => {
  it("describes a refusal: office, deal, request, Core's reason, when Core refused and on which attempt", async () => {
    const { crmNoticeForRow } = await load();
    expect(crmNoticeForRow(refusedRow())).toEqual({
      event: "refused",
      office: "dallas",
      sourceDealId: CRM_DEAL_ID,
      rfpApprovalRequestId: 77,
      occurredAt: REFUSED_AT,
      attempt: 2,
      reason: "live_project",
    });
  });

  it("describes an acceptance at sent_at, with no reason", async () => {
    const { crmNoticeForRow } = await load();
    expect(crmNoticeForRow(acceptedRow())).toEqual({
      event: "accepted",
      office: "dallas",
      sourceDealId: CRM_DEAL_ID,
      rfpApprovalRequestId: 77,
      occurredAt: SENT_AT,
      attempt: 3,
    });
  });

  it("cannot describe a refusal without Core's reason, or any row without its office", async () => {
    const { crmNoticeForRow } = await load();
    expect(crmNoticeForRow(refusedRow({ last_error: "Core ingress rejected the request with 400" }))).toBeNull();
    expect(crmNoticeForRow(refusedRow({ payload: { rfp: { requestId: 77 }, deal: { id: CRM_DEAL_ID } } }))).toBeNull();
  });
});

describe("notifyCrmForRow", () => {
  it("sends a refusal, then settles the row at 'failed' without touching Core's evidence", async () => {
    const { notifyCrmForRow } = await load();
    expect(await notifyCrmForRow(refusedRow(), deps(respond(200)))).toBe("sent");

    const settle = statements().join("\n");
    expect(settle).toContain("SET status = 'failed'");
    // Guarded: a re-drive that replaced the row meanwhile is not overwritten.
    expect(settle).toContain("status = 'crm_notify_refused'");
    for (const column of ["last_error", "last_attempt_at", "attempt_count", "sent_at", "last_status_code"]) {
      expect(settle).not.toMatch(new RegExp(`${column}\\s*=`));
    }
    // ...and guarded by the generation it was claimed at (an in-flight older notice cannot settle a newer refusal).
    expect(settle).toContain("last_attempt_at IS NOT DISTINCT FROM");
    expect(alertMock).toHaveBeenCalledWith(expect.objectContaining({ ok: true, event: "refused" }));
  });

  it("sends an acceptance, then settles the row at 'sent'", async () => {
    const { notifyCrmForRow } = await load();
    const fetchImpl = respond(200);
    expect(await notifyCrmForRow(acceptedRow(), deps(fetchImpl))).toBe("sent");
    expect(JSON.parse((fetchImpl.mock.calls[0] as any[])[1].body).event).toBe("accepted");
    const settle = statements().join("\n");
    expect(settle).toContain("SET status = 'sent'");
    expect(settle).toContain("status = 'crm_notify_accepted'");
  });

  it("settles a deterministic CRM refusal and alerts operators instead of retrying it", async () => {
    const { notifyCrmForRow } = await load();
    expect(await notifyCrmForRow(refusedRow(), deps(respond(404)))).toBe("terminal");
    expect(statements().join("\n")).toContain("SET status = 'failed'");
    expect(alertMock).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, status: 404, event: "refused", rfpRequestId: 77, office: "dallas" }),
    );
  });

  it("reschedules a retryable failure with a growing delay, keeping the row parked and unalerted", async () => {
    const { notifyCrmForRow } = await load();
    const tenMinutesLater = new Date(REFUSED_AT).getTime() + 10 * 60 * 1000;

    expect(await notifyCrmForRow(refusedRow(), deps(respond(503), { now: () => tenMinutesLater }))).toBe("retrying");

    const sqls = statements();
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toContain("next_attempt_at = NOW() +");
    expect(sqls[0]).toContain("600 seconds");
    expect(sqls[0]).not.toContain("SET status");
    expect(alertMock).not.toHaveBeenCalled();
  });

  it("gives up a day after Core answered, settling the row and alerting", async () => {
    const { notifyCrmForRow } = await load();
    const aDayLater = new Date(REFUSED_AT).getTime() + 24 * 60 * 60 * 1000;
    expect(await notifyCrmForRow(refusedRow(), deps(respond(503), { now: () => aDayLater }))).toBe("gave_up");
    expect(statements().join("\n")).toContain("SET status = 'failed'");
    expect(alertMock).toHaveBeenCalledWith(expect.objectContaining({ ok: false, event: "refused" }));
  });

  it("settles, without posting, a parked refusal it cannot describe, and alerts", async () => {
    const { notifyCrmForRow } = await load();
    const fetchImpl = respond(200);
    expect(await notifyCrmForRow(refusedRow({ last_error: "Core ingress rejected the request with 400" }), deps(fetchImpl))).toBe("terminal");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(statements().join("\n")).toContain("SET status = 'failed'");
    expect(alertMock).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });

  it("is not held up by a wedged alerter", async () => {
    alertMock.mockImplementationOnce(() => new Promise(() => {}));
    vi.useFakeTimers();
    try {
      const { notifyCrmForRow } = await load();
      const done = notifyCrmForRow(refusedRow(), deps(respond(404)));
      await vi.advanceTimersByTimeAsync(2_100);
      expect(await done).toBe("terminal");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the drain", () => {
  it("claims only parked notices, leasing them by next_attempt_at alone", async () => {
    const { claimCrmNoticeRows } = await load();
    await claimCrmNoticeRows();
    const claim = statements()[0];
    expect(claim).toContain("status IN ('crm_notify_refused', 'crm_notify_accepted')");
    expect(claim).toContain("FOR UPDATE SKIP LOCKED");
    expect(claim).not.toContain("attempt_count");
    expect(claim).not.toMatch(/last_attempt_at\s*=/);
    // The instants and the generation are computed in SQL, never parsed from the zone-less columns in JS.
    expect(claim).toContain("::timestamptz");
    expect(claim).toContain("AS generation");
  });

  it("tells the CRM about each claimed row", async () => {
    dbExecuteMock.mockResolvedValueOnce({ rows: [refusedRow(), acceptedRow({ id: 502 })] });
    const { processCoreHandoffCrmNotices } = await load();
    const fetchImpl = respond(200);

    expect(await processCoreHandoffCrmNotices(deps(fetchImpl))).toEqual({ processed: 2, sent: 2 });
    expect(fetchImpl.mock.calls.map((call: any[]) => JSON.parse(call[1].body).event)).toEqual(["refused", "accepted"]);
  });

  it("reads Core's reason back off last_error", async () => {
    const { coreReasonFromLastError } = await load();
    expect(coreReasonFromLastError("Core refused the approval: job_type_diverged")).toBe("job_type_diverged");
    expect(coreReasonFromLastError("Core ingress returned 503")).toBeNull();
    expect(coreReasonFromLastError(null)).toBeNull();
  });
});
