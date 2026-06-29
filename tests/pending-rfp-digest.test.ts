import { describe, expect, it } from "vitest";
import {
  buildPendingRfpDigest,
  type PendingRfpRow,
  type PendingRfpDigest,
} from "../server/pendingRfpDigest.ts";

// Public base URL is now an explicit input to the builder (no env / localhost fallback).
const APP_URL = "https://hub.trockgc.com";

// Mirrors the prod predicate (isRfpApprovalRequestExpired): expired only when a non-null
// tokenExpiresAt is in the past; null = legacy never-expiring link (kept).
const isExpired = (row: { tokenExpiresAt?: Date | string | null }) =>
  !!row.tokenExpiresAt && new Date() > new Date(row.tokenExpiresAt);

// Fake resolver mirroring the real approver routing: type '4' -> James + Colby,
// everything else (non-service) -> Sidney + James + Tim (the Item-3 non-service set).
const JAMES = "jhelms@trockgc.com";
const COLBY = "cburling@trockgc.com";
const SIDNEY = "sgibson@trockgc.com";
const TIM = "tmitchell@trockgc.com";
const TYPE4 = [JAMES, COLBY];
const NON_SERVICE = [SIDNEY, JAMES, TIM];
async function fakeResolver(projectType: string | null | undefined): Promise<string[]> {
  return String(projectType ?? "").trim() === "4" ? TYPE4 : NON_SERVICE;
}

const digestFor = (d: PendingRfpDigest, email: string) =>
  d.perRecipient.find((r) => r.recipient === email);

describe("buildPendingRfpDigest", () => {
  it("skips the send when there are no pending RFPs", async () => {
    const digest = await buildPendingRfpDigest([], fakeResolver, APP_URL, isExpired);
    expect(digest.skip).toBe(true);
    expect(digest.pendingCount).toBe(0);
    expect(digest.perRecipient).toEqual([]);
  });

  it("scopes each RFP to ONLY its authorized approvers (no cross-type link exposure)", async () => {
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
    // One scoped email per distinct approver across the set.
    expect(digest.perRecipient.map((r) => r.recipient).sort()).toEqual(
      [COLBY, JAMES, SIDNEY, TIM].sort()
    );

    // James approves both routes → sees both RFPs.
    const james = digestFor(digest, JAMES)!;
    expect(james.count).toBe(2);
    expect(james.htmlBody).toContain("Service Job");
    expect(james.htmlBody).toContain("Reno Job");

    // Colby is a SERVICE approver → only the service RFP, never the non-service one.
    const colby = digestFor(digest, COLBY)!;
    expect(colby.count).toBe(1);
    expect(colby.htmlBody).toContain("Service Job");
    expect(colby.htmlBody).not.toContain("Reno Job");
    expect(colby.htmlBody).not.toContain("/rfp-review/tok-reno");

    // Sidney / Tim are NON-SERVICE approvers → only the non-service RFP. They must NOT receive
    // the service RFP's review link (the cross-type-approval exposure this scoping closes).
    for (const email of [SIDNEY, TIM]) {
      const d = digestFor(digest, email)!;
      expect(d.count).toBe(1);
      expect(d.htmlBody).toContain("Reno Job");
      expect(d.htmlBody).not.toContain("Service Job");
      expect(d.htmlBody).not.toContain("/rfp-review/tok-service");
    }
  });

  it("routes a row by the CANONICAL type (project NUMBER digit), not the raw project_types", async () => {
    // Mismatch: routed project_types is '2' (non-service) but the project NUMBER encodes type 4
    // (service) — the approval would CREATE a service project. The digest must bucket this under the
    // SERVICE approvers who can actually act on it (the same canonical type the approve/decline gates
    // authorize against), NOT the non-service set the raw project_types would have picked.
    const rows: PendingRfpRow[] = [
      {
        token: "tok-mismatch",
        createdAt: new Date("2026-06-20T15:00:00Z"),
        dealData: { dealname: "Mismatched Service", project_number: "DFW-4-300", project_types: "2" },
        sourceSystem: "hubspot",
      },
    ];

    const digest = await buildPendingRfpDigest(rows, fakeResolver, APP_URL, isExpired);

    // Bucketed under the SERVICE approvers (canonical type 4), not the non-service set.
    expect(digest.perRecipient.map((r) => r.recipient).sort()).toEqual([COLBY, JAMES].sort());
    const colby = digestFor(digest, COLBY)!;
    expect(colby.count).toBe(1);
    expect(colby.htmlBody).toContain("Mismatched Service");
    // Non-service approvers (raw project_types '2') must NOT receive this service RFP.
    expect(digestFor(digest, SIDNEY)).toBeUndefined();
    expect(digestFor(digest, TIM)).toBeUndefined();
  });

  it("renders project name/number/date and an /rfp-review/<token> link for the recipient's row", async () => {
    const rows: PendingRfpRow[] = [
      {
        token: "abc123",
        createdAt: new Date("2026-06-20T15:00:00Z"),
        dealData: { dealname: "Roof Replacement", project_number: "DFW-2-555", project_types: "2" },
        sourceSystem: "hubspot",
      },
    ];

    const digest = await buildPendingRfpDigest(rows, fakeResolver, APP_URL, isExpired);
    const sidney = digestFor(digest, SIDNEY)!;

    expect(sidney.subject).toContain("1 pending");
    expect(sidney.htmlBody).toContain("Roof Replacement");
    expect(sidney.htmlBody).toContain("DFW-2-555");
    expect(sidney.htmlBody).toContain("Jun 20, 2026");
    expect(sidney.htmlBody).toContain("https://hub.trockgc.com/rfp-review/abc123");
    // Regression: links derive from the passed public base URL, never localhost.
    expect(sidney.htmlBody).not.toContain("localhost");
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
    const sidney = digestFor(digest, SIDNEY)!;

    expect(sidney.htmlBody).toContain("https://hub.trockgc.com/rfp-review/abc123");
    expect(sidney.htmlBody).not.toContain("//rfp-review");
  });

  it("shows the full approver list in the 'Awaiting' column of each scoped digest", async () => {
    const rows: PendingRfpRow[] = [
      {
        token: "other",
        createdAt: new Date("2026-06-20T15:00:00Z"),
        dealData: { dealname: "Other Only", project_number: "DFW-2-9", project_types: "2" },
        sourceSystem: "hubspot",
      },
    ];

    const digest = await buildPendingRfpDigest(rows, fakeResolver, APP_URL, isExpired);
    // Tim's scoped digest still lists the co-approvers awaiting this non-service RFP.
    expect(digestFor(digest, TIM)!.htmlBody).toContain(
      `${SIDNEY}, ${JAMES}, ${TIM}`
    );
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
    const sidney = digestFor(digest, SIDNEY)!;

    expect(sidney.htmlBody).toContain("Final Name");
    expect(sidney.htmlBody).toContain("NEW-2");
    expect(sidney.htmlBody).not.toContain("Stale Name");
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
    const sidney = digestFor(digest, SIDNEY)!;
    expect(sidney.count).toBe(2);
    expect(sidney.htmlBody).toContain("Live Deal");
    expect(sidney.htmlBody).toContain("Legacy Deal");
    expect(sidney.htmlBody).not.toContain("Expired Deal");
    expect(sidney.htmlBody).not.toContain("/rfp-review/expired-tok");
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
    expect(digest.perRecipient).toEqual([]);
  });
});
