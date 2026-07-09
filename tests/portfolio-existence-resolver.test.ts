import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module-level mocks — must come before any server-module imports so that
// server/db.ts (which throws on missing DATABASE_URL) is never evaluated.
// This is the standard pattern in this repo (see portfolio-automation-guardrails.test.ts,
// bidboard-to-portfolio.test.ts, etc.).
// ---------------------------------------------------------------------------

vi.mock("../server/db.ts", () => ({ db: {}, pool: {} }));

vi.mock("../server/storage.ts", () => ({
  storage: {
    getProcoreProjectByNumber: vi.fn(),
    getSyncMappingByBidboardProjectId: vi.fn(),
    updateSyncMapping: vi.fn(),
    createAuditLog: vi.fn(),
  },
}));

import {
  resolveExistingPortfolioProject,
  decidePortfolioCreateAction,
  handlePortfolioCreateGate,
  type PortfolioExistenceResult,
} from "../server/portfolio-existence-resolver";

function makeDeps(over: Partial<{
  cacheRow: any;
  liveResult: PortfolioExistenceResult | Error;
  mapping: any;
}> = {}) {
  const calls: any = { updateSyncMapping: [], createAuditLog: [] };
  const deps = {
    getProcoreProjectByNumber: vi.fn(async () => over.cacheRow),
    liveConfirmByNumber: vi.fn(async () => {
      if (over.liveResult instanceof Error) throw over.liveResult;
      return over.liveResult ?? ({ exists: false } as PortfolioExistenceResult);
    }),
    getSyncMappingByBidboardProjectId: vi.fn(async () => over.mapping),
    updateSyncMapping: vi.fn(async (id: number, patch: any) => { calls.updateSyncMapping.push({ id, patch }); }),
    createAuditLog: vi.fn(async (row: any) => { calls.createAuditLog.push(row); }),
  };
  return { deps, calls };
}

const BASE = { companyId: "12345", procoreProjectNumber: "DFW-4-08226-aa", bidboardProjectId: "562949955660910" };

describe("resolveExistingPortfolioProject", () => {
  it("cache hit → exists:true (source cache), no live call", async () => {
    const { deps } = makeDeps({ cacheRow: { procoreId: "999" } });
    const r = await resolveExistingPortfolioProject(BASE, deps);
    expect(r).toEqual({ exists: true, portfolioProjectId: "999", source: "cache" });
    expect(deps.liveConfirmByNumber).not.toHaveBeenCalled();
  });

  it("cache miss → live hit → exists:true (source live)", async () => {
    const { deps } = makeDeps({ cacheRow: undefined, liveResult: { exists: true, portfolioProjectId: "888", source: "live" } });
    const r = await resolveExistingPortfolioProject(BASE, deps);
    expect(r).toEqual({ exists: true, portfolioProjectId: "888", source: "live" });
  });

  it("cache miss → live authoritative not-found → exists:false", async () => {
    const { deps } = makeDeps({ cacheRow: undefined, liveResult: { exists: false } });
    expect(await resolveExistingPortfolioProject(BASE, deps)).toEqual({ exists: false });
  });

  it("cache miss → live error → exists:unknown (never throws)", async () => {
    const { deps } = makeDeps({ cacheRow: undefined, liveResult: new Error("procore down") });
    const r = await resolveExistingPortfolioProject(BASE, deps);
    expect(r.exists).toBe("unknown");
  });

  it("blank project number → exists:unknown (fail-closed, no lookups)", async () => {
    const { deps } = makeDeps({});
    const r = await resolveExistingPortfolioProject({ ...BASE, procoreProjectNumber: "  " }, deps);
    expect(r.exists).toBe("unknown");
    expect(deps.getProcoreProjectByNumber).not.toHaveBeenCalled();
  });
});

describe("decidePortfolioCreateAction", () => {
  it("true → skip, false → create, unknown → abort", () => {
    expect(decidePortfolioCreateAction({ exists: true, portfolioProjectId: "1", source: "cache" })).toBe("skip");
    expect(decidePortfolioCreateAction({ exists: false })).toBe("create");
    expect(decidePortfolioCreateAction({ exists: "unknown", reason: "x" })).toBe("abort");
  });
});

describe("handlePortfolioCreateGate", () => {
  it("exists → action skip + self-heal writes portfolio_project_id when unset", async () => {
    const { deps, calls } = makeDeps({ cacheRow: { procoreId: "999" }, mapping: { id: 7, portfolioProjectId: null } });
    const out = await handlePortfolioCreateGate(BASE, deps);
    expect(out.action).toBe("skip");
    expect(out.portfolioProjectId).toBe("999");
    expect(calls.updateSyncMapping).toEqual([{ id: 7, patch: { portfolioProjectId: "999" } }]);
    expect(calls.createAuditLog).toHaveLength(0);
  });

  it("exists but mapping already has portfolio_project_id → skip, no redundant write", async () => {
    const { deps, calls } = makeDeps({ cacheRow: { procoreId: "999" }, mapping: { id: 7, portfolioProjectId: "999" } });
    const out = await handlePortfolioCreateGate(BASE, deps);
    expect(out.action).toBe("skip");
    expect(calls.updateSyncMapping).toHaveLength(0);
  });

  it("false → action create, no writes", async () => {
    const { deps, calls } = makeDeps({ cacheRow: undefined, liveResult: { exists: false } });
    const out = await handlePortfolioCreateGate(BASE, deps);
    expect(out.action).toBe("create");
    expect(calls.updateSyncMapping).toHaveLength(0);
    expect(calls.createAuditLog).toHaveLength(0);
  });

  it("unknown → action abort + writes a status='error' audit alert (no create, no self-heal)", async () => {
    const { deps, calls } = makeDeps({ cacheRow: undefined, liveResult: new Error("procore down") });
    const out = await handlePortfolioCreateGate(BASE, deps);
    expect(out.action).toBe("abort");
    expect(calls.updateSyncMapping).toHaveLength(0);
    expect(calls.createAuditLog).toHaveLength(1);
    expect(calls.createAuditLog[0]).toMatchObject({
      action: "portfolio_existence_check_indeterminate",
      status: "error",
      source: "portfolio_automation",
      category: "sync",
    });
  });
});
