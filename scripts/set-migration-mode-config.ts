#!/usr/bin/env -S npx tsx

import { execFileSync } from "child_process";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import pg from "pg";
import { createTimestamp, parseArgs } from "./bidboard-stage-rename-common";

const { Pool } = pg;

// Migration mode suppresses stage-transition external effects (HubSpot writes,
// Portfolio creation, and stage notifications). The scheduled sync still exports
// Bid Board and posts the raw export to the internal T Rock CRM ingestion route;
// that receiver updates CRM-local Bid Board cache fields only and is accepted
// during the rollout.

type ConfigTarget = {
  key: string;
  value: Record<string, unknown>;
  description: string;
};

type SnapshotRow = {
  key: string;
  existed: boolean;
  value: Record<string, unknown> | null;
  description: string | null;
  is_active: boolean | null;
};

type ConfigSnapshot = {
  timestamp: string;
  createdAt: string;
  expectedMainSha: string;
  deployedSha: string;
  rows: SnapshotRow[];
};

const REQUIRED_TABLES = [
  "automation_config",
  "stage_mappings",
  "bidboard_sync_state",
  "manual_review_queue",
] as const;

const TARGET_CONFIGS: ConfigTarget[] = [
  {
    key: "bidboard_stage_sync",
    value: {
      enabled: true,
      mode: "migration",
      dryRun: false,
      suppressHubSpotWrites: true,
      suppressPortfolioTriggers: true,
      suppressStageNotifications: true,
      logSuppressedActions: true,
    },
    description: "BidBoard stage sync migration-mode rollout",
  },
  {
    key: "bidboard_automation",
    value: { enabled: false },
    description: "BidBoard Playwright automation legacy poller disabled",
  },
  {
    key: "bidboard_stage_mapping",
    value: {
      useDb: true,
      allowHardcodedFallback: true,
      auditFallbackUsage: true,
    },
    description: "BidBoard stage mapping source control",
  },
  {
    key: "bidboard_portfolio_trigger",
    value: {
      source: "stage_mappings",
      requireHubspotDeal: true,
      allowUnmappedAutoCreate: false,
      enabled: false,
    },
    description: "BidBoard Portfolio trigger controls",
  },
  {
    key: "stage_notify_bb_closed_won_contract",
    value: { enabled: false },
    description: "Stage notification: Contract -> Closed Won",
  },
  {
    key: "stage_notify_bb_closed_lost_lost",
    value: { enabled: false },
    description: "Stage notification: Lost -> Closed Lost",
  },
];

const TOUCHED_KEYS = TARGET_CONFIGS.map((target) => target.key);

const NEW_STAGE_MAPPING_ROWS = [
  ["Estimating", "Estimating", false],
  ["Service Estimating", "Service – Estimating", false],
  ["Estimate Under Review", "Internal Review", false],
  ["Estimate Sent to Client", "Proposal Sent", false],
  ["Contract", "Closed Won", true],
  ["Contract", "Service – Won", true],
  ["Won", "Closed Won", false],
  ["Won", "Service – Won", false],
  ["Lost", "Closed Lost", false],
  ["Lost", "Service – Lost", false],
] as const;

const OLD_STAGE_LABELS = [
  "Sent to Production",
  "Service - Sent to Production",
  "Production Lost",
  "Service - Lost",
  "Estimate in Progress",
  "Service - Estimating",
  "Service – Estimating",
] as const;

function assertDatabaseUrl(): string {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
  return process.env.DATABASE_URL;
}

function gitRevParse(ref: string): string {
  return execFileSync("git", ["rev-parse", ref], { encoding: "utf8" }).trim();
}

function expectedMainSha(): string {
  return process.env.EXPECTED_MAIN_SHA || gitRevParse("origin/main");
}

function deployedSha(): string {
  const value = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.DEPLOYED_GIT_SHA;
  if (!value) {
    throw new Error("Set RAILWAY_GIT_COMMIT_SHA or DEPLOYED_GIT_SHA so the pre-flight can verify the deployed commit");
  }
  return value;
}

function normalizeSha(value: string): string {
  return value.trim().toLowerCase();
}

async function queryOne<T>(client: pg.PoolClient, sql: string, params: unknown[] = []): Promise<T | undefined> {
  const result = await client.query<T>(sql, params);
  return result.rows[0];
}

async function tableExists(client: pg.PoolClient, tableName: string): Promise<boolean> {
  const row = await queryOne<{ exists: string | null }>(client, "SELECT to_regclass($1) AS exists", [`public.${tableName}`]);
  return Boolean(row?.exists);
}

async function columnExists(client: pg.PoolClient, tableName: string, columnName: string): Promise<boolean> {
  const row = await queryOne<{ count: string }>(
    client,
    `SELECT COUNT(*)::int AS count
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND column_name = $2`,
    [tableName, columnName]
  );
  return Number(row?.count || 0) > 0;
}

async function requirePreflight(client: pg.PoolClient, expectedSha: string, actualDeployedSha: string): Promise<void> {
  if (normalizeSha(expectedSha) !== normalizeSha(actualDeployedSha)) {
    throw new Error(`SHA mismatch: deployed=${actualDeployedSha}, expected main=${expectedSha}`);
  }

  for (const table of REQUIRED_TABLES) {
    if (!(await tableExists(client, table))) throw new Error(`Missing required table: ${table}`);
  }

  if (!(await columnExists(client, "manual_review_queue", "updated_at"))) {
    throw new Error("Migration 0012 evidence missing: manual_review_queue.updated_at column does not exist");
  }

  const stageRows = await client.query<{
    procore_stage_label: string;
    hubspot_stage_label: string;
    trigger_portfolio: boolean;
  }>(
    `SELECT procore_stage_label, hubspot_stage_label, trigger_portfolio
     FROM stage_mappings
     WHERE direction = 'bidboard_to_hubspot'
       AND is_active = true`
  );
  for (const [procoreStageLabel, hubspotStageLabel, triggerPortfolio] of NEW_STAGE_MAPPING_ROWS) {
    const match = stageRows.rows.find((row) =>
      row.procore_stage_label === procoreStageLabel &&
      row.hubspot_stage_label === hubspotStageLabel &&
      row.trigger_portfolio === triggerPortfolio
    );
    if (!match) {
      throw new Error(`Missing seeded stage mapping: ${procoreStageLabel} -> ${hubspotStageLabel}, triggerPortfolio=${triggerPortfolio}`);
    }
  }

  const contractTriggers = stageRows.rows.filter((row) => row.trigger_portfolio);
  const nonContractTrigger = contractTriggers.find((row) => row.procore_stage_label !== "Contract");
  if (nonContractTrigger) {
    throw new Error(`Invalid triggerPortfolio mapping outside Contract: ${nonContractTrigger.procore_stage_label} -> ${nonContractTrigger.hubspot_stage_label}`);
  }

  const oldLabels = await client.query<{ procore_stage_label: string }>(
    `SELECT DISTINCT procore_stage_label
     FROM stage_mappings
     WHERE procore_stage_label = ANY($1::text[])`,
    [OLD_STAGE_LABELS]
  );
  const oldLabelSet = new Set(oldLabels.rows.map((row) => row.procore_stage_label));
  for (const label of OLD_STAGE_LABELS) {
    if (!oldLabelSet.has(label)) throw new Error(`Legacy transition label missing from stage_mappings: ${label}`);
  }

  const legacyPoller = await queryOne<{ enabled: boolean | null }>(
    client,
    `SELECT (value->>'enabled')::boolean AS enabled
     FROM automation_config
     WHERE key = 'bidboard_automation'`
  );
  if (legacyPoller?.enabled !== false) {
    throw new Error("Migration 0013 evidence missing: bidboard_automation.enabled is not false before migration-mode config");
  }
}

async function readTouchedRows(client: pg.PoolClient): Promise<SnapshotRow[]> {
  const existing = await client.query<{
    key: string;
    value: Record<string, unknown>;
    description: string | null;
    is_active: boolean | null;
  }>(
    `SELECT key, value, description, is_active
     FROM automation_config
     WHERE key = ANY($1::text[])
     ORDER BY key`,
    [TOUCHED_KEYS]
  );
  const byKey = new Map(existing.rows.map((row) => [row.key, row]));
  return TOUCHED_KEYS.map((key) => {
    const row = byKey.get(key);
    return {
      key,
      existed: Boolean(row),
      value: row?.value ?? null,
      description: row?.description ?? null,
      is_active: row?.is_active ?? null,
    };
  });
}

function snapshotPath(timestamp: string): string {
  return path.resolve(process.cwd(), "logs", `config-snapshot-pre-migration-mode-${timestamp}.json`);
}

function writeSnapshot(snapshot: ConfigSnapshot): string {
  const outputPath = snapshotPath(snapshot.timestamp);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  return outputPath;
}

async function upsertTargetConfigs(client: pg.PoolClient): Promise<void> {
  for (const target of TARGET_CONFIGS) {
    await client.query(
      `INSERT INTO automation_config (key, value, description, is_active, updated_at)
       VALUES ($1, $2::jsonb, $3, true, NOW())
       ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value,
           description = EXCLUDED.description,
           is_active = true,
           updated_at = NOW()`,
      [target.key, JSON.stringify(target.value), target.description]
    );
  }
}

export function deepSemanticEqual(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (actual === null || expected === null) return actual === expected;
  if (typeof actual !== typeof expected) return false;
  if (typeof actual !== "object") return actual === expected;
  if (Array.isArray(actual) !== Array.isArray(expected)) return false;
  if (Array.isArray(actual)) {
    if (actual.length !== (expected as unknown[]).length) return false;
    return actual.every((value, index) => deepSemanticEqual(value, (expected as unknown[])[index]));
  }

  const actualObject = actual as Record<string, unknown>;
  const expectedObject = expected as Record<string, unknown>;
  const actualKeys = Object.keys(actualObject).sort();
  const expectedKeys = Object.keys(expectedObject).sort();

  if (actualKeys.length !== expectedKeys.length) return false;
  if (!actualKeys.every((key, index) => key === expectedKeys[index])) return false;
  return actualKeys.every((key) => deepSemanticEqual(actualObject[key], expectedObject[key]));
}

async function verifyTargets(client: pg.PoolClient): Promise<string[]> {
  const rows = await readTouchedRows(client);
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const drift: string[] = [];
  for (const target of TARGET_CONFIGS) {
    const row = byKey.get(target.key);
    if (!row?.existed) {
      drift.push(`${target.key}: row missing`);
      continue;
    }
    if (!deepSemanticEqual(row.value, target.value)) {
      drift.push(`${target.key}: value drift actual=${JSON.stringify(row.value)} expected=${JSON.stringify(target.value)}`);
    }
    if (row.is_active !== true) {
      drift.push(`${target.key}: is_active drift actual=${row.is_active} expected=true`);
    }
  }
  return drift;
}

async function rollbackFromSnapshot(client: pg.PoolClient, filePath: string): Promise<void> {
  const snapshot = JSON.parse(readFileSync(filePath, "utf8")) as ConfigSnapshot;
  await client.query("BEGIN");
  try {
    for (const row of snapshot.rows) {
      if (row.existed) {
        await client.query(
          `INSERT INTO automation_config (key, value, description, is_active, updated_at)
           VALUES ($1, $2::jsonb, $3, $4, NOW())
           ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value,
               description = EXCLUDED.description,
               is_active = EXCLUDED.is_active,
               updated_at = NOW()`,
          [row.key, JSON.stringify(row.value), row.description, row.is_active]
        );
      } else {
        await client.query("DELETE FROM automation_config WHERE key = $1", [row.key]);
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function printChangeSummary(before: SnapshotRow[], after: SnapshotRow[]) {
  const beforeMap = new Map(before.map((row) => [row.key, row]));
  console.log("\nWhat changed");
  for (const row of after) {
    const oldRow = beforeMap.get(row.key);
    console.log(`- ${row.key}`);
    console.log(`  old: ${oldRow?.existed ? JSON.stringify(oldRow.value) : "(missing)"}`);
    console.log(`  new: ${JSON.stringify(row.value)}`);
  }
  console.log("\nWhat was preserved");
  console.log("- Existing notification routes were untouched: stage_notify_bb_closed_won, stage_notify_bb_closed_lost, stage_notify_bb_internal_review, stage_notify_bb_proposal_sent");
  console.log("- Only runtime-canonical new-route keys were touched: stage_notify_bb_closed_won_contract, stage_notify_bb_closed_lost_lost");
}

function nextScheduledRunSummary(): string {
  const now = new Date();
  const next = new Date(now.getTime() + 19 * 60 * 1000);
  return `${next.toISOString()} if the service is restarted after this config write; otherwise the already-scheduled timer remains in effect until restart/config refresh`;
}

async function applyMigrationModeConfig(client: pg.PoolClient): Promise<void> {
  const expectedSha = expectedMainSha();
  const actualDeployedSha = deployedSha();
  await requirePreflight(client, expectedSha, actualDeployedSha);

  const before = await readTouchedRows(client);
  const timestamp = createTimestamp();
  const snapshot: ConfigSnapshot = {
    timestamp,
    createdAt: new Date().toISOString(),
    expectedMainSha: expectedSha,
    deployedSha: actualDeployedSha,
    rows: before,
  };
  const writtenSnapshotPath = writeSnapshot(snapshot);

  await client.query("BEGIN");
  try {
    await upsertTargetConfigs(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  const drift = await verifyTargets(client);
  const after = await readTouchedRows(client);
  printChangeSummary(before, after);
  console.log("\nVerification result");
  if (drift.length > 0) {
    console.log("FAIL");
    for (const issue of drift) console.log(`- ${issue}`);
    console.log(`Rollback: railway run -s <service> tsx scripts/set-migration-mode-config.ts --rollback ${writtenSnapshotPath}`);
    process.exitCode = 1;
    return;
  }
  console.log("PASS");
  console.log(`Snapshot: ${writtenSnapshotPath}`);
  console.log(`Rollback: railway run -s <service> tsx scripts/set-migration-mode-config.ts --rollback ${writtenSnapshotPath}`);
  console.log(`Expected next bidboard_stage_sync cycle: ${nextScheduledRunSummary()}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pool = new Pool({ connectionString: assertDatabaseUrl() });
  const client = await pool.connect();
  try {
    if (typeof args.rollback === "string") {
      await rollbackFromSnapshot(client, args.rollback);
      console.log(`[Migration Mode Config] Rollback complete from ${args.rollback}`);
      return;
    }
    await applyMigrationModeConfig(client);
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("set-migration-mode-config.ts")) {
  main().catch((error) => {
    console.error("[Migration Mode Config] Fatal:", error.message);
    process.exit(1);
  });
}
