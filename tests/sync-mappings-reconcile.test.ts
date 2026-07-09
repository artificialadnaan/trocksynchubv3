import { describe, it, expect } from "vitest";
import { findIntegrityIssues, partitionIssues, type ReconMappingRow } from "../shared/sync-mappings-reconcile";

function row(over: Partial<ReconMappingRow> & { id: number }): ReconMappingRow {
  return {
    sourceSystem: "hubspot",
    sourceDealId: null,
    procoreProjectId: null,
    portfolioProjectId: null,
    bidboardProjectId: null,
    procoreProjectNumber: null,
    ...over,
  };
}
const cache = (...ids: string[]) => new Set(ids);

describe("findIntegrityIssues — cross-column", () => {
  it("DIFFERENT deals sharing a Procore id across columns → cross_column_conflict (error)", () => {
    const issues = findIntegrityIssues(
      [
        row({ id: 1, sourceDealId: "D1", procoreProjectId: "X", procoreProjectNumber: "DFW-1" }),
        row({ id: 2, sourceDealId: "D2", portfolioProjectId: "X" }),
      ],
      cache("X"),
    );
    const xcol = issues.filter((i) => i.type.startsWith("cross_column"));
    expect(xcol).toHaveLength(1);
    expect(xcol[0]).toMatchObject({ type: "cross_column_conflict", severity: "error", procoreId: "X", mappingIds: [1, 2] });
    expect(xcol[0].projectNumber).toBe("DFW-1");
  });

  it("SAME deal across columns → cross_column_redundant (info, not an alert)", () => {
    const issues = findIntegrityIssues(
      [
        row({ id: 1, sourceDealId: "D1", procoreProjectId: "X" }),
        row({ id: 2, sourceDealId: "D1", portfolioProjectId: "X" }),
      ],
      cache("X"),
    );
    const xcol = issues.filter((i) => i.type.startsWith("cross_column"));
    expect(xcol).toHaveLength(1);
    expect(xcol[0]).toMatchObject({ type: "cross_column_redundant", severity: "info" });
  });

  it("a transitioned row (procore==portfolio on the SAME row) is benign — no cross-column finding", () => {
    const issues = findIntegrityIssues(
      [row({ id: 1, sourceDealId: "D1", procoreProjectId: "X", portfolioProjectId: "X" })],
      cache("X"),
    );
    expect(issues.filter((i) => i.type.startsWith("cross_column"))).toHaveLength(0);
  });

  it("does not double-report the same pair", () => {
    const issues = findIntegrityIssues(
      [
        row({ id: 1, sourceDealId: "D1", procoreProjectId: "X" }),
        row({ id: 2, sourceDealId: "D2", portfolioProjectId: "X" }),
      ],
      cache("X"),
    );
    expect(issues.filter((i) => i.type.startsWith("cross_column"))).toHaveLength(1);
  });

  it("null/absent source_deal_id is NOT treated as 'same deal' (→ conflict)", () => {
    const issues = findIntegrityIssues(
      [
        row({ id: 1, sourceDealId: null, procoreProjectId: "X" }),
        row({ id: 2, sourceDealId: null, portfolioProjectId: "X" }),
      ],
      cache("X"),
    );
    expect(issues[0]).toMatchObject({ type: "cross_column_conflict", severity: "error" });
  });
});

describe("findIntegrityIssues — orphaned portfolio", () => {
  it("portfolio_project_id absent from the cache → orphaned_portfolio (error)", () => {
    const issues = findIntegrityIssues(
      [row({ id: 1, sourceDealId: "D1", portfolioProjectId: "GONE", procoreProjectNumber: "DFW-9" })],
      cache("STILL-HERE"),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ type: "orphaned_portfolio", severity: "error", procoreId: "GONE", mappingIds: [1] });
  });

  it("portfolio present in the cache → no orphan finding", () => {
    const issues = findIntegrityIssues([row({ id: 1, portfolioProjectId: "HERE" })], cache("HERE"));
    expect(issues).toHaveLength(0);
  });

  it("empty cache → NEVER flags orphans (fail-safe on a cache-load failure)", () => {
    const issues = findIntegrityIssues([row({ id: 1, portfolioProjectId: "ANY" })], new Set());
    expect(issues.filter((i) => i.type === "orphaned_portfolio")).toHaveLength(0);
  });

  it("blank/whitespace ids are ignored everywhere", () => {
    const issues = findIntegrityIssues(
      [row({ id: 1, procoreProjectId: "  ", portfolioProjectId: "" })],
      cache("X"),
    );
    expect(issues).toHaveLength(0);
  });
});

describe("partitionIssues", () => {
  it("splits error alerts from info", () => {
    const issues = findIntegrityIssues(
      [
        row({ id: 1, sourceDealId: "D1", procoreProjectId: "X" }),
        row({ id: 2, sourceDealId: "D2", portfolioProjectId: "X" }), // conflict → error
        row({ id: 3, sourceDealId: "D3", procoreProjectId: "Y" }),
        row({ id: 4, sourceDealId: "D3", portfolioProjectId: "Y" }), // redundant → info
      ],
      cache("X", "Y"),
    );
    const { alerts, info } = partitionIssues(issues);
    expect(alerts.every((i) => i.severity === "error")).toBe(true);
    expect(info.every((i) => i.severity === "info")).toBe(true);
    expect(alerts).toHaveLength(1);
    expect(info).toHaveLength(1);
  });
});
