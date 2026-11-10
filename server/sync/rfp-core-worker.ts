/**
 * RFP Phase 2, S1a: the timer that drives the E2 sender and the E4 / E5 / N1 follow-ups.
 * S1a RED: exported stubs only, no behaviour (no timer). GREEN implements them and wires them into server/routes/index.ts.
 */
import type { RfpCoreDrainDeps } from "./rfp-core-sender";

export async function runRfpCoreWorkerTick(_deps: RfpCoreDrainDeps = {}): Promise<void> {}

export function startRfpCoreWorkers(_intervalMs = 15_000): void {}

export function stopRfpCoreWorkers(): void {}
