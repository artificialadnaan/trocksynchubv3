import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SyncHub #63: the role-polling rotation is owned by ONE replica. Two replicas are modelled as two independent
// module instances of settings.ts (vi.resetModules between imports), sharing one in-memory store whose lease
// behaves like storage's SQL: one owner until it expires, expiry on one clock, cursor writes fenced by the lease.
const store = vi.hoisted(() => ({
  rows: {} as Record<string, any>,
  /** Owners whose process has "died": they stop renewing (their calls are ignored), exactly like a crash. */
  dead: new Set<string>(),
}));

const leaseHeldBy = (key: string, owner: string) => {
  const l = store.rows[key];
  return l && l.owner === owner && typeof l.expiresAt === "number" && l.expiresAt > Date.now();
};

const mocks = vi.hoisted(() => ({
  storage: {
    getAutomationConfig: vi.fn(async (key: string) => (key in store.rows ? { key, value: store.rows[key] } : undefined)),
    getAutomationConfigs: vi.fn(async () => []),
    upsertAutomationConfig: vi.fn(),
    upsertAutomationConfigUnlessAuthDisabled: vi.fn(),
    patchAutomationConfig: vi.fn(),
    tryAcquireAutomationLease: vi.fn(async (key: string, owner: string, ttlMs: number) => {
      if (store.dead.has(owner)) return false;
      const l = store.rows[key];
      if (!l || l.owner === owner || !(l.expiresAt > Date.now())) {
        store.rows[key] = { owner, expiresAt: Date.now() + ttlMs };
        return true;
      }
      return false;
    }),
    releaseAutomationLease: vi.fn(async (key: string, owner: string) => {
      if (store.rows[key]?.owner === owner) store.rows[key] = { ...store.rows[key], expiresAt: 0 };
    }),
    patchAutomationConfigIfLeaseHeld: vi.fn(async (key: string, patch: Record<string, unknown>, leaseKey: string, owner: string) => {
      if (!leaseHeldBy(leaseKey, owner)) return false;
      store.rows[key] = { ...(store.rows[key] ?? {}), ...patch };
      return true;
    }),
    createAuditLog: vi.fn(async () => ({})),
  },
  syncProcoreRoleAssignmentsBatch: vi.fn(),
}));

vi.mock("../server/storage.ts", () => ({ storage: mocks.storage }));
vi.mock("../server/procore.ts", () => ({
  syncProcoreRoleAssignments: vi.fn(),
  syncProcoreRoleAssignmentsBatch: mocks.syncProcoreRoleAssignmentsBatch,
  runFullProcoreSync: vi.fn(),
}));
vi.mock("../server/bidboard-automation.ts", () => ({
  runBidBoardPolling: vi.fn(),
  getAutomationStatus: vi.fn(async () => ({ enabled: false, projectCount: 0, pendingPortfolioTransitions: 0 })),
  enableBidBoardAutomation: vi.fn(),
  manualSyncProject: vi.fn(),
  onBidBoardProjectCreated: vi.fn(),
  detectAndProcessNewProjects: vi.fn(),
}));
vi.mock("../server/playwright/bidboard.ts", () => ({ syncHubSpotClientToBidBoard: vi.fn() }));
vi.mock("../server/sync", () => ({ runBidBoardStageSync: vi.fn() }));
vi.mock("../server/hubspot.ts", () => ({ updateHubSpotDealStage: vi.fn(), runFullHubSpotSync: vi.fn() }));
vi.mock("../server/hubspot-procore-sync.ts", () => ({ triggerPostSyncProcoreUpdates: vi.fn() }));
vi.mock("../server/deal-project-number.ts", () => ({ processNewDealWebhook: vi.fn() }));
vi.mock("../server/playwright/auth", () => ({ testLogin: vi.fn(), saveProcoreCredentials: vi.fn(), logout: vi.fn() }));
vi.mock("../server/playwright/portfolio", () => ({ runPortfolioTransition: vi.fn(), runFullPortfolioWorkflow: vi.fn() }));
vi.mock("../server/playwright/documents", () => ({
  syncHubSpotAttachmentsToBidBoard: vi.fn(),
  syncBidBoardDocumentsToPortfolio: vi.fn(),
}));
vi.mock("../server/playwright/browser", () => ({
  closeBrowser: vi.fn(),
  withBrowserLock: vi.fn((_name: string, fn: () => unknown) => fn()),
}));

const LEASE = "role_assignment_polling_lease";
const CURSOR = "role_assignment_polling_cursor";
const INTERVAL_MS = 23 * 60_000;
const FIRST_RUN_MS = 150_000;
const TTL_MS = 3 * 60_000;

/** Boot one replica: a fresh module instance of settings.ts. Returns its owner id once it has taken a lease turn. */
async function bootReplica() {
  vi.resetModules();
  const mod = await import("../server/routes/settings.ts");
  await mod.initPolling();
  return mod;
}

const batch = (nextCursor: number) => ({ synced: 0, newAssignments: [], nextCursor, totalProjects: 374, batchProcessed: 50 });

describe("role polling — one replica owns the rotation (#63)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    store.rows = { role_assignment_polling: { enabled: true, intervalMinutes: 23, batchSize: 50 } };
    store.dead = new Set();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("two enabled replicas run ONE cycle per tick between them, not one each", async () => {
    mocks.syncProcoreRoleAssignmentsBatch.mockImplementation(async (_size: number, cursor: number) => batch(cursor + 50));
    await bootReplica();
    await bootReplica();

    await vi.advanceTimersByTimeAsync(FIRST_RUN_MS);
    expect(mocks.syncProcoreRoleAssignmentsBatch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2 * INTERVAL_MS);
    expect(mocks.syncProcoreRoleAssignmentsBatch).toHaveBeenCalledTimes(3);
    // One continuous rotation: each batch starts where the previous one ended.
    expect(mocks.syncProcoreRoleAssignmentsBatch.mock.calls.map((c) => c[1])).toEqual([0, 50, 100]);
    expect(store.rows[CURSOR]).toEqual({ batchCursor: 150 });
  });

  it("when the owner dies, another replica takes over within the TTL and resumes from the STORED cursor", async () => {
    mocks.syncProcoreRoleAssignmentsBatch.mockImplementation(async (_size: number, cursor: number) => batch(cursor + 50));
    await bootReplica(); // A boots first and takes the lease
    await vi.advanceTimersByTimeAsync(1);
    const ownerA = store.rows[LEASE].owner;
    await bootReplica(); // B
    await vi.advanceTimersByTimeAsync(FIRST_RUN_MS);
    expect(mocks.syncProcoreRoleAssignmentsBatch.mock.calls.map((c) => c[1])).toEqual([0]); // A's cycle; B skipped
    expect(store.rows[CURSOR]).toEqual({ batchCursor: 50 });

    store.dead.add(ownerA); // A crashes: it never renews again
    await vi.advanceTimersByTimeAsync(TTL_MS + 60_000);
    expect(store.rows[LEASE].owner).not.toBe(ownerA); // B's heartbeat took it

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    // B's own memory still says 0 (it booted before A's cycle). It must resume at 50, from the row.
    expect(mocks.syncProcoreRoleAssignmentsBatch.mock.calls.map((c) => c[1])).toEqual([0, 50]);
    expect(store.rows[CURSOR]).toEqual({ batchCursor: 100 });
  });

  it("a replica that lost the lease mid-cycle cannot rewind the cursor the new owner moved on", async () => {
    let finishSlowBatch!: (r: any) => void;
    mocks.syncProcoreRoleAssignmentsBatch.mockImplementationOnce(() => new Promise((r) => (finishSlowBatch = r)));
    await bootReplica();
    await vi.advanceTimersByTimeAsync(FIRST_RUN_MS); // A's slow batch from cursor 0 is now in flight
    const ownerA = store.rows[LEASE].owner;

    // A stalls long enough to lose the lease; B owns it and moves the cursor to 300.
    store.dead.add(ownerA);
    store.rows[LEASE] = { owner: "replica-b", expiresAt: Date.now() + TTL_MS };
    store.rows[CURSOR] = { batchCursor: 300 };

    finishSlowBatch(batch(50)); // A's OLD batch finishes and tries to write 50
    await vi.advanceTimersByTimeAsync(0);
    expect(store.rows[CURSOR]).toEqual({ batchCursor: 300 });
  });

  it("a tick re-reads the policy row: disabled in the database stops this replica's timer, with no cycle", async () => {
    mocks.syncProcoreRoleAssignmentsBatch.mockImplementation(async (_size: number, cursor: number) => batch(cursor + 50));
    await bootReplica();
    await vi.advanceTimersByTimeAsync(FIRST_RUN_MS);
    expect(mocks.syncProcoreRoleAssignmentsBatch).toHaveBeenCalledTimes(1);

    // Disabled by another replica (or a request whose timer side effect raced): THIS replica was never told.
    store.rows.role_assignment_polling = { enabled: false, intervalMinutes: 23, batchSize: 50 };
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(mocks.syncProcoreRoleAssignmentsBatch).toHaveBeenCalledTimes(1);
    // It stopped itself, and gave the lease up rather than holding it to expiry.
    expect(store.rows[LEASE].expiresAt).toBe(0);

    const readsAfterStop = mocks.storage.getAutomationConfig.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3 * INTERVAL_MS);
    expect(mocks.storage.getAutomationConfig.mock.calls.length).toBe(readsAfterStop);
  });

  it("a replica that cannot reach the lease does not poll (fail closed)", async () => {
    mocks.syncProcoreRoleAssignmentsBatch.mockImplementation(async (_size: number, cursor: number) => batch(cursor + 50));
    mocks.storage.tryAcquireAutomationLease.mockRejectedValue(new Error("db unavailable"));
    await bootReplica();
    await vi.advanceTimersByTimeAsync(FIRST_RUN_MS + INTERVAL_MS);
    expect(mocks.syncProcoreRoleAssignmentsBatch).not.toHaveBeenCalled();
  });
});
