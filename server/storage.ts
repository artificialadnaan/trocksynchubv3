import { eq, desc, and, gte, lte, sql, ilike, or } from "drizzle-orm";
import { db } from "./db";
import {
  users, type User, type InsertUser,
  syncMappings, type SyncMapping, type InsertSyncMapping,
  stageMappings, type StageMapping, type InsertStageMapping,
  webhookLogs, type WebhookLog, type InsertWebhookLog,
  auditLogs, type AuditLog, type InsertAuditLog,
  idempotencyKeys, type IdempotencyKey, type InsertIdempotencyKey,
  oauthTokens, type OAuthToken, type InsertOAuthToken,
  automationConfig, type AutomationConfig, type InsertAutomationConfig,
  contractCounters, type ContractCounter, type InsertContractCounter,
  pollJobs, type PollJob, type InsertPollJob,
  hubspotCompanies, type HubspotCompany, type InsertHubspotCompany,
  hubspotContacts, type HubspotContact, type InsertHubspotContact,
  hubspotDeals, type HubspotDeal, type InsertHubspotDeal,
  hubspotPipelines, type HubspotPipeline, type InsertHubspotPipeline,
  hubspotChangeHistory, type HubspotChangeHistory, type InsertHubspotChangeHistory,
  procoreProjects, type ProcoreProject, type InsertProcoreProject,
  procoreVendors, type ProcoreVendor, type InsertProcoreVendor,
  procoreUsers, type ProcoreUser, type InsertProcoreUser,
  procoreChangeHistory, type ProcoreChangeHistory, type InsertProcoreChangeHistory,
  procoreBidPackages, type ProcoreBidPackage, type InsertProcoreBidPackage,
  procoreBids, type ProcoreBid, type InsertProcoreBid,
  procoreBidForms, type ProcoreBidForm, type InsertProcoreBidForm,
  bidboardEstimates, type BidboardEstimate, type InsertBidboardEstimate,
  companycamProjects, type CompanycamProject, type InsertCompanycamProject,
  companycamUsers, type CompanycamUser, type InsertCompanycamUser,
  companycamPhotos, type CompanycamPhoto, type InsertCompanycamPhoto,
  companycamChangeHistory, type CompanycamChangeHistory, type InsertCompanycamChangeHistory,
  procoreRoleAssignments, type ProcoreRoleAssignment, type InsertProcoreRoleAssignment,
  emailTemplates, type EmailTemplate, type InsertEmailTemplate,
  emailSendLog, type EmailSendLog, type InsertEmailSendLog,
  bidboardSyncState, type BidboardSyncState,
  bidboardAutomationLogs, type BidboardAutomationLog,
} from "@shared/schema";
import bcrypt from "bcrypt";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  getSyncMappings(): Promise<SyncMapping[]>;
  getSyncMappingByHubspotDealId(dealId: string): Promise<SyncMapping | undefined>;
  getSyncMappingByProcoreProjectId(projectId: string): Promise<SyncMapping | undefined>;
  createSyncMapping(mapping: InsertSyncMapping): Promise<SyncMapping>;
  updateSyncMapping(id: number, data: Partial<InsertSyncMapping>): Promise<SyncMapping | undefined>;
  searchSyncMappings(query: string): Promise<SyncMapping[]>;

  getStageMappings(): Promise<StageMapping[]>;
  createStageMapping(mapping: InsertStageMapping): Promise<StageMapping>;
  updateStageMapping(id: number, data: Partial<InsertStageMapping>): Promise<StageMapping | undefined>;
  deleteStageMapping(id: number): Promise<void>;

  getWebhookLogs(filters?: { source?: string; status?: string; limit?: number; offset?: number }): Promise<{ logs: WebhookLog[]; total: number }>;
  createWebhookLog(log: InsertWebhookLog): Promise<WebhookLog>;
  updateWebhookLog(id: number, data: Partial<InsertWebhookLog>): Promise<WebhookLog | undefined>;

  getAuditLogs(filters?: { entityType?: string; status?: string; limit?: number; offset?: number; startDate?: Date; endDate?: Date }): Promise<{ logs: AuditLog[]; total: number }>;
  createAuditLog(log: InsertAuditLog): Promise<AuditLog>;

  checkIdempotencyKey(key: string): Promise<IdempotencyKey | undefined>;
  createIdempotencyKey(data: InsertIdempotencyKey): Promise<IdempotencyKey>;

  getOAuthToken(provider: string): Promise<OAuthToken | undefined>;
  upsertOAuthToken(data: InsertOAuthToken): Promise<OAuthToken>;

  getAutomationConfigs(): Promise<AutomationConfig[]>;
  getAutomationConfig(key: string): Promise<AutomationConfig | undefined>;
  upsertAutomationConfig(data: InsertAutomationConfig): Promise<AutomationConfig>;

  getContractCounter(projectId: string, counterType: string): Promise<ContractCounter | undefined>;
  incrementContractCounter(projectId: string, projectNumber: string, counterType: string): Promise<number>;

  getPollJobs(): Promise<PollJob[]>;
  upsertPollJob(data: InsertPollJob): Promise<PollJob>;
  updatePollJob(jobName: string, data: Partial<InsertPollJob>): Promise<PollJob | undefined>;

  getDashboardStats(): Promise<{
    totalSyncs: number;
    successfulSyncs: number;
    failedSyncs: number;
    pendingWebhooks: number;
    recentActivity: AuditLog[];
    syncsByDay: { date: string; count: number; success: number; failed: number }[];
  }>;

  upsertHubspotCompany(data: InsertHubspotCompany): Promise<HubspotCompany>;
  upsertHubspotContact(data: InsertHubspotContact): Promise<HubspotContact>;
  upsertHubspotDeal(data: InsertHubspotDeal): Promise<HubspotDeal>;
  upsertHubspotPipeline(data: InsertHubspotPipeline): Promise<HubspotPipeline>;
  getHubspotCompanyByHubspotId(hubspotId: string): Promise<HubspotCompany | undefined>;
  getHubspotContactByHubspotId(hubspotId: string): Promise<HubspotContact | undefined>;
  getHubspotDealByHubspotId(hubspotId: string): Promise<HubspotDeal | undefined>;
  createChangeHistory(data: InsertHubspotChangeHistory): Promise<HubspotChangeHistory>;
  purgeOldChangeHistory(daysToKeep: number): Promise<number>;
  getHubspotDataCounts(): Promise<{ companies: number; contacts: number; deals: number; pipelines: number; changeHistory: number }>;

  getHubspotCompanies(filters: { search?: string; limit?: number; offset?: number }): Promise<{ data: HubspotCompany[]; total: number }>;
  getHubspotContacts(filters: { search?: string; limit?: number; offset?: number }): Promise<{ data: HubspotContact[]; total: number }>;
  getHubspotDeals(filters: { search?: string; pipeline?: string; stage?: string; limit?: number; offset?: number }): Promise<{ data: HubspotDeal[]; total: number }>;
  getHubspotPipelines(): Promise<HubspotPipeline[]>;
  getHubspotChangeHistoryList(filters: { entityType?: string; changeType?: string; limit?: number; offset?: number }): Promise<{ data: HubspotChangeHistory[]; total: number }>;

  upsertProcoreProject(data: InsertProcoreProject): Promise<ProcoreProject>;
  getProcoreProjectByProcoreId(procoreId: string): Promise<ProcoreProject | undefined>;
  getProcoreProjects(filters: { search?: string; limit?: number; offset?: number }): Promise<{ data: ProcoreProject[]; total: number }>;

  upsertProcoreVendor(data: InsertProcoreVendor): Promise<ProcoreVendor>;
  getProcoreVendorByProcoreId(procoreId: string): Promise<ProcoreVendor | undefined>;
  getProcoreVendors(filters: { search?: string; limit?: number; offset?: number }): Promise<{ data: ProcoreVendor[]; total: number }>;

  upsertProcoreUser(data: InsertProcoreUser): Promise<ProcoreUser>;
  getProcoreUserByProcoreId(procoreId: string): Promise<ProcoreUser | undefined>;
  getProcoreUsers(filters: { search?: string; limit?: number; offset?: number }): Promise<{ data: ProcoreUser[]; total: number }>;

  createProcoreChangeHistory(data: InsertProcoreChangeHistory): Promise<ProcoreChangeHistory>;
  getProcoreChangeHistory(filters: { entityType?: string; changeType?: string; limit?: number; offset?: number }): Promise<{ data: ProcoreChangeHistory[]; total: number }>;
  getProcoreDataCounts(): Promise<{ projects: number; vendors: number; users: number; changeHistory: number; bidPackages: number; bids: number; bidForms: number }>;
  purgeProcoreChangeHistory(daysToKeep: number): Promise<number>;

  upsertProcoreBidPackage(data: InsertProcoreBidPackage): Promise<ProcoreBidPackage>;
  getProcoreBidPackages(filters: { search?: string; limit?: number; offset?: number }): Promise<{ data: ProcoreBidPackage[]; total: number }>;
  upsertProcoreBid(data: InsertProcoreBid): Promise<ProcoreBid>;
  getProcoreBidByProcoreId(procoreId: string): Promise<ProcoreBid | undefined>;
  getProcoreBids(filters: { search?: string; bidPackageId?: string; bidStatus?: string; limit?: number; offset?: number }): Promise<{ data: ProcoreBid[]; total: number }>;
  upsertProcoreBidForm(data: InsertProcoreBidForm): Promise<ProcoreBidForm>;
  getProcoreBidForms(filters: { search?: string; bidPackageId?: string; limit?: number; offset?: number }): Promise<{ data: ProcoreBidForm[]; total: number }>;

  upsertBidboardEstimate(data: InsertBidboardEstimate): Promise<BidboardEstimate>;
  getBidboardEstimates(filters: { search?: string; status?: string; matchStatus?: string; limit?: number; offset?: number }): Promise<{ data: BidboardEstimate[]; total: number }>;
  getBidboardEstimateCount(): Promise<number>;
  clearBidboardEstimates(): Promise<void>;
  getBidboardDistinctStatuses(): Promise<string[]>;
  getHubspotDealsByDealNames(names: string[]): Promise<HubspotDeal[]>;

  upsertCompanycamProject(data: InsertCompanycamProject): Promise<CompanycamProject>;
  getCompanycamProjectByCompanycamId(companycamId: string): Promise<CompanycamProject | undefined>;
  getCompanycamProjects(filters: { search?: string; status?: string; limit?: number; offset?: number }): Promise<{ data: CompanycamProject[]; total: number }>;
  upsertCompanycamUser(data: InsertCompanycamUser): Promise<CompanycamUser>;
  getCompanycamUserByCompanycamId(companycamId: string): Promise<CompanycamUser | undefined>;
  getCompanycamUsers(filters: { search?: string; role?: string; limit?: number; offset?: number }): Promise<{ data: CompanycamUser[]; total: number }>;
  upsertCompanycamPhoto(data: InsertCompanycamPhoto): Promise<CompanycamPhoto>;
  getCompanycamPhotoByCompanycamId(companycamId: string): Promise<CompanycamPhoto | undefined>;
  getCompanycamPhotos(filters: { search?: string; projectId?: string; limit?: number; offset?: number }): Promise<{ data: CompanycamPhoto[]; total: number }>;
  createCompanycamChangeHistory(data: InsertCompanycamChangeHistory): Promise<CompanycamChangeHistory>;
  getCompanycamChangeHistory(filters: { entityType?: string; changeType?: string; limit?: number; offset?: number }): Promise<{ data: CompanycamChangeHistory[]; total: number }>;
  getCompanycamDataCounts(): Promise<{ projects: number; users: number; photos: number; changeHistory: number }>;
  purgeCompanycamChangeHistory(olderThan: Date): Promise<number>;

  upsertProcoreRoleAssignment(data: InsertProcoreRoleAssignment): Promise<ProcoreRoleAssignment>;
  getProcoreRoleAssignmentsByProject(procoreProjectId: string): Promise<ProcoreRoleAssignment[]>;
  getProcoreRoleAssignments(filters: { search?: string; roleName?: string; limit?: number; offset?: number }): Promise<{ data: ProcoreRoleAssignment[]; total: number }>;
  deleteProcoreRoleAssignment(procoreProjectId: string, roleName: string, assigneeId: string): Promise<void>;

  getEmailTemplates(): Promise<EmailTemplate[]>;
  getEmailTemplate(templateKey: string): Promise<EmailTemplate | undefined>;
  updateEmailTemplate(id: number, data: Partial<InsertEmailTemplate>): Promise<EmailTemplate | undefined>;

  createEmailSendLog(data: InsertEmailSendLog): Promise<EmailSendLog>;
  checkEmailDedupeKey(dedupeKey: string): Promise<boolean>;
  getEmailSendLogs(filters: { templateKey?: string; limit?: number; offset?: number }): Promise<{ data: EmailSendLog[]; total: number }>;
  getEmailSendLogCounts(): Promise<{ total: number; sent: number; failed: number }>;

  getBidboardSyncStates(): Promise<BidboardSyncState[]>;
  getBidboardSyncState(projectId: string): Promise<BidboardSyncState | undefined>;
  upsertBidboardSyncState(data: { projectId: string; projectName?: string; currentStage?: string; metadata?: any }): Promise<BidboardSyncState>;
  getBidboardAutomationLogs(limit?: number): Promise<BidboardAutomationLog[]>;
  createBidboardAutomationLog(data: { projectId?: string; projectName?: string; action: string; status: string; details?: any; errorMessage?: string; screenshotPath?: string }): Promise<BidboardAutomationLog>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const hashedPassword = await bcrypt.hash(insertUser.password, 10);
    const [user] = await db.insert(users).values({ ...insertUser, password: hashedPassword }).returning();
    return user;
  }

  async getSyncMappings(): Promise<SyncMapping[]> {
    return db.select().from(syncMappings).orderBy(desc(syncMappings.lastSyncAt));
  }

  async getSyncMappingByHubspotDealId(dealId: string): Promise<SyncMapping | undefined> {
    const [mapping] = await db.select().from(syncMappings).where(eq(syncMappings.hubspotDealId, dealId));
    return mapping;
  }

  async getSyncMappingByProcoreProjectId(projectId: string): Promise<SyncMapping | undefined> {
    const [mapping] = await db.select().from(syncMappings).where(eq(syncMappings.procoreProjectId, projectId));
    return mapping;
  }

  async createSyncMapping(mapping: InsertSyncMapping): Promise<SyncMapping> {
    const [result] = await db.insert(syncMappings).values(mapping).returning();
    return result;
  }

  async updateSyncMapping(id: number, data: Partial<InsertSyncMapping>): Promise<SyncMapping | undefined> {
    const [result] = await db.update(syncMappings).set(data).where(eq(syncMappings.id, id)).returning();
    return result;
  }

  async searchSyncMappings(query: string): Promise<SyncMapping[]> {
    return db.select().from(syncMappings).where(
      or(
        ilike(syncMappings.hubspotDealName, `%${query}%`),
        ilike(syncMappings.procoreProjectName, `%${query}%`),
        ilike(syncMappings.procoreProjectNumber, `%${query}%`)
      )
    ).orderBy(desc(syncMappings.lastSyncAt));
  }

  async getStageMappings(): Promise<StageMapping[]> {
    return db.select().from(stageMappings).orderBy(stageMappings.sortOrder);
  }

  async createStageMapping(mapping: InsertStageMapping): Promise<StageMapping> {
    const [result] = await db.insert(stageMappings).values(mapping).returning();
    return result;
  }

  async updateStageMapping(id: number, data: Partial<InsertStageMapping>): Promise<StageMapping | undefined> {
    const [result] = await db.update(stageMappings).set(data).where(eq(stageMappings.id, id)).returning();
    return result;
  }

  async deleteStageMapping(id: number): Promise<void> {
    await db.delete(stageMappings).where(eq(stageMappings.id, id));
  }

  async getWebhookLogs(filters?: { source?: string; status?: string; limit?: number; offset?: number }): Promise<{ logs: WebhookLog[]; total: number }> {
    const conditions = [];
    if (filters?.source) conditions.push(eq(webhookLogs.source, filters.source));
    if (filters?.status) conditions.push(eq(webhookLogs.status, filters.status));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const limit = filters?.limit || 50;
    const offset = filters?.offset || 0;

    const [logs, countResult] = await Promise.all([
      db.select().from(webhookLogs).where(whereClause).orderBy(desc(webhookLogs.createdAt)).limit(limit).offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(webhookLogs).where(whereClause),
    ]);

    return { logs, total: countResult[0]?.count || 0 };
  }

  async createWebhookLog(log: InsertWebhookLog): Promise<WebhookLog> {
    const [result] = await db.insert(webhookLogs).values(log).returning();
    return result;
  }

  async updateWebhookLog(id: number, data: Partial<InsertWebhookLog>): Promise<WebhookLog | undefined> {
    const [result] = await db.update(webhookLogs).set(data).where(eq(webhookLogs.id, id)).returning();
    return result;
  }

  async getAuditLogs(filters?: { entityType?: string; status?: string; limit?: number; offset?: number; startDate?: Date; endDate?: Date }): Promise<{ logs: AuditLog[]; total: number }> {
    const conditions = [];
    if (filters?.entityType) conditions.push(eq(auditLogs.entityType, filters.entityType));
    if (filters?.status) conditions.push(eq(auditLogs.status, filters.status));
    if (filters?.startDate) conditions.push(gte(auditLogs.createdAt, filters.startDate));
    if (filters?.endDate) conditions.push(lte(auditLogs.createdAt, filters.endDate));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const limit = filters?.limit || 50;
    const offset = filters?.offset || 0;

    const [logs, countResult] = await Promise.all([
      db.select().from(auditLogs).where(whereClause).orderBy(desc(auditLogs.createdAt)).limit(limit).offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(auditLogs).where(whereClause),
    ]);

    return { logs, total: countResult[0]?.count || 0 };
  }

  async createAuditLog(log: InsertAuditLog): Promise<AuditLog> {
    const [result] = await db.insert(auditLogs).values(log).returning();
    return result;
  }

  async checkIdempotencyKey(key: string): Promise<IdempotencyKey | undefined> {
    const [result] = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key));
    return result;
  }

  async createIdempotencyKey(data: InsertIdempotencyKey): Promise<IdempotencyKey> {
    const [result] = await db.insert(idempotencyKeys).values(data).returning();
    return result;
  }

  async getOAuthToken(provider: string): Promise<OAuthToken | undefined> {
    const [token] = await db.select().from(oauthTokens).where(eq(oauthTokens.provider, provider));
    return token;
  }

  async upsertOAuthToken(data: InsertOAuthToken): Promise<OAuthToken> {
    const [result] = await db.insert(oauthTokens).values(data)
      .onConflictDoUpdate({
        target: oauthTokens.provider,
        set: { ...data, updatedAt: new Date() },
      }).returning();
    return result;
  }

  async getAutomationConfigs(): Promise<AutomationConfig[]> {
    return db.select().from(automationConfig);
  }

  async getAutomationConfig(key: string): Promise<AutomationConfig | undefined> {
    const [config] = await db.select().from(automationConfig).where(eq(automationConfig.key, key));
    return config;
  }

  async upsertAutomationConfig(data: InsertAutomationConfig): Promise<AutomationConfig> {
    const [result] = await db.insert(automationConfig).values(data)
      .onConflictDoUpdate({
        target: automationConfig.key,
        set: { ...data, updatedAt: new Date() },
      }).returning();
    return result;
  }

  async getContractCounter(projectId: string, counterType: string): Promise<ContractCounter | undefined> {
    const [counter] = await db.select().from(contractCounters)
      .where(and(eq(contractCounters.procoreProjectId, projectId), eq(contractCounters.counterType, counterType)));
    return counter;
  }

  async incrementContractCounter(projectId: string, projectNumber: string, counterType: string): Promise<number> {
    const existing = await this.getContractCounter(projectId, counterType);
    if (existing) {
      const newValue = existing.currentValue + 1;
      await db.update(contractCounters)
        .set({ currentValue: newValue, updatedAt: new Date() })
        .where(eq(contractCounters.id, existing.id));
      return newValue;
    } else {
      await db.insert(contractCounters).values({
        procoreProjectId: projectId,
        projectNumber,
        counterType,
        currentValue: 1,
      });
      return 1;
    }
  }

  async getPollJobs(): Promise<PollJob[]> {
    return db.select().from(pollJobs).orderBy(pollJobs.jobName);
  }

  async upsertPollJob(data: InsertPollJob): Promise<PollJob> {
    const [result] = await db.insert(pollJobs).values(data)
      .onConflictDoUpdate({
        target: pollJobs.jobName,
        set: { ...data, updatedAt: new Date() },
      }).returning();
    return result;
  }

  async updatePollJob(jobName: string, data: Partial<InsertPollJob>): Promise<PollJob | undefined> {
    const [result] = await db.update(pollJobs).set({ ...data, updatedAt: new Date() })
      .where(eq(pollJobs.jobName, jobName)).returning();
    return result;
  }

  async getDashboardStats() {
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [totalRes, successRes, failedRes, pendingRes, recentActivity, dailyStats] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(auditLogs).where(gte(auditLogs.createdAt, twentyFourHoursAgo)),
      db.select({ count: sql<number>`count(*)::int` }).from(auditLogs).where(and(gte(auditLogs.createdAt, twentyFourHoursAgo), eq(auditLogs.status, "success"))),
      db.select({ count: sql<number>`count(*)::int` }).from(auditLogs).where(and(gte(auditLogs.createdAt, twentyFourHoursAgo), eq(auditLogs.status, "error"))),
      db.select({ count: sql<number>`count(*)::int` }).from(webhookLogs).where(eq(webhookLogs.status, "received")),
      db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(20),
      db.select({
        date: sql<string>`to_char(${auditLogs.createdAt}, 'YYYY-MM-DD')`,
        count: sql<number>`count(*)::int`,
        success: sql<number>`count(*) filter (where ${auditLogs.status} = 'success')::int`,
        failed: sql<number>`count(*) filter (where ${auditLogs.status} = 'error')::int`,
      }).from(auditLogs).where(gte(auditLogs.createdAt, sevenDaysAgo)).groupBy(sql`to_char(${auditLogs.createdAt}, 'YYYY-MM-DD')`).orderBy(sql`to_char(${auditLogs.createdAt}, 'YYYY-MM-DD')`),
    ]);

    return {
      totalSyncs: totalRes[0]?.count || 0,
      successfulSyncs: successRes[0]?.count || 0,
      failedSyncs: failedRes[0]?.count || 0,
      pendingWebhooks: pendingRes[0]?.count || 0,
      recentActivity,
      syncsByDay: dailyStats,
    };
  }

  async upsertHubspotCompany(data: InsertHubspotCompany): Promise<HubspotCompany> {
    const [result] = await db.insert(hubspotCompanies).values(data)
      .onConflictDoUpdate({
        target: hubspotCompanies.hubspotId,
        set: { ...data, updatedAt: new Date(), lastSyncedAt: new Date() },
      }).returning();
    return result;
  }

  async upsertHubspotContact(data: InsertHubspotContact): Promise<HubspotContact> {
    const [result] = await db.insert(hubspotContacts).values(data)
      .onConflictDoUpdate({
        target: hubspotContacts.hubspotId,
        set: { ...data, updatedAt: new Date(), lastSyncedAt: new Date() },
      }).returning();
    return result;
  }

  async upsertHubspotDeal(data: InsertHubspotDeal): Promise<HubspotDeal> {
    const [result] = await db.insert(hubspotDeals).values(data)
      .onConflictDoUpdate({
        target: hubspotDeals.hubspotId,
        set: { ...data, updatedAt: new Date(), lastSyncedAt: new Date() },
      }).returning();
    return result;
  }

  async upsertHubspotPipeline(data: InsertHubspotPipeline): Promise<HubspotPipeline> {
    const [result] = await db.insert(hubspotPipelines).values(data)
      .onConflictDoUpdate({
        target: hubspotPipelines.hubspotId,
        set: { ...data, lastSyncedAt: new Date() },
      }).returning();
    return result;
  }

  async getHubspotCompanyByHubspotId(hubspotId: string): Promise<HubspotCompany | undefined> {
    const [result] = await db.select().from(hubspotCompanies).where(eq(hubspotCompanies.hubspotId, hubspotId));
    return result;
  }

  async getHubspotContactByHubspotId(hubspotId: string): Promise<HubspotContact | undefined> {
    const [result] = await db.select().from(hubspotContacts).where(eq(hubspotContacts.hubspotId, hubspotId));
    return result;
  }

  async getHubspotDealByHubspotId(hubspotId: string): Promise<HubspotDeal | undefined> {
    const [result] = await db.select().from(hubspotDeals).where(eq(hubspotDeals.hubspotId, hubspotId));
    return result;
  }

  async createChangeHistory(data: InsertHubspotChangeHistory): Promise<HubspotChangeHistory> {
    const [result] = await db.insert(hubspotChangeHistory).values(data).returning();
    return result;
  }

  async purgeOldChangeHistory(daysToKeep: number): Promise<number> {
    const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);
    const deleted = await db.delete(hubspotChangeHistory).where(lte(hubspotChangeHistory.createdAt, cutoff)).returning();
    return deleted.length;
  }

  async getHubspotDataCounts(): Promise<{ companies: number; contacts: number; deals: number; pipelines: number; changeHistory: number }> {
    const [compRes, contRes, dealRes, pipeRes, histRes] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(hubspotCompanies),
      db.select({ count: sql<number>`count(*)::int` }).from(hubspotContacts),
      db.select({ count: sql<number>`count(*)::int` }).from(hubspotDeals),
      db.select({ count: sql<number>`count(*)::int` }).from(hubspotPipelines),
      db.select({ count: sql<number>`count(*)::int` }).from(hubspotChangeHistory),
    ]);
    return {
      companies: compRes[0]?.count || 0,
      contacts: contRes[0]?.count || 0,
      deals: dealRes[0]?.count || 0,
      pipelines: pipeRes[0]?.count || 0,
      changeHistory: histRes[0]?.count || 0,
    };
  }

  async getHubspotCompanies(filters: { search?: string; limit?: number; offset?: number }): Promise<{ data: HubspotCompany[]; total: number }> {
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    const conditions = [];
    if (filters.search) {
      conditions.push(or(
        ilike(hubspotCompanies.name, `%${filters.search}%`),
        ilike(hubspotCompanies.domain, `%${filters.search}%`),
        ilike(hubspotCompanies.hubspotId, `%${filters.search}%`)
      ));
    }
    const where = conditions.length ? and(...conditions) : undefined;
    const [data, countRes] = await Promise.all([
      where
        ? db.select().from(hubspotCompanies).where(where).orderBy(desc(hubspotCompanies.updatedAt)).limit(limit).offset(offset)
        : db.select().from(hubspotCompanies).orderBy(desc(hubspotCompanies.updatedAt)).limit(limit).offset(offset),
      where
        ? db.select({ count: sql<number>`count(*)::int` }).from(hubspotCompanies).where(where)
        : db.select({ count: sql<number>`count(*)::int` }).from(hubspotCompanies),
    ]);
    return { data, total: countRes[0]?.count || 0 };
  }

  async getHubspotContacts(filters: { search?: string; limit?: number; offset?: number }): Promise<{ data: HubspotContact[]; total: number }> {
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    const conditions = [];
    if (filters.search) {
      const words = filters.search.trim().split(/\s+/);
      const wordConditions = words.map(word => or(
        ilike(hubspotContacts.firstName, `%${word}%`),
        ilike(hubspotContacts.lastName, `%${word}%`),
        ilike(hubspotContacts.email, `%${word}%`),
        ilike(hubspotContacts.company, `%${word}%`),
        ilike(hubspotContacts.ownerName, `%${word}%`),
        ilike(hubspotContacts.associatedCompanyName, `%${word}%`),
        ilike(hubspotContacts.hubspotId, `%${word}%`)
      ));
      conditions.push(and(...wordConditions));
    }
    const where = conditions.length ? and(...conditions) : undefined;
    const [data, countRes] = await Promise.all([
      where
        ? db.select().from(hubspotContacts).where(where).orderBy(desc(hubspotContacts.updatedAt)).limit(limit).offset(offset)
        : db.select().from(hubspotContacts).orderBy(desc(hubspotContacts.updatedAt)).limit(limit).offset(offset),
      where
        ? db.select({ count: sql<number>`count(*)::int` }).from(hubspotContacts).where(where)
        : db.select({ count: sql<number>`count(*)::int` }).from(hubspotContacts),
    ]);
    return { data, total: countRes[0]?.count || 0 };
  }

  async getHubspotDeals(filters: { search?: string; pipeline?: string; stage?: string; limit?: number; offset?: number }): Promise<{ data: HubspotDeal[]; total: number }> {
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    const conditions = [];
    if (filters.search) {
      const words = filters.search.trim().split(/\s+/);
      const wordConditions = words.map(word => or(
        ilike(hubspotDeals.dealName, `%${word}%`),
        ilike(hubspotDeals.hubspotId, `%${word}%`),
        ilike(hubspotDeals.ownerName, `%${word}%`),
        ilike(hubspotDeals.associatedCompanyName, `%${word}%`)
      ));
      conditions.push(and(...wordConditions));
    }
    if (filters.pipeline) conditions.push(eq(hubspotDeals.pipeline, filters.pipeline));
    if (filters.stage) conditions.push(eq(hubspotDeals.dealStage, filters.stage));
    const where = conditions.length ? and(...conditions) : undefined;
    const [data, countRes] = await Promise.all([
      where
        ? db.select().from(hubspotDeals).where(where).orderBy(desc(hubspotDeals.updatedAt)).limit(limit).offset(offset)
        : db.select().from(hubspotDeals).orderBy(desc(hubspotDeals.updatedAt)).limit(limit).offset(offset),
      where
        ? db.select({ count: sql<number>`count(*)::int` }).from(hubspotDeals).where(where)
        : db.select({ count: sql<number>`count(*)::int` }).from(hubspotDeals),
    ]);
    return { data, total: countRes[0]?.count || 0 };
  }

  async getHubspotPipelines(): Promise<HubspotPipeline[]> {
    return db.select().from(hubspotPipelines).orderBy(hubspotPipelines.displayOrder);
  }

  async getHubspotChangeHistoryList(filters: { entityType?: string; changeType?: string; limit?: number; offset?: number }): Promise<{ data: HubspotChangeHistory[]; total: number }> {
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    const conditions = [];
    if (filters.entityType) conditions.push(eq(hubspotChangeHistory.entityType, filters.entityType));
    if (filters.changeType) conditions.push(eq(hubspotChangeHistory.changeType, filters.changeType));
    const where = conditions.length ? and(...conditions) : undefined;
    const [data, countRes] = await Promise.all([
      where
        ? db.select().from(hubspotChangeHistory).where(where).orderBy(desc(hubspotChangeHistory.createdAt)).limit(limit).offset(offset)
        : db.select().from(hubspotChangeHistory).orderBy(desc(hubspotChangeHistory.createdAt)).limit(limit).offset(offset),
      where
        ? db.select({ count: sql<number>`count(*)::int` }).from(hubspotChangeHistory).where(where)
        : db.select({ count: sql<number>`count(*)::int` }).from(hubspotChangeHistory),
    ]);
    return { data, total: countRes[0]?.count || 0 };
  }

  async upsertProcoreProject(data: InsertProcoreProject): Promise<ProcoreProject> {
    const [result] = await db.insert(procoreProjects).values(data)
      .onConflictDoUpdate({
        target: procoreProjects.procoreId,
        set: { ...data, updatedAt: new Date(), lastSyncedAt: new Date() },
      }).returning();
    return result;
  }

  async getProcoreProjectByProcoreId(procoreId: string): Promise<ProcoreProject | undefined> {
    const [result] = await db.select().from(procoreProjects).where(eq(procoreProjects.procoreId, procoreId));
    return result;
  }

  async getProcoreProjects(filters: { search?: string; limit?: number; offset?: number }): Promise<{ data: ProcoreProject[]; total: number }> {
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    const conditions = [];
    if (filters.search) {
      const words = filters.search.trim().split(/\s+/);
      const wordConditions = words.map(word => or(
        ilike(procoreProjects.name, `%${word}%`),
        ilike(procoreProjects.projectNumber, `%${word}%`),
        ilike(procoreProjects.city, `%${word}%`),
        ilike(procoreProjects.stateCode, `%${word}%`),
        ilike(procoreProjects.stage, `%${word}%`),
        ilike(procoreProjects.companyName, `%${word}%`),
        ilike(procoreProjects.procoreId, `%${word}%`)
      ));
      conditions.push(and(...wordConditions));
    }
    const where = conditions.length ? and(...conditions) : undefined;
    const [data, countRes] = await Promise.all([
      where
        ? db.select().from(procoreProjects).where(where).orderBy(desc(procoreProjects.updatedAt)).limit(limit).offset(offset)
        : db.select().from(procoreProjects).orderBy(desc(procoreProjects.updatedAt)).limit(limit).offset(offset),
      where
        ? db.select({ count: sql<number>`count(*)::int` }).from(procoreProjects).where(where)
        : db.select({ count: sql<number>`count(*)::int` }).from(procoreProjects),
    ]);
    return { data, total: countRes[0]?.count || 0 };
  }

  async upsertProcoreVendor(data: InsertProcoreVendor): Promise<ProcoreVendor> {
    const [result] = await db.insert(procoreVendors).values(data)
      .onConflictDoUpdate({
        target: procoreVendors.procoreId,
        set: { ...data, updatedAt: new Date(), lastSyncedAt: new Date() },
      }).returning();
    return result;
  }

  async getProcoreVendorByProcoreId(procoreId: string): Promise<ProcoreVendor | undefined> {
    const [result] = await db.select().from(procoreVendors).where(eq(procoreVendors.procoreId, procoreId));
    return result;
  }

  async getProcoreVendors(filters: { search?: string; limit?: number; offset?: number }): Promise<{ data: ProcoreVendor[]; total: number }> {
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    const conditions = [];
    if (filters.search) {
      const words = filters.search.trim().split(/\s+/);
      const wordConditions = words.map(word => or(
        ilike(procoreVendors.name, `%${word}%`),
        ilike(procoreVendors.tradeName, `%${word}%`),
        ilike(procoreVendors.emailAddress, `%${word}%`),
        ilike(procoreVendors.legalName, `%${word}%`),
        ilike(procoreVendors.city, `%${word}%`),
        ilike(procoreVendors.stateCode, `%${word}%`),
        ilike(procoreVendors.procoreId, `%${word}%`)
      ));
      conditions.push(and(...wordConditions));
    }
    const where = conditions.length ? and(...conditions) : undefined;
    const [data, countRes] = await Promise.all([
      where
        ? db.select().from(procoreVendors).where(where).orderBy(desc(procoreVendors.updatedAt)).limit(limit).offset(offset)
        : db.select().from(procoreVendors).orderBy(desc(procoreVendors.updatedAt)).limit(limit).offset(offset),
      where
        ? db.select({ count: sql<number>`count(*)::int` }).from(procoreVendors).where(where)
        : db.select({ count: sql<number>`count(*)::int` }).from(procoreVendors),
    ]);
    return { data, total: countRes[0]?.count || 0 };
  }

  async upsertProcoreUser(data: InsertProcoreUser): Promise<ProcoreUser> {
    const [result] = await db.insert(procoreUsers).values(data)
      .onConflictDoUpdate({
        target: procoreUsers.procoreId,
        set: { ...data, updatedAt: new Date(), lastSyncedAt: new Date() },
      }).returning();
    return result;
  }

  async getProcoreUserByProcoreId(procoreId: string): Promise<ProcoreUser | undefined> {
    const [result] = await db.select().from(procoreUsers).where(eq(procoreUsers.procoreId, procoreId));
    return result;
  }

  async getProcoreUsers(filters: { search?: string; limit?: number; offset?: number }): Promise<{ data: ProcoreUser[]; total: number }> {
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    const conditions = [];
    if (filters.search) {
      const words = filters.search.trim().split(/\s+/);
      const wordConditions = words.map(word => or(
        ilike(procoreUsers.name, `%${word}%`),
        ilike(procoreUsers.firstName, `%${word}%`),
        ilike(procoreUsers.lastName, `%${word}%`),
        ilike(procoreUsers.emailAddress, `%${word}%`),
        ilike(procoreUsers.jobTitle, `%${word}%`),
        ilike(procoreUsers.vendorName, `%${word}%`),
        ilike(procoreUsers.procoreId, `%${word}%`)
      ));
      conditions.push(and(...wordConditions));
    }
    const where = conditions.length ? and(...conditions) : undefined;
    const [data, countRes] = await Promise.all([
      where
        ? db.select().from(procoreUsers).where(where).orderBy(desc(procoreUsers.updatedAt)).limit(limit).offset(offset)
        : db.select().from(procoreUsers).orderBy(desc(procoreUsers.updatedAt)).limit(limit).offset(offset),
      where
        ? db.select({ count: sql<number>`count(*)::int` }).from(procoreUsers).where(where)
        : db.select({ count: sql<number>`count(*)::int` }).from(procoreUsers),
    ]);
    return { data, total: countRes[0]?.count || 0 };
  }

  async createProcoreChangeHistory(data: InsertProcoreChangeHistory): Promise<ProcoreChangeHistory> {
    const [result] = await db.insert(procoreChangeHistory).values(data).returning();
    return result;
  }

  async getProcoreChangeHistory(filters: { entityType?: string; changeType?: string; limit?: number; offset?: number }): Promise<{ data: ProcoreChangeHistory[]; total: number }> {
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    const conditions = [];
    if (filters.entityType) conditions.push(eq(procoreChangeHistory.entityType, filters.entityType));
    if (filters.changeType) conditions.push(eq(procoreChangeHistory.changeType, filters.changeType));
    const where = conditions.length ? and(...conditions) : undefined;
    const [data, countRes] = await Promise.all([
      where
        ? db.select().from(procoreChangeHistory).where(where).orderBy(desc(procoreChangeHistory.createdAt)).limit(limit).offset(offset)
        : db.select().from(procoreChangeHistory).orderBy(desc(procoreChangeHistory.createdAt)).limit(limit).offset(offset),
      where
        ? db.select({ count: sql<number>`count(*)::int` }).from(procoreChangeHistory).where(where)
        : db.select({ count: sql<number>`count(*)::int` }).from(procoreChangeHistory),
    ]);
    return { data, total: countRes[0]?.count || 0 };
  }

  async getProcoreDataCounts(): Promise<{ projects: number; vendors: number; users: number; changeHistory: number; bidPackages: number; bids: number; bidForms: number }> {
    const [projRes, vendRes, userRes, histRes, bpRes, bidRes, bfRes] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(procoreProjects),
      db.select({ count: sql<number>`count(*)::int` }).from(procoreVendors),
      db.select({ count: sql<number>`count(*)::int` }).from(procoreUsers),
      db.select({ count: sql<number>`count(*)::int` }).from(procoreChangeHistory),
      db.select({ count: sql<number>`count(*)::int` }).from(procoreBidPackages),
      db.select({ count: sql<number>`count(*)::int` }).from(procoreBids),
      db.select({ count: sql<number>`count(*)::int` }).from(procoreBidForms),
    ]);
    return {
      projects: projRes[0]?.count || 0,
      vendors: vendRes[0]?.count || 0,
      users: userRes[0]?.count || 0,
      changeHistory: histRes[0]?.count || 0,
      bidPackages: bpRes[0]?.count || 0,
      bids: bidRes[0]?.count || 0,
      bidForms: bfRes[0]?.count || 0,
    };
  }

  async purgeProcoreChangeHistory(daysToKeep: number): Promise<number> {
    const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);
    const deleted = await db.delete(procoreChangeHistory).where(lte(procoreChangeHistory.createdAt, cutoff)).returning();
    return deleted.length;
  }

  async upsertProcoreBidPackage(data: InsertProcoreBidPackage): Promise<ProcoreBidPackage> {
    const [result] = await db.insert(procoreBidPackages).values(data)
      .onConflictDoUpdate({
        target: procoreBidPackages.procoreId,
        set: { ...data, updatedAt: new Date(), lastSyncedAt: new Date() },
      }).returning();
    return result;
  }

  async getProcoreBidPackages(filters: { search?: string; limit?: number; offset?: number }): Promise<{ data: ProcoreBidPackage[]; total: number }> {
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    const conditions = [];
    if (filters.search) {
      const words = filters.search.trim().split(/\s+/);
      const wordConditions = words.map(word => or(
        ilike(procoreBidPackages.title, `%${word}%`),
        ilike(procoreBidPackages.projectName, `%${word}%`),
        ilike(procoreBidPackages.projectLocation, `%${word}%`),
        ilike(procoreBidPackages.procoreId, `%${word}%`)
      ));
      conditions.push(and(...wordConditions));
    }
    const where = conditions.length ? and(...conditions) : undefined;
    const [data, countRes] = await Promise.all([
      where
        ? db.select().from(procoreBidPackages).where(where).orderBy(desc(procoreBidPackages.updatedAt)).limit(limit).offset(offset)
        : db.select().from(procoreBidPackages).orderBy(desc(procoreBidPackages.updatedAt)).limit(limit).offset(offset),
      where
        ? db.select({ count: sql<number>`count(*)::int` }).from(procoreBidPackages).where(where)
        : db.select({ count: sql<number>`count(*)::int` }).from(procoreBidPackages),
    ]);
    return { data, total: countRes[0]?.count || 0 };
  }

  async upsertProcoreBid(data: InsertProcoreBid): Promise<ProcoreBid> {
    const [result] = await db.insert(procoreBids).values(data)
      .onConflictDoUpdate({
        target: procoreBids.procoreId,
        set: { ...data, updatedAt: new Date(), lastSyncedAt: new Date() },
      }).returning();
    return result;
  }

  async getProcoreBidByProcoreId(procoreId: string): Promise<ProcoreBid | undefined> {
    const [result] = await db.select().from(procoreBids).where(eq(procoreBids.procoreId, procoreId));
    return result;
  }

  async getProcoreBids(filters: { search?: string; bidPackageId?: string; bidStatus?: string; limit?: number; offset?: number }): Promise<{ data: ProcoreBid[]; total: number }> {
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    const conditions = [];
    if (filters.bidPackageId) conditions.push(eq(procoreBids.bidPackageId, filters.bidPackageId));
    if (filters.bidStatus) conditions.push(eq(procoreBids.bidStatus, filters.bidStatus));
    if (filters.search) {
      const words = filters.search.trim().split(/\s+/);
      const wordConditions = words.map(word => or(
        ilike(procoreBids.vendorName, `%${word}%`),
        ilike(procoreBids.bidPackageTitle, `%${word}%`),
        ilike(procoreBids.bidFormTitle, `%${word}%`),
        ilike(procoreBids.projectName, `%${word}%`),
        ilike(procoreBids.bidStatus, `%${word}%`),
        ilike(procoreBids.procoreId, `%${word}%`)
      ));
      conditions.push(and(...wordConditions));
    }
    const where = conditions.length ? and(...conditions) : undefined;
    const [data, countRes] = await Promise.all([
      where
        ? db.select().from(procoreBids).where(where).orderBy(desc(procoreBids.updatedAt)).limit(limit).offset(offset)
        : db.select().from(procoreBids).orderBy(desc(procoreBids.updatedAt)).limit(limit).offset(offset),
      where
        ? db.select({ count: sql<number>`count(*)::int` }).from(procoreBids).where(where)
        : db.select({ count: sql<number>`count(*)::int` }).from(procoreBids),
    ]);
    return { data, total: countRes[0]?.count || 0 };
  }

  async upsertProcoreBidForm(data: InsertProcoreBidForm): Promise<ProcoreBidForm> {
    const [result] = await db.insert(procoreBidForms).values(data)
      .onConflictDoUpdate({
        target: procoreBidForms.procoreId,
        set: { ...data, updatedAt: new Date(), lastSyncedAt: new Date() },
      }).returning();
    return result;
  }

  async getProcoreBidForms(filters: { search?: string; bidPackageId?: string; limit?: number; offset?: number }): Promise<{ data: ProcoreBidForm[]; total: number }> {
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    const conditions = [];
    if (filters.bidPackageId) conditions.push(eq(procoreBidForms.bidPackageId, filters.bidPackageId));
    if (filters.search) {
      const words = filters.search.trim().split(/\s+/);
      const wordConditions = words.map(word => or(
        ilike(procoreBidForms.title, `%${word}%`),
        ilike(procoreBidForms.proposalName, `%${word}%`),
        ilike(procoreBidForms.procoreId, `%${word}%`)
      ));
      conditions.push(and(...wordConditions));
    }
    const where = conditions.length ? and(...conditions) : undefined;
    const [data, countRes] = await Promise.all([
      where
        ? db.select().from(procoreBidForms).where(where).orderBy(desc(procoreBidForms.updatedAt)).limit(limit).offset(offset)
        : db.select().from(procoreBidForms).orderBy(desc(procoreBidForms.updatedAt)).limit(limit).offset(offset),
      where
        ? db.select({ count: sql<number>`count(*)::int` }).from(procoreBidForms).where(where)
        : db.select({ count: sql<number>`count(*)::int` }).from(procoreBidForms),
    ]);
    return { data, total: countRes[0]?.count || 0 };
  }

  async upsertBidboardEstimate(data: InsertBidboardEstimate): Promise<BidboardEstimate> {
    const [result] = await db.insert(bidboardEstimates).values(data).returning();
    return result;
  }

  async getBidboardEstimates(filters: { search?: string; status?: string; matchStatus?: string; limit?: number; offset?: number }): Promise<{ data: BidboardEstimate[]; total: number }> {
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    const conditions: any[] = [];
    if (filters.search) {
      const words = filters.search.trim().split(/\s+/);
      const wordConditions = words.map(word => or(
        ilike(bidboardEstimates.name, `%${word}%`),
        ilike(bidboardEstimates.estimator, `%${word}%`),
        ilike(bidboardEstimates.customerName, `%${word}%`),
        ilike(bidboardEstimates.projectNumber, `%${word}%`)
      ));
      conditions.push(and(...wordConditions));
    }
    if (filters.status) conditions.push(eq(bidboardEstimates.status, filters.status));
    if (filters.matchStatus) conditions.push(eq(bidboardEstimates.matchStatus, filters.matchStatus));
    const where = conditions.length ? and(...conditions) : undefined;
    const [data, countRes] = await Promise.all([
      where
        ? db.select().from(bidboardEstimates).where(where).orderBy(desc(bidboardEstimates.updatedAt)).limit(limit).offset(offset)
        : db.select().from(bidboardEstimates).orderBy(desc(bidboardEstimates.updatedAt)).limit(limit).offset(offset),
      where
        ? db.select({ count: sql<number>`count(*)::int` }).from(bidboardEstimates).where(where)
        : db.select({ count: sql<number>`count(*)::int` }).from(bidboardEstimates),
    ]);
    return { data, total: countRes[0]?.count || 0 };
  }

  async getBidboardEstimateCount(): Promise<number> {
    const [res] = await db.select({ count: sql<number>`count(*)::int` }).from(bidboardEstimates);
    return res?.count || 0;
  }

  async clearBidboardEstimates(): Promise<void> {
    await db.delete(bidboardEstimates);
  }

  async getBidboardDistinctStatuses(): Promise<string[]> {
    const rows = await db.selectDistinct({ status: bidboardEstimates.status }).from(bidboardEstimates).where(sql`${bidboardEstimates.status} IS NOT NULL`);
    return rows.map(r => r.status).filter(Boolean) as string[];
  }

  async getHubspotDealsByDealNames(names: string[]): Promise<HubspotDeal[]> {
    if (!names.length) return [];
    const lowerNames = names.map(n => n.trim().toLowerCase());
    const results = await db.select().from(hubspotDeals).where(
      sql`LOWER(TRIM(${hubspotDeals.dealName})) IN (${sql.join(lowerNames.map(n => sql`${n}`), sql`, `)})`
    );
    return results;
  }

  async upsertCompanycamProject(data: InsertCompanycamProject): Promise<CompanycamProject> {
    const [result] = await db.insert(companycamProjects).values(data)
      .onConflictDoUpdate({
        target: companycamProjects.companycamId,
        set: { ...data, updatedAt: new Date(), lastSyncedAt: new Date() },
      }).returning();
    return result;
  }

  async getCompanycamProjectByCompanycamId(companycamId: string): Promise<CompanycamProject | undefined> {
    const [result] = await db.select().from(companycamProjects).where(eq(companycamProjects.companycamId, companycamId));
    return result;
  }

  async getCompanycamProjects(filters: { search?: string; status?: string; limit?: number; offset?: number }): Promise<{ data: CompanycamProject[]; total: number }> {
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    const conditions: any[] = [];
    if (filters.status) conditions.push(eq(companycamProjects.status, filters.status));
    if (filters.search) {
      const words = filters.search.trim().split(/\s+/);
      const wordConditions = words.map(word => or(
        ilike(companycamProjects.name, `%${word}%`),
        ilike(companycamProjects.city, `%${word}%`),
        ilike(companycamProjects.state, `%${word}%`),
        ilike(companycamProjects.companycamId, `%${word}%`)
      ));
      conditions.push(and(...wordConditions));
    }
    const where = conditions.length ? and(...conditions) : undefined;
    const [data, countRes] = await Promise.all([
      where
        ? db.select().from(companycamProjects).where(where).orderBy(desc(companycamProjects.updatedAt)).limit(limit).offset(offset)
        : db.select().from(companycamProjects).orderBy(desc(companycamProjects.updatedAt)).limit(limit).offset(offset),
      where
        ? db.select({ count: sql<number>`count(*)::int` }).from(companycamProjects).where(where)
        : db.select({ count: sql<number>`count(*)::int` }).from(companycamProjects),
    ]);
    return { data, total: countRes[0]?.count || 0 };
  }

  async upsertCompanycamUser(data: InsertCompanycamUser): Promise<CompanycamUser> {
    const [result] = await db.insert(companycamUsers).values(data)
      .onConflictDoUpdate({
        target: companycamUsers.companycamId,
        set: { ...data, updatedAt: new Date(), lastSyncedAt: new Date() },
      }).returning();
    return result;
  }

  async getCompanycamUserByCompanycamId(companycamId: string): Promise<CompanycamUser | undefined> {
    const [result] = await db.select().from(companycamUsers).where(eq(companycamUsers.companycamId, companycamId));
    return result;
  }

  async getCompanycamUsers(filters: { search?: string; role?: string; limit?: number; offset?: number }): Promise<{ data: CompanycamUser[]; total: number }> {
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    const conditions: any[] = [];
    if (filters.role) conditions.push(eq(companycamUsers.userRole, filters.role));
    if (filters.search) {
      const words = filters.search.trim().split(/\s+/);
      const wordConditions = words.map(word => or(
        ilike(companycamUsers.firstName, `%${word}%`),
        ilike(companycamUsers.lastName, `%${word}%`),
        ilike(companycamUsers.email, `%${word}%`),
        ilike(companycamUsers.companycamId, `%${word}%`)
      ));
      conditions.push(and(...wordConditions));
    }
    const where = conditions.length ? and(...conditions) : undefined;
    const [data, countRes] = await Promise.all([
      where
        ? db.select().from(companycamUsers).where(where).orderBy(desc(companycamUsers.updatedAt)).limit(limit).offset(offset)
        : db.select().from(companycamUsers).orderBy(desc(companycamUsers.updatedAt)).limit(limit).offset(offset),
      where
        ? db.select({ count: sql<number>`count(*)::int` }).from(companycamUsers).where(where)
        : db.select({ count: sql<number>`count(*)::int` }).from(companycamUsers),
    ]);
    return { data, total: countRes[0]?.count || 0 };
  }

  async upsertCompanycamPhoto(data: InsertCompanycamPhoto): Promise<CompanycamPhoto> {
    const [result] = await db.insert(companycamPhotos).values(data)
      .onConflictDoUpdate({
        target: companycamPhotos.companycamId,
        set: { ...data, updatedAt: new Date(), lastSyncedAt: new Date() },
      }).returning();
    return result;
  }

  async getCompanycamPhotoByCompanycamId(companycamId: string): Promise<CompanycamPhoto | undefined> {
    const [result] = await db.select().from(companycamPhotos).where(eq(companycamPhotos.companycamId, companycamId));
    return result;
  }

  async getCompanycamPhotos(filters: { search?: string; projectId?: string; limit?: number; offset?: number }): Promise<{ data: CompanycamPhoto[]; total: number }> {
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    const conditions: any[] = [];
    if (filters.projectId) conditions.push(eq(companycamPhotos.projectId, filters.projectId));
    if (filters.search) {
      const words = filters.search.trim().split(/\s+/);
      const wordConditions = words.map(word => or(
        ilike(companycamPhotos.projectName, `%${word}%`),
        ilike(companycamPhotos.creatorName, `%${word}%`),
        ilike(companycamPhotos.description, `%${word}%`),
        ilike(companycamPhotos.companycamId, `%${word}%`)
      ));
      conditions.push(and(...wordConditions));
    }
    const where = conditions.length ? and(...conditions) : undefined;
    const [data, countRes] = await Promise.all([
      where
        ? db.select().from(companycamPhotos).where(where).orderBy(desc(companycamPhotos.updatedAt)).limit(limit).offset(offset)
        : db.select().from(companycamPhotos).orderBy(desc(companycamPhotos.updatedAt)).limit(limit).offset(offset),
      where
        ? db.select({ count: sql<number>`count(*)::int` }).from(companycamPhotos).where(where)
        : db.select({ count: sql<number>`count(*)::int` }).from(companycamPhotos),
    ]);
    return { data, total: countRes[0]?.count || 0 };
  }

  async createCompanycamChangeHistory(data: InsertCompanycamChangeHistory): Promise<CompanycamChangeHistory> {
    const [result] = await db.insert(companycamChangeHistory).values(data).returning();
    return result;
  }

  async getCompanycamChangeHistory(filters: { entityType?: string; changeType?: string; limit?: number; offset?: number }): Promise<{ data: CompanycamChangeHistory[]; total: number }> {
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    const conditions: any[] = [];
    if (filters.entityType) conditions.push(eq(companycamChangeHistory.entityType, filters.entityType));
    if (filters.changeType) conditions.push(eq(companycamChangeHistory.changeType, filters.changeType));
    const where = conditions.length ? and(...conditions) : undefined;
    const [data, countRes] = await Promise.all([
      where
        ? db.select().from(companycamChangeHistory).where(where).orderBy(desc(companycamChangeHistory.createdAt)).limit(limit).offset(offset)
        : db.select().from(companycamChangeHistory).orderBy(desc(companycamChangeHistory.createdAt)).limit(limit).offset(offset),
      where
        ? db.select({ count: sql<number>`count(*)::int` }).from(companycamChangeHistory).where(where)
        : db.select({ count: sql<number>`count(*)::int` }).from(companycamChangeHistory),
    ]);
    return { data, total: countRes[0]?.count || 0 };
  }

  async getCompanycamDataCounts(): Promise<{ projects: number; users: number; photos: number; changeHistory: number }> {
    const [projRes, userRes, photoRes, histRes] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(companycamProjects),
      db.select({ count: sql<number>`count(*)::int` }).from(companycamUsers),
      db.select({ count: sql<number>`count(*)::int` }).from(companycamPhotos),
      db.select({ count: sql<number>`count(*)::int` }).from(companycamChangeHistory),
    ]);
    return {
      projects: projRes[0]?.count || 0,
      users: userRes[0]?.count || 0,
      photos: photoRes[0]?.count || 0,
      changeHistory: histRes[0]?.count || 0,
    };
  }

  async purgeCompanycamChangeHistory(olderThan: Date): Promise<number> {
    const deleted = await db.delete(companycamChangeHistory).where(lte(companycamChangeHistory.createdAt, olderThan)).returning();
    return deleted.length;
  }

  async upsertProcoreRoleAssignment(data: InsertProcoreRoleAssignment): Promise<ProcoreRoleAssignment> {
    const [result] = await db
      .insert(procoreRoleAssignments)
      .values(data)
      .onConflictDoUpdate({
        target: [procoreRoleAssignments.procoreProjectId, procoreRoleAssignments.roleName, procoreRoleAssignments.assigneeId],
        set: {
          ...data,
          updatedAt: new Date(),
          lastSyncedAt: new Date(),
        },
      })
      .returning();
    return result;
  }

  async getProcoreRoleAssignmentsByProject(procoreProjectId: string): Promise<ProcoreRoleAssignment[]> {
    return db.select().from(procoreRoleAssignments).where(eq(procoreRoleAssignments.procoreProjectId, procoreProjectId));
  }

  async getProcoreRoleAssignments(filters: { search?: string; roleName?: string; limit?: number; offset?: number }): Promise<{ data: ProcoreRoleAssignment[]; total: number }> {
    const conditions: any[] = [];
    if (filters.search) {
      conditions.push(or(
        ilike(procoreRoleAssignments.projectName, `%${filters.search}%`),
        ilike(procoreRoleAssignments.assigneeName, `%${filters.search}%`),
        ilike(procoreRoleAssignments.assigneeEmail, `%${filters.search}%`),
      ));
    }
    if (filters.roleName) {
      conditions.push(eq(procoreRoleAssignments.roleName, filters.roleName));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const [countResult] = await db.select({ count: sql<number>`count(*)::int` }).from(procoreRoleAssignments).where(where);
    const data = await db.select().from(procoreRoleAssignments).where(where).orderBy(desc(procoreRoleAssignments.createdAt)).limit(filters.limit || 50).offset(filters.offset || 0);
    return { data, total: countResult?.count || 0 };
  }

  async deleteProcoreRoleAssignment(procoreProjectId: string, roleName: string, assigneeId: string): Promise<void> {
    await db.delete(procoreRoleAssignments).where(and(
      eq(procoreRoleAssignments.procoreProjectId, procoreProjectId),
      eq(procoreRoleAssignments.roleName, roleName),
      eq(procoreRoleAssignments.assigneeId, assigneeId),
    ));
  }

  async getEmailTemplates(): Promise<EmailTemplate[]> {
    return db.select().from(emailTemplates).orderBy(emailTemplates.name);
  }

  async getEmailTemplate(templateKey: string): Promise<EmailTemplate | undefined> {
    const [result] = await db.select().from(emailTemplates).where(eq(emailTemplates.templateKey, templateKey));
    return result;
  }

  async updateEmailTemplate(id: number, data: Partial<InsertEmailTemplate>): Promise<EmailTemplate | undefined> {
    const [result] = await db.update(emailTemplates).set({ ...data, updatedAt: new Date() }).where(eq(emailTemplates.id, id)).returning();
    return result;
  }

  async createEmailSendLog(data: InsertEmailSendLog): Promise<EmailSendLog> {
    const [result] = await db.insert(emailSendLog).values(data).returning();
    return result;
  }

  async checkEmailDedupeKey(dedupeKey: string): Promise<boolean> {
    const [result] = await db.select({ count: sql<number>`count(*)::int` }).from(emailSendLog).where(eq(emailSendLog.dedupeKey, dedupeKey));
    return (result?.count || 0) > 0;
  }

  async getEmailSendLogs(filters: { templateKey?: string; limit?: number; offset?: number }): Promise<{ data: EmailSendLog[]; total: number }> {
    const conditions: any[] = [];
    if (filters.templateKey) {
      conditions.push(eq(emailSendLog.templateKey, filters.templateKey));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const [countResult] = await db.select({ count: sql<number>`count(*)::int` }).from(emailSendLog).where(where);
    const data = await db.select().from(emailSendLog).where(where).orderBy(desc(emailSendLog.sentAt)).limit(filters.limit || 50).offset(filters.offset || 0);
    return { data, total: countResult?.count || 0 };
  }

  async getEmailSendLogCounts(): Promise<{ total: number; sent: number; failed: number }> {
    const [totalRes] = await db.select({ count: sql<number>`count(*)::int` }).from(emailSendLog);
    const [sentRes] = await db.select({ count: sql<number>`count(*)::int` }).from(emailSendLog).where(eq(emailSendLog.status, "sent"));
    const [failedRes] = await db.select({ count: sql<number>`count(*)::int` }).from(emailSendLog).where(eq(emailSendLog.status, "failed"));
    return {
      total: totalRes?.count || 0,
      sent: sentRes?.count || 0,
      failed: failedRes?.count || 0,
    };
  }

  async getBidboardSyncStates(): Promise<BidboardSyncState[]> {
    return db.select().from(bidboardSyncState).orderBy(desc(bidboardSyncState.lastCheckedAt));
  }

  async getBidboardSyncState(projectId: string): Promise<BidboardSyncState | undefined> {
    const [result] = await db.select().from(bidboardSyncState).where(eq(bidboardSyncState.projectId, projectId));
    return result;
  }

  async upsertBidboardSyncState(data: { projectId: string; projectName?: string; currentStage?: string; metadata?: any }): Promise<BidboardSyncState> {
    const [result] = await db
      .insert(bidboardSyncState)
      .values({
        projectId: data.projectId,
        projectName: data.projectName,
        currentStage: data.currentStage,
        lastCheckedAt: new Date(),
        lastChangedAt: new Date(),
        metadata: data.metadata,
      })
      .onConflictDoUpdate({
        target: [bidboardSyncState.projectId],
        set: {
          projectName: data.projectName,
          currentStage: data.currentStage,
          lastCheckedAt: new Date(),
          metadata: data.metadata,
        },
      })
      .returning();
    return result;
  }

  async getBidboardAutomationLogs(limit: number = 50): Promise<BidboardAutomationLog[]> {
    return db.select().from(bidboardAutomationLogs).orderBy(desc(bidboardAutomationLogs.createdAt)).limit(limit);
  }

  async createBidboardAutomationLog(data: { projectId?: string; projectName?: string; action: string; status: string; details?: any; errorMessage?: string; screenshotPath?: string }): Promise<BidboardAutomationLog> {
    const [result] = await db
      .insert(bidboardAutomationLogs)
      .values({
        projectId: data.projectId || null,
        projectName: data.projectName || null,
        action: data.action,
        status: data.status,
        details: data.details,
        errorMessage: data.errorMessage,
        screenshotPath: data.screenshotPath,
      })
      .returning();
    return result;
  }

  async seedEmailTemplates(): Promise<void> {
    const existingTemplates = await this.getEmailTemplates();
    
    const defaultTemplates = [
      {
        templateKey: "project_role_assignment",
        name: "Project Role Assignment",
        description: "Sent when a user is assigned a role on a Procore project",
        subject: "You've been assigned to {{projectName}}",
        bodyHtml: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #333;">Project Role Assignment</h2>
            <p>Hello {{assigneeName}},</p>
            <p>You have been assigned the role of <strong>{{roleName}}</strong> on the project <strong>{{projectName}}</strong>.</p>
            <p>
              <a href="{{projectUrl}}" style="display: inline-block; background-color: #f97316; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">
                View Project in Procore
              </a>
            </p>
            <p style="color: #666; font-size: 14px; margin-top: 24px;">
              This is an automated notification from T-Rock Sync Hub.
            </p>
          </div>
        `,
        enabled: true,
        variables: ["assigneeName", "projectName", "roleName", "projectUrl", "projectId", "companyId"],
      },
      {
        templateKey: "stage_change_notification",
        name: "Deal Stage Change",
        description: "Sent when a deal/project stage changes",
        subject: "{{projectName}} - Stage Updated to {{newStage}}",
        bodyHtml: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #333;">Project Stage Update</h2>
            <p>Hello,</p>
            <p>The project <strong>{{projectName}}</strong> has been updated:</p>
            <ul>
              <li>Previous Stage: {{previousStage}}</li>
              <li>New Stage: <strong>{{newStage}}</strong></li>
            </ul>
            <p style="color: #666; font-size: 14px; margin-top: 24px;">
              This is an automated notification from T-Rock Sync Hub.
            </p>
          </div>
        `,
        enabled: true,
        variables: ["projectName", "previousStage", "newStage"],
      },
      {
        templateKey: "bidboard_sync_summary",
        name: "BidBoard Sync Summary",
        description: "Daily/hourly summary of BidBoard sync activities",
        subject: "BidBoard Sync Summary - {{date}}",
        bodyHtml: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #333;">BidBoard Sync Summary</h2>
            <p>Here's a summary of recent BidBoard sync activities:</p>
            <ul>
              <li>Projects Scanned: {{projectsScanned}}</li>
              <li>Stage Changes Detected: {{stageChanges}}</li>
              <li>Portfolio Transitions: {{portfolioTransitions}}</li>
            </ul>
            <p style="color: #666; font-size: 14px; margin-top: 24px;">
              Generated on {{date}} by T-Rock Sync Hub.
            </p>
          </div>
        `,
        enabled: false,
        variables: ["date", "projectsScanned", "stageChanges", "portfolioTransitions"],
      },
    ];

    for (const template of defaultTemplates) {
      const exists = existingTemplates.find(t => t.templateKey === template.templateKey);
      if (!exists) {
        await db.insert(emailTemplates).values(template);
        console.log(`[seed] Created email template: ${template.templateKey}`);
      }
    }
  }
}

export const storage = new DatabaseStorage();
