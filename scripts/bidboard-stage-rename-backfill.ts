#!/usr/bin/env -S npx tsx

import {
  BACKFILL_TRANSITIONS,
  createPgPool,
  parseArgs,
  parseRange,
  readSnapshotManifest,
  validateSnapshotManifest,
  type BackfillTransition,
  type Queryable,
  type TransactionClient,
} from "./bidboard-stage-rename-common";

export type BackfillOptions = {
  dryRun?: boolean;
  apply?: boolean;
  snapshotManifestPath?: string;
  expectedProductionRange?: [number, number];
  expectedLostRange?: [number, number];
};

export type BackfillResult = {
  mode: "dry-run" | "apply";
  countsByTransition: Record<string, number>;
  finalCountsByStage: Record<string, number>;
  totalProductionRows: number;
  totalLostRows: number;
  updatedRows: number;
};

async function getCountsByTransition(db: Queryable): Promise<Record<string, number>> {
  const stages = BACKFILL_TRANSITIONS.map((transition) => transition.oldStage);
  const result = await db.query<{ oldStage: string; count: number | string }>(
    `SELECT current_stage AS "oldStage", COUNT(*)::int AS count
     FROM bidboard_sync_state
     WHERE current_stage = ANY($1)
     GROUP BY current_stage`,
    [stages],
  );
  const counts = Object.fromEntries(BACKFILL_TRANSITIONS.map((transition) => [transition.oldStage, 0]));
  for (const row of result.rows) {
    counts[row.oldStage] = Number(row.count);
  }
  return counts;
}

function totalForBucket(counts: Record<string, number>, bucket: BackfillTransition["bucket"]): number {
  return BACKFILL_TRANSITIONS
    .filter((transition) => transition.bucket === bucket)
    .reduce((sum, transition) => sum + (counts[transition.oldStage] || 0), 0);
}

function assertInRange(label: string, value: number, range: [number, number]): void {
  const [min, max] = range;
  if (value < min || value > max) {
    throw new Error(`${label} row count ${value} outside expected range ${min}-${max}`);
  }
}

async function backfillTransition(db: Queryable, transition: BackfillTransition): Promise<number> {
  if (transition.newStage === "Contract") {
    throw new Error("Backfill may never write Contract");
  }

  const rows = await db.query<{ projectId: string; projectName: string | null }>(
    `SELECT project_id AS "projectId", project_name AS "projectName"
     FROM bidboard_sync_state
     WHERE current_stage = $1`,
    [transition.oldStage],
  );

  await db.query(
    `UPDATE bidboard_sync_state
     SET current_stage = $1
     WHERE current_stage = $2`,
    [transition.newStage, transition.oldStage],
  );

  for (const row of rows.rows) {
    await db.query(
      `INSERT INTO bidboard_automation_logs (project_id, project_name, action, status, details)
       VALUES ($1, $2, 'bidboard_stage_rename_backfill:row_updated', 'success', $3::jsonb)`,
      [
        row.projectId,
        row.projectName,
        {
          projectNumber: row.projectId,
          projectName: row.projectName,
          oldStage: transition.oldStage,
          newStage: transition.newStage,
        },
      ],
    );
  }

  return rows.rows.length;
}

export async function runBidBoardStageRenameBackfill(client: TransactionClient, options: BackfillOptions = {}): Promise<BackfillResult> {
  const apply = options.apply === true;
  if (apply && !options.snapshotManifestPath) {
    throw new Error("--snapshot-manifest is required when using --apply");
  }

  const countsByTransition = await getCountsByTransition(client);
  const totalProductionRows = totalForBucket(countsByTransition, "production");
  const totalLostRows = totalForBucket(countsByTransition, "lost");
  const result: BackfillResult = {
    mode: apply ? "apply" : "dry-run",
    countsByTransition,
    finalCountsByStage: {},
    totalProductionRows,
    totalLostRows,
    updatedRows: 0,
  };

  if (!apply) return result;

  assertInRange("Production", totalProductionRows, options.expectedProductionRange || [80, 95]);
  assertInRange("Lost", totalLostRows, options.expectedLostRange || [100, 115]);

  const manifest = readSnapshotManifest(options.snapshotManifestPath!);
  await validateSnapshotManifest(client, manifest);

  await client.query("BEGIN");
  try {
    for (const transition of BACKFILL_TRANSITIONS) {
      result.updatedRows += await backfillTransition(client, transition);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  result.finalCountsByStage = await getCountsByTransitionForStages(client, ["Won", "Lost"]);

  return result;
}

async function getCountsByTransitionForStages(db: Queryable, stages: string[]): Promise<Record<string, number>> {
  const result = await db.query<{ oldStage: string; count: number | string }>(
    `SELECT current_stage AS "oldStage", COUNT(*)::int AS count
     FROM bidboard_sync_state
     WHERE current_stage = ANY($1)
     GROUP BY current_stage`,
    [stages],
  );
  const counts = Object.fromEntries(stages.map((stage) => [stage, 0]));
  for (const row of result.rows) {
    counts[row.oldStage] = Number(row.count);
  }
  return counts;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apply = args.apply === true;
  const snapshotManifestPath = typeof args["snapshot-manifest"] === "string" ? args["snapshot-manifest"] : undefined;
  const pool = createPgPool();
  const client = await pool.connect();
  try {
    const result = await runBidBoardStageRenameBackfill(client, {
      apply,
      dryRun: !apply,
      snapshotManifestPath,
      expectedProductionRange: parseRange(typeof args["production-range"] === "string" ? args["production-range"] : undefined, [80, 95]),
      expectedLostRange: parseRange(typeof args["lost-range"] === "string" ? args["lost-range"] : undefined, [100, 115]),
    });
    console.log(`[BidBoard Stage Rename Backfill] Mode: ${result.mode}`);
    for (const [stage, count] of Object.entries(result.countsByTransition)) {
      console.log(`  ${stage}: ${count}`);
    }
    console.log(`Production rows -> Won: ${result.totalProductionRows}`);
    console.log(`Lost rows -> Lost: ${result.totalLostRows}`);
    console.log(`Updated rows: ${result.updatedRows}`);
    if (apply) {
      console.log(`Final Won rows: ${result.finalCountsByStage.Won ?? 0}`);
      console.log(`Final Lost rows: ${result.finalCountsByStage.Lost ?? 0}`);
    }
    if (!apply) {
      console.log("Next: run snapshot, then npx tsx scripts/bidboard-stage-rename-backfill.ts --apply --snapshot-manifest <manifest-path>");
    } else {
      console.log(`Rollback: npx tsx scripts/bidboard-stage-rename-rollback.ts --snapshot-manifest ${snapshotManifestPath}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("bidboard-stage-rename-backfill.ts")) {
  main().catch((error) => {
    console.error("[BidBoard Stage Rename Backfill] Fatal:", error.message);
    process.exit(1);
  });
}
