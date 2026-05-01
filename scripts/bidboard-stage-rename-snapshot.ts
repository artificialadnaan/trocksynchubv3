#!/usr/bin/env -S npx tsx

import path from "path";
import { writeFileSync } from "fs";
import {
  countTable,
  createPgPool,
  createTimestamp,
  defaultManifestDir,
  ensureManifestDir,
  getDeployId,
  getGitSha,
  parseArgs,
  quoteIdent,
  SNAPSHOT_SOURCES,
  type Queryable,
  type SnapshotManifest,
} from "./bidboard-stage-rename-common";

export type { SnapshotManifest } from "./bidboard-stage-rename-common";

export type SnapshotOptions = {
  timestamp?: string;
  manifestDir?: string;
  gitSha?: string | null;
  deployId?: string | null;
};

export async function createBidBoardStageRenameSnapshot(db: Queryable, options: SnapshotOptions = {}) {
  const timestamp = options.timestamp || createTimestamp();
  const manifestDir = options.manifestDir || defaultManifestDir();
  ensureManifestDir(manifestDir);

  const manifest: SnapshotManifest = {
    timestamp,
    createdAt: new Date().toISOString(),
    gitSha: options.gitSha ?? getGitSha(),
    deployId: options.deployId ?? getDeployId(),
    tables: {} as SnapshotManifest["tables"],
  };

  for (const source of SNAPSHOT_SOURCES) {
    const snapshotTable = `${source}_snapshot_${timestamp}`;
    const sourceCount = await countTable(db, source);
    await db.query(`CREATE TABLE ${quoteIdent(snapshotTable)} AS SELECT * FROM ${quoteIdent(source)}`);
    const snapshotCount = await countTable(db, snapshotTable);
    if (sourceCount !== snapshotCount) {
      throw new Error(`Snapshot count mismatch for ${source}: source=${sourceCount}, snapshot=${snapshotCount}`);
    }
    manifest.tables[source] = { snapshotTable, rowCount: sourceCount };
  }

  const manifestPath = path.join(manifestDir, `bidboard-stage-rename-manifest-${timestamp}.json`);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return { manifest, manifestPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pool = createPgPool();
  try {
    const result = await createBidBoardStageRenameSnapshot(pool, {
      manifestDir: typeof args["manifest-dir"] === "string" ? args["manifest-dir"] : undefined,
    });
    console.log("[BidBoard Stage Rename Snapshot] Snapshot complete");
    console.log(`Manifest: ${result.manifestPath}`);
    for (const [source, entry] of Object.entries(result.manifest.tables)) {
      console.log(`  ${source}: ${entry.rowCount} rows -> ${entry.snapshotTable}`);
    }
    console.log(`Next: npx tsx scripts/bidboard-stage-rename-backfill.ts --apply --snapshot-manifest ${result.manifestPath}`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("bidboard-stage-rename-snapshot.ts")) {
  main().catch((error) => {
    console.error("[BidBoard Stage Rename Snapshot] Fatal:", error.message);
    process.exit(1);
  });
}
