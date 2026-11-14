import { beforeEach, describe, expect, it, vi } from "vitest";

// The Procore Bid Board stage sync is retired (Fable, 2026-11-14, on the owner's Procore retirement): T-Rock Core owns the Bid
// Board. runBidBoardStageSync returns at its first line, before any export, browser or push, whichever route calls it: the
// timers, a manual "Sync Now" and POST /api/bidboard/stage-sync all reach it here. Synthetic data only.
const m = vi.hoisted(() => ({
  log: vi.fn(),
  exportList: vi.fn(async () => "/srv/data/exports/bidboard-export-synthetic.xlsx"),
  parse: vi.fn(() => [{ Name: "Synthetic Job", Status: "Estimating", "Project #": "DFW-1-00001-aa" }]),
  diff: vi.fn(async () => []),
  pushCrm: vi.fn(async () => ({ ok: true, attempts: 1 })),
  pushCore: vi.fn(async () => {}),
  recordPush: vi.fn(async () => {}),
  access: vi.fn(async () => {}),
}));

vi.mock("../server/index", () => ({ log: m.log }));
vi.mock("../server/log.ts", () => ({ log: m.log }));
vi.mock("../server/storage", () => ({ storage: { hasSuccessfulBidboardStageSyncRun: vi.fn(async () => true) } }));
vi.mock("../server/playwright/bidboard-export", () => ({ exportBidBoardProjectList: m.exportList }));
vi.mock("../server/sync/bidboard-stage-sync", () => ({
  diffBidBoardStages: m.diff,
  parseActiveProjectsSheet: m.parse,
  syncStagesToHubSpot: vi.fn(async () => ({ updated: 0, failed: 0, errors: [] })),
}));
vi.mock("../server/sync/bidboard-crm-ingestion", () => ({ pushBidBoardRowsToCrm: m.pushCrm }));
vi.mock("../server/sync/bidboard-core-ingestion", () => ({ pushBidBoardRowsToCore: m.pushCore }));
vi.mock("../server/sync/bidboard-crm-alert", () => ({ recordPushOutcomeAndMaybeAlert: m.recordPush }));
vi.mock("fs/promises", () => ({
  writeFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  readdir: vi.fn(async () => [] as string[]),
  stat: vi.fn(async () => ({ mtime: new Date() })),
  unlink: vi.fn(async () => {}),
  access: m.access,
}));

const { runBidBoardStageSync } = await import("../server/sync/index.ts");
const { BID_BOARD_STAGE_SYNC_RETIRED_ERROR } = await import("../server/sync/procore-create-retired.ts");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the Procore Bid Board stage sync is retired", () => {
  it.each([
    ["a scheduled / Sync Now run (live)", { dryRun: false }],
    ["a dry run", { dryRun: true }],
    ["a forced export file", { dryRun: false, forceExport: "/srv/data/exports/forced-synthetic.xlsx" }],
  ] as const)("%s returns the retirement error and exports, parses and pushes NOTHING", async (_label, options) => {
    const result = await runBidBoardStageSync(options as any);

    expect(result.errors).toEqual([BID_BOARD_STAGE_SYNC_RETIRED_ERROR]);
    // A refused run FAILS (failed 1), so scripts/run-bidboard-stage-sync.ts (exit on failed > 0) exits non-zero for a cron / shell
    // caller (CodeRabbit on #137); nothing else is counted.
    expect({ total: result.total, changed: result.changed, failed: result.failed, changes: result.changes }).toEqual({
      total: 0,
      changed: 0,
      failed: 1,
      changes: [],
    });
    expect(m.exportList).not.toHaveBeenCalled();
    expect(m.access).not.toHaveBeenCalled();
    expect(m.parse).not.toHaveBeenCalled();
    expect(m.pushCrm).not.toHaveBeenCalled();
    expect(m.pushCore).not.toHaveBeenCalled();
    expect(m.recordPush).not.toHaveBeenCalled();
  });
});
