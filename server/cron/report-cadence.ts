/**
 * When is the scheduled report due, and has it already gone out?
 *
 * Pure and in its own module: the scheduler imports `storage`, which demands DATABASE_URL at import time,
 * so decision logic living beside it could not be tested without a database. It is the part most worth
 * testing — it silently lost a day of production sends on 2026-08-13.
 *
 * THE QUESTION IS "HAVE WE ALREADY SENT TODAY'S REPORT", NOT "HAS 24 HOURS ELAPSED".
 *
 * The elapsed-time form compared two independently jittered clock samples against an exact boundary:
 * `lastSentAt` was stored as one tick's own `now` (13:00:00.162) and the next day's tick fired at
 * ~13:00:00.0xx — 162ms short of 24h — so the guard returned early and, because eligibility was a single
 * 15-minute slot with no retry, the whole day was skipped. It alternated: every 48 hours, not every 24.
 *
 * A calendar comparison cannot be defeated by jitter, and a catch-up window means a restart, a deploy or a
 * blocked event loop at the scheduled minute costs minutes rather than a day.
 */

export type ScheduleFrequency = "daily" | "weekly" | "biweekly" | "monthly" | string;

export interface ScheduledSendInput {
  now: Date;
  lastSentAt: Date | null;
  frequency: ScheduleFrequency;
  dayOfWeek: number | null;
  /** "HH:MM" or "HH:MM:SS", in `timezone`. */
  timeOfDay: string;
  timezone: string;
}

/**
 * A STABLE discriminator. `reason` is prose for a log line; both consumers were reading it structurally —
 * the scheduler branched on its prefix and the preview rendered it to admins — so rewording a log message
 * would have changed control flow and UI text. Branch on this instead.
 */
export type ScheduledSendOutcome =
  | "due"
  | "catch-up"
  | "already-sent"
  | "before-scheduled-time"
  | "not-a-send-day"
  | "invalid-config";

export interface ScheduledSendDecision {
  send: boolean;
  outcome: ScheduledSendOutcome;
  /** Prose, for logs only. Never branch on it and never show it to a user — see ScheduledSendOutcome. */
  reason: string;
  /** The local calendar date this decision is about (YYYY-MM-DD), or null when today is not a send day. */
  occurrenceDate: string | null;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
  /** YYYY-MM-DD in the target timezone. */
  date: string;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * The wall-clock reading in `timezone`. Everything downstream compares these LOCAL values, because the
 * schedule is expressed in local time: at a 23:00 send time the local day and the UTC day differ, and
 * keying off UTC would send twice one evening and skip the next.
 */
function localParts(instant: Date, timezone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(instant);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const year = parseInt(get("year"), 10);
  const month = parseInt(get("month"), 10);
  const day = parseInt(get("day"), 10);
  // "24" rather than "00" at midnight is a documented Intl hour12:false quirk on some engines.
  const hour = parseInt(get("hour"), 10) % 24;
  const minute = parseInt(get("minute"), 10);

  return {
    year,
    month,
    day,
    hour,
    minute,
    weekday: WEEKDAY_INDEX[get("weekday")] ?? 0,
    date: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

/** Is this local day one the schedule fires on at all? */
function isSendDay(
  local: LocalParts,
  frequency: ScheduleFrequency,
  dayOfWeek: number | null,
  scheduledHour: number,
  scheduledMinute: number,
  timezone: string
): boolean {
  const targetDow = dayOfWeek ?? 1;
  switch (frequency) {
    case "daily":
      return true;
    case "weekly":
      return local.weekday === targetDow;
    case "biweekly": {
      // Parity is anchored to the local occurrence DATE, never to the tick. Deriving it from `now` was safe
      // only while eligibility was a single 15-minute slot: with catch-up spanning hours, the UTC week
      // boundary falls during the local evening in US timezones, so parity FLIPPED mid-occurrence. An
      // alternate-week Wednesday correctly ineligible at 08:00 became eligible after 00:00 UTC, and the
      // biweekly report went out every week — alternating between its configured time and the evening.
      //
      // Days-since-epoch of the local date keeps the same phase as the old tick-based form for daytime
      // schedules (both bucket on the Thursday 00:00 UTC boundary), so an existing biweekly schedule does
      // not invert on deploy.
      // From the occurrence's SCHEDULED INSTANT — the configured local time resolved to UTC — not from
      // local midnight. Week buckets break on Thursday 00:00 UTC, so an evening schedule (20:00 Chicago is
      // 01:00 UTC Thursday) sits in the NEXT bucket from its own local midnight: keying off midnight would
      // have shifted such a schedule's phase on deploy, sending twice one week or opening a three-week gap.
      // The scheduled instant is what the old tick-based form effectively bucketed, so phase is preserved,
      // and being fixed per occurrence it cannot drift during catch-up.
      const scheduled = zonedInstant(local, scheduledHour, scheduledMinute, timezone);
      return local.weekday === targetDow && Math.floor(scheduled.getTime() / (7 * 24 * 60 * 60 * 1000)) % 2 === 0;
    }
    case "monthly":
      return local.day === 1;
    default:
      return local.weekday === targetDow;
  }
}

/**
 * The UTC instant a local wall-clock time denotes. Two passes: guess the instant as if the reading were
 * UTC, see what that guess reads as locally, and correct by the difference — the standard trick for doing
 * this without a timezone library.
 */
function zonedInstant(local: LocalParts, hour: number, minute: number, timezone: string): Date {
  const guess = Date.UTC(local.year, local.month - 1, local.day, hour, minute);
  const readBack = localParts(new Date(guess), timezone);
  const readBackAsUtc = Date.UTC(
    readBack.year,
    readBack.month - 1,
    readBack.day,
    readBack.hour,
    readBack.minute
  );
  return new Date(guess - (readBackAsUtc - guess));
}

export function resolveScheduledSend(input: ScheduledSendInput): ScheduledSendDecision {
  const { now, lastSentAt, frequency, dayOfWeek, timeOfDay, timezone } = input;

  let local: LocalParts;
  try {
    local = localParts(now, timezone);
  } catch {
    // An unknown timezone must not wedge the schedule permanently silent; fall back to UTC and say so.
    local = localParts(now, "UTC");
    return {
      send: false,
      outcome: "invalid-config",
      reason: `unknown timezone "${timezone}" — refusing to guess the send time`,
      occurrenceDate: null,
    };
  }

  // Parsed BEFORE the send-day test, which needs the configured time: a biweekly schedule's parity is
  // anchored to the occurrence's scheduled instant, and that instant is only knowable once the time is.
  const [rawHour, rawMinute] = String(timeOfDay || "08:00").split(":");
  const configHour = Number.parseInt(rawHour, 10);
  const configMinute = Number.parseInt(rawMinute ?? "0", 10);
  if (!Number.isFinite(configHour) || !Number.isFinite(configMinute)) {
    return {
      send: false,
      outcome: "invalid-config",
      reason: `unusable timeOfDay "${timeOfDay}"`,
      occurrenceDate: null,
    };
  }

  if (!isSendDay(local, frequency, dayOfWeek, configHour, configMinute, timezone)) {
    return {
      send: false,
      outcome: "not-a-send-day",
      reason: `not a ${frequency} send day (${local.date})`,
      occurrenceDate: null,
    };
  }

  const nowMinutes = local.hour * 60 + local.minute;
  // Floored to the 15-minute tick grid the cron actually fires on. A schedule set to 23:50 has NO tick
  // between its due time and midnight — the next callback lands at 00:00 on a new local date, where a
  // daily schedule is before the new due time and a weekly one may not even be a send day, so the
  // occurrence was never eligible at all. The previous slot matcher fired during the 23:45 slot, so
  // flooring both preserves that behaviour exactly rather than inventing a new one.
  const dueMinutes = Math.floor((configHour * 60 + configMinute) / 15) * 15;
  if (nowMinutes < dueMinutes) {
    return {
      send: false,
      outcome: "before-scheduled-time",
      reason: `before the scheduled time (${local.date} ${local.hour}:${String(local.minute).padStart(2, "0")} < ${timeOfDay})`,
      occurrenceDate: local.date,
    };
  }

  // THE IDEMPOTENCY KEY: the local calendar date, not an elapsed duration. A send recorded on this date
  // means today's report is done, whatever the clock says about how long ago that was — and whatever an
  // admin has since done to the configured time.
  if (lastSentAt && !Number.isNaN(lastSentAt.getTime())) {
    const lastLocal = localParts(lastSentAt, timezone);
    if (lastLocal.date >= local.date) {
      return {
        send: false,
        outcome: "already-sent",
        reason: `already sent for ${local.date}`,
        occurrenceDate: local.date,
      };
    }
  }

  // Late but eligible. Worth naming in the log: a run that reports catch-up is evidence the scheduled tick
  // was missed, which is otherwise invisible.
  const lateBy = nowMinutes - dueMinutes;
  const late = lateBy > 15;
  return {
    send: true,
    outcome: late ? "catch-up" : "due",
    reason: late ? `catch-up for ${local.date} (${lateBy} min after ${timeOfDay})` : `due for ${local.date}`,
    occurrenceDate: local.date,
  };
}

/**
 * Is the local day containing `instant` one this schedule fires on?
 *
 * Exported so the settings preview asks the SAME question the sender does. Two copies of this logic have
 * now disagreed twice — first on which weeks a biweekly schedule is eligible, then again on the parity
 * anchor — because each fix landed on one copy. There is one copy.
 */
export function isOccurrenceDay(args: {
  instant: Date;
  frequency: ScheduleFrequency;
  dayOfWeek: number | null;
  timeOfDay: string;
  timezone: string;
}): boolean {
  const [rawHour, rawMinute] = String(args.timeOfDay || "08:00").split(":");
  const hour = Number.parseInt(rawHour, 10);
  const minute = Number.parseInt(rawMinute ?? "0", 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;
  try {
    const local = localParts(args.instant, args.timezone);
    return isSendDay(local, args.frequency, args.dayOfWeek, hour, minute, args.timezone);
  } catch {
    return false;
  }
}

/**
 * The YYYY-MM-DD an instant falls on in `timeZone` — the unit this module treats as one occurrence.
 * Exported so callers key off the same shape; this PR removed duplicated recurrence logic and a private
 * copy of the key format would reintroduce exactly that.
 */
export function localOccurrenceDate(instant: Date, timeZone: string): string {
  return localParts(instant, timeZone).date;
}
