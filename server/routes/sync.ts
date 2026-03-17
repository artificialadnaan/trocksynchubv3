import type { Express, RequestHandler } from "express";
import { asyncHandler } from "../lib/async-handler";
import { storage } from "../storage";
import { insertStageMappingSchema, insertSyncMappingSchema } from "@shared/schema";

export function registerSyncRoutes(app: Express, requireAuth: RequestHandler) {
  app.get("/api/sync-mappings", requireAuth, asyncHandler(async (req, res) => {
    const query = req.query.search as string;
    const mappings = query ? await storage.searchSyncMappings(query) : await storage.getSyncMappings();
    res.json(mappings);
  }));

  app.post("/api/sync-mappings", requireAuth, asyncHandler(async (req, res) => {
    const data = insertSyncMappingSchema.parse(req.body);
    const mapping = await storage.createSyncMapping(data);
    res.json(mapping);
  }));

  app.patch("/api/sync-mappings/:id", requireAuth, asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id as string);
    const mapping = await storage.updateSyncMapping(id, req.body);
    if (!mapping) return res.status(404).json({ message: "Not found" });
    res.json(mapping);
  }));

  app.get("/api/sync-mappings/lookup", requireAuth, asyncHandler(async (_req, res) => {
    const mappings = await storage.getSyncMappings();
    const lookup: Record<string, { hubspotDealId: string | null; hubspotDealName: string | null; procoreProjectId: string | null; procoreProjectName: string | null; procoreProjectNumber: string | null; companycamProjectId: string | null }> = {};
    for (const m of mappings) {
      const entry = {
        hubspotDealId: m.hubspotDealId,
        hubspotDealName: m.hubspotDealName,
        procoreProjectId: m.procoreProjectId,
        procoreProjectName: m.procoreProjectName,
        procoreProjectNumber: m.procoreProjectNumber,
        companycamProjectId: m.companyCamProjectId,
      };
      if (m.procoreProjectId) {
        lookup[`procore:${m.procoreProjectId}`] = entry;
        lookup[`bidboard:${m.procoreProjectId}`] = entry;
      }
      if (m.hubspotDealId) {
        lookup[`hubspot:${m.hubspotDealId}`] = entry;
      }
      if (m.companyCamProjectId) {
        lookup[`companycam:${m.companyCamProjectId}`] = entry;
      }
    }
    res.json(lookup);
  }));

  app.get("/api/stage-mappings", requireAuth, asyncHandler(async (_req, res) => {
    const mappings = await storage.getStageMappings();
    res.json(mappings);
  }));

  app.post("/api/stage-mappings", requireAuth, asyncHandler(async (req, res) => {
    const data = insertStageMappingSchema.parse(req.body);
    const mapping = await storage.createStageMapping(data);
    res.json(mapping);
  }));

  app.patch("/api/stage-mappings/:id", requireAuth, asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id as string);
    const mapping = await storage.updateStageMapping(id, req.body);
    if (!mapping) return res.status(404).json({ message: "Not found" });
    res.json(mapping);
  }));

  app.delete("/api/stage-mappings/:id", requireAuth, asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id as string);
    await storage.deleteStageMapping(id);
    res.json({ message: "Deleted" });
  }));

  app.get("/api/webhook-logs", requireAuth, asyncHandler(async (req, res) => {
    const filters = {
      source: req.query.source as string,
      status: req.query.status as string,
      limit: parseInt(req.query.limit as string) || 50,
      offset: parseInt(req.query.offset as string) || 0,
    };
    const result = await storage.getWebhookLogs(filters);
    res.json(result);
  }));

  app.post("/api/webhook-logs/:id/retry", requireAuth, asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id as string);
    const log = await storage.updateWebhookLog(id, { status: "retrying", retryCount: 0 });
    if (!log) return res.status(404).json({ message: "Not found" });
    res.json(log);
  }));

  app.get("/api/audit-logs", requireAuth, asyncHandler(async (req, res) => {
    const filters = {
      entityType: req.query.entityType as string,
      status: req.query.status as string,
      limit: parseInt(req.query.limit as string) || 50,
      offset: parseInt(req.query.offset as string) || 0,
      startDate: req.query.startDate ? new Date(req.query.startDate as string) : undefined,
      endDate: req.query.endDate ? new Date(req.query.endDate as string) : undefined,
    };
    const result = await storage.getAuditLogs(filters);
    res.json(result);
  }));
}
