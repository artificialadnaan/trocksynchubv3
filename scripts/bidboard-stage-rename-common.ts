import { execFileSync } from "child_process";
import { mkdirSync, readFileSync } from "fs";
import path from "path";
import pg from "pg";

const { Pool } = pg;

export type QueryResult<T = any> = { rows: T[]; rowCount?: number | null };
export type Queryable = {
  query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>>;
};

export type TransactionClient = Queryable & {
  release(): void;
};

export const SNAPSHOT_SOURCES = [
  "bidboard_sync_state",
  "stage_mappings",
  "automation_config",
  "sync_mappings",
] as const;

export type SnapshotSource = typeof SNAPSHOT_SOURCES[number];

export type SnapshotManifest = {
  timestamp: string;
  createdAt: string;
  gitSha: string | null;
  deployId: string | null;
  tables: Record<SnapshotSource, { snapshotTable: string; rowCount: number }>;
};

export type BackfillTransition = {
  oldStage: string;
  newStage: "Won" | "Lost";
  bucket: "production" | "lost";
};

export const BACKFILL_TRANSITIONS: BackfillTransition[] = [
  { oldStage: "Sent to Production", newStage: "Won", bucket: "production" },
  { oldStage: "Service - Sent to Production", newStage: "Won", bucket: "production" },
  { oldStage: "Service – Sent to Production", newStage: "Won", bucket: "production" },
  { oldStage: "Production Lost", newStage: "Lost", bucket: "lost" },
  { oldStage: "Service - Lost", newStage: "Lost", bucket: "lost" },
  { oldStage: "Service – Lost", newStage: "Lost", bucket: "lost" },
];

export function quoteIdent(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

export function createTimestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`;
}

export function getGitSha(): string | null {
  if (process.env.RENDER_GIT_COMMIT) return process.env.RENDER_GIT_COMMIT;
  if (process.env.RAILWAY_GIT_COMMIT_SHA) return process.env.RAILWAY_GIT_COMMIT_SHA;
  if (process.env.GIT_SHA) return process.env.GIT_SHA;
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export function getDeployId(): string | null {
  return process.env.RAILWAY_DEPLOYMENT_ID || process.env.RENDER_SERVICE_ID || process.env.DEPLOY_ID || null;
}

export async function countTable(db: Queryable, tableName: string): Promise<number> {
  const result = await db.query<{ count: number | string }>(`SELECT COUNT(*)::int AS count FROM ${quoteIdent(tableName)}`);
  return Number(result.rows[0]?.count ?? 0);
}

export async function snapshotTableExists(db: Queryable, tableName: string): Promise<boolean> {
  const result = await db.query<{ exists: string | null }>("SELECT to_regclass($1) AS exists", [tableName]);
  return Boolean(result.rows[0]?.exists);
}

export async function validateSnapshotManifest(db: Queryable, manifest: SnapshotManifest, includeSyncMappings = false): Promise<void> {
  const sources = includeSyncMappings ? SNAPSHOT_SOURCES : SNAPSHOT_SOURCES.filter((source) => source !== "sync_mappings");
  for (const source of sources) {
    const entry = manifest.tables[source];
    if (!entry) throw new Error(`Snapshot manifest missing table entry: ${source}`);
    if (!(await snapshotTableExists(db, entry.snapshotTable))) {
      throw new Error(`Snapshot table missing: ${entry.snapshotTable}`);
    }
    const snapshotCount = await countTable(db, entry.snapshotTable);
    if (snapshotCount !== entry.rowCount) {
      throw new Error(`Snapshot count mismatch for ${entry.snapshotTable}: manifest=${entry.rowCount}, actual=${snapshotCount}`);
    }
  }
}

export function readSnapshotManifest(manifestPath: string): SnapshotManifest {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as SnapshotManifest;
}

export function ensureManifestDir(manifestDir: string): void {
  mkdirSync(manifestDir, { recursive: true });
}

export function defaultManifestDir(): string {
  return path.resolve(process.cwd(), "bidboard-stage-rename-manifests");
}

export function parseRange(value: string | undefined, fallback: [number, number]): [number, number] {
  if (!value) return fallback;
  const [min, max] = value.split("-").map((part) => Number(part));
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
    throw new Error(`Invalid range: ${value}`);
  }
  return [min, max];
}

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

export function createPgPool(): pg.Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set");
  }
  return new Pool({ connectionString: process.env.DATABASE_URL });
}
