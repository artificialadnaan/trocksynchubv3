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

describe("resolveScheduledSend — biweekly parity is anchored to the occurrence", () => {
  // Codex P1 on #69. Deriving parity from the TICK was safe only while eligibility was one 15-minute
  // slot. With catch-up, the UTC week boundary falls during the local evening in US timezones, so parity
  // flipped mid-occurrence: an alternate-week Wednesday correctly ineligible at 08:00 became eligible
  // after 00:00 UTC, and a biweekly report went out every week.
  const biweekly = {
    frequency: "biweekly",
    dayOfWeek: 3, // Wednesday
    timeOfDay: "08:00:00",
    timezone: "America/Chicago",
  };

  it("gives the same answer all day, either side of the UTC week boundary", () => {
    // 2026-08-12 is a Wednesday. 13:00Z is 08:00 local; 04:00Z the next day is still 23:00 local the SAME
    // Wednesday — but a different UTC week bucket.
    const atSchedule = resolveScheduledSend({
      now: new Date("2026-08-12T13:00:00Z"),
      lastSentAt: null,
      ...biweekly,
    });
    const lateSameLocalDay = resolveScheduledSend({
      now: new Date("2026-08-13T04:00:00Z"),
      lastSentAt: null,
      ...biweekly,
    });
    expect(lateSameLocalDay.send).toBe(atSchedule.send);
    expect(lateSameLocalDay.occurrenceDate).toBe(atSchedule.occurrenceDate);
  });

  it("still alternates weeks rather than sending every Wednesday", () => {
    const wednesdays = ["2026-08-05", "2026-08-12", "2026-08-19", "2026-08-26"];
    const eligible = wednesdays.filter(
      (d) =>
        resolveScheduledSend({
          now: new Date(`${d}T13:00:00Z`),
          lastSentAt: null,
          ...biweekly,
        }).send
    );
    // Every OTHER Wednesday — the defining property of a biweekly schedule.
    expect(eligible.length).toBe(2);
    expect(eligible).not.toEqual(wednesdays);
  });
});

describe("resolveScheduledSend — schedules that fall between ticks", () => {
  // Codex P1 on #69 round 3. The cron only fires at :00/:15/:30/:45, so a time configured at 23:50 has no
  // tick between its due moment and midnight: the next callback lands at 00:00 on a NEW local date, where
  // a daily schedule is before the new due time and a weekly one may not even be a send day. The
  // occurrence became permanently ineligible. The old slot matcher fired during the 23:45 slot.
  const lateNight = {
    frequency: "daily",
    dayOfWeek: null,
    timeOfDay: "23:50:00",
    timezone: "America/Chicago",
  };

  it("fires on the tick whose slot contains a late-night scheduled time", () => {
    // 04:45Z is 23:45 Chicago — the last tick of the local day, and the slot holding 23:50.
    const decision = resolveScheduledSend({
      now: new Date("2026-08-14T04:45:00Z"),
      lastSentAt: new Date("2026-08-13T04:45:00.162Z"),
      ...lateNight,
    });
    expect(decision.send).toBe(true);
  });

  it("still refuses earlier ticks on that day", () => {
    // 04:30Z is 23:30 Chicago — an earlier slot, genuinely before the schedule.
    const decision = resolveScheduledSend({
      now: new Date("2026-08-14T04:30:00Z"),
      lastSentAt: new Date("2026-08-13T04:45:00.162Z"),
      ...lateNight,
    });
    expect(decision.send).toBe(false);
    expect(decision.reason).toContain("before");
  });

  it("delivers a 23:50 schedule every day rather than never", () => {
    let lastSentAt: Date | null = null;
    const sent: string[] = [];
    for (let day = 11; day <= 14; day++) {
      const now = new Date(`2026-08-${day}T04:45:00Z`); // 23:45 Chicago the previous local day
      const d = resolveScheduledSend({ now, lastSentAt, ...lateNight });
      if (d.send) {
        sent.push(d.occurrenceDate!);
        lastSentAt = new Date(now.getTime() + 162);
      }
    }
    expect(sent.length).toBe(4);
  });
});

describe("resolveScheduledSend — biweekly phase for an evening schedule", () => {
  // Codex P2 on #69 round 3: week buckets break on Thursday 00:00 UTC, so 20:00 Chicago on a Wednesday
  // (01:00 UTC Thursday) sits in a DIFFERENT bucket from that Wednesday's local midnight. Keying parity
  // off midnight would have shifted an existing evening schedule's phase on deploy.
  const eveningBiweekly = {
    frequency: "biweekly",
    dayOfWeek: 3, // Wednesday
    timeOfDay: "20:00:00",
    timezone: "America/Chicago",
  };

  it("matches the phase the old tick-based form produced", () => {
    for (const wednesday of ["2026-08-05", "2026-08-12", "2026-08-19", "2026-08-26"]) {
      // The instant the schedule actually fires: 20:00 Chicago = 01:00 UTC the next calendar day.
      const scheduledInstant = new Date(`${wednesday}T20:00:00-05:00`);
      const oldParity =
        Math.floor(scheduledInstant.getTime() / (7 * 24 * 60 * 60 * 1000)) % 2 === 0;
      const decision = resolveScheduledSend({
        now: scheduledInstant,
        lastSentAt: null,
        ...eveningBiweekly,
      });
      expect(decision.send).toBe(oldParity);
    }
  });

  it("keeps that answer stable across the UTC week boundary within one occurrence", () => {
    // 19:00 and 23:00 local on the same Wednesday straddle 00:00 UTC.
    const early = resolveScheduledSend({
      now: new Date("2026-08-12T20:00:00-05:00"),
      lastSentAt: null,
      ...eveningBiweekly,
    });
    const late = resolveScheduledSend({
      now: new Date("2026-08-12T23:30:00-05:00"),
      lastSentAt: null,
      ...eveningBiweekly,
    });
    expect(late.send).toBe(early.send);
  });
});
