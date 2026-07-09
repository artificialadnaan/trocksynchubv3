# Portfolio Existence-Check Keystone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate the Bid Board → Portfolio "Add to Portfolio" create on an authoritative "does a Procore portfolio already exist for this deal?" check, so the automation can never create a duplicate portfolio and self-heals the DB when one already exists.

**Architecture:** A pure resolver (cache-first via a new keyed storage lookup, one live Procore confirm on a cache miss) returns a discriminated existence result. A pure gate orchestrator turns that into a `skip | create | abort` decision, performing the self-heal write-back (skip) or the fail-closed `audit_logs` alert (abort). `runPhase1BidBoardActions` calls the orchestrator once and branches on the decision.

**Tech Stack:** TypeScript, Drizzle/Postgres (`procore_projects`, `sync_mappings`), Procore REST v1.0 (`getAccessToken` + `fetchWithRateLimitRetry`), Playwright automation, vitest.

**Branch:** `feat/portfolio-existence-check` (already created off `origin/main`).

**Spec:** `docs/superpowers/specs/2026-07-09-portfolio-existence-check-keystone-design.md`. Locked decisions: **fail-closed** on an indeterminate check; **exact project-number** matching.

---

## File Structure

- **Modify** `server/storage.ts` — add `getProcoreProjectByNumber(companyId, projectNumber)` (IStorage interface + `DatabaseStorage` impl). Thin keyed query mirroring `getProcoreProjectByProcoreId` (`:1073`).
- **Create** `server/portfolio-existence-resolver.ts` — the pure resolver + decision + gate orchestrator (no Playwright import). One focused module; fully unit-testable via injected deps.
- **Modify** `server/playwright/portfolio-automation.ts` — call the gate orchestrator inside `runPhase1BidBoardActions` (`~:1013`, before the add-to-portfolio decision) and branch on `skip | create | abort`.
- **Create** `tests/portfolio-existence-resolver.test.ts` — unit tests for the resolver + decision + gate side-effects (mirrors the `tests/bidboard-to-portfolio.test.ts` storage-mock style).

---

### Task 1: Storage lookup `getProcoreProjectByNumber`

**Files:**
- Modify: `server/storage.ts` (IStorage interface near `:301`; `DatabaseStorage` impl near `:1073`)

Thin keyed query. It is exercised through the resolver's mocked deps (Task 2), consistent with how this codebase tests storage (consumers mock `storage`); no dedicated PGlite test.

- [ ] **Step 1: Add the interface method**

In the `IStorage` interface, immediately after the existing `getProcoreProjectByProcoreId(procoreId: string): Promise<ProcoreProject | undefined>;` line, add:

```ts
  /** Find a Procore project by exact project number within a company (portfolio existence check). */
  getProcoreProjectByNumber(companyId: string, projectNumber: string): Promise<ProcoreProject | undefined>;
```

- [ ] **Step 2: Add the implementation**

In `DatabaseStorage`, immediately after the existing `getProcoreProjectByProcoreId` method (ends `:1075`), add. (`and`, `eq`, `desc` are already imported in this file — `desc` is used by other methods; verify the import line and add `desc` if missing.)

```ts
  async getProcoreProjectByNumber(companyId: string, projectNumber: string): Promise<ProcoreProject | undefined> {
    const [result] = await db
      .select()
      .from(procoreProjects)
      .where(and(eq(procoreProjects.companyId, companyId), eq(procoreProjects.projectNumber, projectNumber)))
      // A portfolio project may be active or archived; either means "exists". Prefer active, newest first.
      .orderBy(desc(procoreProjects.active), desc(procoreProjects.lastSyncedAt))
      .limit(1);
    return result;
  }
```

- [ ] **Step 3: Typecheck the touched file**

Run: `npx tsc --noEmit 2>&1 | grep "server/storage.ts" || echo "storage.ts CLEAN"`
Expected: `storage.ts CLEAN`

- [ ] **Step 4: Commit**

```bash
git add server/storage.ts
git commit -m "feat(portfolio): storage.getProcoreProjectByNumber for existence checks"
```

---

### Task 2: The resolver + decision + gate orchestrator

**Files:**
- Create: `server/portfolio-existence-resolver.ts`
- Test: `tests/portfolio-existence-resolver.test.ts`

The module exposes three units:
- `resolveExistingPortfolioProject(input, deps)` — cache-first, one live confirm on miss; never throws; returns `PortfolioExistenceResult`.
- `decidePortfolioCreateAction(existence)` — pure map from existence → `"skip" | "create" | "abort"`.
- `handlePortfolioCreateGate(input, deps)` — resolves, decides, and performs the side-effect for that decision (self-heal write-back on skip; `audit_logs` error on abort); returns `{ action, portfolioProjectId?, existence }`.

`deps` are injected so the whole module is unit-testable with no DB/Procore/Playwright.

- [ ] **Step 1: Write the failing tests**

Create `tests/portfolio-existence-resolver.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/portfolio-existence-resolver.test.ts`
Expected: FAIL — cannot resolve `../server/portfolio-existence-resolver`.

- [ ] **Step 3: Implement the module**

Create `server/portfolio-existence-resolver.ts`:

```ts
import { storage } from "./storage";

export type PortfolioExistenceResult =
  | { exists: true; portfolioProjectId: string; source: "cache" | "live" }
  | { exists: false }
  | { exists: "unknown"; reason: string };

export type PortfolioCreateAction = "skip" | "create" | "abort";

export interface ResolverInput {
  companyId: string;
  procoreProjectNumber: string;
  bidboardProjectId: string;
}

export interface ResolverDeps {
  getProcoreProjectByNumber: (companyId: string, projectNumber: string) => Promise<{ procoreId: string } | undefined>;
  liveConfirmByNumber: (companyId: string, projectNumber: string) => Promise<PortfolioExistenceResult>;
  getSyncMappingByBidboardProjectId: (bidboardProjectId: string) => Promise<{ id: number; portfolioProjectId: string | null } | undefined>;
  updateSyncMapping: (id: number, patch: { portfolioProjectId: string }) => Promise<unknown>;
  createAuditLog: (row: {
    action: string; entityType: string; entityId: string | null; source: string;
    status: string; category: string; errorMessage: string; details: Record<string, unknown>;
  }) => Promise<unknown>;
}

/** Default deps wired to real storage + live Procore. Import at the call site; inject mocks in tests. */
export function defaultResolverDeps(): ResolverDeps {
  return {
    getProcoreProjectByNumber: (c, n) => storage.getProcoreProjectByNumber(c, n),
    liveConfirmByNumber: liveConfirmByNumber,
    getSyncMappingByBidboardProjectId: (id) => storage.getSyncMappingByBidboardProjectId(id) as any,
    updateSyncMapping: (id, patch) => storage.updateSyncMapping(id, patch),
    createAuditLog: (row) => storage.createAuditLog(row as any),
  };
}

/**
 * One authoritative live Procore confirm (cache-miss path only). Fetches active company projects and matches
 * the EXACT project number. Any error → { exists: "unknown" } so the caller fails closed. Never throws.
 */
export async function liveConfirmByNumber(companyId: string, projectNumber: string): Promise<PortfolioExistenceResult> {
  try {
    const { getAccessToken } = await import("./procore");
    const { fetchWithRateLimitRetry } = await import("./lib/rate-limit-tracker");
    const accessToken = await getAccessToken();
    const resp = await fetchWithRateLimitRetry(
      `https://api.procore.com/rest/v1.0/companies/${companyId}/projects?per_page=500&active=true`,
      { headers: { Authorization: `Bearer ${accessToken}`, "Procore-Company-Id": companyId } },
      "procore"
    );
    if (!resp.ok) return { exists: "unknown", reason: `procore ${resp.status}` };
    const projects = (await resp.json()) as Array<{ id: unknown; project_number?: unknown; number?: unknown }>;
    if (!Array.isArray(projects)) return { exists: "unknown", reason: "unexpected procore response" };
    const match = projects.find(
      (p) => String(p.project_number ?? p.number ?? "") === projectNumber
    );
    return match ? { exists: true, portfolioProjectId: String(match.id), source: "live" } : { exists: false };
  } catch (err) {
    return { exists: "unknown", reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Cache-first, live-confirm-on-miss. Exact number match. Never throws. */
export async function resolveExistingPortfolioProject(
  input: ResolverInput,
  deps: ResolverDeps
): Promise<PortfolioExistenceResult> {
  const number = (input.procoreProjectNumber ?? "").trim();
  if (!number) return { exists: "unknown", reason: "no project number" };
  try {
    const cached = await deps.getProcoreProjectByNumber(input.companyId, number);
    if (cached?.procoreId) return { exists: true, portfolioProjectId: String(cached.procoreId), source: "cache" };
  } catch (err) {
    // A cache read failure alone is not authoritative "not found" — fall through to the live confirm.
  }
  return deps.liveConfirmByNumber(input.companyId, number);
}

export function decidePortfolioCreateAction(existence: PortfolioExistenceResult): PortfolioCreateAction {
  if (existence.exists === true) return "skip";
  if (existence.exists === false) return "create";
  return "abort";
}

/**
 * Resolve → decide → perform the decision's side effect:
 *   skip  → self-heal write-back of portfolio_project_id (if unset)
 *   create→ (none)
 *   abort → write a status='error' audit alert (the 15-min failure digest scans it)
 * Returns the decision so runPhase1BidBoardActions can branch on the Playwright parts.
 */
export async function handlePortfolioCreateGate(
  input: ResolverInput,
  deps: ResolverDeps
): Promise<{ action: PortfolioCreateAction; portfolioProjectId?: string; existence: PortfolioExistenceResult }> {
  const existence = await resolveExistingPortfolioProject(input, deps);
  const action = decidePortfolioCreateAction(existence);

  if (action === "skip" && existence.exists === true) {
    try {
      const mapping = await deps.getSyncMappingByBidboardProjectId(input.bidboardProjectId);
      if (mapping?.id && !mapping.portfolioProjectId) {
        await deps.updateSyncMapping(mapping.id, { portfolioProjectId: existence.portfolioProjectId });
      }
    } catch {
      /* self-heal is best-effort; skipping the create is the important part */
    }
    return { action, portfolioProjectId: existence.portfolioProjectId, existence };
  }

  if (action === "abort") {
    try {
      await deps.createAuditLog({
        action: "portfolio_existence_check_indeterminate",
        entityType: "bidboard_project",
        entityId: input.bidboardProjectId,
        source: "portfolio_automation",
        status: "error",
        category: "sync",
        errorMessage:
          `Portfolio automation aborted for bidboard ${input.bidboardProjectId} (project ${input.procoreProjectNumber}): ` +
          `could not confirm whether a Procore portfolio already exists — failing closed to avoid a duplicate. Retry when Procore is reachable.`,
        details: {
          bidboardProjectId: input.bidboardProjectId,
          procoreProjectNumber: input.procoreProjectNumber,
          reason: existence.exists === "unknown" ? existence.reason : "unknown",
        },
      });
    } catch {
      /* alert write is best-effort; the abort itself (no create) is the safety guarantee */
    }
  }

  return { action, existence };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/portfolio-existence-resolver.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "portfolio-existence-resolver" || echo "resolver CLEAN"`
Expected: `resolver CLEAN`

- [ ] **Step 6: Commit**

```bash
git add server/portfolio-existence-resolver.ts tests/portfolio-existence-resolver.test.ts
git commit -m "feat(portfolio): existence resolver + create-gate orchestrator (unit-tested)"
```

---

### Task 3: Wire the gate into `runPhase1BidBoardActions`

**Files:**
- Modify: `server/playwright/portfolio-automation.ts` (`runPhase1BidBoardActions`, around the `isProjectAlreadyInPortfolio` decision at `:1013`)

Integration point. The gate runs BEFORE the existing UI check; the UI check stays as a cheap secondary guard on the `create` path. `runPhase1BidBoardActions` receives only `bidboardProjectUrl` + `bidboardProjectId` today, so resolve the `companyId` (from the URL, as the file already does at `:982`) and the `procore_project_number` (from the sync mapping) at the gate.

- [ ] **Step 1: Add the import**

Near the other imports at the top of `server/playwright/portfolio-automation.ts`, add:

```ts
import { handlePortfolioCreateGate, defaultResolverDeps } from "../portfolio-existence-resolver";
```

- [ ] **Step 2: Insert the gate before the add-to-portfolio decision**

Replace the existing lines (`:1013-1014`):

```ts
  const alreadyInPortfolio = await isProjectAlreadyInPortfolio(page);
  const shouldSkipAddToPortfolio = skipAddToPortfolio || alreadyInPortfolio;
```

with:

```ts
  // ── Authoritative existence gate (keystone): before touching "Add to Portfolio", ask whether a Procore
  //    portfolio already exists for this deal. skip → don't create (self-healed); create → proceed;
  //    abort → fail closed (do NOT create when we can't confirm — avoids a duplicate).
  const gateCompanyId = bidboardProjectUrl.match(/\/companies\/(\d+)/)?.[1] ?? "";
  const gateBidId = bidboardProjectUrl.match(/\/project\/(\d+)/)?.[1] ?? bidboardProjectId;
  const gateMapping = await storage.getSyncMappingByBidboardProjectId(gateBidId).catch(() => undefined);
  const gate = await handlePortfolioCreateGate(
    { companyId: gateCompanyId, procoreProjectNumber: gateMapping?.procoreProjectNumber ?? "", bidboardProjectId: gateBidId },
    defaultResolverDeps()
  );

  if (gate.action === "abort") {
    await logStep(page, result, "portfolio_existence_gate", "failed", 0, {
      reason: "existence_indeterminate",
      procoreProjectNumber: gateMapping?.procoreProjectNumber ?? null,
    });
    result.success = false;
    result.error =
      `Portfolio existence check indeterminate for bidboard ${gateBidId} — failing closed (not creating) to avoid a duplicate.`;
    return { estimateExcelPath, proposalPdfPath };
  }

  if (gate.action === "skip" && gate.portfolioProjectId) {
    result.portfolioProjectId = result.portfolioProjectId ?? gate.portfolioProjectId;
  }

  const shouldSkipAddToPortfolio =
    skipAddToPortfolio || gate.action === "skip" || (await isProjectAlreadyInPortfolio(page));
```

- [ ] **Step 3: Typecheck the touched file**

Run: `npx tsc --noEmit 2>&1 | grep "playwright/portfolio-automation.ts" || echo "portfolio-automation.ts CLEAN"`
Expected: `portfolio-automation.ts CLEAN`

- [ ] **Step 4: Verify the fail-closed return type + `result.success` semantics**

Read `runPhase1BidBoardActions`'s return type and confirm `return { estimateExcelPath, proposalPdfPath };` matches its declared return (`{ estimateExcelPath: string | null; proposalPdfPath: string | null }`, `:954`) and that setting `result.success = false` before returning causes `runPhase1WithRetry` to treat the attempt as failed (it branches on `result.success` at `portfolio-automation-runner.ts:78`). No code change if both hold; otherwise adjust the early-return to match the existing failure convention (e.g. set `result.error` + a failed step and let the function fall through to its normal failure return).

- [ ] **Step 5: Commit**

```bash
git add server/playwright/portfolio-automation.ts
git commit -m "feat(portfolio): gate Add-to-Portfolio on the authoritative existence check"
```

---

### Task 4: Full-suite regression + baseline check

**Files:** none (verification only)

- [ ] **Step 1: Run the touched-area tests**

Run: `npx vitest run tests/portfolio-existence-resolver.test.ts tests/bidboard-to-portfolio.test.ts`
Expected: all pass (the new suite + the existing portfolio suite unaffected).

- [ ] **Step 2: Run the full suite and compare to the known baseline**

Run: `npx vitest run 2>&1 | grep -E "Test Files|Tests "`
Expected: the pre-existing 5 failures / 8 files ONLY (unrelated tech debt: bidboard-export-menu, bidboard-export-sync, change-order-sync, email-html-normalization, estimator-settings, procore-role-sync, rfp-approval-processing, stage-change-email). Any NEW failing file = a regression to fix before proceeding.

- [ ] **Step 3: Typecheck touched files are clean**

Run: `npx tsc --noEmit 2>&1 | grep -E "portfolio-existence-resolver|playwright/portfolio-automation\.ts|server/storage\.ts|tests/portfolio-existence-resolver" || echo "ALL TOUCHED FILES CLEAN"`
Expected: `ALL TOUCHED FILES CLEAN`

- [ ] **Step 4: Commit any fixups**

```bash
git add -A && git commit -m "test(portfolio): existence-gate regression pass" --allow-empty
```

---

## Self-Review

**Spec coverage:**
- Resolver (cache-first, live-confirm, discriminated true/false/unknown, never throws) → Task 2 ✓
- Create-gate (skip / create / fail-closed abort) → Task 2 (`handlePortfolioCreateGate` + `decidePortfolioCreateAction`) + Task 3 (wiring) ✓
- Self-heal write-back of `portfolio_project_id` → Task 2 (`handlePortfolioCreateGate` skip branch) ✓
- Fail-closed = `audit_logs status='error'` alert + non-success outcome → Task 2 (audit) + Task 3 (`result.success=false`) ✓
- Exact number match / fail-closed on uncertain → Task 2 ✓
- `storage.getActiveProcoreProjectByNumber` (spec name) → implemented as `getProcoreProjectByNumber` (Task 1); existence is regardless of active state, so the name was corrected — noted here for consistency.
- Manual-review row (spec's deferred/optional): NOT implemented in #1 — the fail-closed loud signal is the `audit_logs` alert (spec allows audit-alert-only for #1; the queue row is owned by the reconciler #3). Consistent with the spec's layering note.

**Placeholder scan:** none — every code step has complete code; Task 3 Step 4 is a verification step (read + confirm), not a code placeholder.

**Type consistency:** `PortfolioExistenceResult`, `handlePortfolioCreateGate`, `decidePortfolioCreateAction`, `resolveExistingPortfolioProject`, `getProcoreProjectByNumber` names/signatures match across Tasks 1–3 and the tests.
