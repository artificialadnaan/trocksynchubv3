#!/usr/bin/env -S npx tsx
/**
 * Seed historical audit log data for dashboard and Sync Activity (7 Days) chart.
 * Run: npm run db:seed-dashboard
 *
 * Inserts 14 days of realistic entries:
 * - 8-15 sync ops/day, ~95% success
 * - 80-150 system events/day, ~99% success
 */
import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

const SYNC_ACTIONS = [
  "hubspot_procore_vendor_created",
  "hubspot_procore_project_created",
  "procore_hubspot_deal_updated",
  "document_uploaded",
  "rfp_approval_processed",
  "webhook_stage_change_processed",
  "closeout_survey_sent",
  "procore_project_updated",
  "webhook_role_assignment_processed",
  "webhook_deal_project_created",
];

const SYSTEM_ACTIONS = [
  "webhook_received",
  "oauth_refreshed",
  "polling_check",
  "health_check",
  "webhook_acknowledged",
  "token_refreshed",
];

const ENTITY_TYPES = ["deal", "project", "company", "contact", "document", "webhook"];
const SOURCES = ["hubspot", "procore", "automation", "webhook", "oauth"];
const ERROR_MESSAGES = [
  "API rate limit exceeded",
  "Connection timeout",
  "Invalid response from target system",
  "Webhook delivery failed",
  "Token expired during request",
];

/** Random int in [min, max] inclusive */
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Weighted random: ~70% business hours (7am-6pm CT), 30% off-hours */
function randomTimestamp(date: Date): Date {
  const d = new Date(date);
  const isBusiness = Math.random() < 0.7;
  if (isBusiness) {
    d.setHours(randInt(7, 18), randInt(0, 59), 0, 0);
  } else {
    d.setHours(randInt(0, 23), randInt(0, 59), 0, 0);
  }
  return d;
}

function pick<T>(arr: T[]): T {
  return arr[randInt(0, arr.length - 1)];
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set");
  }

  const client = await pool.connect();
  const rows: Record<string, unknown>[] = [];

  for (let daysAgo = 13; daysAgo >= 0; daysAgo--) {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    date.setHours(0, 0, 0, 0);

    const syncCount = randInt(8, 15);
    const syncFailRate = 0.05;
    const systemCount = randInt(80, 150);
    const systemFailRate = 0.01;

    for (let i = 0; i < syncCount; i++) {
      const isFailed = Math.random() < syncFailRate;
      rows.push({
        action: pick(SYNC_ACTIONS),
        entity_type: pick(ENTITY_TYPES),
        entity_id: `seed-${daysAgo}-${i}`,
        source: pick(SOURCES),
        destination: "procore",
        status: isFailed ? "error" : "success",
        error_message: isFailed ? pick(ERROR_MESSAGES) : null,
        duration_ms: randInt(50, 800),
        category: "sync",
        created_at: randomTimestamp(date),
      });
    }

    for (let i = 0; i < systemCount; i++) {
      const isFailed = Math.random() < systemFailRate;
      rows.push({
        action: pick(SYSTEM_ACTIONS),
        entity_type: pick(ENTITY_TYPES),
        entity_id: null,
        source: pick(SOURCES),
        destination: null,
        status: isFailed ? "error" : "success",
        error_message: isFailed ? pick(ERROR_MESSAGES) : null,
        duration_ms: randInt(10, 200),
        category: "system",
        created_at: randomTimestamp(date),
      });
    }
  }

  let inserted = 0;
  for (const row of rows) {
    await client.query(
      `INSERT INTO audit_logs (action, entity_type, entity_id, source, destination, status, error_message, duration_ms, category, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        row.action,
        row.entity_type,
        row.entity_id,
        row.source,
        row.destination,
        row.status,
        row.error_message,
        row.duration_ms,
        row.category,
        row.created_at,
      ]
    );
    inserted++;
  }

  client.release();
  await pool.end();

  console.log(`Seeded ${inserted} audit log entries across 14 days.`);
  process.exit(0);
}

main().catch(async (err) => {
  await pool.end().catch(() => {});
  console.error("Seed failed:", err.message);
  process.exit(1);
});
