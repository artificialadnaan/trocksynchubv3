import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 68, 2026-10-15: the first Stage Sync run after the stale-export incident must be EXPORT-ONLY — download the
// fresh Bid Board file, log what it holds, push NOTHING (CRM paused: a push would 401 and alert; CRM restored:
// the first export would write deals before anyone looked at it).

const m = vi.hoisted(() => ({
  log: vi.fn(),
  exportList: vi.fn(async () => "/srv/data/exports/bidboard-export-2026-10-15T15-00-00-000Z.xlsx"),
  parse: vi.fn(() => [
    { Name: "Cedar Springs", Status: "Won", "Project #": "DFW-1-08926-aa" },
    { Name: "Roof repair", Status: "Estimating", "Project #": "DFW-4-14126-ai" },
    { Name: "No number yet", Status: "Estimating" },
  ]),
  diff: vi.fn(async () => []),
  pushCrm: vi.fn(async () => ({ ok: true, attempts: 1 })),
  pushCore: vi.fn(async () => {}),
  recordPush: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {}),
  readdir: vi.fn(async () => [] as string[]),
  unlink: vi.fn(async () => {}),
}));

vi.mock("../server/index", () => ({ log: m.log }));
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
  writeFile: m.writeFile,
  mkdir: vi.fn(async () => {}),
  readdir: m.readdir,
  stat: vi.fn(async () => ({ mtime: new Date() })),
  unlink: m.unlink,
  access: vi.fn(async () => {}),
}));

const prev = process.env.BIDBOARD_STAGE_SYNC_EXPORT_ONLY;
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  if (prev === undefined) delete process.env.BIDBOARD_STAGE_SYNC_EXPORT_ONLY;
  else process.env.BIDBOARD_STAGE_SYNC_EXPORT_ONLY = prev;
});

describe("BIDBOARD_STAGE_SYNC_EXPORT_ONLY", () => {
  it("downloads and summarises the fresh export, saves its rows, and pushes NOTHING (CRM, Core, HubSpot, alerts)", async () => {
    process.env.BIDBOARD_STAGE_SYNC_EXPORT_ONLY = "true";
    const { runBidBoardStageSync } = await import("../server/sync/index");
    const res = await runBidBoardStageSync({ dryRun: false });

    expect(m.exportList).toHaveBeenCalledTimes(1);
    expect(m.pushCrm).not.toHaveBeenCalled();
    expect(m.pushCore).not.toHaveBeenCalled();
    expect(m.recordPush).not.toHaveBeenCalled();
    expect(m.diff).not.toHaveBeenCalled();
    expect(res).toMatchObject({ exportOnly: true, exportPath: expect.stringMatching(/\.xlsx$/), total: 0, changed: 0 });

    const line = m.log.mock.calls.map((c) => String(c[0])).find((l) => /EXPORT-ONLY/.test(l));
    expect(line).toMatch(/3 rows/);
    expect(line).toMatch(/1 service \(-4-\)/);
    expect(line).toMatch(/Won: 1/);
    expect(line).toMatch(/NOTHING pushed/);

    expect(m.writeFile).toHaveBeenCalledTimes(1);
    const [file, body] = m.writeFile.mock.calls[0] as unknown as [string, string];
    expect(file).toMatch(/\.xlsx\.rows\.json$/);
    expect(JSON.parse(body)).toEqual([
      { projectNumber: "DFW-1-08926-aa", name: "Cedar Springs", status: "Won" },
      { projectNumber: "DFW-4-14126-ai", name: "Roof repair", status: "Estimating" },
      { projectNumber: null, name: "No number yet", status: "Estimating" },
    ]);
  });

  it("keeps only the newest exports AND their .rows.json snapshots, so a left-on switch can't fill the disk (Codex on #112)", async () => {
    process.env.BIDBOARD_STAGE_SYNC_EXPORT_ONLY = "true";
    const names = Array.from({ length: 8 }, (_, i) => `bidboard-export-2026-10-0${i + 1}T00-00-00-000Z.xlsx`);
    m.readdir.mockResolvedValue([...names, ...names.map((n) => `${n}.rows.json`)]);
    const { runBidBoardStageSync } = await import("../server/sync/index");
    await runBidBoardStageSync({ dryRun: false });
    const removed = m.unlink.mock.calls.map((c) => String(c[0]));
    expect(removed.filter((f) => f.endsWith(".xlsx"))).toHaveLength(3);
    expect(removed.filter((f) => f.endsWith(".rows.json"))).toHaveLength(3);
  });

  it("without the switch the pipeline pushes as before (the control)", async () => {
    delete process.env.BIDBOARD_STAGE_SYNC_EXPORT_ONLY;
    const { runBidBoardStageSync } = await import("../server/sync/index");
    await runBidBoardStageSync({ dryRun: true });
    expect(m.pushCrm).toHaveBeenCalledTimes(1);
  });
});
