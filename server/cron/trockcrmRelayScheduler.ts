import { processTrockCrmRelayOutboxBatch } from "../trockcrm-relay";

let relayTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startTrockCrmRelayScheduler() {
  stopTrockCrmRelayScheduler();

  if (process.env.TROCKCRM_RELAY_ENABLED === "false") {
    console.log("[TrockCRMRelay] Scheduler disabled by TROCKCRM_RELAY_ENABLED=false");
    return;
  }
  if (!process.env.SYNCHUB_RELAY_SECRET?.trim()) {
    console.warn("[TrockCRMRelay] SYNCHUB_RELAY_SECRET missing; relay outbox processing disabled");
    return;
  }

  relayTimer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const result = await processTrockCrmRelayOutboxBatch({ limit: 25 });
      if (result.processed > 0) {
        console.log(`[TrockCRMRelay] processed=${result.processed} sent=${result.sent} failed=${result.failed} abandoned=${result.abandoned}`);
      }
    } catch (err) {
      console.error("[TrockCRMRelay] Outbox processing failed:", err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  }, 60_000);

  console.log("[TrockCRMRelay] Outbox scheduler started (every 60 seconds)");
}

export function stopTrockCrmRelayScheduler() {
  if (relayTimer) {
    clearInterval(relayTimer);
    relayTimer = null;
  }
  running = false;
}
