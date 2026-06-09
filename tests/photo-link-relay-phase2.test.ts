/**
 * Photo-link relay on Phase-2 completion
 * ======================================
 *
 * Regression coverage for the structural gap where the `procore.project.created` relay (which
 * drives the CRM public "T Rock Photos" photo link) was only enqueued in the projects.create
 * webhook's *no-pending-Phase-2-job* fallback branch.
 *
 * The normal automation flow registers a pending Phase-2 job (right after Phase-1) BEFORE the
 * create-webhook arrives, so the webhook claims that job and runs Phase-2 down the `if (pending)`
 * branch — never reaching the relay enqueue. Net: the photo link was silently skipped for every
 * automation-portfolio'd project. The fix moves the relay enqueue into runPhase2WithRetry's success
 * path via `enqueueProjectCreatedRelayForPortfolioProject`, so it fires regardless of which branch
 * the create-webhook took (pending present OR empty queue).
 *
 * These tests exercise that helper directly with injected deps (no DB / no Procore / no Playwright).
 *
 * @module tests/photo-link-relay-phase2
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// trockcrm-relay.ts imports "./db" at module load — stub it so importing the module never opens a
// real DB connection. The helper under test uses injected deps, so the real storage/procore/store
// modules are never reached.
vi.mock("../server/db", () => ({ db: {}, pool: {} }));

import { enqueueProjectCreatedRelayForPortfolioProject } from "../server/trockcrm-relay";

type Mapping = {
  id: number;
  bidboardProjectId: string | null;
  hubspotDealId: string | null;
  portfolioProjectId: string | null;
};

function makeDeps(opts?: { mapping?: Partial<Mapping>; projectNumber?: string | null }) {
  const mapping: Mapping = {
    id: 7,
    bidboardProjectId: "bb-1",
    hubspotDealId: "hs-1",
    portfolioProjectId: null,
    ...opts?.mapping,
  };
  const insertOutbox = vi.fn(async (_row: Record<string, unknown>) => ({ id: 123 }));
  const updateSyncMapping = vi.fn(async () => mapping);
  const getSyncMappingByBidboardProjectId = vi.fn(async () => mapping);
  const getSyncMappingByProcoreProjectNumber = vi.fn(async () => mapping);
  const fetchProcoreProjectDetail = vi.fn(async () => ({
    project_number: opts?.projectNumber === undefined ? "DFW-4-15526-ac" : opts.projectNumber,
    name: "Rayside Residences",
    company_id: "co-1",
  }));
  return {
    mapping,
    insertOutbox,
    updateSyncMapping,
    getSyncMappingByBidboardProjectId,
    getSyncMappingByProcoreProjectNumber,
    fetchProcoreProjectDetail,
    deps: {
      storage: { getSyncMappingByBidboardProjectId, getSyncMappingByProcoreProjectNumber, updateSyncMapping },
      fetchProcoreProjectDetail,
      store: { insertOutbox },
    },
  };
}

describe("photo-link relay on Phase-2 completion", () => {
  beforeEach(() => vi.clearAllMocks());

  it("enqueues the procore.project.created relay on Phase-2 success — the path the webhook if-pending branch skipped", async () => {
    const t = makeDeps();

    const result = await enqueueProjectCreatedRelayForPortfolioProject({
      portfolioProjectId: "598134326634550",
      bidboardProjectId: "bb-1",
      webhookLog: { id: 42, createdAt: new Date("2026-06-09T00:00:00Z"), payload: { id: "wh-9", reason: "create" } },
      deps: t.deps,
    });

    expect(result.enqueued).toBe(true);
    expect(t.insertOutbox).toHaveBeenCalledTimes(1);

    const row: any = t.insertOutbox.mock.calls[0][0];
    // Relay is the right event, for the right portfolio project.
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

    // Stamps portfolioProjectId so the webhook fallback / any re-run no-ops (the once-guard).
    expect(t.updateSyncMapping).toHaveBeenCalledWith(7, { portfolioProjectId: "598134326634550" });
  });

  it("is idempotent (once-guard): skips when the mapping already has a portfolioProjectId", async () => {
    const t = makeDeps({ mapping: { portfolioProjectId: "598134326634550" } });

    const result = await enqueueProjectCreatedRelayForPortfolioProject({
      portfolioProjectId: "598134326634550",
      bidboardProjectId: "bb-1",
      deps: t.deps,
    });

    expect(result).toEqual({ enqueued: false, reason: "already_relayed" });
    expect(t.insertOutbox).not.toHaveBeenCalled();
    expect(t.updateSyncMapping).not.toHaveBeenCalled();
  });

  it("works without an originating webhook (manual / orphan-failsafe Phase-2) — webhookLogId is null", async () => {
    const t = makeDeps();

    const result = await enqueueProjectCreatedRelayForPortfolioProject({
      portfolioProjectId: "598134326634550",
      bidboardProjectId: "bb-1",
      // no webhookLog
      deps: t.deps,
    });

    expect(result.enqueued).toBe(true);
    const row: any = t.insertOutbox.mock.calls[0][0];
    expect(row.webhookLogId).toBeNull();
    expect(row.payload.eventType).toBe("procore.project.created");
  });

  it("falls back to project_number lookup when no bid-board id is given", async () => {
    const t = makeDeps();

    await enqueueProjectCreatedRelayForPortfolioProject({
      portfolioProjectId: "598134326634550",
      // no bidboardProjectId → must resolve the mapping by project_number
      deps: t.deps,
    });

    expect(t.getSyncMappingByBidboardProjectId).not.toHaveBeenCalled();
    expect(t.getSyncMappingByProcoreProjectNumber).toHaveBeenCalledWith("DFW-4-15526-ac");
    expect(t.insertOutbox).toHaveBeenCalledTimes(1);
  });

  it("skips safely when the Procore project has no project_number (CRM resolves by project number)", async () => {
    const t = makeDeps({ projectNumber: null });

    const result = await enqueueProjectCreatedRelayForPortfolioProject({
      portfolioProjectId: "598134326634550",
      bidboardProjectId: "bb-1",
      deps: t.deps,
    });

    expect(result).toEqual({ enqueued: false, reason: "no_project_number" });
    expect(t.insertOutbox).not.toHaveBeenCalled();
  });

  it("skips when no bid-board sync-mapping resolves (e.g. a manual non-bid-board project)", async () => {
    const t = makeDeps({ mapping: { bidboardProjectId: null } });

    const result = await enqueueProjectCreatedRelayForPortfolioProject({
      portfolioProjectId: "598134326634550",
      bidboardProjectId: "bb-1",
      deps: t.deps,
    });

    expect(result).toEqual({ enqueued: false, reason: "no_bidboard_mapping" });
    expect(t.insertOutbox).not.toHaveBeenCalled();
  });
});
