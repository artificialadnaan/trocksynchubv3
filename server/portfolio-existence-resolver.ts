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
  try {
    return await deps.liveConfirmByNumber(input.companyId, number);
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
