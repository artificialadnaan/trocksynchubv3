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
  // Plural: returns ALL cached matches so the resolver can detect a duplicate (>1 distinct id) and fail closed
  // rather than arbitrarily picking one via limit(1).
  getProcoreProjectsByNumber: (companyId: string, projectNumber: string) => Promise<Array<{ procoreId: string }>>;
  // excludeId = the source Bid Board project id; a same-number match on it is NOT the Portfolio project.
  liveConfirmByNumber: (companyId: string, projectNumber: string, excludeId: string) => Promise<PortfolioExistenceResult>;
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
    getProcoreProjectsByNumber: (c, n) => storage.getProcoreProjectsByNumber(c, n),
    liveConfirmByNumber: (c, n, x) => liveConfirmByNumber(c, n, x),
    getSyncMappingByBidboardProjectId: (id) => storage.getSyncMappingByBidboardProjectId(id),
    updateSyncMapping: (id, patch) => storage.updateSyncMapping(id, patch),
    createAuditLog: (row) => storage.createAuditLog(row as any),
  };
}

// Relevance-ranked TOP-N window for the live-confirm. Procore's filters[search] is FUZZY — a number like
// "DFW-1-14126-ag" matches the "DFW" token and returns thousands of projects (>2500 observed), so ENUMERATING
// to completeness is infeasible. But the search is RELEVANCE-RANKED: an exact project_number match ranks at
// the top (the sibling matcher at bidboard.ts:1860 relies on exactly this, reading only the top 5). So we read
// a wide top-N window (300 = 60× that margin) and exact-match within it: an exact match would appear here; its
// absence means it does not exist.
const LIVE_SEARCH_TOP_N = 300;

/**
 * Pure matcher for the live-confirm response — operates on the relevance-ranked TOP-N results. Keeps only
 * EXACT project-number matches, trimming BOTH sides (Procore may pad `project_number`, e.g. " DFW-4-08226-aa ";
 * the sibling matcher at bidboard.ts:1860 relies on the same field). Outcomes:
 *   - >1 DISTINCT matching ids   → { exists: "unknown" }    (ambiguous duplicate state → fail closed, don't
 *                                                            resolve the ambiguity by arbitrarily picking one)
 *   - exactly 1 distinct id      → { exists: true, ... }    (portfolio exists → skip + self-heal)
 *   - 0 exact matches            → { exists: false }        (not in the top-N relevance window → does not exist
 *                                                            → safe to create)
 * A non-array response → "unknown".
 *
 * TRADEOFF (accepted 2026-07-10): "0 exact in top-N → create" trusts that Procore ranks an exact project_number
 * match into the top-N window — the same assumption the codebase already makes at bidboard.ts:1860 (top-5).
 * If Procore ranked an existing exact match below N, a duplicate could be created; N=300 makes that remote.
 * This supersedes the (correct-but-infeasible) paginate-to-completeness approach: filters[search] returns
 * thousands of fuzzy matches, so completeness can't be reached, and the honest fail-closed blocked every create.
 */
export function matchLiveProjects(
  projects: unknown,
  projectNumber: string,
  excludeId: string = ""
): PortfolioExistenceResult {
  if (!Array.isArray(projects)) return { exists: "unknown", reason: "unexpected procore response" };
  const target = projectNumber.trim();
  const exact = projects.filter((p: any) => String(p?.project_number ?? p?.number ?? "").trim() === target);
  // Exclude the source Bid Board project id: it can share the project number but is NOT the Portfolio project.
  const distinctIds = Array.from(new Set(exact.map((p: any) => String(p.id)))).filter((id) => id && id !== excludeId);
  if (distinctIds.length > 1) {
    return { exists: "unknown", reason: `multiple (${distinctIds.length}) procore projects share number ${target}` };
  }
  if (distinctIds.length === 1) return { exists: true, portfolioProjectId: distinctIds[0], source: "live" };
  return { exists: false };
}

/**
 * One live Procore confirm (cache-miss path only). Reads the relevance-ranked TOP-N of Procore's KEYED search
 * (filters[search]=<number>, per_page=LIVE_SEARCH_TOP_N) and exact-matches within it. filters[search] is FUZZY
 * and returns thousands of loose matches, so enumerating is infeasible — but it's relevance-ranked, so an exact
 * project_number match lands in the top-N (matchLiveProjects owns that tradeoff; bidboard.ts:1860 makes the
 * same assumption with top-5). It is a cache-MISS backstop for recently-created (necessarily active) portfolios;
 * the archived-inclusive source is the upsert-only procore_projects cache. v1.0 = the version the rest of the
 * codebase uses for company projects (procore.ts:450/847); the original v1.1 path 404'd. Any error / non-ok /
 * non-array → { exists: "unknown" } so the caller fails closed. Never throws.
 */
const LIVE_CONFIRM_TIMEOUT_MS = 15000;

export async function liveConfirmByNumber(
  companyId: string,
  projectNumber: string,
  excludeId: string = ""
): Promise<PortfolioExistenceResult> {
  // Bound the WHOLE operation: this runs while Phase 1 holds the global browser lock, and
  // fetchWithRateLimitRetry can sleep up to 60s between 429 retries WITHOUT observing the abort signal. So race
  // the request against a hard timeout that both aborts the in-flight fetch and resolves to a fail-closed
  // "unknown", so a rate-limited/stalled Procore can never hang the automation past LIVE_CONFIRM_TIMEOUT_MS.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutGuard = new Promise<PortfolioExistenceResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ exists: "unknown", reason: `live confirm timed out after ${LIVE_CONFIRM_TIMEOUT_MS}ms` });
    }, LIVE_CONFIRM_TIMEOUT_MS);
  });
  const doConfirm = async (): Promise<PortfolioExistenceResult> => {
    try {
      const { getAccessToken, getProcoreApiBaseUrl } = await import("./procore");
      const { fetchWithRateLimitRetry } = await import("./lib/rate-limit-tracker");
      const [accessToken, baseUrl] = await Promise.all([getAccessToken(), getProcoreApiBaseUrl()]);
      const resp = await fetchWithRateLimitRetry(
        `${baseUrl}/rest/v1.0/companies/${companyId}/projects?filters[search]=${encodeURIComponent(projectNumber)}&per_page=${LIVE_SEARCH_TOP_N}`,
        { headers: { Authorization: `Bearer ${accessToken}`, "Procore-Company-Id": companyId }, signal: controller.signal },
        "procore"
      );
      if (!resp.ok) return { exists: "unknown", reason: `procore ${resp.status}` };
      return matchLiveProjects(await resp.json(), projectNumber, excludeId);
    } catch (err) {
      return { exists: "unknown", reason: err instanceof Error ? err.message : String(err) };
    }
  };
  try {
    return await Promise.race([doConfirm(), timeoutGuard]);
  } finally {
    if (timer) clearTimeout(timer);
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
    const cached = await deps.getProcoreProjectsByNumber(input.companyId, number);
    // Exclude the source Bid Board project id (a same-number match on it is not the Portfolio project).
    const ids = Array.from(new Set((cached ?? []).map((p) => String(p.procoreId)).filter(Boolean)))
      .filter((id) => id !== input.bidboardProjectId);
    if (ids.length > 1) {
      // Duplicate portfolio state in the cache — mirror the live matcher: fail closed, don't pick one.
      return { exists: "unknown", reason: `multiple (${ids.length}) cached procore projects share number ${number}` };
    }
    if (ids.length === 1) return { exists: true, portfolioProjectId: ids[0], source: "cache" };
  } catch (err) {
    // The cache is the archived-inclusive source (upsert-only, retains archived rows). If it FAILS we lose
    // archived coverage, and the live confirm is active-only — so fail closed rather than risk an
    // archived-portfolio duplicate.
    return { exists: "unknown", reason: `cache read failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    return await deps.liveConfirmByNumber(input.companyId, number, input.bidboardProjectId);
  } catch (err) {
    return { exists: "unknown", reason: err instanceof Error ? err.message : String(err) };
  }
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
