#!/usr/bin/env -S npx tsx

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import pg from "pg";
import { createTimestamp } from "./bidboard-stage-rename-common";
import { deepSemanticEqual } from "./set-migration-mode-config";

const { Pool } = pg;

const CANARY_PROJECT_NUMBER = "DFW-1-12126-ad";

type ConfigRow = {
  key: string;
  value: Record<string, unknown>;
  description: string | null;
  is_active: boolean | null;
};

type Snapshot = {
  timestamp: string;
  createdAt: string;
  rows: ConfigRow[];
};

function assertDatabaseUrl(): string {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
  return process.env.DATABASE_URL;
}

function snapshotPath(timestamp: string): string {
  return path.resolve(process.cwd(), "logs", `config-snapshot-pre-canary-${timestamp}.json`);
}

async function readConfigRows(client: pg.PoolClient): Promise<ConfigRow[]> {
  const rows = await client.query<ConfigRow>(
    `SELECT key, value, description, is_active
     FROM automation_config
     ORDER BY key`
  );
  return rows.rows;
}

async function requirePreflight(client: pg.PoolClient): Promise<{
  stageSync: Record<string, unknown>;
  portfolioTrigger: Record<string, unknown>;
  triggerRows: Array<{ procore_stage_label: string; hubspot_stage_label: string; trigger_portfolio: boolean }>;
}> {
  const configRows = await client.query<{ key: string; value: Record<string, unknown> }>(
    `SELECT key, value
     FROM automation_config
     WHERE key IN ('bidboard_stage_sync', 'bidboard_portfolio_trigger')`
  );
  const configs = new Map(configRows.rows.map((row) => [row.key, row.value]));
  const stageSync = configs.get("bidboard_stage_sync");
  const portfolioTrigger = configs.get("bidboard_portfolio_trigger");
  if (!stageSync) throw new Error("Missing automation_config row: bidboard_stage_sync");
  if (!portfolioTrigger) throw new Error("Missing automation_config row: bidboard_portfolio_trigger");
  if (stageSync.mode !== "migration") throw new Error(`bidboard_stage_sync.mode is not migration: ${stageSync.mode}`);
  if (stageSync.suppressHubSpotWrites !== true) throw new Error("bidboard_stage_sync.suppressHubSpotWrites is not true");
  if (stageSync.suppressStageNotifications !== true) throw new Error("bidboard_stage_sync.suppressStageNotifications is not true");
  if (portfolioTrigger.enabled !== false) throw new Error(`bidboard_portfolio_trigger.enabled is not false: ${portfolioTrigger.enabled}`);

  const triggerRows = await client.query<{
    procore_stage_label: string;
    hubspot_stage_label: string;
    trigger_portfolio: boolean;
  }>(
    `SELECT procore_stage_label, hubspot_stage_label, trigger_portfolio
     FROM stage_mappings
     WHERE direction = 'bidboard_to_hubspot'
       AND is_active = true
       AND trigger_portfolio = true
     ORDER BY procore_stage_label, hubspot_stage_label`
  );
  const allowedTriggerStages = new Set(["Won", "Sent to Production", "Service - Sent to Production"]);
  const invalidTrigger = triggerRows.rows.find((row) => !allowedTriggerStages.has(row.procore_stage_label));
  if (invalidTrigger) {
    throw new Error(
      `Unexpected triggerPortfolio stage: ${invalidTrigger.procore_stage_label} -> ${invalidTrigger.hubspot_stage_label}`
    );
  }
  if (!triggerRows.rows.some((row) => row.procore_stage_label === "Won")) {
    throw new Error("Won is not currently configured as a triggerPortfolio stage");
  }

  return { stageSync, portfolioTrigger, triggerRows: triggerRows.rows };
}

function writeSnapshot(rows: ConfigRow[]): string {
  const timestamp = createTimestamp();
  const outputPath = snapshotPath(timestamp);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  const snapshot: Snapshot = {
    timestamp,
    createdAt: new Date().toISOString(),
    rows,
  };
  writeFileSync(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  return outputPath;
}

function mergeStageSyncConfig(value: Record<string, unknown>): Record<string, unknown> {
  return {
    ...value,
    mode: "migration",
    suppressHubSpotWrites: true,
    suppressPortfolioTriggers: false,
    suppressStageNotifications: true,
  };
}

function mergePortfolioTriggerConfig(value: Record<string, unknown>): Record<string, unknown> {
  return {
    ...value,
    enabled: false,
    allowlist: [CANARY_PROJECT_NUMBER],
  };
}

async function applyConfig(client: pg.PoolClient, before: ConfigRow[]): Promise<{
  expectedStageSync: Record<string, unknown>;
  expectedPortfolioTrigger: Record<string, unknown>;
}> {
  const beforeByKey = new Map(before.map((row) => [row.key, row]));
  const stageSync = beforeByKey.get("bidboard_stage_sync");
  const portfolioTrigger = beforeByKey.get("bidboard_portfolio_trigger");
  if (!stageSync) throw new Error("Missing snapshot row: bidboard_stage_sync");
  if (!portfolioTrigger) throw new Error("Missing snapshot row: bidboard_portfolio_trigger");

  const expectedStageSync = mergeStageSyncConfig(stageSync.value);
  const expectedPortfolioTrigger = mergePortfolioTriggerConfig(portfolioTrigger.value);

  await client.query(
    `UPDATE automation_config
     SET value = $2::jsonb, updated_at = NOW()
     WHERE key = $1`,
    ["bidboard_stage_sync", JSON.stringify(expectedStageSync)]
  );
  await client.query(
    `UPDATE automation_config
     SET value = $2::jsonb, updated_at = NOW()
     WHERE key = $1`,
    ["bidboard_portfolio_trigger", JSON.stringify(expectedPortfolioTrigger)]
  );

  return { expectedStageSync, expectedPortfolioTrigger };
}

async function verifyConfig(
  client: pg.PoolClient,
  expectedStageSync: Record<string, unknown>,
  expectedPortfolioTrigger: Record<string, unknown>
): Promise<string[]> {
  const rows = await client.query<{ key: string; value: Record<string, unknown> }>(
    `SELECT key, value
     FROM automation_config
     WHERE key IN ('bidboard_stage_sync', 'bidboard_portfolio_trigger')`
  );
  const byKey = new Map(rows.rows.map((row) => [row.key, row.value]));
  const drift: string[] = [];
  const actualStageSync = byKey.get("bidboard_stage_sync");
  const actualPortfolioTrigger = byKey.get("bidboard_portfolio_trigger");

  if (!deepSemanticEqual(actualStageSync, expectedStageSync)) {
    drift.push(`bidboard_stage_sync drift actual=${JSON.stringify(actualStageSync)} expected=${JSON.stringify(expectedStageSync)}`);
  }
  if (!deepSemanticEqual(actualPortfolioTrigger, expectedPortfolioTrigger)) {
    drift.push(`bidboard_portfolio_trigger drift actual=${JSON.stringify(actualPortfolioTrigger)} expected=${JSON.stringify(expectedPortfolioTrigger)}`);
  }
  if (actualStageSync?.suppressPortfolioTriggers !== false) drift.push("bidboard_stage_sync.suppressPortfolioTriggers is not false");
  if (actualStageSync?.suppressHubSpotWrites !== true) drift.push("bidboard_stage_sync.suppressHubSpotWrites is not true");
  if (actualStageSync?.suppressStageNotifications !== true) drift.push("bidboard_stage_sync.suppressStageNotifications is not true");
  if (actualPortfolioTrigger?.enabled !== false) drift.push("bidboard_portfolio_trigger.enabled is not false");
  if (!deepSemanticEqual(actualPortfolioTrigger?.allowlist, [CANARY_PROJECT_NUMBER])) {
    drift.push(`bidboard_portfolio_trigger.allowlist is not exactly ${JSON.stringify([CANARY_PROJECT_NUMBER])}`);
  }

  return drift;
}

async function rollbackFromSnapshot(client: pg.PoolClient, filePath: string): Promise<void> {
  const snapshot = JSON.parse(readFileSync(filePath, "utf8")) as Snapshot;
  await client.query("BEGIN");
  try {
    for (const row of snapshot.rows) {
      await client.query(
        `UPDATE automation_config
         SET value = $2::jsonb,
             description = $3,
             is_active = $4,
             updated_at = NOW()
         WHERE key = $1`,
        [row.key, JSON.stringify(row.value), row.description, row.is_active]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  const rollbackArg = process.argv.find((arg) => arg.startsWith("--rollback="));
  const pool = new Pool({ connectionString: assertDatabaseUrl() });
  const client = await pool.connect();
  try {
    if (rollbackArg) {
      const filePath = rollbackArg.slice("--rollback=".length);
      await rollbackFromSnapshot(client, filePath);
      console.log(JSON.stringify({ status: "rolled_back", snapshotPath: filePath }, null, 2));
      return;
    }

    const preflight = await requirePreflight(client);
    const before = await readConfigRows(client);
    const outputPath = writeSnapshot(before);
    await client.query("BEGIN");
    let expectedStageSync: Record<string, unknown>;
    let expectedPortfolioTrigger: Record<string, unknown>;
    try {
      ({ expectedStageSync, expectedPortfolioTrigger } = await applyConfig(client, before));
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    const drift = await verifyConfig(client, expectedStageSync!, expectedPortfolioTrigger!);
    const after = await readConfigRows(client);
    const afterByKey = new Map(after.map((row) => [row.key, row]));
    const beforeByKey = new Map(before.map((row) => [row.key, row]));
    const changedKeys = ["bidboard_stage_sync", "bidboard_portfolio_trigger"].map((key) => ({
      key,
      before: beforeByKey.get(key)?.value ?? null,
      after: afterByKey.get(key)?.value ?? null,
    }));

    console.log(JSON.stringify({
      status: drift.length === 0 ? "PASS" : "FAIL",
      snapshotPath: outputPath,
      preflight: {
        migrationMode: preflight.stageSync.mode,
        portfolioTriggerEnabled: preflight.portfolioTrigger.enabled,
        triggerRows: preflight.triggerRows,
      },
      changedKeys,
      drift,
      preserved: "All other automation_config keys untouched",
      rollbackCommand: `railway run -s trocksynchubv3 -- npx tsx scripts/set-bidboard-canary-config.ts --rollback=${outputPath}`,
    }, null, 2));

    if (drift.length > 0) process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("set-bidboard-canary-config.ts")) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: "ERROR", error: error.message }, null, 2));
    process.exit(1);
  });
}
