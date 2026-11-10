/**
 * RFP Phase 2, S1a: the timer that drives the E2 sender and the E4 / E5 / N1 follow-ups, started beside the Procore Bid
 * Board create worker (server/routes/index.ts). Each tick: the E2 drain, then the follow-ups, so an E2 that landed this
 * tick has its E4 sent on the same tick.
 *
 * NOT gated on RFP_NONSERVICE_DESTINATION (§12, d9 ruling, S1a r2): the setting governs only NEW stamping (S0), and rows
 * already core-stamped drain under any setting, so a rollback to procore still delivers them. Before activation the timer
 * is inert BY DATA: no row can be core-stamped until the setting is core, so a tick reads an empty outbox (the 0027 probe
 * plus one indexed due-row read per drain), sends nothing and alerts nothing.
 */
import { log } from "../index";
import { processRfpCoreCreateOutbox, type RfpCoreDrainDeps } from "./rfp-core-sender";
import { processRfpCoreFollowupOutbox } from "./rfp-core-followup";

let timer: ReturnType<typeof setInterval> | null = null;
let tickRunning = false;

export async function runRfpCoreWorkerTick(deps: RfpCoreDrainDeps = {}): Promise<void> {
  try {
    await processRfpCoreCreateOutbox(deps);
  } catch (error: any) {
    log(`[rfp-core] E2 sender tick failed: ${error?.message || error}`, "rfp-core");
  }
  try {
    await processRfpCoreFollowupOutbox(deps);
  } catch (error: any) {
    log(`[rfp-core] follow-up tick failed: ${error?.message || error}`, "rfp-core");
  }
}

export function startRfpCoreWorkers(intervalMs = 15_000): void {
  if (timer) return;
  timer = setInterval(() => {
    if (tickRunning) return;
    tickRunning = true;
    void runRfpCoreWorkerTick().finally(() => {
      tickRunning = false;
    });
  }, intervalMs);
  log(
    `[rfp-core] Workers started (${intervalMs}ms): drain already core-stamped rows under any RFP_NONSERVICE_DESTINATION; ` +
      "nothing to send until the first core stamp",
    "rfp-core",
  );
}

export function stopRfpCoreWorkers(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
