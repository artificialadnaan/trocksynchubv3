import { beforeEach, describe, expect, it, vi } from "vitest";

const insertReturning = vi.fn();
const insertValues = vi.fn(() => ({ returning: insertReturning }));
const insert = vi.fn(() => ({ values: insertValues }));

const selectLimit = vi.fn();
const selectOffset = vi.fn();
const selectOrderBy = vi.fn(() => ({ limit: selectLimit, offset: selectOffset }));
const selectWhere = vi.fn(() => ({ orderBy: selectOrderBy }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const select = vi.fn(() => ({ from: selectFrom }));

const updateWhere = vi.fn();
const updateSet = vi.fn(() => ({ where: updateWhere }));
const update = vi.fn(() => ({ set: updateSet }));

vi.mock("../server/db.ts", () => ({
  db: {
    insert,
    select,
    update,
  },
}));

describe("TrockCRM relay Drizzle store adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertReturning.mockResolvedValue([{ id: 42 }]);
    selectLimit.mockResolvedValue([{ id: 1, status: "pending" }]);
    selectOffset.mockResolvedValue([{ id: 2, status: "sent" }]);
    updateWhere.mockResolvedValue(undefined);
  });

  it("inserts outbox rows through the database adapter", async () => {
    const { createDbRelayStore } = await import("../server/trockcrm-relay.ts");
    const store = createDbRelayStore();

    await expect(store.insertOutbox({
      webhookLogId: 7,
      syncMappingId: 9,
      procorePortfolioProjectId: "598134326517540",
      projectNumber: "DFW-1-02326-ad",
      payload: { eventType: "procore.project.created" },
    })).resolves.toEqual({ id: 42 });

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
      webhookLogId: 7,
      syncMappingId: 9,
      procorePortfolioProjectId: "598134326517540",
      projectNumber: "DFW-1-02326-ad",
    }));
  });

  it("finds pending and due failed outbox rows", async () => {
    const { createDbRelayStore } = await import("../server/trockcrm-relay.ts");
    const store = createDbRelayStore();

    await expect(store.findReadyOutbox(25, new Date("2026-05-01T12:00:00.000Z"))).resolves.toEqual([
      { id: 1, status: "pending" },
    ]);

    expect(select).toHaveBeenCalledTimes(1);
    expect(selectWhere).toHaveBeenCalledTimes(1);
    expect(selectLimit).toHaveBeenCalledWith(25);
  });

  it("updates sent, failed, and abandoned delivery states", async () => {
    const { createDbRelayStore } = await import("../server/trockcrm-relay.ts");
    const store = createDbRelayStore();
    const now = new Date("2026-05-01T12:00:00.000Z");

    await store.markSent(1, { responseStatus: 200, responseBody: "ok", sentAt: now });
    await store.markFailed(2, {
      attempts: 3,
      error: "temporary",
      responseStatus: 503,
      responseBody: "retry",
      nextRetryAt: new Date(now.getTime() + 1000),
      attemptedAt: now,
    });
    await store.markAbandoned(3, {
      attempts: 20,
      error: "bad request",
      responseStatus: 400,
      responseBody: "invalid",
      attemptedAt: now,
    });

    expect(update).toHaveBeenCalledTimes(3);
    expect(updateSet).toHaveBeenNthCalledWith(1, expect.objectContaining({ status: "sent", lastError: null }));
    expect(updateSet).toHaveBeenNthCalledWith(2, expect.objectContaining({ status: "failed", attempts: 3 }));
    expect(updateSet).toHaveBeenNthCalledWith(3, expect.objectContaining({ status: "abandoned", attempts: 20 }));
  });

  it("lists relay outbox rows with filters and pagination", async () => {
    const { listTrockCrmRelayOutbox } = await import("../server/trockcrm-relay.ts");
    selectLimit.mockReturnValueOnce({ offset: selectOffset });

    await expect(listTrockCrmRelayOutbox({
      webhookLogIds: [7, 9],
      status: "sent",
      limit: 10,
      offset: 5,
    })).resolves.toEqual([{ id: 2, status: "sent" }]);

    expect(select).toHaveBeenCalledTimes(1);
    expect(selectWhere).toHaveBeenCalledTimes(1);
    expect(selectOrderBy).toHaveBeenCalledTimes(1);
    expect(selectLimit).toHaveBeenCalledWith(10);
    expect(selectOffset).toHaveBeenCalledWith(5);
  });
});
