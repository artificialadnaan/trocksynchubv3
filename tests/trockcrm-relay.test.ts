import crypto from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const logMock = vi.hoisted(() => vi.fn());

vi.mock("../server/index.ts", () => ({
  log: logMock,
}));
vi.mock("../server/db.ts", () => ({
  db: {},
}));

const {
  buildTrockCrmProjectCreatedPayload,
  calculateTrockCrmRelayBackoff,
  enqueueTrockCrmRelayOutbox,
  processTrockCrmRelayOutboxEntry,
  processTrockCrmRelayOutboxBatch,
  signTrockCrmRelayBody,
} = await import("../server/trockcrm-relay.ts");

function samplePayload() {
  return {
    eventType: "procore.project.created",
    source: "synchub",
    procore: {
      companyId: "598134325683880",
      portfolioProjectId: "598134326517540",
      projectNumber: "DFW-1-02326-ad",
      projectName: "Palm Villas",
    },
    synchub: {
      webhookLogId: "101",
      syncMappingId: "501",
      bidboardProjectId: "598134326000001",
      hubspotDealId: "323528245957",
      receivedAt: "2026-05-01T12:00:00.000Z",
      enrichedAt: "2026-05-01T12:05:00.000Z",
    },
    rawProcoreWebhook: {
      id: "evt-1",
      reason: "create",
      resource_type: "Projects",
      resource_id: "598134326517540",
    },
  };
}

describe("trockcrm relay payload and signing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SYNCHUB_RELAY_SECRET;
    delete process.env.TROCKCRM_RELAY_ENABLED;
  });

  it("builds the enriched Procore project-created payload", () => {
    const payload = buildTrockCrmProjectCreatedPayload({
      webhookLog: {
        id: 101,
        createdAt: new Date("2026-05-01T12:00:00.000Z"),
        payload: { id: "evt-1", reason: "create", resource_type: "Projects", resource_id: "598134326517540" },
      },
      syncMapping: {
        id: 501,
        bidboardProjectId: "598134326000001",
        hubspotDealId: "323528245957",
      },
      procoreProject: {
        id: "598134326517540",
        company_id: "598134325683880",
        project_number: "DFW-1-02326-ad",
        name: "Palm Villas",
      },
      enrichedAt: new Date("2026-05-01T12:05:00.000Z"),
    });

    expect(payload).toEqual(samplePayload());
  });

  it("signs bodies as deterministic sha256 HMAC headers", () => {
    const body = JSON.stringify(samplePayload());
    const signature = signTrockCrmRelayBody(body, "shared-secret");
    const expected = crypto.createHmac("sha256", "shared-secret").update(body).digest("hex");

    expect(signature).toBe(`sha256=${expected}`);
    expect(signTrockCrmRelayBody(JSON.stringify({ other: true }), "shared-secret")).not.toBe(signature);
  });
});

describe("trockcrm relay outbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SYNCHUB_RELAY_SECRET = "shared-secret";
    delete process.env.TROCKCRM_RELAY_ENABLED;
  });

  it("enqueues an outbox row with the enriched payload", async () => {
    const store = {
      insertOutbox: vi.fn().mockResolvedValue({ id: 12 }),
    };

    const result = await enqueueTrockCrmRelayOutbox({
      store,
      webhookLogId: 101,
      syncMappingId: 501,
      procorePortfolioProjectId: "598134326517540",
      projectNumber: "DFW-1-02326-ad",
      payload: samplePayload(),
    });

    expect(result).toEqual({ enqueued: true, outboxId: 12 });
    expect(store.insertOutbox).toHaveBeenCalledWith(expect.objectContaining({
      webhookLogId: 101,
      syncMappingId: 501,
      procorePortfolioProjectId: "598134326517540",
      projectNumber: "DFW-1-02326-ad",
      payload: samplePayload(),
      status: "pending",
      attempts: 0,
    }));
  });

  it("still enqueues when disabled or when the signing secret is missing", async () => {
    const store = { insertOutbox: vi.fn().mockResolvedValueOnce({ id: 13 }).mockResolvedValueOnce({ id: 14 }) };

    process.env.TROCKCRM_RELAY_ENABLED = "false";
    await expect(enqueueTrockCrmRelayOutbox({
      store,
      webhookLogId: 101,
      syncMappingId: 501,
      procorePortfolioProjectId: "598134326517540",
      projectNumber: "DFW-1-02326-ad",
      payload: samplePayload(),
    })).resolves.toEqual({ enqueued: true, outboxId: 13 });

    delete process.env.TROCKCRM_RELAY_ENABLED;
    delete process.env.SYNCHUB_RELAY_SECRET;
    await expect(enqueueTrockCrmRelayOutbox({
      store,
      webhookLogId: 101,
      syncMappingId: 501,
      procorePortfolioProjectId: "598134326517540",
      projectNumber: "DFW-1-02326-ad",
      payload: samplePayload(),
    })).resolves.toEqual({ enqueued: true, outboxId: 14 });

    expect(store.insertOutbox).toHaveBeenCalledTimes(2);
    expect(store.insertOutbox).toHaveBeenCalledWith(expect.objectContaining({ status: "pending" }));
  });

  it("returns insert_failed when outbox persistence throws", async () => {
    const store = {
      insertOutbox: vi.fn().mockRejectedValue(new Error("write failed")),
    };

    await expect(enqueueTrockCrmRelayOutbox({
      store,
      webhookLogId: 101,
      syncMappingId: 501,
      procorePortfolioProjectId: "598134326517540",
      projectNumber: "DFW-1-02326-ad",
      payload: samplePayload(),
    })).resolves.toEqual({ enqueued: false, reason: "insert_failed" });
  });

  it("marks successful delivery as sent with signature header", async () => {
    const store = {
      markSent: vi.fn(),
      markFailed: vi.fn(),
      markAbandoned: vi.fn(),
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: vi.fn().mockResolvedValue("ok") });

    await processTrockCrmRelayOutboxEntry({
      store,
      fetchImpl: fetchMock,
      row: {
        id: 12,
        payload: samplePayload(),
        attempts: 1,
      },
      now: new Date("2026-05-01T12:06:00.000Z"),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api-production-ad218.up.railway.app/api/webhooks/synchub/procore-project-created",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-synchub-signature": expect.stringMatching(/^sha256=[a-f0-9]{64}$/),
        }),
      }),
    );
    expect(store.markSent).toHaveBeenCalledWith(12, expect.objectContaining({ responseStatus: 200 }));
    expect(store.markFailed).not.toHaveBeenCalled();
  });

  it("uses the configured relay URL and tolerates unreadable response bodies", async () => {
    process.env.TROCKCRM_RELAY_URL = "https://crm.example.test/custom-relay";
    const store = {
      markSent: vi.fn(),
      markFailed: vi.fn(),
      markAbandoned: vi.fn(),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      text: vi.fn().mockRejectedValue(new Error("body unavailable")),
    });

    await processTrockCrmRelayOutboxEntry({
      store,
      fetchImpl: fetchMock,
      row: { id: 12, payload: samplePayload(), attempts: 1 },
      now: new Date("2026-05-01T12:06:00.000Z"),
    });

    expect(fetchMock).toHaveBeenCalledWith("https://crm.example.test/custom-relay", expect.any(Object));
    expect(store.markSent).toHaveBeenCalledWith(12, expect.objectContaining({
      responseStatus: 202,
      responseBody: null,
    }));
  });

  it("marks a due row failed when the signing secret disappears before processing", async () => {
    delete process.env.SYNCHUB_RELAY_SECRET;
    const store = {
      markFailed: vi.fn(),
    };

    await expect(processTrockCrmRelayOutboxEntry({
      store,
      fetchImpl: vi.fn(),
      row: { id: 12, payload: samplePayload(), attempts: 2 },
      now: new Date("2026-05-01T12:06:00.000Z"),
    })).resolves.toBe("failed");

    expect(store.markFailed).toHaveBeenCalledWith(12, expect.objectContaining({
      attempts: 2,
      error: "SYNCHUB_RELAY_SECRET missing",
      nextRetryAt: expect.any(Date),
    }));
  });

  it.each([
    [400, "abandoned"],
    [401, "abandoned"],
    [429, "failed"],
    [503, "failed"],
  ])("classifies HTTP %s as %s", async (status, expectedStatus) => {
    const store = {
      markSent: vi.fn(),
      markFailed: vi.fn(),
      markAbandoned: vi.fn(),
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status, text: vi.fn().mockResolvedValue("nope") });

    await processTrockCrmRelayOutboxEntry({
      store,
      fetchImpl: fetchMock,
      row: { id: 12, payload: samplePayload(), attempts: 1 },
      now: new Date("2026-05-01T12:06:00.000Z"),
    });

    if (expectedStatus === "abandoned") {
      expect(store.markAbandoned).toHaveBeenCalledWith(12, expect.objectContaining({ responseStatus: status }));
    } else {
      expect(store.markFailed).toHaveBeenCalledWith(12, expect.objectContaining({
        responseStatus: status,
        attempts: 1,
        nextRetryAt: expect.any(Date),
      }));
    }
  });

  it("abandons retryable failures after max attempts", async () => {
    const store = {
      markSent: vi.fn(),
      markFailed: vi.fn(),
      markAbandoned: vi.fn(),
    };
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNRESET"));

    await processTrockCrmRelayOutboxEntry({
      store,
      fetchImpl: fetchMock,
      row: { id: 12, payload: samplePayload(), attempts: 20 },
      now: new Date("2026-05-01T12:06:00.000Z"),
    });

    expect(store.markAbandoned).toHaveBeenCalledWith(12, expect.objectContaining({
      attempts: 20,
      error: "ECONNRESET",
    }));
  });

  it("abandons retryable HTTP failures after max attempts", async () => {
    const store = {
      markSent: vi.fn(),
      markFailed: vi.fn(),
      markAbandoned: vi.fn(),
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, text: vi.fn().mockResolvedValue("busy") });

    await expect(processTrockCrmRelayOutboxEntry({
      store,
      fetchImpl: fetchMock,
      row: { id: 12, payload: samplePayload(), attempts: 20 },
      now: new Date("2026-05-01T12:06:00.000Z"),
    })).resolves.toBe("abandoned");

    expect(store.markAbandoned).toHaveBeenCalledWith(12, expect.objectContaining({
      attempts: 20,
      responseStatus: 503,
      responseBody: "busy",
    }));
  });

  it("marks network errors failed before retry exhaustion", async () => {
    const store = {
      markSent: vi.fn(),
      markFailed: vi.fn(),
      markAbandoned: vi.fn(),
    };
    const fetchMock = vi.fn().mockRejectedValue(new Error("temporary network error"));

    await expect(processTrockCrmRelayOutboxEntry({
      store,
      fetchImpl: fetchMock,
      row: { id: 12, payload: samplePayload(), attempts: 3 },
      now: new Date("2026-05-01T12:06:00.000Z"),
    })).resolves.toBe("failed");

    expect(store.markFailed).toHaveBeenCalledWith(12, expect.objectContaining({
      attempts: 3,
      error: "temporary network error",
      nextRetryAt: expect.any(Date),
    }));
  });

  it("processes atomically claimed entries", async () => {
    const due = { id: 1, payload: samplePayload(), attempts: 2 };
    const store = {
      claimReadyOutbox: vi.fn().mockResolvedValue([due]),
      markSent: vi.fn(),
      markFailed: vi.fn(),
      markAbandoned: vi.fn(),
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: vi.fn().mockResolvedValue("ok") });

    const result = await processTrockCrmRelayOutboxBatch({ store, fetchImpl: fetchMock, limit: 10 });

    expect(store.claimReadyOutbox).toHaveBeenCalledWith(10, expect.any(Date), expect.any(Date));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ processed: 1, sent: 1, failed: 0, abandoned: 0 });
  });

  it("parallel processors do not double-send atomically claimed rows", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      id: index + 1,
      payload: samplePayload(),
      attempts: 0,
      status: "pending",
    }));
    const sentIds: number[] = [];
    const store = {
      async claimReadyOutbox(limit: number) {
        const claimed = rows
          .filter((row) => row.status === "pending")
          .slice(0, limit);
        for (const row of claimed) {
          row.status = "processing";
          row.attempts += 1;
        }
        return claimed.map((row) => ({ id: row.id, payload: row.payload, attempts: row.attempts }));
      },
      async markSent(id: number) {
        rows.find((row) => row.id === id)!.status = "sent";
        sentIds.push(id);
      },
      markFailed: vi.fn(),
      markAbandoned: vi.fn(),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue("ok"),
    });

    const [first, second] = await Promise.all([
      processTrockCrmRelayOutboxBatch({ store, fetchImpl: fetchMock, limit: 3 }),
      processTrockCrmRelayOutboxBatch({ store, fetchImpl: fetchMock, limit: 3 }),
    ]);

    expect(first.processed + second.processed).toBe(5);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(new Set(sentIds).size).toBe(5);
    expect(rows.every((row) => row.status === "sent")).toBe(true);
  });

  it("does not process a batch when relay is disabled", async () => {
    process.env.TROCKCRM_RELAY_ENABLED = "false";
    const store = {
      claimReadyOutbox: vi.fn(),
    };

    await expect(processTrockCrmRelayOutboxBatch({ store, limit: 10 })).resolves.toEqual({
      processed: 0,
      sent: 0,
      failed: 0,
      abandoned: 0,
    });
    expect(store.claimReadyOutbox).not.toHaveBeenCalled();
  });

  it("delivers pending rows that were created while relay was disabled once enabled", async () => {
    const rows = [{ id: 1, payload: samplePayload(), attempts: 0, status: "pending" }];
    const store = {
      async claimReadyOutbox() {
        const row = rows.find((candidate) => candidate.status === "pending");
        if (!row) return [];
        row.status = "processing";
        row.attempts += 1;
        return [{ id: row.id, payload: row.payload, attempts: row.attempts }];
      },
      async markSent(id: number) {
        rows.find((row) => row.id === id)!.status = "sent";
      },
      markFailed: vi.fn(),
      markAbandoned: vi.fn(),
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: vi.fn().mockResolvedValue("ok") });

    process.env.TROCKCRM_RELAY_ENABLED = "false";
    await expect(processTrockCrmRelayOutboxBatch({ store, fetchImpl: fetchMock, limit: 10 })).resolves.toEqual({
      processed: 0,
      sent: 0,
      failed: 0,
      abandoned: 0,
    });
    expect(rows[0].status).toBe("pending");

    delete process.env.TROCKCRM_RELAY_ENABLED;
    await expect(processTrockCrmRelayOutboxBatch({ store, fetchImpl: fetchMock, limit: 10 })).resolves.toEqual({
      processed: 1,
      sent: 1,
      failed: 0,
      abandoned: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rows[0].status).toBe("sent");
  });

  it("uses increasing capped backoff delays", () => {
    expect(calculateTrockCrmRelayBackoff(1)).toBe(30_000);
    expect(calculateTrockCrmRelayBackoff(2)).toBe(120_000);
    expect(calculateTrockCrmRelayBackoff(3)).toBe(600_000);
    expect(calculateTrockCrmRelayBackoff(4)).toBe(3_600_000);
    expect(calculateTrockCrmRelayBackoff(99)).toBe(12 * 60 * 60 * 1000);
  });
});
