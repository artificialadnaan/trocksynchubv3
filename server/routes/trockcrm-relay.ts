import type { Express, RequestHandler } from "express";
import { asyncHandler } from "../lib/async-handler";
import { listTrockCrmRelayOutbox } from "../trockcrm-relay";

export function registerTrockCrmRelayRoutes(app: Express, requireAuth: RequestHandler) {
  app.get("/api/trockcrm-relay-outbox", requireAuth, asyncHandler(async (req, res) => {
    const webhookLogIds = typeof req.query.webhookLogIds === "string"
      ? req.query.webhookLogIds.split(",").map((id) => parseInt(id, 10)).filter(Number.isFinite)
      : undefined;
    const entries = await listTrockCrmRelayOutbox({
      webhookLogIds,
      status: typeof req.query.status === "string" ? req.query.status : undefined,
      limit: parseInt(req.query.limit as string) || 100,
      offset: parseInt(req.query.offset as string) || 0,
    });
    res.json({ entries });
  }));
}
