/**
 * RFP Phase 2 (CONTRACT v2.4 §2 RE-ARM / §10 Requeue CLI): the EXACT reset a re-arm applies, in one place, so S0's CRM
 * re-post (bidboard-create-worker.ts handleReattempt) and the operator requeue CLI (scripts/rfp-requeue-dead.ts, S1b) can
 * never drift apart on which fields are reset.
 */
import { sql } from "drizzle-orm";

/** A not-yet-sent Core create back on the E2 schedule: attempts, error and refusal cleared, due now. */
export function coreCreateRearmSet(projectNumber: string | null) {
  return sql`status = 'pending', attempt_count = 0, next_attempt_at = NOW(), last_error = NULL, refusal_reason = NULL,
             project_number = ${projectNumber}`;
}

/** A dead follow-up (E4 / N1) back on its schedule: attempts and error cleared, due now. Its stored body is untouched. */
export function coreFollowupRearmSet() {
  return sql`status = 'pending', attempt_count = 0, next_attempt_at = NOW(), last_error = NULL`;
}
