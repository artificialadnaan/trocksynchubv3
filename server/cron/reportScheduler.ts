/**
 * RFP Report Scheduler
 * ====================
 * Uses node-cron to send scheduled RFP report emails based on report_schedule_config.
 * Runs every 15 minutes and sends when config matches (timezone-aware).
 * Only fires if lastSentAt is null or older than the configured frequency window.
 */

import cron from "node-cron";
import { storage } from "../storage";
import { sendScheduledRfpReport } from "../rfp-reports";

let cronTask: ReturnType<typeof cron.schedule> | null = null;

function getFrequencyWindowMs(frequency: string): number {
  const dayMs = 24 * 60 * 60 * 1000;
  switch (frequency) {
    case "daily":
      return dayMs;
    case "weekly":
      return 7 * dayMs;
    case "biweekly":
      return 14 * dayMs;
    case "monthly":
      return 28 * dayMs;
    default:
      return 7 * dayMs;
  }
}

function shouldSendReport(config: {
  frequency: string;
  dayOfWeek: number | null;
  timeOfDay: string;
  timezone: string;
}): boolean {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
    day: "numeric",
    month: "numeric",
    year: "numeric",
  });
  const parts = formatter.formatToParts(now);
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const day = parseInt(parts.find((p) => p.type === "day")?.value ?? "0", 10);
  const month = parseInt(parts.find((p) => p.type === "month")?.value ?? "0", 10);

  const [configHour, configMin] = (config.timeOfDay || "08:00").toString().split(":").map(Number);
  const targetDow = config.dayOfWeek ?? 1;
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const currentDow = dayMap[weekday] ?? 0;

  const currentSlot = hour * 4 + Math.floor(minute / 15);
  const configSlot = configHour * 4 + Math.floor((configMin || 0) / 15);
  if (currentSlot !== configSlot) return false;

  switch (config.frequency) {
    case "daily":
      return true;
    case "weekly":
      return currentDow === targetDow;
    case "biweekly": {
      // Use weeks since Unix epoch for consistent two-week cycles (not per-month)
      const weekNum = Math.floor(now.getTime() / (7 * 24 * 60 * 60 * 1000));
      return currentDow === targetDow && weekNum % 2 === 0;
    }
    case "monthly":
      return day === 1;
    default:
      return currentDow === targetDow;
  }
}

export function startRfpReportScheduler() {
  stopRfpReportScheduler();
  cronTask = cron.schedule("*/15 * * * *", async () => {
    try {
      const config = await storage.getReportScheduleConfig();
      if (!config?.enabled || !config.recipients?.length) return;

      const lastSentAt = config.lastSentAt ? new Date(config.lastSentAt) : null;
      const now = new Date();
      const windowMs = getFrequencyWindowMs(config.frequency);
      if (lastSentAt && now.getTime() - lastSentAt.getTime() < windowMs) return;

      if (
        !shouldSendReport({
          frequency: config.frequency,
          dayOfWeek: config.dayOfWeek,
          timeOfDay: String(config.timeOfDay),
          timezone: config.timezone,
        })
      )
        return;

      // Persist the boundary the report ACTUALLY queried to, not this loop's earlier `now`. The two are
      // different clock samples, and starting the next window from the earlier one re-reports everything
      // entered in between.
      // `now` is handed down so the report's upper bound and this checkpoint are the SAME instant. When
      // the report sampled its own, the checkpoint landed later than this `now` by the query duration,
      // and the next day's guard below (`now - lastSentAt < windowMs`) then returned early — with only a
      // 15-minute matching slot and no later retry, a daily report would have sent every other day.
      const { sent, windowEnd, estimatesOk } = await sendScheduledRfpReport(undefined, now);
      // TWO checkpoints, because they answer different questions and fail independently.
      //
      // lastSentAt records the DELIVERY and drives the cadence guard above, so it advances whenever an
      // email actually went out — otherwise two eligible slots inside one cadence (the fall DST repeat,
      // or an admin moving the send time later) would each send a duplicate.
      //
      // estimatesCoveredThrough records how far the CRM lookup REACHED, so it advances only when the
      // lookup answered — otherwise the interval the CRM failed to provide is skipped forever, since the
      // next window would start after it.
      if (sent > 0) {
        await storage.upsertReportScheduleConfig({
          ...config,
          lastSentAt: windowEnd ?? now,
          ...(estimatesOk ? { estimatesCoveredThrough: windowEnd ?? now } : {}),
        });
        console.log(`[RFP Report] Sent scheduled report to ${sent} recipient(s)`);
      }
    } catch (e: unknown) {
      console.error("[RFP Report] Scheduler error:", e instanceof Error ? e.message : e);
    }
  });
  console.log("[RFP Report] Scheduler started (checks every 15 min)");
}

export function stopRfpReportScheduler() {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
    console.log("[RFP Report] Scheduler stopped");
  }
}
