import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, boolean, timestamp, jsonb, serial, numeric } from "drizzle-orm/pg-core";
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

export const hubspotCompanies = pgTable("hubspot_companies", {
  id: serial("id").primaryKey(),
  hubspotId: text("hubspot_id").notNull().unique(),
  name: text("name"),
  domain: text("domain"),
  phone: text("phone"),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  industry: text("industry"),
  ownerId: text("owner_id"),
  properties: jsonb("properties"),
  lastSyncedAt: timestamp("last_synced_at").defaultNow(),
  hubspotUpdatedAt: timestamp("hubspot_updated_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
export const insertHubspotCompanySchema = createInsertSchema(hubspotCompanies).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertHubspotCompany = z.infer<typeof insertHubspotCompanySchema>;
export type HubspotCompany = typeof hubspotCompanies.$inferSelect;

export const hubspotContacts = pgTable("hubspot_contacts", {
  id: serial("id").primaryKey(),
  hubspotId: text("hubspot_id").notNull().unique(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  email: text("email"),
  phone: text("phone"),
  company: text("company"),
  jobTitle: text("job_title"),
  lifecycleStage: text("lifecycle_stage"),
  ownerId: text("owner_id"),
  ownerName: text("owner_name"),
  associatedCompanyId: text("associated_company_id"),
  associatedCompanyName: text("associated_company_name"),
  properties: jsonb("properties"),
  lastSyncedAt: timestamp("last_synced_at").defaultNow(),
  hubspotUpdatedAt: timestamp("hubspot_updated_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
export const insertHubspotContactSchema = createInsertSchema(hubspotContacts).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertHubspotContact = z.infer<typeof insertHubspotContactSchema>;
export type HubspotContact = typeof hubspotContacts.$inferSelect;

export const hubspotDeals = pgTable("hubspot_deals", {
  id: serial("id").primaryKey(),
  hubspotId: text("hubspot_id").notNull().unique(),
  dealName: text("deal_name"),
  amount: text("amount"),
  dealStage: text("deal_stage"),
  dealStageName: text("deal_stage_name"),
  pipeline: text("pipeline"),
  pipelineName: text("pipeline_name"),
  closeDate: text("close_date"),
  ownerId: text("owner_id"),
  ownerName: text("owner_name"),
  associatedCompanyId: text("associated_company_id"),
  associatedCompanyName: text("associated_company_name"),
  associatedContactIds: text("associated_contact_ids"),
  properties: jsonb("properties"),
  lastSyncedAt: timestamp("last_synced_at").defaultNow(),
  hubspotUpdatedAt: timestamp("hubspot_updated_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
export const insertHubspotDealSchema = createInsertSchema(hubspotDeals).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertHubspotDeal = z.infer<typeof insertHubspotDealSchema>;
export type HubspotDeal = typeof hubspotDeals.$inferSelect;

export const hubspotPipelines = pgTable("hubspot_pipelines", {
  id: serial("id").primaryKey(),
  hubspotId: text("hubspot_id").notNull().unique(),
  label: text("label").notNull(),
  displayOrder: integer("display_order"),
  stages: jsonb("stages"),
  lastSyncedAt: timestamp("last_synced_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
});
export const insertHubspotPipelineSchema = createInsertSchema(hubspotPipelines).omit({ id: true, createdAt: true });
export type InsertHubspotPipeline = z.infer<typeof insertHubspotPipelineSchema>;
export type HubspotPipeline = typeof hubspotPipelines.$inferSelect;

export const hubspotChangeHistory = pgTable("hubspot_change_history", {
  id: serial("id").primaryKey(),
  entityType: text("entity_type").notNull(),
  entityHubspotId: text("entity_hubspot_id").notNull(),
  changeType: text("change_type").notNull(),
  fieldName: text("field_name"),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  fullSnapshot: jsonb("full_snapshot"),
  syncedAt: timestamp("synced_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
});
export const insertHubspotChangeHistorySchema = createInsertSchema(hubspotChangeHistory).omit({ id: true, createdAt: true });
export type InsertHubspotChangeHistory = z.infer<typeof insertHubspotChangeHistorySchema>;
export type HubspotChangeHistory = typeof hubspotChangeHistory.$inferSelect;

export const procoreProjects = pgTable("procore_projects", {
  id: serial("id").primaryKey(),
  procoreId: text("procore_id").notNull().unique(),
  name: text("name"),
  displayName: text("display_name"),
  projectNumber: text("project_number"),
  address: text("address"),
  city: text("city"),
  stateCode: text("state_code"),
  zip: text("zip"),
  countryCode: text("country_code"),
  phone: text("phone"),
  active: boolean("active"),
  stage: text("stage"),
  projectStageName: text("project_stage_name"),
  startDate: text("start_date"),
  completionDate: text("completion_date"),
  projectedFinishDate: text("projected_finish_date"),
  estimatedValue: text("estimated_value"),
  totalValue: text("total_value"),
  storeNumber: text("store_number"),
  deliveryMethod: text("delivery_method"),
  workScope: text("work_scope"),
  companyId: text("company_id"),
  companyName: text("company_name"),
  properties: jsonb("properties"),
  lastSyncedAt: timestamp("last_synced_at").defaultNow(),
  procoreUpdatedAt: timestamp("procore_updated_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
export const insertProcoreProjectSchema = createInsertSchema(procoreProjects).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertProcoreProject = z.infer<typeof insertProcoreProjectSchema>;
export type ProcoreProject = typeof procoreProjects.$inferSelect;

export const procoreVendors = pgTable("procore_vendors", {
  id: serial("id").primaryKey(),
  procoreId: text("procore_id").notNull().unique(),
  name: text("name"),
  abbreviatedName: text("abbreviated_name"),
  address: text("address"),
  city: text("city"),
  stateCode: text("state_code"),
  zip: text("zip"),
  countryCode: text("country_code"),
  emailAddress: text("email_address"),
  businessPhone: text("business_phone"),
  mobilePhone: text("mobile_phone"),
  faxNumber: text("fax_number"),
  website: text("website"),
  legalName: text("legal_name"),
  licenseNumber: text("license_number"),
  isActive: boolean("is_active"),
  tradeName: text("trade_name"),
  laborUnion: text("labor_union"),
  contactCount: integer("contact_count"),
  childrenCount: integer("children_count"),
  notes: text("notes"),
  companyId: text("company_id"),
  properties: jsonb("properties"),
  lastSyncedAt: timestamp("last_synced_at").defaultNow(),
  procoreUpdatedAt: timestamp("procore_updated_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
export const insertProcoreVendorSchema = createInsertSchema(procoreVendors).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertProcoreVendor = z.infer<typeof insertProcoreVendorSchema>;
export type ProcoreVendor = typeof procoreVendors.$inferSelect;

export const procoreUsers = pgTable("procore_users", {
  id: serial("id").primaryKey(),
  procoreId: text("procore_id").notNull().unique(),
  name: text("name"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  emailAddress: text("email_address"),
  jobTitle: text("job_title"),
  businessPhone: text("business_phone"),
  mobilePhone: text("mobile_phone"),
  address: text("address"),
  city: text("city"),
  stateCode: text("state_code"),
  zip: text("zip"),
  countryCode: text("country_code"),
  isActive: boolean("is_active"),
  isEmployee: boolean("is_employee"),
  lastLoginAt: text("last_login_at"),
  employeeId: text("employee_id"),
  vendorId: text("vendor_id"),
  vendorName: text("vendor_name"),
  companyId: text("company_id"),
  properties: jsonb("properties"),
  lastSyncedAt: timestamp("last_synced_at").defaultNow(),
  procoreUpdatedAt: timestamp("procore_updated_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
export const insertProcoreUserSchema = createInsertSchema(procoreUsers).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertProcoreUser = z.infer<typeof insertProcoreUserSchema>;
export type ProcoreUser = typeof procoreUsers.$inferSelect;

export const procoreBidPackages = pgTable("procore_bid_packages", {
  id: serial("id").primaryKey(),
  procoreId: text("procore_id").notNull().unique(),
  projectId: text("project_id"),
  projectName: text("project_name"),
  projectLocation: text("project_location"),
  title: text("title"),
  number: integer("number"),
  bidDueDate: text("bid_due_date"),
  formattedBidDueDate: text("formatted_bid_due_date"),
  accountingMethod: text("accounting_method"),
  open: boolean("open"),
  hidden: boolean("hidden"),
  sealed: boolean("sealed"),
  hasBidDocs: boolean("has_bid_docs"),
  acceptPostDueSubmissions: boolean("accept_post_due_submissions"),
  allowBidderSum: boolean("allow_bidder_sum"),
  enablePrebidWalkthrough: boolean("enable_prebid_walkthrough"),
  enablePrebidRfiDeadline: boolean("enable_prebid_rfi_deadline"),
  preBidRfiDeadlineDate: text("pre_bid_rfi_deadline_date"),
  bidInvitesSentCount: integer("bid_invites_sent_count"),
  bidsReceivedCount: integer("bids_received_count"),
  bidEmailMessage: text("bid_email_message"),
  bidWebMessage: text("bid_web_message"),
  companyId: text("company_id"),
  properties: jsonb("properties"),
  lastSyncedAt: timestamp("last_synced_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
export const insertProcoreBidPackageSchema = createInsertSchema(procoreBidPackages).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertProcoreBidPackage = z.infer<typeof insertProcoreBidPackageSchema>;
export type ProcoreBidPackage = typeof procoreBidPackages.$inferSelect;

export const procoreBids = pgTable("procore_bids", {
  id: serial("id").primaryKey(),
  procoreId: text("procore_id").notNull().unique(),
  bidPackageId: text("bid_package_id"),
  bidPackageTitle: text("bid_package_title"),
  bidFormId: text("bid_form_id"),
  bidFormTitle: text("bid_form_title"),
  projectId: text("project_id"),
  projectName: text("project_name"),
  projectAddress: text("project_address"),
  vendorId: text("vendor_id"),
  vendorName: text("vendor_name"),
  vendorTrades: text("vendor_trades"),
  bidStatus: text("bid_status"),
  awarded: boolean("awarded"),
  submitted: boolean("submitted"),
  isBidderCommitted: boolean("is_bidder_committed"),
  lumpSumEnabled: boolean("lump_sum_enabled"),
  lumpSumAmount: numeric("lump_sum_amount"),
  bidderComments: text("bidder_comments"),
  dueDate: text("due_date"),
  invitationLastSentAt: text("invitation_last_sent_at"),
  bidRequesterName: text("bid_requester_name"),
  bidRequesterEmail: text("bid_requester_email"),
  bidRequesterCompany: text("bid_requester_company"),
  requireNda: boolean("require_nda"),
  ndaStatus: text("nda_status"),
  showBidInEstimating: boolean("show_bid_in_estimating"),
  companyId: text("company_id"),
  properties: jsonb("properties"),
  procoreCreatedAt: text("procore_created_at"),
  procoreUpdatedAt: text("procore_updated_at"),
  lastSyncedAt: timestamp("last_synced_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
export const insertProcoreBidSchema = createInsertSchema(procoreBids).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertProcoreBid = z.infer<typeof insertProcoreBidSchema>;
export type ProcoreBid = typeof procoreBids.$inferSelect;

export const procoreBidForms = pgTable("procore_bid_forms", {
  id: serial("id").primaryKey(),
  procoreId: text("procore_id").notNull().unique(),
  bidPackageId: text("bid_package_id"),
  projectId: text("project_id"),
  title: text("title"),
  proposalId: text("proposal_id"),
  proposalName: text("proposal_name"),
  companyId: text("company_id"),
  properties: jsonb("properties"),
  lastSyncedAt: timestamp("last_synced_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
export const insertProcoreBidFormSchema = createInsertSchema(procoreBidForms).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertProcoreBidForm = z.infer<typeof insertProcoreBidFormSchema>;
export type ProcoreBidForm = typeof procoreBidForms.$inferSelect;

export const procoreChangeHistory = pgTable("procore_change_history", {
  id: serial("id").primaryKey(),
  entityType: text("entity_type").notNull(),
  entityProcoreId: text("entity_procore_id").notNull(),
  changeType: text("change_type").notNull(),
  fieldName: text("field_name"),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  fullSnapshot: jsonb("full_snapshot"),
  syncedAt: timestamp("synced_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
});
export const insertProcoreChangeHistorySchema = createInsertSchema(procoreChangeHistory).omit({ id: true, createdAt: true });
export type InsertProcoreChangeHistory = z.infer<typeof insertProcoreChangeHistorySchema>;
export type ProcoreChangeHistory = typeof procoreChangeHistory.$inferSelect;
