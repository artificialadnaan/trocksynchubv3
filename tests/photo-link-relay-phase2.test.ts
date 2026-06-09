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
 *  - the once-guard is **outbox existence** (`hasProjectCreatedRelay`), NOT mapping.portfolioProjectId
 *    (which runPhase2 sets mid-automation and would falsely report already-relayed);
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

type Mapping = { id: number; bidboardProjectId: string | null; hubspotDealId: string | null };

function makeDeps(opts?: { mapping?: Partial<Mapping> | null; projectNumber?: string | null; alreadyRelayed?: boolean }) {
  const mapping: Mapping | null =
    opts?.mapping === null
      ? null
      : { id: 7, bidboardProjectId: "bb-1", hubspotDealId: "hs-1", ...opts?.mapping };
  const insertOutbox = vi.fn(async (_row: Record<string, unknown>) => ({ id: 123 }));
  const hasProjectCreatedRelay = vi.fn(async () => Boolean(opts?.alreadyRelayed));
  const getSyncMappingByProcoreProjectNumber = vi.fn(async () => mapping);
  const fetchProcoreProjectDetail = vi.fn(async () => ({
    project_number: opts?.projectNumber === undefined ? "DFW-4-15526-ac" : opts.projectNumber,
    name: "Rayside Residences",
    company_id: "co-1",
  }));
  return {
    mapping,
    insertOutbox,
    hasProjectCreatedRelay,
    getSyncMappingByProcoreProjectNumber,
    fetchProcoreProjectDetail,
    deps: {
      storage: { getSyncMappingByProcoreProjectNumber },
      fetchProcoreProjectDetail,
      store: { insertOutbox, hasProjectCreatedRelay },
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
    expect(t.insertOutbox).toHaveBeenCalledTimes(1);

    const row: any = t.insertOutbox.mock.calls[0][0];
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

  it("resolves the mapping by project_number (not a bid-board id) — prevents attaching to the wrong deal", async () => {
    const t = makeDeps();

    await enqueueProjectCreatedRelayForPortfolioProject({ portfolioProjectId: "598134326634550", deps: t.deps });

    // The project's own project_number is the lookup key — never a (possibly mismatched) bid-board id.
    expect(t.fetchProcoreProjectDetail).toHaveBeenCalledWith("598134326634550");
    expect(t.getSyncMappingByProcoreProjectNumber).toHaveBeenCalledWith("DFW-4-15526-ac");
    expect(t.insertOutbox).toHaveBeenCalledTimes(1);
  });

  it("is idempotent (once-guard via outbox): skips when a procore.project.created relay already exists", async () => {
    const t = makeDeps({ alreadyRelayed: true });

    const result = await enqueueProjectCreatedRelayForPortfolioProject({ portfolioProjectId: "598134326634550", deps: t.deps });

    expect(result).toEqual({ enqueued: false, reason: "already_relayed" });
    expect(t.hasProjectCreatedRelay).toHaveBeenCalledWith("598134326634550");
    expect(t.insertOutbox).not.toHaveBeenCalled();
  });

  it("works without an originating webhook (direct-chain / manual Phase-2) — webhookLogId is null", async () => {
    const t = makeDeps();

    const result = await enqueueProjectCreatedRelayForPortfolioProject({ portfolioProjectId: "598134326634550", deps: t.deps });

    expect(result.enqueued).toBe(true);
    const row: any = t.insertOutbox.mock.calls[0][0];
    expect(row.webhookLogId).toBeNull();
    expect(row.payload.eventType).toBe("procore.project.created");
  });

  it("skips safely when the Procore project has no project_number (CRM resolves by project number)", async () => {
    const t = makeDeps({ projectNumber: null });

    const result = await enqueueProjectCreatedRelayForPortfolioProject({ portfolioProjectId: "598134326634550", deps: t.deps });

    expect(result).toEqual({ enqueued: false, reason: "no_project_number" });
    expect(t.insertOutbox).not.toHaveBeenCalled();
  });

  it("skips when no bid-board sync-mapping resolves (e.g. a manual non-bid-board project)", async () => {
    const t = makeDeps({ mapping: null });

    const result = await enqueueProjectCreatedRelayForPortfolioProject({ portfolioProjectId: "598134326634550", deps: t.deps });

    expect(result).toEqual({ enqueued: false, reason: "no_bidboard_mapping" });
    expect(t.insertOutbox).not.toHaveBeenCalled();
  });
});
