/**
 * RFP approval auto-expiry scheduler — once a day at 3:10 AM America/Chicago, well before the 5:00 PM pending-RFP digest.
 * The night hour is deliberate (CodeRabbit on #142): an approval reads its request without a lock and logs its attempt one
 * round trip later, so an expiry committing in that gap would let the approval's HubSpot writes run on an expired request.
 * At 3 AM no approver is acting. The rule, the switch and the quiet shape live in server/rfpAutoExpire.ts: switched off
 * (the default) it only logs how many requests would expire.
 */

import cron from "node-cron";
import { runRfpAutoExpire } from "../rfpAutoExpire";

export const RFP_AUTO_EXPIRE_CRON = "10 3 * * *";

let cronTask: ReturnType<typeof cron.schedule> | null = null;

export function startRfpAutoExpireScheduler() {
  stopRfpAutoExpireScheduler();
  cronTask = cron.schedule(RFP_AUTO_EXPIRE_CRON, () => void runRfpAutoExpire(), {
    timezone: "America/Chicago",
  });
  console.log("[rfp-auto-expire] daily RFP approval auto-expiry scheduler started (3:10 AM CT)");
}

export function stopRfpAutoExpireScheduler() {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }
}
