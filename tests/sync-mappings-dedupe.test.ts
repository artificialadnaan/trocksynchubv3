import { describe, it, expect } from "vitest";
import {
  planClusterDedupe,
  runSyncMappingsDedupe,
  AmbiguousClusterError,
  type DedupeMappingRow,
  type Queryable,
} from "../server/sync-mappings-dedupe";

function row(over: Partial<DedupeMappingRow> & { id: number }): DedupeMappingRow {
  return {
    sourceSystem: "hubspot",
    sourceDealId: null,
    hubspotDealId: null,
    hubspotCompanyId: null,
    hubspotDealName: null,
    procoreProjectId: "PJ-1",
    procoreCompanyId: null,
    procoreProjectName: null,
    procoreProjectNumber: null,
    companyCamProjectId: null,
    bidboardProjectId: null,
    bidboardProjectName: null,
    portfolioProjectId: null,
    portfolioProjectName: null,
    sentToPortfolioAt: null,
    lastSyncAt: null,
    lastSyncStatus: null,
    lastSyncDirection: null,
    metadata: null,
    ...over,
  };
}

describe("planClusterDedupe", () => {
  it("two junk dupes with no lineage → survivor is lowest id, other deleted, no updates", () => {
    const plan = planClusterDedupe([row({ id: 40 }), row({ id: 12 }), row({ id: 28 })]);
    expect(plan.survivorId).toBe(12);
    expect(plan.deleteIds.sort((a, b) => a - b)).toEqual([28, 40]);
    expect(plan.updates).toEqual({});
  });

  it("COALESCE-merges a sibling's non-null field the survivor lacks; never overwrites a survivor non-null", () => {
    const plan = planClusterDedupe([
      row({ id: 5, procoreProjectName: null, procoreProjectNumber: "DFW-1" }),
      row({ id: 9, procoreProjectName: "Real Name", procoreProjectNumber: "DFW-SHOULD-NOT-WIN" }),
    ]);
    expect(plan.survivorId).toBe(5);
    // survivor lacked the name → takes the sibling's; survivor already had a number → keeps its own
    expect(plan.updates).toEqual({ procoreProjectName: "Real Name" });
    expect(plan.deleteIds).toEqual([9]);
  });

  it("when two siblings both supply a field the survivor lacks, the lowest-id donor wins", () => {
    const plan = planClusterDedupe([
      row({ id: 3, hubspotDealName: null }),
      row({ id: 20, hubspotDealName: "from-20" }),
      row({ id: 8, hubspotDealName: "from-8" }),
    ]);
    expect(plan.survivorId).toBe(3);
    expect(plan.updates).toEqual({ hubspotDealName: "from-8" });
  });

  it("a lineage-bearing row wins survivorship even if it is NOT the lowest id", () => {
    const plan = planClusterDedupe([
      row({ id: 2, procoreProjectName: "junk" }),
      row({ id: 7, bidboardProjectId: "BB-99", bidboardProjectName: "Lineage", procoreProjectName: "Lineage Name" }),
    ]);
    expect(plan.survivorId).toBe(7);
    expect(plan.deleteIds).toEqual([2]);
    // survivor is already complete — a lower-id junk sibling never overwrites its non-null fields
    expect(plan.updates).toEqual({});
  });

  it("treats blank/whitespace strings as null for both survivor gaps and donor eligibility", () => {
    const plan = planClusterDedupe([
      row({ id: 1, procoreProjectName: "   ", lastSyncStatus: "" }),
      row({ id: 4, procoreProjectName: "Filled", lastSyncStatus: "synced" }),
    ]);
    expect(plan.survivorId).toBe(1);
    expect(plan.updates).toEqual({ procoreProjectName: "Filled", lastSyncStatus: "synced" });
  });

  it("merges metadata when the survivor has none", () => {
    const meta = { proposalId: "PROP-7" };
    const plan = planClusterDedupe([row({ id: 1, metadata: null }), row({ id: 2, metadata: meta })]);
    expect(plan.updates.metadata).toBe(meta);
  });

  it("the same lineage id repeated across rows is NOT ambiguous", () => {
    const plan = planClusterDedupe([
      row({ id: 1, bidboardProjectId: "BB-1" }),
      row({ id: 2, bidboardProjectId: "BB-1" }),
    ]);
    expect(plan.survivorId).toBe(1);
    expect(plan.deleteIds).toEqual([2]);
  });

  it("throws AmbiguousClusterError when rows disagree on a bidboard id", () => {
    expect(() =>
      planClusterDedupe([row({ id: 1, bidboardProjectId: "BB-1" }), row({ id: 2, bidboardProjectId: "BB-2" })]),
    ).toThrow(AmbiguousClusterError);
  });

  it("throws AmbiguousClusterError when rows disagree on a portfolio id", () => {
    expect(() =>
      planClusterDedupe([row({ id: 1, portfolioProjectId: "PF-1" }), row({ id: 2, portfolioProjectId: "PF-2" })]),
    ).toThrow(AmbiguousClusterError);
  });

  it("a single-row cluster is a no-op (defensive; the driver never feeds it one)", () => {
    const plan = planClusterDedupe([row({ id: 1 })]);
    expect(plan).toEqual({ survivorId: 1, updates: {}, deleteIds: [] });
  });
});

// --- driver over a fake single-connection Queryable (no real DB) ---

class FakeClient implements Queryable {
  calls: Array<{ text: string; params?: unknown[] }> = [];
  constructor(
    private clusterRows: Record<string, any>[],
    private total: number,
  ) {}
  async query(text: string, params?: unknown[]) {
    this.calls.push({ text, params });
    if (/count\(\*\)::int/.test(text)) return { rows: [{ n: this.total }] };
    if (/WHERE procore_project_id IN/.test(text)) return { rows: this.clusterRows };
    return { rows: [] };
  }
  issued(re: RegExp) {
    return this.calls.filter((c) => re.test(c.text));
  }
}

describe("runSyncMappingsDedupe (driver)", () => {
  const clusterRows = [
    { id: 10, procore_project_id: "PJ-A", procore_project_number: "DFW-A", procore_project_name: null },
    { id: 11, procore_project_id: "PJ-A", procore_project_number: null, procore_project_name: "Name A" },
    { id: 12, procore_project_id: "PJ-A", procore_project_number: null, procore_project_name: null },
    { id: 30, procore_project_id: "PJ-B", procore_project_number: "DFW-B", procore_project_name: null },
    { id: 31, procore_project_id: "PJ-B", procore_project_number: "DFW-B", procore_project_name: null },
  ];

  it("dry-run plans without issuing any write", async () => {
    const c = new FakeClient(clusterRows, 200);
    const report = await runSyncMappingsDedupe(c, { commit: false });
    expect(report.clusters).toBe(2);
    expect(report.rowsToDelete).toBe(3); // PJ-A: delete 11,12 ; PJ-B: delete 31
    expect(report.committed).toBe(false);
    expect(c.issued(/BEGIN|DELETE|UPDATE|COMMIT/i)).toHaveLength(0);
    const a = report.perCluster.find((x) => x.procoreProjectId === "PJ-A")!;
    expect(a.survivorId).toBe(10);
    expect(a.deletedIds.sort((x, y) => x - y)).toEqual([11, 12]);
    expect(a.updates).toEqual({ procoreProjectName: "Name A" });
  });

  it("--commit wraps the collapse in one transaction and deletes the siblings", async () => {
    const c = new FakeClient(clusterRows, 200);
    const report = await runSyncMappingsDedupe(c, { commit: true });
    expect(report.committed).toBe(true);
    expect(c.issued(/^BEGIN$/)).toHaveLength(1);
    expect(c.issued(/^COMMIT$/)).toHaveLength(1);
    // one UPDATE (PJ-A survivor gets the merged name; PJ-B survivor needs nothing)
    expect(c.issued(/UPDATE sync_mappings SET/)).toHaveLength(1);
    const deletes = c.issued(/DELETE FROM sync_mappings WHERE id = ANY/);
    expect(deletes).toHaveLength(2);
    expect(deletes.flatMap((d) => d.params?.[0] as number[]).sort((a, b) => a - b)).toEqual([11, 12, 31]);
  });

  it("no clusters → nothing to do, no transaction (idempotent second run)", async () => {
    const c = new FakeClient([], 200);
    const report = await runSyncMappingsDedupe(c, { commit: true });
    expect(report.clusters).toBe(0);
    expect(report.committed).toBe(false);
    expect(c.issued(/BEGIN/)).toHaveLength(0);
  });
});
