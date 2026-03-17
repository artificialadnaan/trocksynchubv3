-- SyncHub Data Reconciliation Engine
-- Adds reconciliation tables for Data Health dashboard
-- Run with: npx drizzle-kit migrate (or your migration runner)

CREATE TYPE "public"."conflict_severity" AS ENUM('critical', 'warning', 'info');
--> statement-breakpoint
CREATE TYPE "public"."project_number_era" AS ENUM('legacy', 'zapier', 'synchub');
--> statement-breakpoint
CREATE TYPE "public"."reconciliation_bucket" AS ENUM('exact_match', 'fuzzy_match', 'orphan_procore', 'orphan_hubspot', 'orphan_bidboard', 'conflict', 'resolved', 'ignored');
--> statement-breakpoint
CREATE TYPE "public"."resolution_action" AS ENUM('accept_procore', 'accept_hubspot', 'manual_override', 'create_counterpart', 'link_existing', 'mark_ignored', 'merge_records', 'assign_canonical_number');
--> statement-breakpoint
CREATE TABLE "legacy_number_mappings" (
	"id" serial PRIMARY KEY NOT NULL,
	"legacy_number" text NOT NULL,
	"canonical_number" text,
	"era" "project_number_era" NOT NULL,
	"project_name" text,
	"procore_project_id" text,
	"hubspot_deal_id" text,
	"mapped_by" text,
	"mapped_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "legacy_number_mappings_legacy_number_unique" UNIQUE("legacy_number")
);
--> statement-breakpoint
CREATE TABLE "reconciliation_projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"procore_project_id" text,
	"hubspot_deal_id" text,
	"bidboard_item_id" text,
	"companycam_project_id" text,
	"procore_data" jsonb,
	"hubspot_data" jsonb,
	"bidboard_data" jsonb,
	"bucket" "reconciliation_bucket" DEFAULT 'fuzzy_match' NOT NULL,
	"match_confidence" real,
	"match_method" text,
	"canonical_name" text,
	"canonical_project_number" text,
	"canonical_location" text,
	"canonical_amount" real,
	"canonical_stage" text,
	"is_resolved" boolean DEFAULT false NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp,
	"admin_notes" text,
	"last_scanned_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliation_conflicts" (
	"id" serial PRIMARY KEY NOT NULL,
	"reconciliation_project_id" integer NOT NULL,
	"field_name" text NOT NULL,
	"procore_value" text,
	"hubspot_value" text,
	"bidboard_value" text,
	"severity" "conflict_severity" DEFAULT 'warning' NOT NULL,
	"is_resolved" boolean DEFAULT false NOT NULL,
	"resolved_value" text,
	"resolved_source" text,
	"resolved_by" text,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliation_audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"reconciliation_project_id" integer NOT NULL,
	"action" "resolution_action" NOT NULL,
	"field_name" text,
	"previous_value" text,
	"new_value" text,
	"source" text,
	"performed_by" text NOT NULL,
	"performed_at" timestamp DEFAULT now() NOT NULL,
	"notes" text,
	"snapshot_before" jsonb,
	"snapshot_after" jsonb
);
--> statement-breakpoint
CREATE TABLE "reconciliation_scan_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"total_projects" integer,
	"exact_matches" integer,
	"fuzzy_matches" integer,
	"orphans_procore" integer,
	"orphans_hubspot" integer,
	"conflicts" integer,
	"resolved" integer,
	"new_conflicts" integer,
	"new_resolutions" integer,
	"triggered_by" text,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "reconciliation_conflicts" ADD CONSTRAINT "reconciliation_conflicts_reconciliation_project_id_reconciliation_projects_id_fk" FOREIGN KEY ("reconciliation_project_id") REFERENCES "public"."reconciliation_projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "reconciliation_audit_log" ADD CONSTRAINT "reconciliation_audit_log_reconciliation_project_id_reconciliation_projects_id_fk" FOREIGN KEY ("reconciliation_project_id") REFERENCES "public"."reconciliation_projects"("id") ON DELETE cascade ON UPDATE no action;
