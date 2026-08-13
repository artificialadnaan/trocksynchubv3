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
import { resolveScheduledSend } from "./report-cadence";

let cronTask: ReturnType<typeof cron.schedule> | null = null;

export function startRfpReportScheduler() {
  stopRfpReportScheduler();
  cronTask = cron.schedule("*/15 * * * *", async () => {
    try {
      const config = await storage.getReportScheduleConfig();
      if (!config?.enabled || !config.recipients?.length) return;

      const lastSentAt = config.lastSentAt ? new Date(config.lastSentAt) : null;
      const now = new Date();

      // Occurrence-keyed, NOT elapsed-time. The previous form asked "has 24h passed since lastSentAt",
      // comparing two independently jittered clock samples against an exact boundary — so a tick landing
      // milliseconds early returned silently, and with one 15-minute slot and no retry that lost the whole
      // day. It alternated: 3 sends a week instead of 7. See report-cadence.ts.
      const decision = resolveScheduledSend({
        now,
        lastSentAt,
        frequency: config.frequency,
        dayOfWeek: config.dayOfWeek,
        timeOfDay: String(config.timeOfDay),
        timezone: config.timezone,
      });
      if (!decision.send) {
        // Config-level problems would otherwise keep the schedule silent forever with nothing to see. The
        // routine skips (not a send day, before the time, already sent today) stay quiet — at four ticks an
        // hour they would bury everything else.
        if (decision.occurrenceDate === null && !decision.reason.startsWith("not a")) {
          console.warn(`[RFP Report] Not scheduling: ${decision.reason}`);
        }
        return;
      }

      // Persist the boundary the report ACTUALLY queried to, not this loop's earlier `now`. The two are
      // different clock samples, and starting the next window from the earlier one re-reports everything
      // entered in between.
      // `now` is handed down so the report's upper bound and this checkpoint are the SAME instant. When
      // the report sampled its own, the checkpoint landed later than this `now` by the query duration,
      // and the next day's guard below (`now - lastSentAt < windowMs`) then returned early — with only a
      // 15-minute matching slot and no later retry, a daily report would have sent every other day.
      const { sent, windowEnd, estimatesCoveredThrough } = await sendScheduledRfpReport(undefined, now);
      // TWO checkpoints, because they answer different questions and fail independently.
      //
      // lastSentAt records the DELIVERY and drives the cadence guard above, so it advances whenever an
      // email actually went out — otherwise two eligible slots inside one cadence (the fall DST repeat,
      // or an admin moving the send time later) would each send a duplicate.
      //
      // estimatesCoveredThrough records how far the CRM lookup REACHED, so it advances to the boundary
      // the lookup actually returned — the full window normally, the end of the covered stretch on a long
      // catch-up, and not at all when the lookup did not answer. Anything else either skips the interval
      // the CRM failed to provide, or never drains a backlog.
      if (sent > 0) {
        await storage.upsertReportScheduleConfig({
          ...config,
          lastSentAt: windowEnd ?? now,
          ...(estimatesCoveredThrough ? { estimatesCoveredThrough } : {}),
        });
        console.log(`[RFP Report] Sent scheduled report to ${sent} recipient(s) — ${decision.reason}`);
      } else {
        // sendEmail reports failure by returning { success: false } rather than throwing, so a provider
        // outage produced sent=0, no checkpoint write and NO LOG AT ALL — indistinguishable from the
        // scheduler never having run. Diagnosing the 2026-08-13 miss needed the CRM's logs and the
        // database to tell those two apart; this line is so the next one does not.
        console.error(
          `[RFP Report] Attempted ${decision.reason} but delivered to 0 recipients — checkpoint NOT advanced, will retry on the next tick`
        );
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
