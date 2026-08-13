import { describe, expect, it } from "vitest";
import { resolveScheduledSend } from "../server/cron/report-cadence";

/**
 * The decision this scheduler makes is "have we already sent TODAY's report", not "has 24 hours
 * elapsed". The elapsed-time form compares two independently jittered clock samples against an exact
 * boundary, and on 2026-08-13 that lost a real send: lastSentAt was 13:00:00.162 and the next day's tick
 * landed at ~13:00:00.0xx — 162ms short of 24h — so the guard returned silently and the daily digest
 * skipped a day. With a 15-minute eligibility slot and no retry, losing one tick loses the whole day.
 */

const DAILY = {
  frequency: "daily",
  dayOfWeek: null,
  timeOfDay: "08:00:00",
  timezone: "America/Chicago",
};

describe("resolveScheduledSend — daily cadence", () => {
  it("sends the next day even when the tick lands a few ms short of 24 hours", () => {
    // The exact production numbers from the 2026-08-13 miss.
    const decision = resolveScheduledSend({
      now: new Date("2026-08-13T13:00:00.000Z"),
      lastSentAt: new Date("2026-08-12T13:00:00.162Z"),
      ...DAILY,
    });
    expect(decision.send).toBe(true);
  });

  it("does not send twice on the same local day", () => {
    const decision = resolveScheduledSend({
      now: new Date("2026-08-13T13:30:00.000Z"),
      lastSentAt: new Date("2026-08-13T13:00:00.162Z"),
      ...DAILY,
    });
    expect(decision.send).toBe(false);
    expect(decision.reason).toContain("already sent");
  });

  it("does not send before the scheduled time", () => {
    // 12:00 UTC is 07:00 in Chicago — an hour early.
    const decision = resolveScheduledSend({
      now: new Date("2026-08-13T12:00:00.000Z"),
      lastSentAt: new Date("2026-08-12T13:00:00.162Z"),
      ...DAILY,
    });
    expect(decision.send).toBe(false);
    expect(decision.reason).toContain("before");
  });

  it("catches up later the same day when the scheduled tick was missed", () => {
    // A deploy, a restart or a blocked event loop at 13:00 used to cost the entire day, because the only
    // eligible slot was 15 minutes wide. Late is better than never for a daily digest.
    const decision = resolveScheduledSend({
      now: new Date("2026-08-13T18:45:00.000Z"),
      lastSentAt: new Date("2026-08-12T13:00:00.162Z"),
      ...DAILY,
    });
    expect(decision.send).toBe(true);
    expect(decision.reason).toContain("catch-up");
  });

  it("sends on the first ever run once the scheduled time has passed", () => {
    const decision = resolveScheduledSend({
      now: new Date("2026-08-13T13:00:00.000Z"),
      lastSentAt: null,
      ...DAILY,
    });
    expect(decision.send).toBe(true);
  });

  it("survives a whole week of ticks without ever skipping a day", () => {
    // The regression this exists to prevent: the elapsed-time guard alternated, delivering every 48h.
    let lastSentAt: Date | null = null;
    const sentOn: string[] = [];
    for (let day = 10; day <= 16; day++) {
      // Each day's tick lands a few ms BEFORE the previous send's offset — the worst case for an
      // elapsed-time comparison, and the case that actually happened.
      const now = new Date(`2026-08-${day}T13:00:00.000Z`);
      const decision = resolveScheduledSend({ now, lastSentAt, ...DAILY });
      if (decision.send) {
        sentOn.push(`2026-08-${day}`);
        // Recorded as the real send instant, jittered later than the tick — exactly what the scheduler
        // persists and what defeated the old guard.
        lastSentAt = new Date(now.getTime() + 162);
      }
    }
    expect(sentOn).toEqual([
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
      "2026-08-13",
      "2026-08-14",
      "2026-08-15",
      "2026-08-16",
    ]);
  });

  it("keeps the local day as the boundary across a UTC date change", () => {
    // 23:00 Chicago is already the NEXT day in UTC. Keying off UTC dates would send twice that evening
    // and then skip the following one.
    const lateNight = { ...DAILY, timeOfDay: "23:00:00" };
    const first = resolveScheduledSend({
      now: new Date("2026-08-14T04:00:00.000Z"), // 23:00 Aug 13 in Chicago
      lastSentAt: new Date("2026-08-13T04:00:00.162Z"), // 23:00 Aug 12 in Chicago
      ...lateNight,
    });
    expect(first.send).toBe(true);

    const second = resolveScheduledSend({
      now: new Date("2026-08-14T04:30:00.000Z"), // still 23:30 Aug 13 in Chicago
      lastSentAt: new Date("2026-08-14T04:00:00.162Z"),
      ...lateNight,
    });
    expect(second.send).toBe(false);
  });
});

describe("resolveScheduledSend — other cadences", () => {
  it("only sends on the configured weekday for a weekly schedule", () => {
    const weekly = { frequency: "weekly", dayOfWeek: 1, timeOfDay: "08:00:00", timezone: "America/Chicago" };
    // 2026-08-13 is a Thursday; 2026-08-17 is a Monday.
    expect(
      resolveScheduledSend({ now: new Date("2026-08-13T13:00:00Z"), lastSentAt: null, ...weekly }).send
    ).toBe(false);
    expect(
      resolveScheduledSend({ now: new Date("2026-08-17T13:00:00Z"), lastSentAt: null, ...weekly }).send
    ).toBe(true);
  });

  it("only sends on the first of the month for a monthly schedule", () => {
    const monthly = { frequency: "monthly", dayOfWeek: null, timeOfDay: "08:00:00", timezone: "America/Chicago" };
    expect(
      resolveScheduledSend({ now: new Date("2026-08-13T13:00:00Z"), lastSentAt: null, ...monthly }).send
    ).toBe(false);
    expect(
      resolveScheduledSend({ now: new Date("2026-09-01T13:00:00Z"), lastSentAt: null, ...monthly }).send
    ).toBe(true);
  });

  it("does not resend a monthly report later the same day", () => {
    const monthly = { frequency: "monthly", dayOfWeek: null, timeOfDay: "08:00:00", timezone: "America/Chicago" };
    const decision = resolveScheduledSend({
      now: new Date("2026-09-01T19:00:00Z"),
      lastSentAt: new Date("2026-09-01T13:00:00.162Z"),
      ...monthly,
    });
    expect(decision.send).toBe(false);
  });
});
