/**
 * Photo-link relay on Phase-2 completion
 * ======================================
 *
 * Regression coverage for the structural gap where the `procore.project.created` relay (which
 * drives the CRM public "T Rock Photos" photo link) was only enqueued in the projects.create
 * webhook's *no-pending-Phase-2-job* fallback branch.
 *
 * The normal automation either (a) direct-chains Phase-2 via runPhase2 inside runPhase1WithRetry, or
 * (b) registers a pending Phase-2 job that the create-webhook claims and runs down the `if (pending)`
 * branch — both bypassing the relay enqueue. Net: the photo link was silently skipped for ~every
 * automation-portfolio'd project. The fix calls `enqueueProjectCreatedRelayForPortfolioProject` on
 * every Phase-2 success (direct-chain + runPhase2WithRetry), so it fires regardless of branch.
 *
 * Correctness pinned here:
 *  - resolves the mapping by **project_number** (from the actual portfolio project), NOT a passed
 *    bid-board id — the webhook claims the oldest pending job globally, which may be a different
 *    project, so a bid-board lookup could attach the relay to the wrong deal;
 *  - the once-guard is an **atomic insert-if-absent** on the outbox (advisory-locked per project),
 *    NOT mapping.portfolioProjectId (which runPhase2 sets mid-automation and would falsely report
 *    already-relayed) — and atomic so concurrent emitters can't both insert;
 *  - no mapping mutation (so a transient insert failure can't permanently lose the relay).
 *
 * Helper is exercised directly with injected deps (no DB / Procore / Playwright).
 *
 * @module tests/photo-link-relay-phase2
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// trockcrm-relay.ts imports "./db" at module load — stub it so importing never opens a real DB
// connection. The helper uses injected deps, so the real storage/procore/store are never reached.
vi.mock("../server/db", () => ({ db: {}, pool: {} }));

import { enqueueProjectCreatedRelayForPortfolioProject } from "../server/trockcrm-relay";

type Mapping = { id: number; procoreProjectNumber?: string | null; bidboardProjectId: string | null; hubspotDealId: string | null };

function makeDeps(opts?: {
  mapping?: Partial<Mapping> | null;
  byPortfolioMapping?: Mapping | null;
  bidboardMapping?: Mapping | null;
  projectNumber?: string | null;
  alreadyRelayed?: boolean;
  enrichmentFails?: boolean;
}) {
  const mapping: Mapping | null =
    opts?.mapping === null
      ? null
      : { id: 7, procoreProjectNumber: "DFW-4-15526-ac", bidboardProjectId: "bb-1", hubspotDealId: "hs-1", ...opts?.mapping };
  // Resolved by portfolioProjectId (runPhase2 stamps it). Defaults to the primary mapping.
  const byPortfolioMapping: Mapping | null = opts?.byPortfolioMapping !== undefined ? opts.byPortfolioMapping : mapping;
  // Targeted bid-board lookup: defaults to the primary row when it already carries the link.
  const bidboardMapping: Mapping | null =
    opts?.bidboardMapping !== undefined ? opts.bidboardMapping : (mapping?.bidboardProjectId ? mapping : null);
  // Atomic insert-if-absent (the outbox once-guard): returns {inserted:false} when a relay already
  // exists for the project. The real impl serializes concurrent emitters with a per-project advisory
  // lock; the helper just delegates to this single call (no separate read-before-write).
  const insertProjectCreatedRelayIfAbsent = vi.fn(async (_row: Record<string, unknown>, _pid: string) =>
    opts?.alreadyRelayed ? { inserted: false as const } : { inserted: true as const, id: 123 },
  );
  const getSyncMappingByPortfolioProjectId = vi.fn(async () => byPortfolioMapping ?? undefined);
  const getSyncMappingByProcoreProjectNumber = vi.fn(async () => mapping);
  const getBidboardMappingByProcoreProjectNumber = vi.fn(async () => bidboardMapping ?? undefined);
  const fetchProcoreProjectDetail = vi.fn(async () => {
    if (opts?.enrichmentFails) throw new Error("procore rate limited");
    return {
      project_number: opts?.projectNumber === undefined ? "DFW-4-15526-ac" : opts.projectNumber,
      name: "Rayside Residences",
      company_id: "co-1",
    };
  });
  return {
    mapping,
    insertProjectCreatedRelayIfAbsent,
    getSyncMappingByPortfolioProjectId,
    getSyncMappingByProcoreProjectNumber,
    getBidboardMappingByProcoreProjectNumber,
    fetchProcoreProjectDetail,
    deps: {
      storage: { getSyncMappingByPortfolioProjectId, getSyncMappingByProcoreProjectNumber, getBidboardMappingByProcoreProjectNumber },
      fetchProcoreProjectDetail,
      store: { insertProjectCreatedRelayIfAbsent },
    },
  };
}

describe("photo-link relay on Phase-2 completion", () => {
  beforeEach(() => vi.clearAllMocks());

  it("enqueues the procore.project.created relay on Phase-2 success — the path both automation branches skipped", async () => {
    const t = makeDeps();

    const result = await enqueueProjectCreatedRelayForPortfolioProject({
      portfolioProjectId: "598134326634550",
      webhookLog: { id: 42, createdAt: new Date("2026-06-09T00:00:00Z"), payload: { id: "wh-9", reason: "create" } },
      deps: t.deps,
    });

    expect(result.enqueued).toBe(true);
    expect(t.insertProjectCreatedRelayIfAbsent).toHaveBeenCalledTimes(1);

    const row: any = t.insertProjectCreatedRelayIfAbsent.mock.calls[0][0];
    expect(row.payload.eventType).toBe("procore.project.created");
    expect(row.procorePortfolioProjectId).toBe("598134326634550");
    expect(row.webhookLogId).toBe(42);
    expect(row.syncMappingId).toBe(7);
    // Carries the project_number + mapping so the CRM worker can resolve the deal.
    expect(row.projectNumber).toBe("DFW-4-15526-ac");
    expect(row.payload.procore.projectNumber).toBe("DFW-4-15526-ac");
    expect(row.payload.procore.portfolioProjectId).toBe("598134326634550");
    expect(row.payload.synchub.syncMappingId).toBe("7");
    expect(row.payload.synchub.bidboardProjectId).toBe("bb-1");
  });

  it("resolves the mapping by the actual portfolio project (portfolioProjectId) — wrong-deal-safe", async () => {
    const t = makeDeps();

    await enqueueProjectCreatedRelayForPortfolioProject({ portfolioProjectId: "598134326634550", deps: t.deps });

    // Resolves by the actual project, never a (possibly mismatched) bid-board id. With portfolioProjectId
    // stamped, the project_number-based fallback isn't even needed.
    expect(t.getSyncMappingByPortfolioProjectId).toHaveBeenCalledWith("598134326634550");
    expect(t.getSyncMappingByProcoreProjectNumber).not.toHaveBeenCalled();
    expect(t.insertProjectCreatedRelayIfAbsent).toHaveBeenCalledTimes(1);
  });

  it("stays durable when Procore detail enrichment fails — uses the mapping's project_number and still enqueues", async () => {
    const t = makeDeps({ enrichmentFails: true });

    const result = await enqueueProjectCreatedRelayForPortfolioProject({ portfolioProjectId: "598134326634550", deps: t.deps });

    expect(result.enqueued).toBe(true);
    const row: any = t.insertProjectCreatedRelayIfAbsent.mock.calls[0][0];
    expect(row.projectNumber).toBe("DFW-4-15526-ac"); // sourced from the sync-mapping, not the failed Procore call
    expect(row.payload.procore.projectNumber).toBe("DFW-4-15526-ac");
  });

  it("prefers a bid-board mapping among duplicate project numbers (skips a portfolio-only/legacy duplicate)", async () => {
    // getSyncMappingByProcoreProjectNumber returns an arbitrary first row with NO bid-board link;
    // the targeted bid-board lookup finds the row that does carry it — the relay must still fire.
    const t = makeDeps({
      mapping: { id: 9, bidboardProjectId: null },
      bidboardMapping: { id: 7, procoreProjectNumber: "DFW-4-15526-ac", bidboardProjectId: "bb-1", hubspotDealId: "hs-1" },
    });

    const result = await enqueueProjectCreatedRelayForPortfolioProject({ portfolioProjectId: "598134326634550", deps: t.deps });

    expect(result.enqueued).toBe(true);
    expect(t.getBidboardMappingByProcoreProjectNumber).toHaveBeenCalledWith("DFW-4-15526-ac");
    const row: any = t.insertProjectCreatedRelayIfAbsent.mock.calls[0][0];
    expect(row.syncMappingId).toBe(7); // the bid-board-linked row, not the null-bidboard duplicate
    expect(row.payload.synchub.bidboardProjectId).toBe("bb-1");
  });

  it("is idempotent (atomic once-guard): insert-if-absent reports an existing relay and we skip", async () => {
    const t = makeDeps({ alreadyRelayed: true });

    const result = await enqueueProjectCreatedRelayForPortfolioProject({ portfolioProjectId: "598134326634550", deps: t.deps });

    expect(result).toEqual({ enqueued: false, reason: "already_relayed" });
    // The guard + insert is ONE atomic store call keyed on the portfolio project id (advisory-locked
    // in the real impl), so concurrent emitters can't both insert.
    expect(t.insertProjectCreatedRelayIfAbsent).toHaveBeenCalledWith(expect.any(Object), "598134326634550");
  });

  it("works without an originating webhook (direct-chain / manual Phase-2) — webhookLogId is null", async () => {
    const t = makeDeps();

    const result = await enqueueProjectCreatedRelayForPortfolioProject({ portfolioProjectId: "598134326634550", deps: t.deps });

    expect(result.enqueued).toBe(true);
    const row: any = t.insertProjectCreatedRelayIfAbsent.mock.calls[0][0];
    expect(row.webhookLogId).toBeNull();
    expect(row.payload.eventType).toBe("procore.project.created");
  });

  it("a project-events webhook with no persisted webhook_logs row writes a null FK (no FK violation) but keeps the trace", async () => {
    const t = makeDeps();

    // The /project-events callers pass { id: null, payload } — there's no webhook_logs row, so the
    // outbox FK must be null (a numeric Procore event id here would violate the FK and drop the relay).
    const result = await enqueueProjectCreatedRelayForPortfolioProject({
      portfolioProjectId: "598134326634550",
      webhookLog: { id: null, payload: { id: "procore-evt-777", reason: "create", resource_id: "598134326634550" } },
      deps: t.deps,
    });

    expect(result.enqueued).toBe(true);
    const row: any = t.insertProjectCreatedRelayIfAbsent.mock.calls[0][0];
    expect(row.webhookLogId).toBeNull(); // null FK — no reference to a non-existent webhook_logs row
    expect(row.payload.synchub.webhookLogId).toBeNull(); // semantically null in the CRM payload, not ""
    // Procore event id is still preserved for trace via rawProcoreWebhook.
    expect(row.payload.rawProcoreWebhook.id).toBe("procore-evt-777");
  });

  it("skips safely when neither the mapping nor enrichment yields a project_number", async () => {
    const t = makeDeps({ projectNumber: null, mapping: { procoreProjectNumber: null } });

    const result = await enqueueProjectCreatedRelayForPortfolioProject({ portfolioProjectId: "598134326634550", deps: t.deps });

    expect(result).toEqual({ enqueued: false, reason: "no_project_number" });
    expect(t.insertProjectCreatedRelayIfAbsent).not.toHaveBeenCalled();
  });

  it("skips when no bid-board sync-mapping resolves (e.g. a manual non-bid-board project)", async () => {
    const t = makeDeps({ mapping: null });

    const result = await enqueueProjectCreatedRelayForPortfolioProject({ portfolioProjectId: "598134326634550", deps: t.deps });

    expect(result).toEqual({ enqueued: false, reason: "no_bidboard_mapping" });
    expect(t.insertProjectCreatedRelayIfAbsent).not.toHaveBeenCalled();
  });
});
