/**
 * Reconciliation Schema — SyncHub Data Reconciliation Engine
 * ==========================================================
 *
 * Tables for the Data Health / reconciliation system that classifies
 * projects across Procore, HubSpot, and BidBoard into match/conflict/orphan buckets.
 *
 * @module shared/reconciliation-schema
 */

import {
  pgTable,
  text,
  integer,
  timestamp,
  boolean,
  jsonb,
  pgEnum,
  serial,
  real,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ============================================================
// ENUMS
// ============================================================

export const reconciliationBucketEnum = pgEnum("reconciliation_bucket", [
  "exact_match", // Project number matches exactly across systems
  "fuzzy_match", // Name/number partially match, needs confirmation
  "orphan_procore", // Exists in Procore only, no HubSpot counterpart
  "orphan_hubspot", // Exists in HubSpot only, no Procore counterpart
  "orphan_bidboard", // Exists in BidBoard only (stuck in pipeline)
  "conflict", // Linked but field values diverge
  "resolved", // Admin has resolved this pair
  "ignored", // Admin marked as intentionally unlinked (test data, archived)
]);

export const conflictSeverityEnum = pgEnum("conflict_severity", [
  "critical", // Project number mismatch, amount > 10% difference
  "warning", // Location mismatch, stage mismatch
  "info", // Minor field differences (formatting, casing)
]);

export const resolutionActionEnum = pgEnum("resolution_action", [
  "accept_procore", // Use Procore value as canonical
  "accept_hubspot", // Use HubSpot value as canonical
  "manual_override", // Admin entered a custom value
  "create_counterpart", // Created missing record in other system
  "link_existing", // Linked to an existing record in other system
  "mark_ignored", // Intentionally unlinked
  "merge_records", // Combined data from both sources
  "assign_canonical_number", // Mapped legacy number to canonical format
]);

export const projectNumberEraEnum = pgEnum("project_number_era", [
  "legacy", // Pre-automation freeform strings
  "zapier", // Zapier-era DFW format (inconsistent)
  "synchub", // Current SyncHub format (canonical)
]);

// ============================================================
// TYPE DEFINITIONS for JSONB columns
// ============================================================

export interface ProcoreProjectSnapshot {
  id: string;
  name: string;
  projectNumber: string | null;
  stage: string | null;
  status: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  estimatedValue: number | null;
  actualValue: number | null;
  startDate: string | null;
  completionDate: string | null;
  projectManager: string | null;
  superintendent: string | null;
  fetchedAt: string; // ISO timestamp
}

export interface HubSpotDealSnapshot {
  id: string;
  dealName: string;
  projectNumber: string | null;
  dealStage: string | null;
  dealStageName: string | null;
  pipelineId: string | null;
  amount: number | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  closeDate: string | null;
  ownerName: string | null;
  fetchedAt: string;
}

export interface BidBoardItemSnapshot {
  id: string;
  title: string;
  projectNumber: string | null;
  status: string | null;
  estimatedValue: number | null;
  bidDueDate: string | null;
  fetchedAt: string;
}

// ============================================================
// CORE TABLES
// ============================================================

/**
 * reconciliation_projects
 *
 * Central table that holds the reconciliation state for every
 * project/deal across all systems. One row per unique project
 * (whether it exists in one system or multiple).
 */
export const reconciliationProjects = pgTable("reconciliation_projects", {
  id: serial("id").primaryKey(),

  // External IDs — nullable because orphans only exist in one system
  procoreProjectId: text("procore_project_id"),
  hubspotDealId: text("hubspot_deal_id"),
  bidboardItemId: text("bidboard_item_id"),
  companycamProjectId: text("companycam_project_id"),

  // Snapshot of values from each system at last scan
  procoreData: jsonb("procore_data").$type<ProcoreProjectSnapshot | null>(),
  hubspotData: jsonb("hubspot_data").$type<HubSpotDealSnapshot | null>(),
  bidboardData: jsonb("bidboard_data").$type<BidBoardItemSnapshot | null>(),

  // Classification
  bucket: reconciliationBucketEnum("bucket").notNull().default("fuzzy_match"),
  matchConfidence: real("match_confidence"), // 0.0 - 1.0 for fuzzy matches
  matchMethod: text("match_method"), // 'project_number', 'name_similarity', 'legacy_map', 'manual'

  // Canonical values (set after resolution)
  canonicalName: text("canonical_name"),
  canonicalProjectNumber: text("canonical_project_number"),
  canonicalLocation: text("canonical_location"),
  canonicalAmount: real("canonical_amount"),
  canonicalStage: text("canonical_stage"),

  // Status
  isResolved: boolean("is_resolved").notNull().default(false),
  resolvedBy: text("resolved_by"), // admin user identifier
  resolvedAt: timestamp("resolved_at"),
  adminNotes: text("admin_notes"),

  // Timestamps
  lastScannedAt: timestamp("last_scanned_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * reconciliation_conflicts
 *
 * One row per field-level conflict on a reconciliation_project.
 * E.g., if a project has location AND amount mismatches, that's 2 rows.
 */
export const reconciliationConflicts = pgTable("reconciliation_conflicts", {
  id: serial("id").primaryKey(),
  reconciliationProjectId: integer("reconciliation_project_id")
    .notNull()
    .references(() => reconciliationProjects.id, { onDelete: "cascade" }),

  fieldName: text("field_name").notNull(), // 'project_number', 'location', 'amount', 'stage', 'name', etc.
  procoreValue: text("procore_value"),
  hubspotValue: text("hubspot_value"),
  bidboardValue: text("bidboard_value"),

  severity: conflictSeverityEnum("severity").notNull().default("warning"),

  // Resolution
  isResolved: boolean("is_resolved").notNull().default(false),
  resolvedValue: text("resolved_value"), // The chosen canonical value
  resolvedSource: text("resolved_source"), // 'procore', 'hubspot', 'manual'
  resolvedBy: text("resolved_by"),
  resolvedAt: timestamp("resolved_at"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * reconciliation_audit_log
 *
 * Immutable log of every admin action. Used for rollback and compliance.
 */
export const reconciliationAuditLog = pgTable("reconciliation_audit_log", {
  id: serial("id").primaryKey(),
  reconciliationProjectId: integer("reconciliation_project_id")
    .notNull()
    .references(() => reconciliationProjects.id, { onDelete: "cascade" }),

  action: resolutionActionEnum("action").notNull(),
  fieldName: text("field_name"), // null for project-level actions
  previousValue: text("previous_value"),
  newValue: text("new_value"),
  source: text("source"), // 'procore', 'hubspot', 'manual'

  performedBy: text("performed_by").notNull(),
  performedAt: timestamp("performed_at").notNull().defaultNow(),
  notes: text("notes"),

  // Store full snapshot at time of action for rollback
  snapshotBefore: jsonb("snapshot_before"),
  snapshotAfter: jsonb("snapshot_after"),
});

/**
 * legacy_number_mappings
 *
 * Maps legacy/Zapier-era project numbers to their canonical equivalents.
 * This solves the "ASMAABALCO" → "DFW-4-XXXXX-XX" problem.
 */
export const legacyNumberMappings = pgTable("legacy_number_mappings", {
  id: serial("id").primaryKey(),

  legacyNumber: text("legacy_number").notNull().unique(),
  canonicalNumber: text("canonical_number"), // null if not yet assigned
  era: projectNumberEraEnum("era").notNull(),

  projectName: text("project_name"), // For reference during mapping
  procoreProjectId: text("procore_project_id"),
  hubspotDealId: text("hubspot_deal_id"),

  mappedBy: text("mapped_by"),
  mappedAt: timestamp("mapped_at"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * reconciliation_scan_runs
 *
 * Tracks each time the reconciliation engine runs.
 * Used for dashboard trends and debugging.
 */
export const reconciliationScanRuns = pgTable("reconciliation_scan_runs", {
  id: serial("id").primaryKey(),

  startedAt: timestamp("started_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),

  // Metrics snapshot
  totalProjects: integer("total_projects"),
  exactMatches: integer("exact_matches"),
  fuzzyMatches: integer("fuzzy_matches"),
  orphansProcore: integer("orphans_procore"),
  orphansHubspot: integer("orphans_hubspot"),
  conflicts: integer("conflicts"),
  resolved: integer("resolved"),

  // Deltas from previous run
  newConflicts: integer("new_conflicts"),
  newResolutions: integer("new_resolutions"),

  triggeredBy: text("triggered_by"), // 'manual', 'scheduled', 'webhook'
  error: text("error"),
});

// ============================================================
// RELATIONS
// ============================================================

export const reconciliationProjectsRelations = relations(
  reconciliationProjects,
  ({ many }) => ({
    conflicts: many(reconciliationConflicts),
    auditLog: many(reconciliationAuditLog),
  })
);

export const reconciliationConflictsRelations = relations(
  reconciliationConflicts,
  ({ one }) => ({
    project: one(reconciliationProjects, {
      fields: [reconciliationConflicts.reconciliationProjectId],
      references: [reconciliationProjects.id],
    }),
  })
);
