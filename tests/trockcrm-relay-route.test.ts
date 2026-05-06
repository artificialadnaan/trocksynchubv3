import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("TrockCRM relay outbox admin route", () => {
  let server: Server | undefined;
  const listTrockCrmRelayOutbox = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    listTrockCrmRelayOutbox.mockReset();
    vi.doMock("../server/trockcrm-relay.ts", () => ({
      listTrockCrmRelayOutbox,
    }));
    vi.doMock("../server/storage.ts", () => ({
      storage: {
        getSyncMappings: vi.fn(),
        getWebhookLogs: vi.fn(),
        getAuditLogs: vi.fn(),
      },
    }));
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    vi.clearAllMocks();
  });

  async function startServer(requireAuth = (_req: any, _res: any, next: any) => next()) {
    const { registerTrockCrmRelayRoutes } = await import("../server/routes/trockcrm-relay.ts");
    const app = express();
    app.use(express.json());
    registerTrockCrmRelayRoutes(app, requireAuth);
    server = await new Promise<Server>((resolve) => {
      const created = app.listen(0, () => resolve(created));
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("requires authentication", async () => {
    const baseUrl = await startServer((_req, res) => res.status(401).json({ message: "Unauthorized" }));

    const response = await fetch(`${baseUrl}/api/trockcrm-relay-outbox`);

    expect(response.status).toBe(401);
    expect(listTrockCrmRelayOutbox).not.toHaveBeenCalled();
  });

  it("lists relay outbox entries with parsed filters", async () => {
    listTrockCrmRelayOutbox.mockResolvedValue([
      {
        id: 10,
        webhookLogId: 4,
        status: "sent",
        projectNumber: "DFW-1-02326-ad",
      },
    ]);
    const baseUrl = await startServer();

    const response = await fetch(`${baseUrl}/api/trockcrm-relay-outbox?webhookLogIds=4,abc,9&status=sent&limit=25&offset=5`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(listTrockCrmRelayOutbox).toHaveBeenCalledWith({
      webhookLogIds: [4, 9],
      status: "sent",
      limit: 25,
      offset: 5,
    });
    expect(body.entries).toEqual([
      {
        id: 10,
        webhookLogId: 4,
        status: "sent",
        projectNumber: "DFW-1-02326-ad",
      },
    ]);
  });

  it("uses default pagination when filters are omitted", async () => {
    listTrockCrmRelayOutbox.mockResolvedValue([]);
    const baseUrl = await startServer();

    const response = await fetch(`${baseUrl}/api/trockcrm-relay-outbox`);

    expect(response.status).toBe(200);
    expect(listTrockCrmRelayOutbox).toHaveBeenCalledWith({
      webhookLogIds: undefined,
      status: undefined,
      limit: 100,
      offset: 0,
    });
  });
});
