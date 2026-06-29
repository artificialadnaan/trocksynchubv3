import { describe, expect, it } from "vitest";
import { buildPendingRfpDigest, type PendingRfpRow } from "../server/pendingRfpDigest.ts";

// Public base URL is now an explicit input to the builder (no env / localhost fallback).
const APP_URL = "https://hub.trockgc.com";

// Fake resolver mirroring the real approver routing: type '4' -> James + Colby,
// everything else -> Sidney + James + Tim (the Item-3 non-service fallback).
const TYPE4 = ["jhelms@trockgc.com", "cburling@trockgc.com"];
const NON_SERVICE = ["sgibson@trockgc.com", "jhelms@trockgc.com", "tmitchell@trockgc.com"];
async function fakeResolver(projectType: string | null | undefined): Promise<string[]> {
  return String(projectType ?? "").trim() === "4" ? TYPE4 : NON_SERVICE;
}

describe("buildPendingRfpDigest", () => {
  it("skips the send when there are no pending RFPs", async () => {
    const digest = await buildPendingRfpDigest([], fakeResolver, APP_URL);
    expect(digest.skip).toBe(true);
    expect(digest.pendingCount).toBe(0);
    expect(digest.recipients).toEqual([]);
    expect(digest.htmlBody).toBe("");
  });

  it("builds a de-duplicated union of approvers across rows of different project types", async () => {
    const rows: PendingRfpRow[] = [
      {
        token: "tok-service",
        createdAt: new Date("2026-06-20T15:00:00Z"),
        dealData: { dealname: "Service Job", project_number: "DFW-4-100", project_types: "4" },
        sourceSystem: "hubspot",
      },
      {
        token: "tok-reno",
        createdAt: new Date("2026-06-21T15:00:00Z"),
        dealData: { dealname: "Reno Job", project_number: "DFW-2-200", project_types: "2" },
        sourceSystem: "hubspot",
      },
    ];

    const digest = await buildPendingRfpDigest(rows, fakeResolver, APP_URL);

    expect(digest.skip).toBe(false);
    expect(digest.pendingCount).toBe(2);
    // Union across both rows, de-duplicated (James appears in both).
    expect([...digest.recipients].sort()).toEqual(
      [
        "jhelms@trockgc.com",
        "cburling@trockgc.com",
        "sgibson@trockgc.com",
        "tmitchell@trockgc.com",
      ].sort()
    );
  });

  it("renders project name/number/date and an /rfp-review/<token> link per row", async () => {
    const rows: PendingRfpRow[] = [
      {
        token: "abc123",
        createdAt: new Date("2026-06-20T15:00:00Z"),
        dealData: { dealname: "Roof Replacement", project_number: "DFW-2-555", project_types: "2" },
        sourceSystem: "hubspot",
      },
    ];

    const digest = await buildPendingRfpDigest(rows, fakeResolver, APP_URL);

    expect(digest.htmlBody).toContain("Roof Replacement");
    expect(digest.htmlBody).toContain("DFW-2-555");
    expect(digest.htmlBody).toContain("Jun 20, 2026");
    expect(digest.htmlBody).toContain("https://hub.trockgc.com/rfp-review/abc123");
    // Regression: links derive from the passed public base URL, never localhost.
    expect(digest.htmlBody).not.toContain("localhost");
  });

  it("'awaiting' column reflects the per-row resolver output", async () => {
    const rows: PendingRfpRow[] = [
      {
        token: "svc",
        createdAt: new Date("2026-06-20T15:00:00Z"),
        dealData: { dealname: "Service Only", project_number: "DFW-4-9", project_types: "4" },
        sourceSystem: "hubspot",
      },
      {
        token: "other",
        createdAt: new Date("2026-06-20T15:00:00Z"),
        dealData: { dealname: "Other Only", project_number: "DFW-2-9", project_types: "2" },
        sourceSystem: "hubspot",
      },
    ];

    const digest = await buildPendingRfpDigest(rows, fakeResolver, APP_URL);

    // The service row awaits James + Colby; the non-service row awaits Sidney + James + Tim.
    expect(digest.htmlBody).toContain("jhelms@trockgc.com, cburling@trockgc.com");
    expect(digest.htmlBody).toContain("sgibson@trockgc.com, jhelms@trockgc.com, tmitchell@trockgc.com");
  });

  it("prefers reviewer-edited values over original dealData", async () => {
    const rows: PendingRfpRow[] = [
      {
        token: "edited",
        createdAt: new Date("2026-06-20T15:00:00Z"),
        dealData: { dealname: "Stale Name", project_number: "OLD-1", project_types: "2" },
        editedFields: { dealname: "Final Name", project_number: "NEW-2" },
        sourceSystem: "hubspot",
      },
    ];

    const digest = await buildPendingRfpDigest(rows, fakeResolver, APP_URL);

    expect(digest.htmlBody).toContain("Final Name");
    expect(digest.htmlBody).toContain("NEW-2");
    expect(digest.htmlBody).not.toContain("Stale Name");
  });
});
