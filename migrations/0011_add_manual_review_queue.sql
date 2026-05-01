CREATE TABLE IF NOT EXISTS "manual_review_queue" (
  "id" serial PRIMARY KEY NOT NULL,
  "project_number" text NOT NULL,
  "project_name" text NOT NULL,
  "customer" text,
  "current_stage" text NOT NULL,
  "previous_stage" text,
  "cycle_id" text NOT NULL,
  "reason" text NOT NULL,
  "details" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "resolved_at" timestamp,
  "resolved_by" text,
  "resolution_notes" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "manual_review_queue_project_cycle_unique"
  ON "manual_review_queue" ("project_number", "cycle_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_manual_review_project_number"
  ON "manual_review_queue" ("project_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_manual_review_cycle_id"
  ON "manual_review_queue" ("cycle_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_manual_review_unresolved"
  ON "manual_review_queue" ("resolved_at")
  WHERE "resolved_at" IS NULL;
