import type { Express, RequestHandler } from "express";
import { asyncHandler } from "../lib/async-handler";
import { storage } from "../storage";
import {
  runFullProcoreSync,
  syncProcoreBidBoard,
  syncProcoreRoleAssignments,
  updateProcoreProject,
  updateProcoreBid,
  fetchProcoreBidDetail,
  proxyProcoreAttachment,
  fetchProcoreProjectStages,
  fetchProcoreProjectDetail,
} from "../procore";
import { updateHubSpotDealStage } from "../hubspot";
import {
  syncProcoreToHubspot,
  getSyncOverview,
  unlinkMapping,
  createManualMapping,
  getUnmatchedProjects,
  mapProcoreStageToHubspot,
  resolveHubspotStageId,
} from "../procore-hubspot-sync";
import { assignProjectNumber, getProjectNumberRegistry } from "../deal-project-number";
import { sendStageChangeEmail } from "../email-notifications";

export function registerProcoreRoutes(app: Express, requireAuth: RequestHandler) {
  // ============= Procore Integration Config =============
  app.post("/api/integrations/procore/save", requireAuth, asyncHandler(async (req, res) => {
    const { clientId, clientSecret, companyId, environment } = req.body;

    // Trim whitespace from all inputs to prevent issues with copy-paste
    const trimmedClientId = clientId?.trim();
    const trimmedClientSecret = clientSecret?.trim();
    const trimmedCompanyId = companyId?.trim();

    if (!trimmedClientId || !trimmedClientSecret) return res.status(400).json({ message: "Client ID and Client Secret are required" });

    await storage.upsertAutomationConfig({
      key: "procore_config",
      value: {
        clientId: trimmedClientId,
        clientSecret: trimmedClientSecret,
        companyId: trimmedCompanyId,
        environment: environment || "production",
        configuredAt: new Date().toISOString(),
      },
      description: "Procore configuration",
      isActive: true,
    });

    await storage.createAuditLog({
      action: "integration_configured",
      entityType: "procore",
      source: "settings",
      status: "success",
      details: { companyId, environment, hasCredentials: true },
    });

    res.json({ success: true, message: "Procore configuration saved" });
  }));

  app.post("/api/integrations/procore/test", requireAuth, asyncHandler(async (_req, res) => {
    const token = await storage.getOAuthToken("procore");
    if (!token?.accessToken) {
      return res.json({ success: false, message: "No Procore OAuth token found. Use the OAuth flow to connect." });
    }

    const config = await storage.getAutomationConfig("procore_config");
    const env = (config?.value as any)?.environment || "production";
    const baseUrl = env === "sandbox" ? "https://sandbox.procore.com" : "https://api.procore.com";

    const axios = (await import("axios")).default;
    const response = await axios.get(`${baseUrl}/rest/v1.0/me`, {
      headers: { Authorization: `Bearer ${token.accessToken}` },
      timeout: 10000,
    });

    res.json({
      success: true,
      message: `Connected as ${response.data.name || response.data.login}`,
    });
  }));

  app.post("/api/integrations/procore/sync", requireAuth, asyncHandler(async (_req, res) => {
    const result = await runFullProcoreSync();

    await storage.createAuditLog({
      action: "procore_full_sync",
      entityType: "all",
      source: "procore",
      status: "success",
      details: result,
      durationMs: result.duration,
    });

    res.json({ success: true, ...result });
  }));

  app.get("/api/integrations/procore/data-counts", requireAuth, asyncHandler(async (_req, res) => {
    const counts = await storage.getProcoreDataCounts();
    const bidboardCount = await storage.getBidboardEstimateCount();
    res.json({ ...counts, bidboardEstimates: bidboardCount });
  }));

  app.post("/api/integrations/procore/sync-bidboard", requireAuth, asyncHandler(async (_req, res) => {
    const result = await syncProcoreBidBoard();
    await storage.createAuditLog({
      action: "procore_bidboard_sync",
      entityType: "bid_board",
      source: "procore",
      status: "success",
      details: result,
    });
    res.json({ success: true, ...result });
  }));

  // ============= Procore Data =============
  app.get("/api/procore/projects", requireAuth, asyncHandler(async (req, res) => {
    const result = await storage.getProcoreProjects({
      search: req.query.search as string,
      limit: parseInt(req.query.limit as string) || 50,
      offset: parseInt(req.query.offset as string) || 0,
    });
    res.json(result);
  }));

  app.get("/api/procore/vendors", requireAuth, asyncHandler(async (req, res) => {
    const result = await storage.getProcoreVendors({
      search: req.query.search as string,
      limit: parseInt(req.query.limit as string) || 50,
      offset: parseInt(req.query.offset as string) || 0,
    });
    res.json(result);
  }));

  app.get("/api/procore/users", requireAuth, asyncHandler(async (req, res) => {
    const result = await storage.getProcoreUsers({
      search: req.query.search as string,
      limit: parseInt(req.query.limit as string) || 50,
      offset: parseInt(req.query.offset as string) || 0,
    });
    res.json(result);
  }));

  app.post("/api/procore/users/bulk", requireAuth, asyncHandler(async (req, res) => {
    const { users } = req.body as { users: Array<Record<string, unknown>> };
    if (!Array.isArray(users)) {
      return res.status(400).json({ error: "users array is required" });
    }
    let created = 0;
    for (const u of users) {
      const procoreId = String(u.procoreId ?? u.Id ?? "").trim();
      const email = String(u.email ?? u.Email ?? "").trim();
      if (!procoreId || !email) continue;
      const firstName = String(u.firstName ?? u["First Name"] ?? "").trim() || null;
      const lastName = String(u.lastName ?? u["Last Name"] ?? "").trim() || null;
      const name = (firstName && lastName ? `${firstName} ${lastName}` : firstName || lastName || email) || null;
      await storage.upsertProcoreUser({
        procoreId,
        emailAddress: email,
        firstName,
        lastName,
        name,
        jobTitle: String(u.jobTitle ?? u["Job Title"] ?? "").trim() || null,
        businessPhone: String(u.businessPhone ?? u["Business Phone"] ?? "").trim() || null,
        mobilePhone: String(u.mobilePhone ?? u["Mobile Phone"] ?? "").trim() || null,
        lastSyncedAt: new Date(),
      });
      created++;
    }
    res.json({ success: true, created });
  }));

  app.get("/api/procore/change-history", requireAuth, asyncHandler(async (req, res) => {
    const result = await storage.getProcoreChangeHistory({
      entityType: req.query.entityType as string,
      changeType: req.query.changeType as string,
      limit: parseInt(req.query.limit as string) || 50,
      offset: parseInt(req.query.offset as string) || 0,
    });
    res.json(result);
  }));

  app.get("/api/procore/bid-packages", requireAuth, asyncHandler(async (req, res) => {
    const result = await storage.getProcoreBidPackages({
      search: req.query.search as string,
      limit: parseInt(req.query.limit as string) || 50,
      offset: parseInt(req.query.offset as string) || 0,
    });
    res.json(result);
  }));

  app.get("/api/procore/bids", requireAuth, asyncHandler(async (req, res) => {
    const result = await storage.getProcoreBids({
      search: req.query.search as string,
      bidPackageId: req.query.bidPackageId as string,
      bidStatus: req.query.bidStatus as string,
      limit: parseInt(req.query.limit as string) || 50,
      offset: parseInt(req.query.offset as string) || 0,
    });
    res.json(result);
  }));

  app.get("/api/procore/project-stages", requireAuth, asyncHandler(async (_req, res) => {
    const stages = await fetchProcoreProjectStages();
    res.json(stages);
  }));

  app.post("/api/procore/check-stage-change/:projectId", requireAuth, asyncHandler(async (req, res) => {
    const projectId = req.params.projectId as string;
    const localProject = await storage.getProcoreProjectByProcoreId(projectId);
    if (!localProject) return res.status(404).json({ message: "Project not found locally" });

    const freshProject = await fetchProcoreProjectDetail(projectId);
    const newStage = freshProject?.project_stage?.name || freshProject?.stage_name || freshProject?.stage || null;
    const oldStage = localProject.projectStageName || localProject.stage || null;

    const mapping = await storage.getSyncMappingByProcoreProjectId(projectId);

    if (!newStage) {
      return res.json({ message: "No stage found on Procore project", oldStage, newStage: null, mapping: mapping?.hubspotDealId || null });
    }

    if (!oldStage || newStage.trim() === oldStage.trim()) {
      return res.json({ message: "No stage change detected", oldStage, newStage, mapping: mapping?.hubspotDealId || null });
    }

    console.log(`[manual] Stage change detected for ${localProject.name}: "${oldStage}" → "${newStage}"`);

    await storage.upsertProcoreProject({
      ...localProject,
      stage: newStage,
      projectStageName: newStage,
      lastSyncedAt: new Date(),
      properties: localProject.properties as Record<string, unknown> | undefined,
    });

    let hubspotUpdate = null;
    let emailResult = null;

    if (mapping?.hubspotDealId) {
      // Map Procore stage to HubSpot stage label, then resolve to actual stage ID
      const hubspotStageLabel = mapProcoreStageToHubspot(newStage);
      if (!hubspotStageLabel) {
        console.log(`[manual] Procore stage "${newStage}" mapped to null — skipping HubSpot sync`);
      } else {
      const resolvedStage = await resolveHubspotStageId(hubspotStageLabel);

      if (!resolvedStage) {
        console.log(`[manual] Could not resolve HubSpot stage for label: ${hubspotStageLabel}`);
      } else {
        const hubspotStageId = resolvedStage.stageId;
        const hubspotStageName = resolvedStage.stageName;

        hubspotUpdate = await updateHubSpotDealStage(mapping.hubspotDealId, hubspotStageId);
        const deal = await storage.getHubspotDealByHubspotId(mapping.hubspotDealId);

        emailResult = await sendStageChangeEmail({
          hubspotDealId: mapping.hubspotDealId,
          dealName: deal?.dealName || mapping.hubspotDealName || 'Unknown Deal',
          procoreProjectId: projectId,
          procoreProjectName: localProject.name || 'Unknown Project',
          oldStage,
          newStage,
          hubspotStageName,
        });

        await storage.createAuditLog({
          action: 'manual_stage_change_processed',
          entityType: 'project_stage',
          entityId: projectId,
          source: 'manual',
          status: 'success',
          details: { projectId, projectName: localProject.name, oldStage, newStage, hubspotDealId: mapping.hubspotDealId, hubspotStageId, hubspotStageName, emailSent: emailResult?.sent },
        });
      }
      } // End hubspotStageLabel null check
    }

    res.json({
      message: "Stage change processed",
      projectName: localProject.name,
      oldStage,
      newStage,
      hubspotDealId: mapping?.hubspotDealId || null,
      hubspotUpdate,
      emailResult,
    });
  }));

  app.patch("/api/procore/projects/:projectId", requireAuth, asyncHandler(async (req, res) => {
    const projectId = req.params.projectId as string;
    const fields = req.body;
    if (!fields || Object.keys(fields).length === 0) return res.status(400).json({ message: "No fields to update" });
    const project = await storage.getProcoreProjectByProcoreId(projectId);
    if (!project) return res.status(404).json({ message: "Project not found in local DB" });
    const result = await updateProcoreProject(projectId, fields);
    await storage.upsertProcoreProject({
      procoreId: project.procoreId,
      name: result.name || project.name,
      displayName: result.display_name || project.displayName,
      projectNumber: result.project_number || project.projectNumber,
      address: result.address || project.address,
      city: result.city || project.city,
      stateCode: result.state_code || project.stateCode,
      zip: result.zip || project.zip,
      countryCode: result.country_code || project.countryCode,
      phone: result.phone || project.phone,
      active: result.active ?? project.active,
      stage: result.project_stage?.name || result.stage || project.stage,
      projectStageName: result.project_stage?.name || project.projectStageName,
      startDate: result.start_date || project.startDate,
      completionDate: result.completion_date || project.completionDate,
      projectedFinishDate: result.projected_finish_date || project.projectedFinishDate,
      estimatedValue: result.estimated_value != null ? String(result.estimated_value) : project.estimatedValue,
      totalValue: result.total_value != null ? String(result.total_value) : project.totalValue,
      storeNumber: project.storeNumber,
      deliveryMethod: result.delivery_method || project.deliveryMethod,
      workScope: project.workScope,
      companyId: project.companyId,
      companyName: project.companyName,
      properties: result,
      lastSyncedAt: new Date(),
      procoreUpdatedAt: result.updated_at ? new Date(result.updated_at) : project.procoreUpdatedAt,
    });
    await storage.createAuditLog({
      action: "procore_project_update",
      entityType: "project",
      entityId: projectId,
      source: "procore",
      status: "success",
      details: { fields: Object.keys(fields), projectName: project.name },
    });
    res.json({ success: true, project: result });
  }));

  app.patch("/api/procore/bids/:bidId", requireAuth, asyncHandler(async (req, res) => {
    const bidId = req.params.bidId as string;
    const fields = req.body;
    if (!fields || Object.keys(fields).length === 0) return res.status(400).json({ message: "No fields to update" });
    const bid = await storage.getProcoreBidByProcoreId(bidId);
    if (!bid) return res.status(404).json({ message: "Bid not found" });
    const result = await updateProcoreBid(bid.projectId!, bid.bidPackageId!, bidId, fields);
    await storage.upsertProcoreBid({
      procoreId: bid.procoreId,
      bidPackageId: bid.bidPackageId,
      bidPackageTitle: bid.bidPackageTitle,
      bidFormId: bid.bidFormId,
      bidFormTitle: bid.bidFormTitle,
      projectId: bid.projectId,
      projectName: bid.projectName,
      projectAddress: bid.projectAddress,
      vendorId: bid.vendorId,
      vendorName: bid.vendorName,
      vendorTrades: bid.vendorTrades,
      bidStatus: result.bid_status || bid.bidStatus,
      awarded: result.awarded ?? null,
      submitted: result.submitted ?? bid.submitted,
      isBidderCommitted: result.is_bidder_committed ?? bid.isBidderCommitted,
      lumpSumEnabled: bid.lumpSumEnabled,
      lumpSumAmount: result.lump_sum_amount != null ? String(result.lump_sum_amount) : bid.lumpSumAmount,
      bidderComments: result.bidder_comments || bid.bidderComments,
      dueDate: bid.dueDate,
      invitationLastSentAt: bid.invitationLastSentAt,
      bidRequesterName: bid.bidRequesterName,
      bidRequesterEmail: bid.bidRequesterEmail,
      bidRequesterCompany: bid.bidRequesterCompany,
      requireNda: bid.requireNda,
      ndaStatus: bid.ndaStatus,
      showBidInEstimating: bid.showBidInEstimating,
      companyId: bid.companyId,
      properties: result,
      procoreCreatedAt: bid.procoreCreatedAt != null ? (typeof bid.procoreCreatedAt === 'string' ? bid.procoreCreatedAt : (bid.procoreCreatedAt as Date).toISOString()) : undefined,
      procoreUpdatedAt: result.updated_at ? new Date(result.updated_at).toISOString() : (bid.procoreUpdatedAt != null ? (typeof bid.procoreUpdatedAt === 'string' ? bid.procoreUpdatedAt : (bid.procoreUpdatedAt as Date).toISOString()) : undefined),
      lastSyncedAt: new Date(),
    });
    await storage.createAuditLog({
      action: "procore_bid_update",
      entityType: "bid",
      entityId: bidId,
      source: "procore",
      status: "success",
      details: { fields: Object.keys(fields), vendorName: bid.vendorName, bidPackageTitle: bid.bidPackageTitle },
    });
    res.json({ success: true, bid: result });
  }));

  app.get("/api/procore/bids/:bidId/detail", requireAuth, asyncHandler(async (req, res) => {
    const bidId = req.params.bidId as string;
    const bid = await storage.getProcoreBidByProcoreId(bidId);
    if (!bid) return res.status(404).json({ message: "Bid not found in local DB" });
    const detail = await fetchProcoreBidDetail(bid.projectId!, bid.bidPackageId!, bidId);
    await storage.upsertProcoreBid({
      procoreId: bid.procoreId,
      bidPackageId: bid.bidPackageId,
      bidPackageTitle: bid.bidPackageTitle,
      bidFormId: bid.bidFormId,
      bidFormTitle: bid.bidFormTitle,
      projectId: bid.projectId,
      projectName: bid.projectName,
      projectAddress: bid.projectAddress,
      vendorId: bid.vendorId,
      vendorName: bid.vendorName,
      vendorTrades: bid.vendorTrades,
      bidStatus: detail.bid_status || bid.bidStatus,
      awarded: detail.awarded ?? null,
      submitted: detail.submitted ?? bid.submitted,
      isBidderCommitted: detail.is_bidder_committed ?? bid.isBidderCommitted,
      lumpSumEnabled: bid.lumpSumEnabled,
      lumpSumAmount: detail.lump_sum_amount != null ? String(detail.lump_sum_amount) : bid.lumpSumAmount,
      bidderComments: detail.bidder_comments || bid.bidderComments,
      dueDate: bid.dueDate,
      invitationLastSentAt: bid.invitationLastSentAt,
      bidRequesterName: bid.bidRequesterName,
      bidRequesterEmail: bid.bidRequesterEmail,
      bidRequesterCompany: bid.bidRequesterCompany,
      requireNda: bid.requireNda,
      ndaStatus: bid.ndaStatus,
      showBidInEstimating: bid.showBidInEstimating,
      companyId: bid.companyId,
      properties: detail,
      procoreCreatedAt: bid.procoreCreatedAt != null ? (typeof bid.procoreCreatedAt === 'string' ? bid.procoreCreatedAt : (bid.procoreCreatedAt as Date).toISOString()) : undefined,
      procoreUpdatedAt: detail.updated_at ? new Date(detail.updated_at).toISOString() : (bid.procoreUpdatedAt != null ? (typeof bid.procoreUpdatedAt === 'string' ? bid.procoreUpdatedAt : (bid.procoreUpdatedAt as Date).toISOString()) : undefined),
      lastSyncedAt: new Date(),
    });
    res.json(detail);
  }));

  app.get("/api/procore/attachments/proxy", requireAuth, asyncHandler(async (req, res) => {
    const url = req.query.url as string;
    if (!url) return res.status(400).json({ message: "url parameter required" });
    const { buffer, contentType, filename } = await proxyProcoreAttachment(url);
    res.setHeader("Content-Type", contentType || "application/octet-stream");
    if (filename) res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    res.send(buffer);
  }));

  app.get("/api/procore/bid-forms", requireAuth, asyncHandler(async (req, res) => {
    const result = await storage.getProcoreBidForms({
      search: req.query.search as string,
      bidPackageId: req.query.bidPackageId as string,
      limit: parseInt(req.query.limit as string) || 50,
      offset: parseInt(req.query.offset as string) || 0,
    });
    res.json(result);
  }));

  // ============= Procore Role Assignments =============
  app.post("/api/procore/sync-role-assignments", requireAuth, asyncHandler(async (req, res) => {
    const { projectIds } = req.body || {};
    const result = await syncProcoreRoleAssignments(projectIds);
    let emailResult = { sent: 0, skipped: 0, failed: 0 };
    if (result.newAssignments.length > 0) {
      try {
        const { sendRoleAssignmentEmails, triggerKickoffForNewPmOnPortfolio } = await import('../email-notifications');
        emailResult = await sendRoleAssignmentEmails(result.newAssignments);
        await triggerKickoffForNewPmOnPortfolio(result.newAssignments);
      } catch (emailErr: any) {
        console.error(`[procore] Email notifications failed:`, emailErr.message);
      }
    }
    res.json({ ...result, emails: emailResult });
  }));

  app.get("/api/procore/role-assignments", requireAuth, asyncHandler(async (req, res) => {
    const { search, roleName, projectId, limit, offset } = req.query;
    if (projectId) {
      const data = await storage.getProcoreRoleAssignmentsByProject(projectId as string);
      return res.json({ data, total: data.length });
    }
    const result = await storage.getProcoreRoleAssignments({
      search: search as string,
      roleName: roleName as string,
      limit: limit ? parseInt(limit as string) : 50,
      offset: offset ? parseInt(offset as string) : 0,
    });
    res.json(result);
  }));

  // ============= Procore-HubSpot Sync =============
  app.post("/api/procore-hubspot/sync", requireAuth, asyncHandler(async (_req, res) => {
    const result = await syncProcoreToHubspot();
    res.json(result);
  }));

  app.get("/api/procore-hubspot/overview", requireAuth, asyncHandler(async (_req, res) => {
    const result = await getSyncOverview();
    res.json(result);
  }));

  app.get("/api/procore-hubspot/mappings", requireAuth, asyncHandler(async (req, res) => {
    const { search } = req.query;
    if (search) {
      const result = await storage.searchSyncMappings(search as string);
      return res.json({ data: result, total: result.length });
    }
    const result = await storage.getSyncMappings();
    res.json({ data: result, total: result.length });
  }));

  app.get("/api/procore-hubspot/unmatched", requireAuth, asyncHandler(async (_req, res) => {
    const result = await getUnmatchedProjects();
    res.json(result);
  }));

  app.post("/api/procore-hubspot/manual-link", requireAuth, asyncHandler(async (req, res) => {
    const { procoreProjectId, hubspotDealId, writeProjectNumber } = req.body;
    if (!procoreProjectId || !hubspotDealId) {
      return res.status(400).json({ message: "Both procoreProjectId and hubspotDealId are required" });
    }
    const result = await createManualMapping(procoreProjectId, hubspotDealId, writeProjectNumber !== false);
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  }));

  app.delete("/api/procore-hubspot/mappings/:id", requireAuth, asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id as string);
    const success = await unlinkMapping(id);
    if (!success) return res.status(404).json({ message: "Mapping not found" });
    res.json({ success: true });
  }));

  // ============= Deal Project Number =============
  app.post("/api/deal-project-number/assign", requireAuth, asyncHandler(async (req, res) => {
    const { hubspotDealId } = req.body;
    if (!hubspotDealId) return res.status(400).json({ message: "hubspotDealId is required" });
    const result = await assignProjectNumber(hubspotDealId);
    res.json(result);
  }));

  app.get("/api/deal-project-number/registry", requireAuth, asyncHandler(async (req, res) => {
    const { search, limit, offset } = req.query;
    const result = await getProjectNumberRegistry({
      search: search as string,
      limit: limit ? parseInt(limit as string) : 50,
      offset: offset ? parseInt(offset as string) : 0,
    });
    res.json(result);
  }));

  app.get("/api/deal-project-number/config", requireAuth, asyncHandler(async (_req, res) => {
    const config = await storage.getAutomationConfig("deal_project_number");
    res.json(config?.value || { enabled: false });
  }));

  app.post("/api/deal-project-number/config", requireAuth, asyncHandler(async (req, res) => {
    await storage.upsertAutomationConfig({
      key: "deal_project_number",
      value: req.body,
      description: "Auto-assign project numbers to new HubSpot deals",
    });
    res.json({ success: true });
  }));
}
