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

      const { sent } = await sendScheduledRfpReport();
      if (sent > 0) {
        await storage.upsertReportScheduleConfig({ ...config, lastSentAt: now });
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
