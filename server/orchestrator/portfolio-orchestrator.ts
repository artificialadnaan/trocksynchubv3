/**
 * Portfolio Orchestrator
 * ======================
 *
 * Ties together Phase 1 (Bid Board) and Phase 2 (Portfolio) automation
 * with state tracking. Maintains a queue of pending Phase 2 jobs so that
 * when the Procore webhook fires with the new portfolio project ID,
 * Phase 2 can be triggered automatically.
 *
 * @module orchestrator/portfolio-orchestrator
 */

import { log } from "../index";

export interface PendingPhase2Job {
  bidboardProjectId: string;
  bidboardProjectUrl: string;
  proposalPdfPath?: string | null;
  estimateExcelPath?: string | null;
  timestamp: number;
}

const pendingPhase2Queue: PendingPhase2Job[] = [];
const MAX_QUEUE_SIZE = 100;
const MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Register that Phase 1 has completed for a project.
 * When the Procore Projects webhook arrives, Phase 2 and Phase 3 will be triggered.
 */
export function registerPendingPhase2(
  bidboardProjectId: string,
  options?: { bidboardProjectUrl?: string; proposalPdfPath?: string | null; estimateExcelPath?: string | null }
): void {
  const bidboardProjectUrl = options?.bidboardProjectUrl || "";
  pendingPhase2Queue.push({
    bidboardProjectId,
    bidboardProjectUrl,
    proposalPdfPath: options?.proposalPdfPath ?? null,
    estimateExcelPath: options?.estimateExcelPath ?? null,
    timestamp: Date.now(),
  });
  if (pendingPhase2Queue.length > MAX_QUEUE_SIZE) {
    pendingPhase2Queue.shift();
  }
  log(
    `[orchestrator] Registered pending Phase 2 for bidboard project ${bidboardProjectId} (queue size: ${pendingPhase2Queue.length})`,
    "webhook"
  );
}

/**
 * Take the next pending Phase 2 job from the queue.
 * Returns null if queue is empty or the oldest job has expired.
 */
export function takeNextPendingPhase2(): PendingPhase2Job | null {
  const now = Date.now();
  while (pendingPhase2Queue.length > 0) {
    const job = pendingPhase2Queue.shift()!;
    if (now - job.timestamp < MAX_AGE_MS) {
      return job;
    }
    log(`[orchestrator] Discarded expired pending Phase 2 job for ${job.bidboardProjectId}`, "webhook");
  }
  return null;
}

/**
 * Get current queue size (for diagnostics).
 */
export function getPendingPhase2Count(): number {
  return pendingPhase2Queue.length;
}
