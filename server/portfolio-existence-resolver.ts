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

// Procore's projects list pages at per_page (mirrors the codebase paginator procore.ts:153 fetchProcorePages).
// MAX_PAGES bounds the loop: filters[search] is FUZZY, so a common token (e.g. "DFW") returns every project
// sharing it (~300); 25×100 = 2500 is far beyond any real project-number search — hitting it means the scan
// is incomplete → fail closed.
const LIVE_SEARCH_PER_PAGE = 100;
const LIVE_SEARCH_MAX_PAGES = 25;

/**
 * Pure matcher for the live-confirm response — operates on the COMPLETE accumulated result set (the caller
 * paginates). Keeps only EXACT project-number matches, trimming BOTH sides (Procore may pad `project_number`,
 * e.g. " DFW-4-08226-aa "; the sibling matcher at bidboard.ts:1863 relies on the same field). Outcomes:
 *   - >1 DISTINCT matching ids   → { exists: "unknown" }    (ambiguous duplicate state → fail closed, don't
 *                                                            resolve the ambiguity by arbitrarily picking one)
 *   - scan not `complete`        → { exists: "unknown" }    (the caller hit the page bound; an exact match
 *                                                            could sit on an unread page → can't assert
 *                                                            existence OR uniqueness)
 *   - exactly 1 distinct id      → { exists: true, ... }    (portfolio exists → skip + self-heal)
 *   - 0 exact matches            → { exists: false }        (safe to create)
 * A non-array response → "unknown".
 *
 * NOTE (convention shift, 2026-07-10): the 4th arg is now `complete: boolean`, NOT `pageCap: number`. The old
 * `projects.length >= pageCap → unknown` guard false-aborted the create for any number whose token fuzzily
 * matched >= a page of projects (e.g. every "DFW-*" Dallas deal). Completeness is now a FACT from the driver
 * having read every page, not a guess off one truncated page.
 */
export function matchLiveProjects(
  projects: unknown,
  projectNumber: string,
  excludeId: string = "",
  complete: boolean = true
): PortfolioExistenceResult {
  if (!Array.isArray(projects)) return { exists: "unknown", reason: "unexpected procore response" };
  const target = projectNumber.trim();
  const exact = projects.filter((p: any) => String(p?.project_number ?? p?.number ?? "").trim() === target);
  // Exclude the source Bid Board project id: it can share the project number but is NOT the Portfolio project.
  const distinctIds = Array.from(new Set(exact.map((p: any) => String(p.id)))).filter((id) => id && id !== excludeId);
  // Ambiguity is decisive even on an incomplete scan: two distinct exact ids already prove a duplicate state.
  if (distinctIds.length > 1) {
    return { exists: "unknown", reason: `multiple (${distinctIds.length}) procore projects share number ${target}` };
  }
  // Existence/absence can only be asserted from a COMPLETE scan — an unread page could hold the (or another) match.
  if (!complete) {
    return { exists: "unknown", reason: `search exceeded ${LIVE_SEARCH_MAX_PAGES}-page bound; cannot confirm existence/uniqueness` };
  }
  if (distinctIds.length === 1) return { exists: true, portfolioProjectId: distinctIds[0], source: "live" };
  return { exists: false };
}

/**
 * One authoritative live Procore confirm (cache-miss path only). Uses Procore's KEYED search
 * (filters[search]=<number>) — but that search is FUZZY (it matches on tokens, so "DFW-1-14126-ag" returns
 * every "DFW-*" project), so a single page is NOT authoritative. We PAGINATE to completeness (read every page
 * until one returns < per_page) and hand the full set + a `complete` flag to matchLiveProjects, which asserts
 * false/true only from a complete scan. It is a cache-MISS backstop for recently-created (necessarily active)
 * portfolios; the archived-inclusive source is the upsert-only procore_projects cache (which retains rows
 * after a project is archived). Any error / non-array / bound-exceeded → { exists: "unknown" } so the caller
 * fails closed. Never throws.
 */
const LIVE_CONFIRM_TIMEOUT_MS = 15000;

export async function liveConfirmByNumber(
  companyId: string,
  projectNumber: string,
  excludeId: string = ""
): Promise<PortfolioExistenceResult> {
  // Bound the WHOLE operation, not just one fetch: this runs while Phase 1 holds the global browser lock, and
  // fetchWithRateLimitRetry can sleep up to 60s between 429 retries WITHOUT observing the abort signal. So race
  // the (now multi-page) request against a hard timeout that both aborts the in-flight fetch and resolves to a
  // fail-closed "unknown", so a rate-limited/stalled Procore can never hang the automation past the timeout.
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
      const all: unknown[] = [];
      let complete = false;
      // Paginate the FUZZY keyed search to completeness (mirrors procore.ts:153). v1.0 = the version the rest
      // of the codebase uses for company projects (procore.ts:450/847); the original v1.1 path 404'd.
      for (let page = 1; page <= LIVE_SEARCH_MAX_PAGES; page++) {
        // Once the outer timeout fires (Promise.race already settled to unknown), stop issuing further pages —
        // fetchWithRateLimitRetry's 429 sleeps don't observe the signal, so without this the detached loop
        // would keep fetching the remaining pages for nothing.
        if (controller.signal.aborted) return { exists: "unknown", reason: "live confirm aborted (timeout)" };
        const resp = await fetchWithRateLimitRetry(
          `${baseUrl}/rest/v1.0/companies/${companyId}/projects?filters[search]=${encodeURIComponent(projectNumber)}&per_page=${LIVE_SEARCH_PER_PAGE}&page=${page}`,
          { headers: { Authorization: `Bearer ${accessToken}`, "Procore-Company-Id": companyId }, signal: controller.signal },
          "procore"
        );
        if (!resp.ok) return { exists: "unknown", reason: `procore ${resp.status}` };
        const batch = await resp.json();
        if (!Array.isArray(batch)) return { exists: "unknown", reason: "unexpected procore response" };
        all.push(...batch);
        if (batch.length < LIVE_SEARCH_PER_PAGE) { complete = true; break; } // last page reached → scan complete
      }
      return matchLiveProjects(all, projectNumber, excludeId, complete);
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
