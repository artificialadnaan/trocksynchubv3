/**
 * Portfolio Orchestrator
 * ======================
 *
 * Ties together Phase 1 (Bid Board) and Phase 2 (Portfolio) automation
 * with state tracking. Uses a database-backed queue so pending Phase 2 jobs
 * survive restarts and are claimed atomically (preventing race conditions
 * when multiple webhook events fire for the same project).
 *
 * @module orchestrator/portfolio-orchestrator
 */

import { log } from "../index";
import { db } from "../db";
import { pendingPhase2Jobs } from "@shared/schema";
import { eq, and, lt, sql, asc } from "drizzle-orm";

export interface PendingPhase2Job {
  id: number;
  bidboardProjectId: string;
  bidboardProjectUrl: string;
  proposalPdfPath?: string | null;
  estimateExcelPath?: string | null;
  customerName?: string | null;
  timestamp: number;
}

const MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

/** Ensure the table exists (idempotent — safe to call on every startup) */
let tableEnsured = false;
async function ensureTable(): Promise<void> {
  if (tableEnsured) return;
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS pending_phase2_jobs (
        id SERIAL PRIMARY KEY,
        bidboard_project_id TEXT NOT NULL,
        bidboard_project_url TEXT DEFAULT '',
        proposal_pdf_path TEXT,
        estimate_excel_path TEXT,
        customer_name TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        claimed_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS "IDX_phase2_status" ON pending_phase2_jobs (status)
    `);
    tableEnsured = true;
  } catch (e) {
    // Table likely already exists — proceed
    tableEnsured = true;
  }
}

/**
 * Register that Phase 1 has completed for a project.
 * Writes to the database so the job survives restarts.
 */
export async function registerPendingPhase2(
  bidboardProjectId: string,
  options?: { bidboardProjectUrl?: string; proposalPdfPath?: string | null; estimateExcelPath?: string | null; customerName?: string }
): Promise<void> {
  await ensureTable();
  await db.insert(pendingPhase2Jobs).values({
    bidboardProjectId,
    bidboardProjectUrl: options?.bidboardProjectUrl || "",
    proposalPdfPath: options?.proposalPdfPath ?? null,
    estimateExcelPath: options?.estimateExcelPath ?? null,
    customerName: options?.customerName ?? null,
    status: "pending",
    attempts: 0,
  });
  log(
    `[orchestrator] Registered pending Phase 2 for bidboard project ${bidboardProjectId}`,
    "webhook"
  );
}

/**
 * Atomically claim the next pending Phase 2 job from the database.
 * Uses UPDATE ... WHERE status = 'pending' RETURNING to prevent race conditions —
 * only one caller gets the job even if multiple webhook handlers call simultaneously.
 * Returns null if no pending jobs or all have expired.
 */
export async function takeNextPendingPhase2(): Promise<PendingPhase2Job | null> {
  await ensureTable();
  const cutoff = new Date(Date.now() - MAX_AGE_MS);

  // Clean up expired jobs first
  await db.update(pendingPhase2Jobs)
    .set({ status: "expired" })
    .where(and(
      eq(pendingPhase2Jobs.status, "pending"),
      lt(pendingPhase2Jobs.createdAt, cutoff)
    ));

  // Atomic claim: find oldest pending job and mark it claimed in one statement
  const result = await db.execute(sql`
    UPDATE pending_phase2_jobs
    SET status = 'claimed', claimed_at = NOW(), attempts = attempts + 1
    WHERE id = (
      SELECT id FROM pending_phase2_jobs
      WHERE status = 'pending' AND created_at >= ${cutoff}
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);
  const rows = (result as unknown as any[]);
  const claimed = rows?.[0];

  if (!claimed) return null;

  log(
    `[orchestrator] Claimed pending Phase 2 job #${claimed.id} for bidboard project ${claimed.bidboard_project_id}`,
    "webhook"
  );

  return {
    id: claimed.id,
    bidboardProjectId: claimed.bidboard_project_id,
    bidboardProjectUrl: claimed.bidboard_project_url || "",
    proposalPdfPath: claimed.proposal_pdf_path,
    estimateExcelPath: claimed.estimate_excel_path,
    customerName: claimed.customer_name,
    timestamp: new Date(claimed.created_at).getTime(),
  };
}

/**
 * Mark a Phase 2 job as completed.
 */
export async function markPhase2Complete(jobId: number): Promise<void> {
  await db.update(pendingPhase2Jobs)
    .set({ status: "completed", completedAt: new Date() })
    .where(eq(pendingPhase2Jobs.id, jobId));
}

/**
 * Mark a Phase 2 job as failed. If under max attempts, reset to pending for retry.
 */
export async function markPhase2Failed(jobId: number, error: string, maxAttempts: number = 3): Promise<void> {
  const [job] = await db.select({ attempts: pendingPhase2Jobs.attempts })
    .from(pendingPhase2Jobs)
    .where(eq(pendingPhase2Jobs.id, jobId));

  if (job && job.attempts < maxAttempts) {
    // Reset to pending for retry
    await db.update(pendingPhase2Jobs)
      .set({ status: "pending", error })
      .where(eq(pendingPhase2Jobs.id, jobId));
    log(`[orchestrator] Phase 2 job #${jobId} failed (attempt ${job.attempts}/${maxAttempts}), will retry`, "webhook");
  } else {
    // Max attempts exceeded — permanent failure
    await db.update(pendingPhase2Jobs)
      .set({ status: "failed", error, completedAt: new Date() })
      .where(eq(pendingPhase2Jobs.id, jobId));
    log(`[orchestrator] Phase 2 job #${jobId} permanently failed after ${maxAttempts} attempts: ${error}`, "webhook");
  }
}

/**
 * Get current pending queue size (for diagnostics).
 */
export async function getPendingPhase2Count(): Promise<number> {
  const [result] = await db.select({ count: sql<number>`count(*)` })
    .from(pendingPhase2Jobs)
    .where(eq(pendingPhase2Jobs.status, "pending"));
  return Number(result?.count ?? 0);
}

/**
 * Look up the most recent Phase 2 job for a bidboard project (any status).
 * Used by the internal Phase 2 trigger to recover proposalPdfPath.
 */
export async function getPendingPhase2ForBidboard(bidboardProjectId: string): Promise<PendingPhase2Job | null> {
  await ensureTable();
  const [row] = await db.select()
    .from(pendingPhase2Jobs)
    .where(eq(pendingPhase2Jobs.bidboardProjectId, bidboardProjectId))
    .orderBy(asc(pendingPhase2Jobs.createdAt))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    bidboardProjectId: row.bidboardProjectId,
    bidboardProjectUrl: row.bidboardProjectUrl || "",
    proposalPdfPath: row.proposalPdfPath,
    estimateExcelPath: row.estimateExcelPath,
    customerName: row.customerName,
    timestamp: row.createdAt ? new Date(row.createdAt).getTime() : Date.now(),
  };
}
