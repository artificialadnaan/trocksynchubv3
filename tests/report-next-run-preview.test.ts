import { afterEach, describe, expect, it, vi } from "vitest";

// rfp-reports.ts imports ./db (throws without DATABASE_URL), ./storage and ./email-service — mocked here
// exactly as the sibling rfp-report-*.test.ts files do.
vi.mock("../server/db", () => ({ db: {}, pool: {} }));
vi.mock("../server/storage", () => ({ storage: {} }));
vi.mock("../server/email-service", () => ({ sendEmail: vi.fn() }));

const { computeNextRun } = await import("../server/rfp-reports");
const { resolveScheduledSend } = await import("../server/cron/report-cadence");

/**
 * The preview must agree with the sender.
 *
 * The scheduler catches up on any tick past the scheduled time that has not already sent, so a preview
 * that only looks for the next slot answered "tomorrow" moments before a catch-up email arrived. Feeding
 * it the checkpoint fixed that — and then created the mirror bug Codex caught on the live editor endpoint,
 * which built its config from query params and omitted lastSentAt, so the preview claimed "Due now" for
 * the rest of every eligible day even after the report had landed.
 */
vi.useFakeTimers({ shouldAdvanceTime: true });

const BASE = {
  enabled: true,
  frequency: "daily",
  dayOfWeek: null,
  timeOfDay: "08:00",
  timezone: "America/Chicago",
  recipients: ["a@example.test", "b@example.test"],
};

afterEach(() => {
  vi.useRealTimers();
});

describe("computeNextRun — outstanding occurrences", () => {
  it("says the run is due when today's report has not been sent yet", () => {
    // FROZEN, not branched on the wall clock. The first draft asked Intl for the current hour and asserted
    // one thing or the other — which both made the test assert different things depending on when CI ran,
    // and walked straight into the hour12:false quirk the implementation itself documents: between 00:00
    // and 00:59 Node returns "24", so it took the >= 8 branch and demanded "Due now" while the code
    // correctly previewed the future 08:00 run. A predictable daily CI failure.
    vi.setSystemTime(new Date("2026-08-13T14:00:00Z")); // 09:00 in Chicago — past the 08:00 slot
    const yesterday = new Date("2026-08-12T13:00:00.162Z");
    expect(computeNextRun({ ...BASE, lastSentAt: yesterday })).toContain("Due now");
  });

  it("does not read as due during the midnight hour, when Intl reports hour 24", () => {
    // The exact window that would have broken CI daily.
    vi.setSystemTime(new Date("2026-08-13T05:30:00Z")); // 00:30 in Chicago
    const yesterday = new Date("2026-08-12T13:00:00.162Z");
    expect(computeNextRun({ ...BASE, lastSentAt: yesterday })).not.toContain("Due now");
  });

  it("does NOT say due now once today's report has already gone out", () => {
    // The bug Codex found: without the checkpoint this returned "Due now" for the rest of the day.
    vi.setSystemTime(new Date("2026-08-13T14:00:00Z")); // 09:00 Chicago, after an 08:00 send
    const next = computeNextRun({ ...BASE, lastSentAt: new Date("2026-08-13T13:00:00.162Z") });
    expect(next).not.toContain("Due now");
    expect(next).toContain("recipient");
  });

  it("does not preview a run later today that the scheduler will suppress", () => {
    // Sent at 08:00, then an admin moves the time to 10:00 at 09:00. resolveScheduledSend says the new
    // time has not arrived, so the forward scan used to offer today's 10:00 — but the scheduler suppresses
    // it, because the date is already marked. The preview promised a run that cannot happen.
    vi.setSystemTime(new Date("2026-08-13T14:00:00Z")); // 09:00 Chicago
    const next = computeNextRun({
      ...BASE,
      timeOfDay: "10:00",
      lastSentAt: new Date("2026-08-13T13:00:00.162Z"), // 08:00 Chicago today
    });
    expect(next).not.toContain("Due now");
    // Tomorrow, not today.
    expect(next).toContain("Aug 14");
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

describe("computeNextRun agrees with the sender", () => {
  // Codex, three rounds running, on the same class: the preview carried its own copy of the eligibility
  // maths, so each fix landed on one copy and the two drifted. An evening biweekly schedule is where they
  // diverged last — 20:00 Chicago on a Wednesday is 01:00 UTC Thursday, the next week bucket.
  const eveningBiweekly = {
    enabled: true,
    frequency: "biweekly",
    dayOfWeek: 3, // Wednesday
    timeOfDay: "20:00",
    timezone: "America/Chicago",
    recipients: ["a@example.test"],
    lastSentAt: null,
  };

  it("previews a week the scheduler would actually send in", () => {
    // Stand just before an eligible Wednesday evening and read what the preview promises.
    vi.setSystemTime(new Date("2026-08-10T12:00:00Z"));
    const preview = computeNextRun(eveningBiweekly);

    // Whichever Wednesday it names, the sender must agree that day is eligible.
    const match = preview.match(/Aug (\d+)/);
    expect(match).not.toBeNull();
    const day = Number(match![1]);
    const senderSaysEligible = resolveScheduledSend({
      now: new Date(`2026-08-${String(day).padStart(2, "0")}T20:00:00-05:00`),
      lastSentAt: null,
      frequency: "biweekly",
      dayOfWeek: 3,
      timeOfDay: "20:00",
      timezone: "America/Chicago",
    }).send;
    expect(senderSaysEligible).toBe(true);
  });
});
