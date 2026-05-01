import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createBidBoardStageRenameSnapshot,
  type SnapshotManifest,
} from "../scripts/bidboard-stage-rename-snapshot";
import {
  runBidBoardStageRenameBackfill,
} from "../scripts/bidboard-stage-rename-backfill";
import {
  runBidBoardStageRenameRollback,
} from "../scripts/bidboard-stage-rename-rollback";

type Row = Record<string, any>;

class InMemoryRenameDb {
  tables: Record<string, Row[]>;
  private txBackup: Record<string, Row[]> | null = null;

  constructor(seed?: Partial<Record<string, Row[]>>) {
    this.tables = {
      bidboard_sync_state: [],
      stage_mappings: [],
      automation_config: [],
      sync_mappings: [],
      bidboard_automation_logs: [],
      ...seed,
    };
  }

  async query(sql: string, params: any[] = []) {
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (normalized === "BEGIN") {
      this.txBackup = this.cloneTables();
      return { rows: [], rowCount: 0 };
    }
    if (normalized === "COMMIT") {
      this.txBackup = null;
      return { rows: [], rowCount: 0 };
    }
    if (normalized === "ROLLBACK") {
      if (this.txBackup) this.tables = this.txBackup;
      this.txBackup = null;
      return { rows: [], rowCount: 0 };
    }

    const countMatch = normalized.match(/^SELECT COUNT\(\*\)::int AS count FROM "([^"]+)"$/);
    if (countMatch) {
      return { rows: [{ count: this.getTable(countMatch[1]).length }], rowCount: 1 };
    }

    const existsMatch = normalized.match(/^SELECT to_regclass\(\$1\) AS exists$/);
    if (existsMatch) {
      return { rows: [{ exists: this.tables[params[0]] ? params[0] : null }], rowCount: 1 };
    }

    const snapshotMatch = normalized.match(/^CREATE TABLE "([^"]+)" AS SELECT \* FROM "([^"]+)"$/);
    if (snapshotMatch) {
      this.tables[snapshotMatch[1]] = this.getTable(snapshotMatch[2]).map((row) => ({ ...row }));
      return { rows: [], rowCount: this.tables[snapshotMatch[1]].length };
    }

    if (normalized.startsWith("SELECT current_stage AS \"oldStage\"")) {
      const stages = params[0] as string[];
      const rows = stages
        .map((stage) => ({
          oldStage: stage,
          count: this.tables.bidboard_sync_state.filter((row) => row.current_stage === stage).length,
        }))
        .filter((row) => row.count > 0);
      return { rows, rowCount: rows.length };
    }

    if (normalized.startsWith("SELECT project_id AS \"projectId\"")) {
      const [oldStage] = params;
      const rows = this.tables.bidboard_sync_state
        .filter((row) => row.current_stage === oldStage)
        .map((row) => ({ projectId: row.project_id, projectName: row.project_name }));
      return { rows, rowCount: rows.length };
    }

    if (normalized.startsWith("UPDATE bidboard_sync_state SET current_stage")) {
      const [newStage, oldStage] = params;
      let count = 0;
      for (const row of this.tables.bidboard_sync_state) {
        if (row.current_stage === oldStage) {
          row.current_stage = newStage;
          count += 1;
        }
      }
      return { rows: [], rowCount: count };
    }

    if (normalized.startsWith("INSERT INTO bidboard_automation_logs")) {
      const [projectId, projectName, details] = params;
      this.tables.bidboard_automation_logs.push({
        project_id: projectId,
        project_name: projectName,
        action: "bidboard_stage_rename_backfill:row_updated",
        status: "success",
        details,
      });
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE bidboard_sync_state AS target")) {
      const snapshot = normalized.match(/FROM "([^"]+)" AS snapshot/)?.[1] || params[0];
      let count = 0;
      for (const target of this.tables.bidboard_sync_state) {
        const source = this.getTable(snapshot).find((row) => row.project_id === target.project_id);
        if (source) {
          Object.assign(target, { ...source });
          count += 1;
        }
      }
      return { rows: [], rowCount: count };
    }

    if (normalized.startsWith("UPDATE stage_mappings AS target")) {
      const snapshot = normalized.match(/FROM "([^"]+)" AS snapshot/)?.[1] || params[0];
      let count = 0;
      for (const target of this.tables.stage_mappings) {
        const source = this.getTable(snapshot).find((row) => row.id === target.id);
        if (source) {
          Object.assign(target, { ...source });
          count += 1;
        }
      }
      return { rows: [], rowCount: count };
    }

    if (normalized.startsWith("UPDATE automation_config AS target")) {
      const snapshot = normalized.match(/FROM "([^"]+)" AS snapshot/)?.[1] || params[0];
      let count = 0;
      for (const target of this.tables.automation_config) {
        const source = this.getTable(snapshot).find((row) => row.key === target.key);
        if (source) {
          Object.assign(target, { ...source });
          count += 1;
        }
      }
      return { rows: [], rowCount: count };
    }

    if (normalized.startsWith("UPDATE sync_mappings AS target")) {
      const snapshot = normalized.match(/FROM "([^"]+)" AS snapshot/)?.[1] || params[0];
      let count = 0;
      for (const target of this.tables.sync_mappings) {
        const source = this.getTable(snapshot).find((row) => row.id === target.id);
        if (source) {
          Object.assign(target, { ...source });
          count += 1;
        }
      }
      return { rows: [], rowCount: count };
    }

    throw new Error(`Unhandled SQL in test DB: ${normalized}`);
  }

  private getTable(name: string) {
    if (!this.tables[name]) throw new Error(`Table not found: ${name}`);
    return this.tables[name];
  }

  private cloneTables() {
    return Object.fromEntries(
      Object.entries(this.tables).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))])
    );
  }
}

function makeRows() {
  return [
    { project_id: "P-1", project_name: "Prod 1", current_stage: "Sent to Production", last_checked_at: "real-check", last_changed_at: "real-change" },
    { project_id: "P-2", project_name: "Prod 2", current_stage: "Service - Sent to Production", last_checked_at: "real-check", last_changed_at: "real-change" },
    { project_id: "P-3", project_name: "Prod 3", current_stage: "Service – Sent to Production", last_checked_at: "real-check", last_changed_at: "real-change" },
    { project_id: "L-1", project_name: "Lost 1", current_stage: "Production Lost", last_checked_at: "lost-check", last_changed_at: "lost-change" },
    { project_id: "L-2", project_name: "Lost 2", current_stage: "Service - Lost", last_checked_at: "lost-check", last_changed_at: "lost-change" },
    { project_id: "L-3", project_name: "Lost 3", current_stage: "Service – Lost", last_checked_at: "lost-check", last_changed_at: "lost-change" },
    { project_id: "E-1", project_name: "Estimating", current_stage: "Estimate in Progress", last_checked_at: "est-check", last_changed_at: "est-change" },
  ];
}

function tempManifestDir() {
  return mkdtempSync(path.join(tmpdir(), "bidboard-rename-test-"));
}

describe("BidBoard stage rename operational scripts", () => {
  let dir: string;

  beforeEach(() => {
    dir = tempManifestDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates snapshot tables and writes a manifest with matching counts", async () => {
    const db = new InMemoryRenameDb({
      bidboard_sync_state: makeRows(),
      stage_mappings: [{ id: 1, procore_stage_label: "Contract" }],
      automation_config: [{ id: 1, key: "bidboard_stage_sync", value: { mode: "migration" } }],
      sync_mappings: [{ id: 1, bidboard_project_id: "P-1" }],
    });

    const result = await createBidBoardStageRenameSnapshot(db, {
      timestamp: "20260501_1305",
      manifestDir: dir,
      gitSha: "test-sha",
      deployId: "test-deploy",
    });

    expect(db.tables.bidboard_sync_state_snapshot_20260501_1305).toHaveLength(7);
    expect(result.manifest.tables.bidboard_sync_state.rowCount).toBe(7);
    expect(result.manifest.gitSha).toBe("test-sha");
    expect(result.manifest.deployId).toBe("test-deploy");
    expect(JSON.parse(readFileSync(result.manifestPath, "utf8"))).toMatchObject({
      timestamp: "20260501_1305",
      gitSha: "test-sha",
      tables: {
        bidboard_sync_state: { rowCount: 7 },
      },
    });
  });

  it("dry-runs backfill with exact counts and no writes", async () => {
    const db = new InMemoryRenameDb({ bidboard_sync_state: makeRows() });

    const result = await runBidBoardStageRenameBackfill(db, { dryRun: true });

    expect(result.mode).toBe("dry-run");
    expect(result.totalProductionRows).toBe(3);
    expect(result.totalLostRows).toBe(3);
    expect(db.tables.bidboard_sync_state.map((row) => row.current_stage)).toContain("Sent to Production");
    expect(db.tables.bidboard_automation_logs).toHaveLength(0);
  });

  it("applies mandatory production-to-Won and lost-to-Lost backfill with a valid manifest", async () => {
    const db = new InMemoryRenameDb({
      bidboard_sync_state: makeRows(),
      stage_mappings: [{ id: 1 }],
      automation_config: [{ key: "bidboard_automation" }],
      sync_mappings: [],
    });
    const snapshot = await createBidBoardStageRenameSnapshot(db, {
      timestamp: "20260501_1310",
      manifestDir: dir,
      gitSha: "test-sha",
    });

    const result = await runBidBoardStageRenameBackfill(db, {
      apply: true,
      snapshotManifestPath: snapshot.manifestPath,
      expectedProductionRange: [1, 10],
      expectedLostRange: [1, 10],
    });

    expect(result.mode).toBe("apply");
    expect(result.updatedRows).toBe(6);
    expect(db.tables.bidboard_sync_state.filter((row) => row.current_stage === "Won")).toHaveLength(3);
    expect(db.tables.bidboard_sync_state.filter((row) => row.current_stage === "Lost")).toHaveLength(3);
    expect(db.tables.bidboard_sync_state.find((row) => row.project_id === "E-1")?.current_stage).toBe("Estimate in Progress");
    expect(db.tables.bidboard_sync_state.find((row) => row.project_id === "P-1")?.last_checked_at).toBe("real-check");
    expect(db.tables.bidboard_automation_logs).toHaveLength(6);
  });

  it("refuses apply without a snapshot manifest", async () => {
    const db = new InMemoryRenameDb({ bidboard_sync_state: makeRows() });

    await expect(runBidBoardStageRenameBackfill(db, { apply: true })).rejects.toThrow("--snapshot-manifest");
  });

  it("aborts backfill when row counts drift outside the expected range", async () => {
    const db = new InMemoryRenameDb({
      bidboard_sync_state: makeRows(),
      stage_mappings: [],
      automation_config: [],
      sync_mappings: [],
    });
    const snapshot = await createBidBoardStageRenameSnapshot(db, {
      timestamp: "20260501_1315",
      manifestDir: dir,
      gitSha: "test-sha",
    });

    await expect(runBidBoardStageRenameBackfill(db, {
      apply: true,
      snapshotManifestPath: snapshot.manifestPath,
      expectedProductionRange: [80, 95],
      expectedLostRange: [100, 115],
    })).rejects.toThrow("outside expected range");
  });

  it("never writes Contract under any backfill input", async () => {
    const db = new InMemoryRenameDb({
      bidboard_sync_state: [
        ...makeRows(),
        { project_id: "C-1", project_name: "Already Contract", current_stage: "Contract" },
      ],
      stage_mappings: [],
      automation_config: [],
      sync_mappings: [],
    });
    const snapshot = await createBidBoardStageRenameSnapshot(db, {
      timestamp: "20260501_1320",
      manifestDir: dir,
      gitSha: "test-sha",
    });

    await runBidBoardStageRenameBackfill(db, {
      apply: true,
      snapshotManifestPath: snapshot.manifestPath,
      expectedProductionRange: [1, 10],
      expectedLostRange: [1, 10],
    });

    const contractRows = db.tables.bidboard_sync_state.filter((row) => row.current_stage === "Contract");
    expect(contractRows).toHaveLength(1);
    expect(contractRows[0].project_id).toBe("C-1");
  });

  it("restores bidboard_sync_state, stage_mappings, and automation_config from snapshot state", async () => {
    const db = new InMemoryRenameDb({
      bidboard_sync_state: makeRows(),
      stage_mappings: [{ id: 1, procore_stage_label: "Old" }],
      automation_config: [{ id: 1, key: "bidboard_automation", value: { enabled: false } }],
      sync_mappings: [{ id: 1, bidboard_project_id: "P-1", project_phase: "bidboard" }],
    });
    const snapshot = await createBidBoardStageRenameSnapshot(db, {
      timestamp: "20260501_1325",
      manifestDir: dir,
      gitSha: "test-sha",
    });
    db.tables.bidboard_sync_state[0].current_stage = "Won";
    db.tables.stage_mappings[0].procore_stage_label = "Changed";
    db.tables.automation_config[0].value = { enabled: true };
    db.tables.sync_mappings[0].project_phase = "portfolio";

    const result = await runBidBoardStageRenameRollback(db, { snapshotManifestPath: snapshot.manifestPath });

    expect(result.restored.bidboard_sync_state).toBe(7);
    expect(db.tables.bidboard_sync_state[0].current_stage).toBe("Sent to Production");
    expect(db.tables.stage_mappings[0].procore_stage_label).toBe("Old");
    expect(db.tables.automation_config[0].value).toEqual({ enabled: false });
    expect(db.tables.sync_mappings[0].project_phase).toBe("portfolio");
  });

  it("refuses rollback when snapshot tables are missing", async () => {
    const db = new InMemoryRenameDb({ bidboard_sync_state: makeRows() });
    const manifest: SnapshotManifest = {
      timestamp: "20260501_1330",
      createdAt: new Date().toISOString(),
      gitSha: "test-sha",
      deployId: null,
      tables: {
        bidboard_sync_state: { snapshotTable: "missing_bidboard_snapshot", rowCount: 7 },
        stage_mappings: { snapshotTable: "missing_stage_snapshot", rowCount: 0 },
        automation_config: { snapshotTable: "missing_config_snapshot", rowCount: 0 },
        sync_mappings: { snapshotTable: "missing_sync_snapshot", rowCount: 0 },
      },
    };
    const manifestPath = path.join(dir, "missing.json");
    await import("fs").then((fs) => fs.writeFileSync(manifestPath, JSON.stringify(manifest)));

    await expect(runBidBoardStageRenameRollback(db, { snapshotManifestPath: manifestPath })).rejects.toThrow("Snapshot table missing");
  });
});
