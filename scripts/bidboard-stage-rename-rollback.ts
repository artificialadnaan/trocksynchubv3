#!/usr/bin/env npx tsx

import {
  createPgPool,
  parseArgs,
  quoteIdent,
  readSnapshotManifest,
  validateSnapshotManifest,
  type Queryable,
  type TransactionClient,
} from "./bidboard-stage-rename-common";

export type RollbackOptions = {
  snapshotManifestPath: string;
  includeSyncMappings?: boolean;
};

export type RollbackResult = {
  restored: {
    bidboard_sync_state: number;
    stage_mappings: number;
    automation_config: number;
    sync_mappings?: number;
  };
};

async function restoreBidboardSyncState(db: Queryable, snapshotTable: string): Promise<number> {
  const result = await db.query(
    `UPDATE bidboard_sync_state AS target
     SET
       project_name = snapshot.project_name,
       current_stage = snapshot.current_stage,
       last_checked_at = snapshot.last_checked_at,
       last_changed_at = snapshot.last_changed_at,
       metadata = snapshot.metadata
     FROM ${quoteIdent(snapshotTable)} AS snapshot
     WHERE target.project_id = snapshot.project_id`,
  );
  return result.rowCount || 0;
}

async function restoreStageMappings(db: Queryable, snapshotTable: string): Promise<number> {
  const result = await db.query(
    `UPDATE stage_mappings AS target
     SET
       hubspot_stage = snapshot.hubspot_stage,
       hubspot_stage_label = snapshot.hubspot_stage_label,
       procore_stage = snapshot.procore_stage,
       procore_stage_label = snapshot.procore_stage_label,
       direction = snapshot.direction,
       is_active = snapshot.is_active,
       sort_order = snapshot.sort_order,
       trigger_portfolio = snapshot.trigger_portfolio,
       created_at = snapshot.created_at
     FROM ${quoteIdent(snapshotTable)} AS snapshot
     WHERE target.id = snapshot.id`,
  );
  return result.rowCount || 0;
}

async function restoreAutomationConfig(db: Queryable, snapshotTable: string): Promise<number> {
  const result = await db.query(
    `UPDATE automation_config AS target
     SET
       value = snapshot.value,
       description = snapshot.description,
       is_active = snapshot.is_active,
       updated_at = snapshot.updated_at
     FROM ${quoteIdent(snapshotTable)} AS snapshot
     WHERE target.key = snapshot.key`,
  );
  return result.rowCount || 0;
}

async function restoreSyncMappings(db: Queryable, snapshotTable: string): Promise<number> {
  const result = await db.query(
    `UPDATE sync_mappings AS target
     SET
       hubspot_deal_id = snapshot.hubspot_deal_id,
       hubspot_company_id = snapshot.hubspot_company_id,
       procore_project_id = snapshot.procore_project_id,
       procore_company_id = snapshot.procore_company_id,
       companycam_project_id = snapshot.companycam_project_id,
       hubspot_deal_name = snapshot.hubspot_deal_name,
       procore_project_name = snapshot.procore_project_name,
       procore_project_number = snapshot.procore_project_number,
       bidboard_project_id = snapshot.bidboard_project_id,
       bidboard_project_name = snapshot.bidboard_project_name,
       portfolio_project_id = snapshot.portfolio_project_id,
       portfolio_project_name = snapshot.portfolio_project_name,
       project_phase = snapshot.project_phase,
       sent_to_portfolio_at = snapshot.sent_to_portfolio_at,
       last_sync_at = snapshot.last_sync_at,
       last_sync_status = snapshot.last_sync_status,
       last_sync_direction = snapshot.last_sync_direction,
       metadata = snapshot.metadata,
       created_at = snapshot.created_at
     FROM ${quoteIdent(snapshotTable)} AS snapshot
     WHERE target.id = snapshot.id`,
  );
  return result.rowCount || 0;
}

export async function runBidBoardStageRenameRollback(client: TransactionClient, options: RollbackOptions): Promise<RollbackResult> {
  if (!options.snapshotManifestPath) {
    throw new Error("--snapshot-manifest is required");
  }
  const manifest = readSnapshotManifest(options.snapshotManifestPath);
  await validateSnapshotManifest(client, manifest, options.includeSyncMappings === true);

  await client.query("BEGIN");
  try {
    const restored: RollbackResult["restored"] = {
      bidboard_sync_state: await restoreBidboardSyncState(client, manifest.tables.bidboard_sync_state.snapshotTable),
      stage_mappings: await restoreStageMappings(client, manifest.tables.stage_mappings.snapshotTable),
      automation_config: await restoreAutomationConfig(client, manifest.tables.automation_config.snapshotTable),
    };
    if (options.includeSyncMappings) {
      restored.sync_mappings = await restoreSyncMappings(client, manifest.tables.sync_mappings.snapshotTable);
    }
    await client.query("COMMIT");
    return { restored };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const snapshotManifestPath = typeof args["snapshot-manifest"] === "string" ? args["snapshot-manifest"] : undefined;
  if (!snapshotManifestPath) throw new Error("--snapshot-manifest is required");
  const includeSyncMappings = args["include-sync-mappings"] === true;
  const pool = createPgPool();
  const client = await pool.connect();
  try {
    const result = await runBidBoardStageRenameRollback(client, { snapshotManifestPath, includeSyncMappings });
    console.log("[BidBoard Stage Rename Rollback] Restore complete");
    for (const [table, count] of Object.entries(result.restored)) {
      console.log(`  ${table}: ${count} rows restored`);
    }
    console.log("Next: verify BidBoard stage sync in migration mode before resuming rollout.");
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("bidboard-stage-rename-rollback.ts")) {
  main().catch((error) => {
    console.error("[BidBoard Stage Rename Rollback] Fatal:", error.message);
    process.exit(1);
  });
}
