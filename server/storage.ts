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
  getProcoreDataCounts(): Promise<{ projects: number; vendors: number; users: number; changeHistory: number }>;
  purgeProcoreChangeHistory(daysToKeep: number): Promise<number>;
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

  async getProcoreDataCounts(): Promise<{ projects: number; vendors: number; users: number; changeHistory: number }> {
    const [projRes, vendRes, userRes, histRes] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(procoreProjects),
      db.select({ count: sql<number>`count(*)::int` }).from(procoreVendors),
      db.select({ count: sql<number>`count(*)::int` }).from(procoreUsers),
      db.select({ count: sql<number>`count(*)::int` }).from(procoreChangeHistory),
    ]);
    return {
      projects: projRes[0]?.count || 0,
      vendors: vendRes[0]?.count || 0,
      users: userRes[0]?.count || 0,
      changeHistory: histRes[0]?.count || 0,
    };
  }

  async purgeProcoreChangeHistory(daysToKeep: number): Promise<number> {
    const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);
    const deleted = await db.delete(procoreChangeHistory).where(lte(procoreChangeHistory.createdAt, cutoff)).returning();
    return deleted.length;
  }
}

export const storage = new DatabaseStorage();
