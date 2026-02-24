import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, boolean, timestamp, jsonb, serial } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  role: text("role").notNull().default("admin"),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const syncMappings = pgTable("sync_mappings", {
  id: serial("id").primaryKey(),
  hubspotDealId: text("hubspot_deal_id"),
  hubspotCompanyId: text("hubspot_company_id"),
  procoreProjectId: text("procore_project_id"),
  procoreCompanyId: text("procore_company_id"),
  companyCamProjectId: text("companycam_project_id"),
  hubspotDealName: text("hubspot_deal_name"),
  procoreProjectName: text("procore_project_name"),
  procoreProjectNumber: text("procore_project_number"),
  lastSyncAt: timestamp("last_sync_at"),
  lastSyncStatus: text("last_sync_status").default("pending"),
  lastSyncDirection: text("last_sync_direction"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertSyncMappingSchema = createInsertSchema(syncMappings).omit({
  id: true,
  createdAt: true,
});
export type InsertSyncMapping = z.infer<typeof insertSyncMappingSchema>;
export type SyncMapping = typeof syncMappings.$inferSelect;

export const stageMappings = pgTable("stage_mappings", {
  id: serial("id").primaryKey(),
  hubspotStage: text("hubspot_stage").notNull(),
  hubspotStageLabel: text("hubspot_stage_label").notNull(),
  procoreStage: text("procore_stage").notNull(),
  procoreStageLabel: text("procore_stage_label").notNull(),
  direction: text("direction").notNull().default("bidirectional"),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  triggerPortfolio: boolean("trigger_portfolio").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertStageMappingSchema = createInsertSchema(stageMappings).omit({
  id: true,
  createdAt: true,
});
export type InsertStageMapping = z.infer<typeof insertStageMappingSchema>;
export type StageMapping = typeof stageMappings.$inferSelect;

export const webhookLogs = pgTable("webhook_logs", {
  id: serial("id").primaryKey(),
  source: text("source").notNull(),
  eventType: text("event_type").notNull(),
  resourceId: text("resource_id"),
  resourceType: text("resource_type"),
  status: text("status").notNull().default("received"),
  payload: jsonb("payload"),
  response: jsonb("response"),
  errorMessage: text("error_message"),
  retryCount: integer("retry_count").notNull().default(0),
  maxRetries: integer("max_retries").notNull().default(3),
  processingTimeMs: integer("processing_time_ms"),
  idempotencyKey: text("idempotency_key"),
  createdAt: timestamp("created_at").defaultNow(),
  processedAt: timestamp("processed_at"),
});

export const insertWebhookLogSchema = createInsertSchema(webhookLogs).omit({
  id: true,
  createdAt: true,
});
export type InsertWebhookLog = z.infer<typeof insertWebhookLogSchema>;
export type WebhookLog = typeof webhookLogs.$inferSelect;

export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  source: text("source").notNull(),
  destination: text("destination"),
  status: text("status").notNull(),
  details: jsonb("details"),
  errorMessage: text("error_message"),
  durationMs: integer("duration_ms"),
  userId: varchar("user_id"),
  idempotencyKey: text("idempotency_key"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertAuditLogSchema = createInsertSchema(auditLogs).omit({
  id: true,
  createdAt: true,
});
export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;
export type AuditLog = typeof auditLogs.$inferSelect;

export const idempotencyKeys = pgTable("idempotency_keys", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  source: text("source").notNull(),
  eventType: text("event_type").notNull(),
  result: jsonb("result"),
  createdAt: timestamp("created_at").defaultNow(),
  expiresAt: timestamp("expires_at"),
});

export const insertIdempotencyKeySchema = createInsertSchema(idempotencyKeys).omit({
  id: true,
  createdAt: true,
});
export type InsertIdempotencyKey = z.infer<typeof insertIdempotencyKeySchema>;
export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;

export const oauthTokens = pgTable("oauth_tokens", {
  id: serial("id").primaryKey(),
  provider: text("provider").notNull().unique(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token"),
  tokenType: text("token_type").default("Bearer"),
  expiresAt: timestamp("expires_at"),
  scopes: text("scopes"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertOAuthTokenSchema = createInsertSchema(oauthTokens).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertOAuthToken = z.infer<typeof insertOAuthTokenSchema>;
export type OAuthToken = typeof oauthTokens.$inferSelect;

export const automationConfig = pgTable("automation_config", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  value: jsonb("value").notNull(),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertAutomationConfigSchema = createInsertSchema(automationConfig).omit({
  id: true,
  updatedAt: true,
});
export type InsertAutomationConfig = z.infer<typeof insertAutomationConfigSchema>;
export type AutomationConfig = typeof automationConfig.$inferSelect;

export const contractCounters = pgTable("contract_counters", {
  id: serial("id").primaryKey(),
  procoreProjectId: text("procore_project_id").notNull(),
  projectNumber: text("project_number").notNull(),
  counterType: text("counter_type").notNull(),
  currentValue: integer("current_value").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertContractCounterSchema = createInsertSchema(contractCounters).omit({
  id: true,
  updatedAt: true,
});
export type InsertContractCounter = z.infer<typeof insertContractCounterSchema>;
export type ContractCounter = typeof contractCounters.$inferSelect;

export const pollJobs = pgTable("poll_jobs", {
  id: serial("id").primaryKey(),
  jobName: text("job_name").notNull().unique(),
  cronExpression: text("cron_expression").notNull(),
  lastRunAt: timestamp("last_run_at"),
  nextRunAt: timestamp("next_run_at"),
  status: text("status").notNull().default("idle"),
  lastResult: jsonb("last_result"),
  isActive: boolean("is_active").notNull().default(true),
  errorCount: integer("error_count").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertPollJobSchema = createInsertSchema(pollJobs).omit({
  id: true,
  updatedAt: true,
});
export type InsertPollJob = z.infer<typeof insertPollJobSchema>;
export type PollJob = typeof pollJobs.$inferSelect;
