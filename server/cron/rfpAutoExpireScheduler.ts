/**
 * RFP approval auto-expiry scheduler — once a day at 4:40 PM America/Chicago, before the 5:00 PM pending-RFP digest,
 * so an RFP that crosses the window drops out of that day's digest. The rule, the switch and the quiet shape live in
 * server/rfpAutoExpire.ts: switched off (the default) it only logs how many requests would expire.
 */

import cron from "node-cron";
import { runRfpAutoExpire } from "../rfpAutoExpire";

export const RFP_AUTO_EXPIRE_CRON = "40 16 * * *";

let cronTask: ReturnType<typeof cron.schedule> | null = null;

export function startRfpAutoExpireScheduler() {
  stopRfpAutoExpireScheduler();
  cronTask = cron.schedule(RFP_AUTO_EXPIRE_CRON, () => void runRfpAutoExpire(), {
    timezone: "America/Chicago",
  });
  console.log("[rfp-auto-expire] daily RFP approval auto-expiry scheduler started (4:40 PM CT)");
}

export function stopRfpAutoExpireScheduler() {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }
}
