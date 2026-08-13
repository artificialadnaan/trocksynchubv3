import { describe, expect, it, vi } from "vitest";

// rfp-reports.ts imports ./db (throws without DATABASE_URL), ./storage and ./email-service — mocked here
// exactly as the sibling rfp-report-*.test.ts files do.
vi.mock("../server/db", () => ({ db: {}, pool: {} }));
vi.mock("../server/storage", () => ({ storage: {} }));
vi.mock("../server/email-service", () => ({ sendEmail: vi.fn() }));

const { computeNextRun } = await import("../server/rfp-reports");

/**
 * The preview must agree with the sender.
 *
 * The scheduler catches up on any tick past the scheduled time that has not already sent, so a preview
 * that only looks for the next slot answered "tomorrow" moments before a catch-up email arrived. Feeding
 * it the checkpoint fixed that — and then created the mirror bug Codex caught on the live editor endpoint,
 * which built its config from query params and omitted lastSentAt, so the preview claimed "Due now" for
 * the rest of every eligible day even after the report had landed.
 */
const BASE = {
  enabled: true,
  frequency: "daily",
  dayOfWeek: null,
  timeOfDay: "08:00",
  timezone: "America/Chicago",
  recipients: ["a@example.test", "b@example.test"],
};

describe("computeNextRun — outstanding occurrences", () => {
  it("says the run is due when today's report has not been sent yet", () => {
    // Yesterday's checkpoint, and the scheduled time has passed today.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const next = computeNextRun({ ...BASE, lastSentAt: yesterday });
    // Only meaningful if the scheduled hour has already passed in the config timezone today.
    const localHour = Number(
      new Intl.DateTimeFormat("en-CA", { timeZone: BASE.timezone, hour: "2-digit", hour12: false })
        .format(new Date())
        .replace(/\D/g, "")
    );
    if (localHour >= 8) {
      expect(next).toContain("Due now");
    } else {
      expect(next).not.toContain("Due now");
    }
  });

  it("does NOT say due now once today's report has already gone out", () => {
    // The bug Codex found: without the checkpoint this returned "Due now" for the rest of the day.
    const next = computeNextRun({ ...BASE, lastSentAt: new Date() });
    expect(next).not.toContain("Due now");
    expect(next).toContain("recipient");
  });

  it("does not claim a run is due when the schedule is off", () => {
    expect(computeNextRun({ ...BASE, enabled: false, lastSentAt: null })).toBe("Not scheduled");
    expect(computeNextRun({ ...BASE, recipients: [], lastSentAt: null })).toBe("Not scheduled");
  });

  it("still previews a future occurrence for a schedule that has never run", () => {
    // A brand new schedule whose time has not arrived today must not read as overdue.
    const early = { ...BASE, timeOfDay: "23:59", lastSentAt: null };
    expect(computeNextRun(early)).toContain("recipient");
  });
});
