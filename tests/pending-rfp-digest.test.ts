import { describe, expect, it } from "vitest";
import { buildPendingRfpDigest, type PendingRfpRow } from "../server/pendingRfpDigest.ts";

// Public base URL is now an explicit input to the builder (no env / localhost fallback).
const APP_URL = "https://hub.trockgc.com";

// Mirrors the prod predicate (isRfpApprovalRequestExpired): expired only when a non-null
// tokenExpiresAt is in the past; null = legacy never-expiring link (kept).
const isExpired = (row: { tokenExpiresAt?: Date | string | null }) =>
  !!row.tokenExpiresAt && new Date() > new Date(row.tokenExpiresAt);

// Fake resolver mirroring the real approver routing: type '4' -> James + Colby,
// everything else -> Sidney + James + Tim (the Item-3 non-service fallback).
const TYPE4 = ["jhelms@trockgc.com", "cburling@trockgc.com"];
const NON_SERVICE = ["sgibson@trockgc.com", "jhelms@trockgc.com", "tmitchell@trockgc.com"];
async function fakeResolver(projectType: string | null | undefined): Promise<string[]> {
  return String(projectType ?? "").trim() === "4" ? TYPE4 : NON_SERVICE;
}

describe("buildPendingRfpDigest", () => {
  it("skips the send when there are no pending RFPs", async () => {
    const digest = await buildPendingRfpDigest([], fakeResolver, APP_URL, isExpired);
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

    const digest = await buildPendingRfpDigest(rows, fakeResolver, APP_URL, isExpired);

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

    const digest = await buildPendingRfpDigest(rows, fakeResolver, APP_URL, isExpired);

    expect(digest.htmlBody).toContain("Roof Replacement");
    expect(digest.htmlBody).toContain("DFW-2-555");
    expect(digest.htmlBody).toContain("Jun 20, 2026");
    expect(digest.htmlBody).toContain("https://hub.trockgc.com/rfp-review/abc123");
    // Regression: links derive from the passed public base URL, never localhost.
    expect(digest.htmlBody).not.toContain("localhost");
  });

  it("strips a trailing slash from the base URL (no // in the link)", async () => {
    const rows: PendingRfpRow[] = [
      {
        token: "abc123",
        createdAt: new Date("2026-06-20T15:00:00Z"),
        dealData: { dealname: "Roof Replacement", project_number: "DFW-2-555", project_types: "2" },
        sourceSystem: "hubspot",
      },
    ];

    const digest = await buildPendingRfpDigest(rows, fakeResolver, "https://hub.trockgc.com/", isExpired);

    expect(digest.htmlBody).toContain("https://hub.trockgc.com/rfp-review/abc123");
    expect(digest.htmlBody).not.toContain("//rfp-review");
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

    const digest = await buildPendingRfpDigest(rows, fakeResolver, APP_URL, isExpired);

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

    const digest = await buildPendingRfpDigest(rows, fakeResolver, APP_URL, isExpired);

    expect(digest.htmlBody).toContain("Final Name");
    expect(digest.htmlBody).toContain("NEW-2");
    expect(digest.htmlBody).not.toContain("Stale Name");
  });

  it("excludes expired-token rows but keeps future and legacy (null) ones", async () => {
    const rows: PendingRfpRow[] = [
      {
        token: "expired-tok",
        createdAt: new Date("2026-01-01T15:00:00Z"),
        dealData: { dealname: "Expired Deal", project_number: "DFW-2-EXP", project_types: "2" },
        tokenExpiresAt: new Date("2020-01-01T00:00:00Z"), // well in the past
        sourceSystem: "hubspot",
      },
      {
        token: "future-tok",
        createdAt: new Date("2026-06-20T15:00:00Z"),
        dealData: { dealname: "Live Deal", project_number: "DFW-2-LIVE", project_types: "2" },
        tokenExpiresAt: new Date("2099-01-01T00:00:00Z"), // well in the future
        sourceSystem: "hubspot",
      },
      {
        token: "legacy-tok",
        createdAt: new Date("2026-06-20T15:00:00Z"),
        dealData: { dealname: "Legacy Deal", project_number: "DFW-2-LEG", project_types: "2" },
        tokenExpiresAt: null, // legacy never-expiring link
        sourceSystem: "hubspot",
      },
    ];

    const digest = await buildPendingRfpDigest(rows, fakeResolver, APP_URL, isExpired);

    expect(digest.skip).toBe(false);
    // Only the two non-expired rows are counted and rendered.
    expect(digest.pendingCount).toBe(2);
    expect(digest.htmlBody).toContain("Live Deal");
    expect(digest.htmlBody).toContain("Legacy Deal");
    expect(digest.htmlBody).not.toContain("Expired Deal");
    expect(digest.htmlBody).not.toContain("/rfp-review/expired-tok");
  });

  it("skips the send when every pending row is expired", async () => {
    const rows: PendingRfpRow[] = [
      {
        token: "exp-only",
        createdAt: new Date("2026-01-01T15:00:00Z"),
        dealData: { dealname: "Expired Only", project_number: "DFW-2-X", project_types: "2" },
        tokenExpiresAt: new Date("2020-01-01T00:00:00Z"),
        sourceSystem: "hubspot",
      },
    ];

    const digest = await buildPendingRfpDigest(rows, fakeResolver, APP_URL, isExpired);

    expect(digest.skip).toBe(true);
    expect(digest.pendingCount).toBe(0);
    expect(digest.htmlBody).toBe("");
  });
});
