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
  matchLiveProjects,
  type PortfolioExistenceResult,
} from "../server/portfolio-existence-resolver";

describe("matchLiveProjects (live-confirm response matcher)", () => {
  it("exactly one exact number match → exists:true (source live), ignoring fuzzy non-matches", () => {
    const r = matchLiveProjects(
      [{ id: 42, project_number: "DFW-4-08226-aa" }, { id: 43, project_number: "DFW-4-08226-aa-2" }],
      "DFW-4-08226-aa"
    );
    expect(r).toEqual({ exists: true, portfolioProjectId: "42", source: "live" });
  });

  it("trims BOTH sides — a whitespace-padded Procore project_number still matches", () => {
    const r = matchLiveProjects([{ id: 7, project_number: "  DFW-4-08226-aa  " }], "DFW-4-08226-aa");
    expect(r).toMatchObject({ exists: true, portfolioProjectId: "7" });
  });

  it("no exact match in the top-N → exists:false (safe to create)", () => {
    const r = matchLiveProjects([{ id: 1, project_number: "OTHER-1" }], "DFW-4-08226-aa");
    expect(r).toEqual({ exists: false });
  });

  it("FIX: a wide window of fuzzy DFW non-matches, no exact → exists:false (no false abort)", () => {
    // Procore's filters[search]=DFW-1-14126-ag fuzzily matches the "DFW" token and returns thousands, but
    // NONE are the exact number. The relevance-ranked top-N contains no exact match → create (not unknown).
    // This is the prod deadlock: the fuzzy flood is unenumerable, so we exact-match the top-N instead.
    const flood = Array.from({ length: 300 }, (_, i) => ({ id: 900 + i, project_number: `DFW-9-${i}` }));
    const r = matchLiveProjects(flood, "DFW-1-14126-ag");
    expect(r).toEqual({ exists: false });
  });

  it("one exact match amid a wide window of fuzzy noise → exists:true", () => {
    const flood = Array.from({ length: 300 }, (_, i) => ({ id: 900 + i, project_number: `DFW-9-${i}` }));
    flood.push({ id: 42, project_number: "DFW-1-14126-ag" });
    const r = matchLiveProjects(flood, "DFW-1-14126-ag");
    expect(r).toEqual({ exists: true, portfolioProjectId: "42", source: "live" });
  });

  it("excludes the source Bid Board id — a same-number match on it is NOT the Portfolio project", () => {
    // Only match is the bidboard project itself → excluded → no portfolio → false.
    const only = matchLiveProjects([{ id: "562949955660910", project_number: "DFW-4-08226-aa" }], "DFW-4-08226-aa", "562949955660910");
    expect(only).toEqual({ exists: false });
    // A DISTINCT portfolio alongside the excluded bidboard id → that portfolio is the match.
    const both = matchLiveProjects(
      [{ id: "562949955660910", project_number: "DFW-4-08226-aa" }, { id: "598134326497075", project_number: "DFW-4-08226-aa" }],
      "DFW-4-08226-aa",
      "562949955660910"
    );
    expect(both).toEqual({ exists: true, portfolioProjectId: "598134326497075", source: "live" });
  });

  it("multiple DISTINCT projects share the exact number → exists:unknown (ambiguous, fail-closed)", () => {
    const r = matchLiveProjects(
      [{ id: 1, project_number: "DFW-4-08226-aa" }, { id: 2, project_number: "DFW-4-08226-aa" }],
      "DFW-4-08226-aa"
    );
    expect(r.exists).toBe("unknown");
  });

  it("the same id repeated for the number is NOT ambiguous → exists:true", () => {
    const r = matchLiveProjects(
      [{ id: 5, project_number: "DFW-4-08226-aa" }, { id: 5, project_number: "DFW-4-08226-aa" }],
      "DFW-4-08226-aa"
    );
    expect(r).toMatchObject({ exists: true, portfolioProjectId: "5" });
  });

  it("non-array response → exists:unknown", () => {
    expect(matchLiveProjects({ error: "boom" } as unknown, "DFW-4-08226-aa").exists).toBe("unknown");
  });

  it("falls back to the `number` field when `project_number` is absent", () => {
    const r = matchLiveProjects([{ id: 9, number: "DFW-4-08226-aa" }], "DFW-4-08226-aa");
    expect(r).toMatchObject({ exists: true, portfolioProjectId: "9" });
  });
});

function makeDeps(over: Partial<{
  cacheRow: any;       // a single cached row (undefined = cache miss)
  cacheRows: any[];    // OR an explicit array of rows (for the duplicate-number test)
  cacheThrows: boolean; // make the cache read reject (fail-closed test)
  liveResult: PortfolioExistenceResult | Error;
  mapping: any;
  mappingThrows: boolean; // make the sync-mapping lookup reject (fail-closed test)
}> = {}) {
  const calls: any = { updateSyncMapping: [], createAuditLog: [] };
  const deps = {
    getProcoreProjectsByNumber: vi.fn(async () => {
      if (over.cacheThrows) throw new Error("cache down");
      return over.cacheRows ?? (over.cacheRow ? [over.cacheRow] : []);
    }),
    liveConfirmByNumber: vi.fn(async () => {
      if (over.liveResult instanceof Error) throw over.liveResult;
      return over.liveResult ?? ({ exists: false } as PortfolioExistenceResult);
    }),
    getSyncMappingByBidboardProjectId: vi.fn(async () => {
      if (over.mappingThrows) throw new Error("mapping db down");
      return over.mapping;
    }),
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

  it("cache has >1 DISTINCT id for the number → exists:unknown (fail-closed, no live call)", async () => {
    const { deps } = makeDeps({ cacheRows: [{ procoreId: "999" }, { procoreId: "1000" }] });
    const r = await resolveExistingPortfolioProject(BASE, deps);
    expect(r.exists).toBe("unknown");
    expect(deps.liveConfirmByNumber).not.toHaveBeenCalled();
  });

  it("cache has the SAME id twice (not a duplicate) → exists:true", async () => {
    const { deps } = makeDeps({ cacheRows: [{ procoreId: "999" }, { procoreId: "999" }] });
    expect(await resolveExistingPortfolioProject(BASE, deps)).toEqual({ exists: true, portfolioProjectId: "999", source: "cache" });
  });

  it("cache read FAILS → exists:unknown (fail-closed; does NOT fall through to the active-only live path)", async () => {
    const { deps } = makeDeps({ cacheThrows: true });
    const r = await resolveExistingPortfolioProject(BASE, deps);
    expect(r.exists).toBe("unknown");
    expect(deps.liveConfirmByNumber).not.toHaveBeenCalled();
  });

  it("cache match that IS the source bidboard id is excluded → falls through to live", async () => {
    const { deps } = makeDeps({ cacheRows: [{ procoreId: BASE.bidboardProjectId }], liveResult: { exists: false } });
    const r = await resolveExistingPortfolioProject(BASE, deps);
    expect(r).toEqual({ exists: false });
    expect(deps.liveConfirmByNumber).toHaveBeenCalled();
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
    expect(deps.getProcoreProjectsByNumber).not.toHaveBeenCalled();
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

  it("self-heal re-reads fresh: if the row got linked concurrently during the resolve, it does NOT clobber the newer link", async () => {
    const updateCalls: any[] = [];
    let call = 0;
    const deps: any = {
      getProcoreProjectsByNumber: async () => [{ procoreId: "999" }], // cache hit → resolve says skip
      liveConfirmByNumber: async () => ({ exists: false }),
      getSyncMappingByBidboardProjectId: async () => {
        call += 1;
        // 1st call (top guard): still unlinked; 2nd call (fresh self-heal read): linked by a concurrent action
        return call === 1 ? { id: 7, portfolioProjectId: null } : { id: 7, portfolioProjectId: "555" };
      },
      updateSyncMapping: async (id: number, patch: any) => { updateCalls.push({ id, patch }); },
      createAuditLog: async () => {},
    };
    const out = await handlePortfolioCreateGate(BASE, deps);
    expect(out.action).toBe("skip");
    expect(updateCalls).toHaveLength(0); // fresh read saw the concurrent link → no clobbering write
    expect(out.portfolioProjectId).toBe("555"); // returns the authoritative fresh link, not the resolved "999"
  });

  it("exists but mapping already has portfolio_project_id → skip via the link, no redundant write", async () => {
    // Distinct ids prove the guard returns the MAPPING's link (777), not the cache resolve (999).
    const { deps, calls } = makeDeps({ cacheRow: { procoreId: "999" }, mapping: { id: 7, portfolioProjectId: "777" } });
    const out = await handlePortfolioCreateGate(BASE, deps);
    expect(out).toMatchObject({ action: "skip", portfolioProjectId: "777" });
    expect(out.existence).toMatchObject({ source: "mapping" });
    expect(calls.updateSyncMapping).toHaveLength(0);
  });

  it("FORWARD-LOOKING: mapping already linked → skip via the existing-link guard, WITHOUT a Procore resolve", async () => {
    // Cross-number rebuild: the mapping is linked to a portfolio recorded under a DIFFERENT number, so the
    // number-based resolve would (wrongly) say create. The stored link must short-circuit to skip.
    const { deps, calls } = makeDeps({
      cacheRow: undefined,
      liveResult: { exists: false }, // resolve WOULD say create...
      mapping: { id: 7, portfolioProjectId: "598134326608331" }, // ...but the deal is already linked
    });
    const out = await handlePortfolioCreateGate(BASE, deps);
    expect(out).toMatchObject({ action: "skip", portfolioProjectId: "598134326608331" });
    expect(out.existence).toMatchObject({ exists: true, source: "mapping" });
    // the number-based resolve must NOT run — the stored link is authoritative
    expect(deps.getProcoreProjectsByNumber).not.toHaveBeenCalled();
    expect(deps.liveConfirmByNumber).not.toHaveBeenCalled();
    // no redundant self-heal write (already linked)
    expect(calls.updateSyncMapping).toHaveLength(0);
  });

  it("blank portfolio_project_id on the mapping does NOT short-circuit → falls through to the Procore resolve", async () => {
    const { deps } = makeDeps({ cacheRow: undefined, liveResult: { exists: false }, mapping: { id: 7, portfolioProjectId: "   " } });
    const out = await handlePortfolioCreateGate(BASE, deps);
    expect(out.action).toBe("create");
    expect(deps.liveConfirmByNumber).toHaveBeenCalled();
  });

  it("mapping lookup ERROR → abort (fail closed), never falls through to a number-based create", async () => {
    // A transient lookup failure can't rule out an existing (possibly cross-number rebuild) link, so we must
    // NOT create. Also don't waste the number-based resolve — go straight to a fail-closed abort + audit.
    const { deps, calls } = makeDeps({ mappingThrows: true, cacheRow: undefined, liveResult: { exists: false } });
    const out = await handlePortfolioCreateGate(BASE, deps);
    expect(out.action).toBe("abort");
    expect(deps.getProcoreProjectsByNumber).not.toHaveBeenCalled();
    expect(deps.liveConfirmByNumber).not.toHaveBeenCalled();
    expect(calls.createAuditLog).toHaveLength(1);
  });

  it("create-path mapping RE-READ error → abort (fail closed), never falls through to a create", async () => {
    // Top guard reads cleanly (no link) so we reach the create decision; but a transient DB error on the
    // create-path re-read means we can't rule out a concurrent/cross-number link added DURING the resolve. We
    // must fail closed (abort + status='error' alert), not fall through and click Add-to-Portfolio → duplicate.
    const auditLogs: any[] = [];
    let call = 0;
    const deps: any = {
      getProcoreProjectsByNumber: async () => [], // cache miss
      liveConfirmByNumber: async () => ({ exists: false } as PortfolioExistenceResult), // → resolve says create
      getSyncMappingByBidboardProjectId: async () => {
        call += 1;
        if (call === 1) return undefined; // top guard: no existing link → proceed to resolve
        throw new Error("mapping db down"); // create-path re-read fails
      },
      updateSyncMapping: async () => {},
      createAuditLog: async (row: any) => { auditLogs.push(row); },
    };
    const out = await handlePortfolioCreateGate(BASE, deps);
    expect(out.action).toBe("abort");
    expect(out.existence.exists).toBe("unknown");
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0]).toMatchObject({ action: "portfolio_existence_check_indeterminate", status: "error" });
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
