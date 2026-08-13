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

export interface ScheduledSendDecision {
  send: boolean;
  /** Always populated, and always logged by the caller — a silent skip is what hid the original bug. */
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
function isSendDay(local: LocalParts, frequency: ScheduleFrequency, dayOfWeek: number | null, now: Date): boolean {
  const targetDow = dayOfWeek ?? 1;
  switch (frequency) {
    case "daily":
      return true;
    case "weekly":
      return local.weekday === targetDow;
    case "biweekly": {
      // Weeks since the epoch, matching the previous implementation so an existing biweekly schedule keeps
      // firing on the same weeks rather than inverting its phase on deploy.
      const weekNum = Math.floor(now.getTime() / (7 * 24 * 60 * 60 * 1000));
      return local.weekday === targetDow && weekNum % 2 === 0;
    }
    case "monthly":
      return local.day === 1;
    default:
      return local.weekday === targetDow;
  }
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
      reason: `unknown timezone "${timezone}" — refusing to guess the send time`,
      occurrenceDate: null,
    };
  }

  if (!isSendDay(local, frequency, dayOfWeek, now)) {
    return { send: false, reason: `not a ${frequency} send day (${local.date})`, occurrenceDate: null };
  }

  const [rawHour, rawMinute] = String(timeOfDay || "08:00").split(":");
  const configHour = Number.parseInt(rawHour, 10);
  const configMinute = Number.parseInt(rawMinute ?? "0", 10);
  if (!Number.isFinite(configHour) || !Number.isFinite(configMinute)) {
    return { send: false, reason: `unusable timeOfDay "${timeOfDay}"`, occurrenceDate: null };
  }

  const nowMinutes = local.hour * 60 + local.minute;
  const dueMinutes = configHour * 60 + configMinute;
  if (nowMinutes < dueMinutes) {
    return {
      send: false,
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
      return { send: false, reason: `already sent for ${local.date}`, occurrenceDate: local.date };
    }
  }

  // Late but eligible. Worth naming in the log: a run that reports catch-up is evidence the scheduled tick
  // was missed, which is otherwise invisible.
  const lateBy = nowMinutes - dueMinutes;
  return {
    send: true,
    reason: lateBy > 15 ? `catch-up for ${local.date} (${lateBy} min after ${timeOfDay})` : `due for ${local.date}`,
    occurrenceDate: local.date,
  };
}
