import crypto from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// D-5: a Core 409 refusal of an approved service RFP is told to the CRM (signed /api/internal/core-handoff-refused),
// riding the outbox row it was recorded on. The DB layer is one `db.execute` spy; the CRM is an injected fetch.
const dbExecuteMock = vi.hoisted(() => vi.fn());
vi.mock("../server/db.ts", () => ({ db: { execute: dbExecuteMock } }));
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));

const SECRET = "crm-callback-secret";
const TARGET = "https://crm.example.com/api/internal/core-handoff-refused";
const CRM_DEAL_ID = "9f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const REFUSED_AT = "2026-10-27T15:00:00.000Z";

function refusedRow(fields: Record<string, unknown> = {}) {
  return {
    id: 501,
    source_system: "trock_crm",
    source_deal_id: CRM_DEAL_ID,
    rfp_request_id: 77,
    status: "crm_notify_pending",
    attempt_count: 1,
    last_status_code: 409,
    last_error: "Core refused the approval: live_project",
    last_attempt_at: REFUSED_AT,
    created_at: "2026-10-27T14:59:00.000Z",
    payload: { rfp: { requestId: 77 }, deal: { id: CRM_DEAL_ID } },
    ...fields,
  };
}

function statements(): string[] {
  return dbExecuteMock.mock.calls.map((call) => JSON.stringify(call[0]));
}

function respond(status: number, body = "{}") {
  return vi.fn(async () => new Response(body, { status }));
}

beforeEach(() => {
  vi.resetModules();
  dbExecuteMock.mockReset();
  dbExecuteMock.mockResolvedValue({ rows: [] });
});

async function load() {
  return import("../server/sync/service-rfp-core-crm-refusal.ts");
}

describe("postCoreRefusalToCrm", () => {
  it("POSTs the refusal to the CRM, signed with the shared HMAC over the exact bytes", async () => {
    const { postCoreRefusalToCrm } = await load();
    const fetchImpl = respond(200, JSON.stringify({ success: true }));
    const payload = { sourceDealId: CRM_DEAL_ID, rfpApprovalRequestId: 77, reason: "live_project", refusedAt: REFUSED_AT };

    const outcome = await postCoreRefusalToCrm(payload, { fetchImpl: fetchImpl as any, secret: SECRET, targetUrl: TARGET });

    expect(outcome).toEqual({ kind: "sent", status: 200 });
    const [url, init] = fetchImpl.mock.calls[0] as any[];
    expect(url).toBe(TARGET);
    expect(JSON.parse(init.body)).toEqual(payload);
    expect(init.headers["x-rfp-request-signature"]).toBe(
      `sha256=${crypto.createHmac("sha256", SECRET).update(init.body).digest("hex")}`,
    );
  });

  it("builds the CRM URL from TROCK_CRM_BASE_URL", async () => {
    const { buildCoreRefusalCallbackTargetUrl } = await load();
    expect(buildCoreRefusalCallbackTargetUrl("https://crm.example.com/")).toBe(TARGET);
    expect(buildCoreRefusalCallbackTargetUrl("")).toBeNull();
  });

  it.each([500, 503, 429, 408])("treats a CRM %s as retryable", async (status) => {
    const { postCoreRefusalToCrm } = await load();
    const outcome = await postCoreRefusalToCrm(
      { sourceDealId: CRM_DEAL_ID, rfpApprovalRequestId: 77, reason: "live_project", refusedAt: REFUSED_AT },
      { fetchImpl: respond(status) as any, secret: SECRET, targetUrl: TARGET },
    );
    expect(outcome.kind).toBe("retryable");
  });

  it.each([400, 401, 404, 409, 422])("treats a CRM %s as terminal", async (status) => {
    const { postCoreRefusalToCrm } = await load();
    const outcome = await postCoreRefusalToCrm(
      { sourceDealId: CRM_DEAL_ID, rfpApprovalRequestId: 77, reason: "live_project", refusedAt: REFUSED_AT },
      { fetchImpl: respond(status) as any, secret: SECRET, targetUrl: TARGET },
    );
    expect(outcome.kind).toBe("terminal");
  });

  it("treats a network failure, and a missing URL or secret, as retryable (never a throw)", async () => {
    const { postCoreRefusalToCrm } = await load();
    const body = { sourceDealId: CRM_DEAL_ID, rfpApprovalRequestId: 77, reason: "live_project", refusedAt: REFUSED_AT };
    const down = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect((await postCoreRefusalToCrm(body, { fetchImpl: down as any, secret: SECRET, targetUrl: TARGET })).kind).toBe("retryable");
    expect((await postCoreRefusalToCrm(body, { fetchImpl: down as any, secret: SECRET, targetUrl: null })).kind).toBe("retryable");
    expect((await postCoreRefusalToCrm(body, { fetchImpl: down as any, secret: "", targetUrl: TARGET })).kind).toBe("retryable");
    expect(down).toHaveBeenCalledTimes(1);
  });
});

describe("notifyCrmForRow", () => {
  it("sends Core's reason for the row's deal and request, then settles the row at 'failed'", async () => {
    const { notifyCrmForRow } = await load();
    const fetchImpl = respond(200);

    expect(await notifyCrmForRow(refusedRow(), { fetchImpl: fetchImpl as any, secret: SECRET, targetUrl: TARGET })).toBe("sent");

    expect(JSON.parse((fetchImpl.mock.calls[0] as any[])[1].body)).toEqual({
      sourceDealId: CRM_DEAL_ID,
      rfpApprovalRequestId: 77,
      reason: "live_project",
      refusedAt: REFUSED_AT,
    });
    const settle = statements().join("\n");
    expect(settle).toContain("status = 'failed'");
    // Guarded: a re-drive that replaced the row meanwhile is not overwritten.
    expect(settle).toContain("status = 'crm_notify_pending'");
    // The Core evidence on the row is never rewritten by the CRM notice.
    expect(settle).not.toContain("last_error");
    expect(settle).not.toContain("last_attempt_at");
    expect(settle).not.toContain("attempt_count");
  });

  it("settles on a deterministic CRM refusal instead of retrying it", async () => {
    const { notifyCrmForRow } = await load();
    expect(await notifyCrmForRow(refusedRow(), { fetchImpl: respond(404) as any, secret: SECRET, targetUrl: TARGET })).toBe("terminal");
    expect(statements().join("\n")).toContain("status = 'failed'");
  });

  it("reschedules a retryable failure with a growing delay, keeping the row pending", async () => {
    const { notifyCrmForRow } = await load();
    const tenMinutesLater = new Date(REFUSED_AT).getTime() + 10 * 60 * 1000;

    expect(
      await notifyCrmForRow(refusedRow(), { fetchImpl: respond(503) as any, secret: SECRET, targetUrl: TARGET, now: () => tenMinutesLater }),
    ).toBe("retrying");

    const sqls = statements();
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toContain("next_attempt_at = NOW() +");
    expect(sqls[0]).toContain("600 seconds");
    expect(sqls[0]).not.toContain("status = 'failed'");
  });

  it("gives up a day after Core refused, settling the row", async () => {
    const { notifyCrmForRow } = await load();
    const aDayLater = new Date(REFUSED_AT).getTime() + 24 * 60 * 60 * 1000;
    expect(
      await notifyCrmForRow(refusedRow(), { fetchImpl: respond(503) as any, secret: SECRET, targetUrl: TARGET, now: () => aDayLater }),
    ).toBe("gave_up");
    expect(statements().join("\n")).toContain("status = 'failed'");
  });

  it("settles, without posting, a parked row that holds no Core reason", async () => {
    const { notifyCrmForRow } = await load();
    const fetchImpl = respond(200);
    expect(
      await notifyCrmForRow(refusedRow({ last_error: "Core ingress rejected the request with 400" }), {
        fetchImpl: fetchImpl as any,
        secret: SECRET,
        targetUrl: TARGET,
      }),
    ).toBe("terminal");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(statements().join("\n")).toContain("status = 'failed'");
  });
});

describe("the drain", () => {
  it("claims only parked refusals, leasing them by next_attempt_at alone", async () => {
    const { claimCrmNotifyRows } = await load();
    await claimCrmNotifyRows();
    const claim = statements()[0];
    expect(claim).toContain("status = 'crm_notify_pending'");
    expect(claim).toContain("FOR UPDATE SKIP LOCKED");
    expect(claim).not.toContain("attempt_count");
    expect(claim).not.toContain("last_attempt_at");
  });

  it("tells the CRM about each claimed refusal", async () => {
    dbExecuteMock.mockResolvedValueOnce({ rows: [refusedRow(), refusedRow({ id: 502, rfp_request_id: 78, payload: { rfp: { requestId: 78 }, deal: { id: CRM_DEAL_ID } } })] });
    const { processCoreRefusalCrmNotifications } = await load();
    const fetchImpl = respond(200);

    const result = await processCoreRefusalCrmNotifications({ fetchImpl: fetchImpl as any, secret: SECRET, targetUrl: TARGET });

    expect(result).toEqual({ processed: 2, sent: 2 });
    expect(fetchImpl.mock.calls.map((call: any[]) => JSON.parse(call[1].body).rfpApprovalRequestId)).toEqual([77, 78]);
  });

  it("reads Core's reason back off last_error", async () => {
    const { coreReasonFromLastError } = await load();
    expect(coreReasonFromLastError("Core refused the approval: job_type_diverged")).toBe("job_type_diverged");
    expect(coreReasonFromLastError("Core ingress returned 503")).toBeNull();
    expect(coreReasonFromLastError(null)).toBeNull();
  });
});
