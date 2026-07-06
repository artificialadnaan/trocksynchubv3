import { sql } from "drizzle-orm";
import { log } from "../index";
import { storage } from "../storage";
import { parseProjectTypeFromNumber } from "../constants";
import { checkRfpApprovalSourceEligibility } from "../rfp-approval";
import { RFP_OVERRIDE_APPROVING_STATUS } from "@shared/schema";
import { buildBidBoardCreatedCallbackTargetUrl } from "./bidboard-callback-worker";
import type { CreateFromRfpInput } from "../routes/rfp-requests";

// Durable command outbox for create-from-rfp (findings V1-V4). See shared/schema.ts bidboardCreateOutbox.
// The endpoint persists a command before its 202; this SERIAL worker (one create at a time, matching the global
// browser lock) does the eligibility recheck + guards + Playwright create + durable callback — without holding a
// request-thread pool client across the long create.

let createWorkerTimer: ReturnType<typeof setInterval> | null = null;
let createWorkerRunning = false;

// A create SUCCEEDED (Procore project exists) but its source-deal sync mapping wasn't persisted (the internal
// createSyncMapping was caught + only logged). This is NOT a create failure: emitting a 'failed' callback would
// tell the CRM the create failed even though the project exists. Carries the created project id + the exact mapping
// row to write so the drain can reconcile the mapping DIRECTLY (storage.createSyncMapping) — WITHOUT re-running the
// Playwright create, which could create a SECOND project for the same accepted vote if its exact-number lookup
// transiently errors (createBidBoardProjectFromDeal proceeds to create on lookup "error").
export class CreatedMappingMissingError extends Error {
  constructor(
    message: string,
    readonly bidboardProjectId: string,
    readonly mappingPayload: Parameters<typeof storage.createSyncMapping>[0],
  ) {
    super(message);
    this.name = "CreatedMappingMissingError";
  }
}

// createBidBoardProjectFromDeal returned success:false with an INDETERMINATE outcome ("Could not confirm project
// creation") — the create UI click happened but neither a success toast nor an error message was seen, so a project
// MAY exist in Procore without a mapping/known id. This is NOT a genuine no-project failure: a terminal 'failed'
// callback would tell the CRM the vote failed while Procore may hold the project. It is parked 'needs_manual' (no
// callback, not supersedable, and NOT auto re-drained — a re-drain could DUPLICATE the maybe-created project, since
// createBidBoardProjectFromDeal re-creates on an inconclusive number lookup). A fresh same-deal round is still
// blocked from creating a duplicate by the sibling-recovery guard in performCreateFromRfpVote (which refuses when a
// sibling row is 'reclaiming'/'needs_manual'). A human resolves it — matching the override-approve path.
export class UnconfirmedCreateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnconfirmedCreateError";
  }
}

async function getDb() {
  return (await import("../db")).db;
}

// Persist a create command (called by the endpoint BEFORE its 202 — finding V3). Idempotent on source_event_id:
// a duplicate delivery is a no-op; a previously FAILED command is re-queued (the CRM's rep-driven retry re-POSTs
// the same source_event_id, so DO NOTHING would otherwise strand the retry).
export async function enqueueBidboardCreateCommand(input: CreateFromRfpInput): Promise<void> {
  const db = await getDb();
  // finding (atomic enqueue+supersede): the INSERT and the same-deal supersede run as ONE statement via a
  // data-modifying CTE. Two separate statements leave a window where the INSERT has committed but the supersede
  // hasn't run yet, during which a worker tick (this or another instance) can claim the older pending row (flip it
  // to 'processing'); the supersede then skips it (it only touches 'pending') and the worker creates the stale
  // project the supersede was meant to retire. As a single statement the older rows are superseded atomically with
  // the insert — a concurrent claim's FOR UPDATE SKIP LOCKED either runs before (sees only the old round) or after
  // (sees the rows already superseded), never in between.
  //
  // KNOWN bounded residual (P3, deferred): this atomicity is enqueue-vs-worker-claim, NOT enqueue-vs-enqueue. Two
  // DISTINCT rounds for the same deal enqueued CONCURRENTLY each run their CTE in its own READ COMMITTED snapshot
  // and miss the other's uncommitted INSERT, so neither supersedes the other; both sit 'pending' and the serial
  // drain runs the lower-id (older) round, after which the newer round is Y2-refused for manual resolution. Damage
  // is bounded — NO duplicate project, just the older round winning a near-simultaneous tie. A full fix is a
  // per-deal pg_advisory_xact_lock(hashtext(source_system||':'||source_deal_id)) around this CTE in a transaction;
  // deferred because it cannot be regression-tested on single-connection PGlite and the impact is bounded.
  await db.execute(sql`
    WITH upsert AS (
    INSERT INTO bidboard_create_outbox
      (source_system, source_deal_id, source_event_id, project_number, payload, status, next_attempt_at, created_at)
    VALUES (
      ${input.sourceSystem}, ${input.sourceDealId}, ${input.sourceEventId},
      ${input.deal.projectNumber ?? null}, ${JSON.stringify(input)}::jsonb, 'pending', NOW(), NOW()
    )
    ON CONFLICT (source_event_id) DO UPDATE
      -- finding Y4: refresh the stored payload + project_number + source fields on re-queue. A rep who corrected
      -- the CRM deal and re-posts the same sourceEventId must have the worker retry with the CORRECTED body, not
      -- the stale one — so create/callback use the new project number / attachments, not the old.
      SET status = 'pending', next_attempt_at = NOW(), attempt_count = 0, last_error = NULL,
          payload = EXCLUDED.payload, project_number = EXCLUDED.project_number,
          source_system = EXCLUDED.source_system, source_deal_id = EXCLUDED.source_deal_id,
          -- refresh the receipt time on re-queue: processBidboardCreateOutbox stamps every callback with the row's
          -- created_at (≈ CRM vote time). Leaving it at the ORIGINAL attempt would make a corrected retry's
          -- 'created' callback carry a timestamp OLDER than the CRM's fresh round/retry, and the CRM's
          -- createdAt-vs-requested_at/reviewed_at freshness would reject it as stale. A re-queue IS a new receipt,
          -- so stamp created_at = NOW() (this also re-orders it fairly in the FIFO drain).
          created_at = NOW()
      -- Re-queue + refresh a 'failed' row or a STILL-'pending' row (a corrected re-post that arrived BEFORE the
      -- worker claimed it — otherwise the worker would run the STALE first payload). A 'processing' row is NEVER
      -- refreshed here (finding): a create can legitimately run longer than any fixed window (slow Playwright + a
      -- large attachment sync), so rewriting it back to 'pending' while a worker is mid-create would let that worker
      -- finalize the refreshed row (markCreateCommandDone) and silently drop the corrected payload. The in-flight
      -- attempt OWNS its row; a crashed worker's stuck 'processing' row is recovered by the stale-reclaim in
      -- claimNextBidboardCreateCommand (which re-runs the row's ORIGINAL payload), and a corrected re-post lands once
      -- the attempt reaches a terminal state. (This deliberately supersedes the earlier AA2 refresh-processing
      -- behavior, trading a rare corrected-re-post-during-create staleness for not corrupting a live long-running
      -- create.)
      -- DELIBERATELY NOT refreshed even when STALE (do not "accept corrected retries for stale processing rows"): a
      -- bare-'processing' row can hold a CREATED-BUT-UNMAPPED project under its ORIGINAL number — a hard crash in the
      -- create→park window, or a DB outage during park (the reconcile's own fallback logs "left 'processing'"), can
      -- leave one. Re-running its ORIGINAL payload safely ADOPTS that project (SyncHub number-map adopt OR Procore
      -- exact-number adopt, both keyed on the original number). Refreshing the payload to a REVISED number would
      -- defeat BOTH adopts (they look up the old number, miss the created project) and CREATE A SECOND project — a
      -- duplicate for one accepted vote. So a stale 'processing' row is left for its ORIGINAL-payload reclaim; the
      -- rep's revised-number correction lands after that reclaim reaches a terminal state.
      -- Also re-queue a 'done' row for CALLBACK RECOVERY (finding): 'done' only means the created callback was
      -- ENQUEUED, not delivered. If that callback later went 'dead' (exhausted its retries) or was lost while the
      -- CRM stayed unaware, a same-sourceEventId retry would otherwise 202-no-op and leave the deal permanently
      -- unlinked. Re-queue ONLY when NO live (pending/sent) CREATED callback exists for the deal — the worker then
      -- re-runs perform's mapping-first ADOPT and re-sends the 'created' callback. Scope the check to CREATED
      -- callbacks (payload.status='created'): a 'sent' FAILED callback from an earlier attempt must NOT block
      -- recovery of a later successful create whose 'created' callback was lost. A live created callback stays put
      -- (preserves duplicate-delivery idempotency).
      -- The newer-round guard is applied PER-BRANCH (not once over the whole WHERE) because the two re-queue kinds
      -- need DIFFERENT "which newer rounds block me" rules:
      WHERE (
        (
           bidboard_create_outbox.status IN ('failed', 'pending')
           -- RE-QUEUE-TO-PENDING branch: this flips the row back to 'pending' and it will DRAIN (create a project).
           -- finding (don't revive a stale round ahead of a newer vote): do NOT re-queue THIS (older, lower-id) row
           -- when a NEWER same-deal round exists. A rep retry of an older sourceEventId would otherwise flip the
           -- older 'failed'/'pending' row back to pending; the supersede below only retires rows with id < the row it
           -- just wrote, so the newer higher-id round stays put, and the id-ordered drain would run the OLDER
           -- (obsolete, possibly revised-number) create first and then refuse the actual latest vote.
           -- finding (block older retries behind newer FAILED rounds too): a newer round that FAILED is NOT stale for
           -- the DRAIN concern — it is the latest reviewed vote awaiting ITS OWN retry (e.g. a transient Playwright
           -- error under a revised number). If BOTH rounds are 'failed' (round 1 was 'processing' when round 2
           -- enqueued, so round 2's supersede couldn't retire it, then both failed), excluding 'failed' here let an
           -- older round's late retry re-queue and drain ahead of round 2: it would create round 1's obsolete
           -- project, after which round 2's retry hits the same-deal revised-number guard and is refused — so the
           -- latest vote never creates. So here ONLY a 'superseded' newer row (definitively retired by an even-newer
           -- round) does NOT block; a newer row in ANY other status blocks. A purely-'superseded' newer chain always
           -- terminates in a non-superseded row (the one that did the last supersede), so the top of the chain still
           -- blocks; the NEWEST round's own retry is never blocked (nothing has a higher id than it).
           AND NOT EXISTS (
             SELECT 1 FROM bidboard_create_outbox nb
              WHERE nb.source_system = EXCLUDED.source_system
                AND nb.source_deal_id = EXCLUDED.source_deal_id
                AND nb.id > bidboard_create_outbox.id
                AND nb.status <> 'superseded'
           )
        )
        OR (
           bidboard_create_outbox.status = 'done'
           AND NOT EXISTS (
             SELECT 1 FROM bidboard_callback_outbox cb
              WHERE cb.source_system = EXCLUDED.source_system
                AND cb.source_deal_id = EXCLUDED.source_deal_id
                AND cb.rfp_approval_request_id IS NULL
                AND cb.status IN ('pending', 'sent')
                AND cb.payload->>'status' = 'created'
           )
           -- CALLBACK-RECOVERY branch: this re-runs perform's mapping-first ADOPT (the project already exists) to
           -- re-send a lost 'created' callback — it does NOT create a new project. So it must NOT inherit the
           -- failed-blocks-too rule above: a newer FAILED round created/linked NOTHING, so this 'done' row's project
           -- is still the deal's actual mapping and its lost 'created' callback must stay recoverable. Defer only to a
           -- newer round that is itself live/completed (pending/processing/reclaiming/needs_manual/done) — a newer
           -- 'superseded' OR 'failed' round is stale for the LINK and does not block re-sending this project's
           -- callback. (This preserves the pre-finding behavior of the callback-recovery re-queue.)
           AND NOT EXISTS (
             SELECT 1 FROM bidboard_create_outbox nb
              WHERE nb.source_system = EXCLUDED.source_system
                AND nb.source_deal_id = EXCLUDED.source_deal_id
                AND nb.id > bidboard_create_outbox.id
                AND nb.status NOT IN ('superseded', 'failed')
           )
        )
      )
    RETURNING id
    )
    -- Supersede any OLDER still-PENDING create command for the SAME source deal. The CRM opens a fresh round (a new
    -- source_event_id) when a deal is re-reviewed; if an earlier round's command is still pending — the worker's
    -- 15s tick hasn't claimed it, or the worker was down — the drain would run that earlier command FIRST and
    -- create its (possibly revised-number) project, after which THIS newer command hits the same-deal
    -- revised-number guard and is REFUSED, so the latest approved vote never creates its intended project. Mark the
    -- earlier PENDING same-deal rows 'superseded' (a terminal, non-claimable status).
    --
    -- Stale-event guard: joining FROM upsert means the supersede runs ONLY when THIS command was actually inserted
    -- OR re-queued (the ON CONFLICT WHERE matched). A LATE duplicate of an OLDER source_event_id whose row is
    -- already superseded/done/processing makes the ON CONFLICT a NO-OP, upsert is EMPTY, the join yields no rows,
    -- and nothing is superseded, so that stale re-delivery can't retire the newer approved round.
    --
    -- Order by the immutable serial id (t.id < upsert.id), NOT created_at: a re-queue of a FAILED/PENDING older
    -- round refreshes its created_at to NOW() (finding Y4), which would make that older round look NEWEST by
    -- timestamp and wrongly supersede a genuinely newer pending round. id is assigned at first INSERT and never
    -- changes on ON CONFLICT DO UPDATE, so id-less-than-ours == "arrived before us" regardless of created_at.
    -- (t.id < upsert.id also excludes the just-written row; a 'processing' row is left alone -- it isn't 'pending'.)
    UPDATE bidboard_create_outbox t
       SET status = 'superseded', processed_at = NOW(),
           last_error = 'superseded by a newer create command for the same source deal'
      FROM upsert
     WHERE t.source_system = ${input.sourceSystem}
       AND t.source_deal_id = ${input.sourceDealId}
       AND t.status = 'pending'
       AND t.id < upsert.id
  `);
}

// Claim ONE pending/retryable command at a time (serial → satisfies the same-project-number ordering V1 needs +
// keeps at most one Playwright create in flight, matching withBrowserLock). FOR UPDATE SKIP LOCKED so overlapping
// ticks can't double-claim. Also RE-CLAIMS a stale 'processing' row (finding X3): if the worker crashed after
// claiming but before marking done/failed, the row would otherwise be stuck 'processing' forever and the
// 202-accepted vote would sit with no project/callback — so a processing row untouched for >10m (well past any
// real create) is picked back up, bounded by attempt_count < max_attempts.
const STALE_PROCESSING_INTERVAL = "10 minutes";
// SAME-PASS guard (finding Macroscope): the drain now CONTINUES past an unreconciled 'reclaiming' row (see the drain
// loop) instead of breaking, so that row must NOT be re-claimed within the SAME drain pass — otherwise, once the pass
// outlasts any fixed backoff (a long pass full of slow Playwright creates), claimNext would re-claim it and burn all
// max_attempts in one pass (premature escalation to needs_manual on a transient blip). A TIME-based backoff can't be
// "longer than the worst-case drain," so the drain passes the set of ids it already claimed THIS pass and claimNext
// excludes them — duration-INDEPENDENT.
// CROSS-PASS cadence: markReclaiming ALSO stamps a small durable next_attempt_at floor (RECLAIM_RETRY_FLOOR) so retry
// spacing survives even if passes are driven back-to-back (a manual "drain now", a shortened interval) rather than
// relying solely on the 15s worker tick. The floor is NOT the same-pass guard (the set is) — so it needn't exceed the
// drain wall-clock; it only paces retries across passes.
const RECLAIM_RETRY_FLOOR = "5 seconds";
export async function claimNextBidboardCreateCommand(excludeIds: Iterable<number> = []): Promise<any | null> {
  const db = await getDb();
  // ids come from row.id (DB serial) — coerce to finite integers, so raw interpolation carries no injection risk.
  const excluded = Array.from(excludeIds, Number).filter((n) => Number.isInteger(n));
  const excludeClause = excluded.length > 0 ? sql`AND id NOT IN (${sql.raw(excluded.join(","))})` : sql``;
  const result = await db.execute(sql`
    UPDATE bidboard_create_outbox
       SET status = 'processing', last_attempt_at = NOW(), attempt_count = attempt_count + 1
     WHERE id IN (
       SELECT id FROM bidboard_create_outbox
        WHERE attempt_count < max_attempts
          AND (
            (status = 'pending' AND next_attempt_at <= NOW())
            -- 'reclaiming' = a created-but-unmapped project awaiting mapping reconciliation. It is claimed (and
            -- re-claimed by id order, so it blocks later same-number commands) but is NOT 'pending', so the enqueue
            -- supersede can never retire it. The drain routes it to the mapping reconcile (by its persisted project
            -- id), never a Playwright re-create.
            OR (status = 'reclaiming' AND next_attempt_at <= NOW())
            OR (status = 'processing' AND last_attempt_at < NOW() - interval '${sql.raw(STALE_PROCESSING_INTERVAL)}')
          )
          -- finding (don't drain past an in-flight/just-crashed same-deal create): do NOT claim a candidate when a
          -- LOWER-id same-deal row is still 'processing' and NOT yet stale-reclaimable. Such a row may have already
          -- clicked create (a maybe-created project invisible to the ownership guard until its mapping lands), so a
          -- later same-deal/number command jumping ahead could adopt it for the wrong deal or duplicate it. Wait
          -- behind it until it completes or its 10-min stale window lets it be reclaimed + resolved. (In normal
          -- single-tick draining the in-flight row is already terminal before the next claim, so this only bites the
          -- cross-tick crash case.)
          AND NOT EXISTS (
            SELECT 1 FROM bidboard_create_outbox p
             WHERE p.id < bidboard_create_outbox.id
               AND p.status = 'processing'
               AND p.last_attempt_at >= NOW() - interval '${sql.raw(STALE_PROCESSING_INTERVAL)}'
               -- same deal OR same project_number: a fresh in-flight create for either could own the maybe-created
               -- Procore project this candidate would otherwise duplicate/mis-adopt (cross-deal number collisions
               -- should be precluded by the DFW/ATL numbering, but guarding by number too is cheap defense-in-depth).
               AND (
                 (p.source_system = bidboard_create_outbox.source_system AND p.source_deal_id = bidboard_create_outbox.source_deal_id)
                 OR (bidboard_create_outbox.project_number IS NOT NULL AND p.project_number = bidboard_create_outbox.project_number)
               )
          )
          -- finding (Macroscope): exclude rows already claimed EARLIER in this same drain pass. A 'reclaiming' row the
          -- drain just parked (and continued past) must not be re-claimed later in the SAME pass, no matter how long
          -- the pass runs — otherwise a long pass burns all its max_attempts in one go. This is duration-independent
          -- (unlike a time-based backoff); the row is re-claimable on the NEXT tick's pass (fresh exclusion set).
          ${excludeClause}
        -- finding: drain by the immutable serial id (arrival order), NOT created_at. created_at is REFRESHED to
        -- NOW() when a still-pending/failed command is re-queued (Y4), which would reorder the FIFO drain and let a
        -- later-arrived same-project-number command create/link the project first while the corrected original then
        -- fails the ownership guard — reversing the serial ownership guarantee. id never changes on re-queue, so it
        -- is the stable arrival order. (Callbacks still stamp the refreshed created_at for CRM freshness — receipt
        -- time is deliberately decoupled from drain order here.)
        ORDER BY id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     RETURNING *
  `);
  const rows = Array.isArray(result) ? result : ((result as any).rows ?? []);
  return rows[0] ?? null;
}

async function markCreateCommandDone(id: number): Promise<void> {
  const db = await getDb();
  await db.execute(sql`
    UPDATE bidboard_create_outbox SET status = 'done', processed_at = NOW(), last_error = NULL WHERE id = ${id}
  `);
}

// A create failure is TERMINAL for the worker (status='failed') — like the pre-rebuild behaviour, the CRM shows
// send_failed and the rep re-triggers, which re-queues via enqueueBidboardCreateCommand. The failed CALLBACK is
// still delivered durably (below) so the CRM learns of it.
async function markCreateCommandFailed(id: number, error: string): Promise<void> {
  const db = await getDb();
  await db.execute(sql`
    UPDATE bidboard_create_outbox SET status = 'failed', processed_at = NOW(), last_error = ${error} WHERE id = ${id}
  `);
}

// finding: once perform has delivered the terminal FAILED callback (a genuine create failure OR a pre-create
// refusal — ineligible/conflict/ownership), the command is logically terminal and must NOT re-run the create path.
// If the terminal-status bookkeeping (markCreateCommandFailed) throws, the row would be left 'processing' and a
// reclaim would re-run perform from scratch — so an RFP the CRM was already told FAILED could later create a project
// once the external eligibility/conflict condition changes. Retry ONLY the status bookkeeping (a fresh pool
// connection usually clears a transient blip) so the row reliably lands 'failed' (never re-picked). Returns false
// only if every attempt fails — an extended DB outage, during which a reclaim's create can't run either.
async function markCreateCommandFailedResilient(id: number, error: string): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await markCreateCommandFailed(id, error);
      return true;
    } catch (e: any) {
      if (attempt === 3) {
        log(`[bidboard-create] Command ${id} markCreateCommandFailed exhausted ${attempt} attempts (${e?.message || e}); left 'processing' — a later reclaim re-refuses idempotently`, "sync");
        return false;
      }
    }
  }
  return false;
}

// finding: a POST-create failure (the project was created but the 'created' callback couldn't be enqueued — e.g.
// TROCK_CRM_BASE_URL missing) leaves the row 'processing' for the stale-reclaim to re-run + adopt. RESET
// attempt_count so this callback-delivery recovery is NOT capped by max_attempts — otherwise a config fixed later
// than max_attempts reclaims would never deliver the 'created' callback without a manual same-sourceEventId re-post,
// leaving the accepted vote with a BidBoard project but no CRM notification. The row stays 'processing' with its
// claim-time last_attempt_at, so it reclaims on the next stale window.
// finding (Macroscope): RESILIENT — retry the reset. If it were single-attempt best-effort and threw on the row's
// FINAL claim (attempt_count == max_attempts), the row would strand 'processing' forever (claimNext needs
// attempt_count < max_attempts; enqueue won't refresh a 'processing' row). Retrying clears a transient blip so the
// row reliably lands reclaimable. Returns false only if every attempt fails (an extended DB outage, during which
// claimNext can't reclaim either); callers escalate that (e.g. to needs_manual) rather than strand silently.
async function resetCreateCommandForReclaim(id: number, note: string): Promise<boolean> {
  const db = await getDb();
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await db.execute(sql`UPDATE bidboard_create_outbox SET attempt_count = 0, last_error = ${note} WHERE id = ${id}`);
      return true;
    } catch { /* retry a transient blip */ }
  }
  return false;
}

// finding (block later commands until recovery resolves, WITHOUT being supersede-killable): a command that created
// a project it can't yet map must be re-drained BEFORE any later same-project command, and must NOT be retired by a
// newer same-deal round (which would orphan the real project + let the newer round create a duplicate). Park it at a
// DISTINCT status 'reclaiming' — NOT 'pending' — so the enqueue supersede (scoped to status='pending') can never
// touch it, and persist the created project id INTO THE PAYLOAD so it survives across ticks (the drain reconciles by
// that id rather than re-running the Playwright create). claimNext also claims 'reclaiming' (by ascending id) so the
// mapping keeps getting reconciled across ticks; later same-deal/same-number commands are blocked from creating a
// duplicate by the sibling-recovery guard in performCreateFromRfpVote (NOT by starving the drain). attempt_count is
// NOT reset — bounded by max_attempts, then it escalates to 'needs_manual' rather than wedging forever. The drain that
// parks it CONTINUES to later commands and does NOT re-claim it this pass (claimNext's claimed-this-pass exclusion,
// finding Macroscope); next_attempt_at gets a SMALL durable RECLAIM_RETRY_FLOOR so retries stay spaced across passes
// (< the 15s tick, so it never delays normal cadence — it only floors back-to-back-driven reclaims).
// finding: also persist the RFP proposalId alongside the project id. The cross-tick reclaim rebuilds the mapping via
// buildBidboardMappingPayload(input, recoveredProjectId, ...); without the stored proposalId that reconstruction
// drops metadata.proposalId, which downstream portfolio automation reads to build BidBoard detail URLs. Stamp both
// so a project recovered across ticks keeps its active-proposal context.
async function markReclaiming(id: number, bidboardProjectId: string, proposalId: string | undefined, note: string): Promise<void> {
  const db = await getDb();
  // Stamp __recoveredProjectId always; add __recoveredProposalId ONLY when present. (to_jsonb(NULL::text) is SQL
  // NULL and jsonb_set is STRICT, so folding a null proposalId in would blank the whole payload → NOT NULL error.)
  const payloadExpr = proposalId
    ? sql`jsonb_set(jsonb_set(payload, '{__recoveredProjectId}', to_jsonb(${bidboardProjectId}::text)), '{__recoveredProposalId}', to_jsonb(${proposalId}::text))`
    : sql`jsonb_set(payload, '{__recoveredProjectId}', to_jsonb(${bidboardProjectId}::text))`;
  await db.execute(sql`
    UPDATE bidboard_create_outbox
       SET status = 'reclaiming', next_attempt_at = NOW() + interval '${sql.raw(RECLAIM_RETRY_FLOOR)}',
           last_error = ${note}, payload = ${payloadExpr}
     WHERE id = ${id}
  `);
}

// finding: an INDETERMINATE create ("Could not confirm project creation") — a project MAY exist but its id is
// UNKNOWN, so we can neither reconcile a mapping (no id) nor safely re-drain (createBidBoardProjectFromDeal would
// re-create on an inconclusive number lookup — indexing lag / Procore blip — DUPLICATING the maybe-created project).
// Park it at 'needs_manual': NOT claimed by claimNext (no auto re-drain → no duplicate), NOT supersedable (not
// 'pending'), NO callback (never tell the CRM it failed when a project may exist). A human resolves it — matching
// the override-approve path's indeterminate handling.
async function markNeedsManual(id: number, note: string, bidboardProjectId?: string): Promise<void> {
  const db = await getDb();
  if (bidboardProjectId) {
    // Escalation of a 'reclaiming' row: preserve the created project id in the payload (belt-and-suspenders — it was
    // already stamped by markReclaiming at any max_attempts > 1, but stamp it here too so the operator always has it).
    await db.execute(sql`
      UPDATE bidboard_create_outbox
         SET status = 'needs_manual', processed_at = NOW(), last_error = ${note},
             payload = jsonb_set(payload, '{__recoveredProjectId}', to_jsonb(${bidboardProjectId}::text))
       WHERE id = ${id}
    `);
    return;
  }
  await db.execute(sql`
    UPDATE bidboard_create_outbox SET status = 'needs_manual', processed_at = NOW(), last_error = ${note} WHERE id = ${id}
  `);
}

// finding (Macroscope): last-resort protection when a needs_manual park write keeps failing for an UnconfirmedCreate.
// Pin the row UNCLAIMABLE by setting attempt_count = max_attempts so claimNextBidboardCreateCommand's
// `attempt_count < max_attempts` gate skips it — the row can then never be stale-reclaimed into a full perform re-run,
// which for an unconfirmed create could DUPLICATE the maybe-created project (the sibling-recovery guard doesn't cover a
// 'processing' row). It's a MINIMAL UPDATE (likeliest to land if anything can); the row sits 'processing' at
// max_attempts for an operator. Returns true iff it landed. (If even this can't write, the DB is down — claimNext
// can't reclaim either, so no re-run happens until it recovers.)
async function markCommandUnclaimable(id: number, note: string): Promise<boolean> {
  const db = await getDb();
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await db.execute(sql`UPDATE bidboard_create_outbox SET attempt_count = max_attempts, last_error = ${note} WHERE id = ${id}`);
      return true;
    } catch { /* retry a transient blip */ }
  }
  return false;
}

// A sibling outbox row in a recovery state ('reclaiming' = created-but-unmapped project; 'needs_manual' = unconfirmed
// maybe-created project), other than this command itself, that would collide with a fresh create. Match on EITHER
// the same source deal OR the same project_number: an unmapped recovery project is invisible to the sync-mapping
// ownership guard, so a later create for the same deal (revised number) OR any command reusing that project_number
// would DUPLICATE / mis-adopt it. finding: the same-DEAL branch is scoped to the same source_system (a source_deal_id
// is only meaningful within its system), but the same-NUMBER branch is SYSTEM-AGNOSTIC — a procore project_number is
// global, and this MUST mirror claimNextBidboardCreateCommand's exclusion (which gates any-system same-number rows) or
// a cross-system row reusing that number would slip past this guard and duplicate the project. (Cross-deal/-system
// number collisions should be precluded by the DFW/ATL numbering, but guarding by number is cheap defense-in-depth
// against a reused/legacy number.) Used by the sibling-recovery guard in performCreateFromRfpVote to refuse the create
// until the prior round is resolved — independent of drain order / attempt_count.
async function findSiblingRecoveryRow(input: CreateFromRfpInput): Promise<{ status: string; recovered_project_id: string | null } | null> {
  const db = await getDb();
  const projectNumber = input.deal.projectNumber ?? null;
  const res: any = await db.execute(sql`
    SELECT status, payload->>'__recoveredProjectId' AS recovered_project_id
      FROM bidboard_create_outbox
     WHERE source_event_id <> ${input.sourceEventId}
       AND status IN ('reclaiming', 'needs_manual')
       AND (
         (source_system = ${input.sourceSystem} AND source_deal_id = ${input.sourceDealId})
         OR (${projectNumber}::text IS NOT NULL AND project_number = ${projectNumber})
       )
     LIMIT 1
  `);
  const rows = Array.isArray(res) ? res : (res?.rows ?? []);
  return rows[0] ?? null;
}

async function resolveProcoreCompanyIdForCallback(): Promise<string | undefined> {
  const getAutomationConfig = (storage as any).getAutomationConfig;
  const config = typeof getAutomationConfig === "function"
    ? await getAutomationConfig.call(storage, "procore_config")
    : null;
  return String((config?.value as any)?.companyId || process.env.PROCORE_COMPANY_ID || "").trim() || undefined;
}

// Persist a voting-path callback into the durable bidboard_callback_outbox (finding S2), delivered by
// startBidBoardCallbackWorker. NULL rfpApprovalRequestId, keyed by sourceDealId.
async function enqueueCreateFromRfpCallback(input: CreateFromRfpInput, payload: Record<string, any>): Promise<void> {
  const targetUrl = buildBidBoardCreatedCallbackTargetUrl();
  if (!targetUrl) {
    // finding X5: do NOT swallow this. If we returned normally the worker would mark the command 'done' — a
    // 202-accepted vote could then create/adopt a project with NO callback row for the CRM to recover from.
    // Throw so the command is marked failed + retryable (the rep-retry re-posts once TROCK_CRM_BASE_URL is set).
    throw new Error("TROCK_CRM_BASE_URL not configured; cannot enqueue create-from-rfp callback");
  }
  // finding X4: supersede any prior PENDING voting callback for this deal before enqueuing. A previously-enqueued
  // 'failed' (from a create that failed while CRM delivery was down) is keyed by NULL rfpApprovalRequestId, so it
  // isn't deduped by the request-id unique index; without this it could be delivered AFTER a later successful
  // 'created', leaving the CRM with a stale failed terminal result. Only the LATEST callback for the deal wins.
  // finding: scope the supersede to callbacks OLDER-OR-EQUAL to the one being enqueued (by payload createdAt = the
  // command's receipt time). Deleting EVERY pending request-less callback would let an OLDER reclaimed command
  // (A, with a lagging createdAt) erase a NEWER round's still-pending callback (B); B's createdAt is STRICTLY
  // greater, so the `<=` bound never touches it — that protection is preserved. finding (Macroscope): the EQUAL case
  // matters — a command that delivered a 'failed' on one attempt and a 'created' on a reclaim stamps BOTH with the
  // SAME receipt time (row.created_at), so a strict `<` would leave the stale 'failed' pending alongside the
  // 'created'; with the same freshness timestamp the CRM can't tell which is newer and delivery order could flip the
  // deal to the wrong terminal state. `<=` deletes the equal-timestamp stale row so only the latest callback for the
  // deal survives. (Two DISTINCT rounds sharing an exact-millisecond created_at isn't reachable here — the
  // create-outbox supersede retires the older same-deal round before both could enqueue callbacks.) A callback with
  // no createdAt (legacy/pre-AA3) is left alone rather than risking deleting a newer one.
  // Residual race (accepted): if the callback worker has ALREADY claimed a stale 'failed' row (still status
  // 'pending' while its HTTP is in flight), this DELETE removes the row but can't recall the in-flight request, so
  // a stale 'failed' could still reach the CRM after this 'created'. That is covered RECEIVER-SIDE, which is the
  // real supersede guarantee: the CRM's request-less 'failed' handler only applies to a deal still in a
  // create-in-flight state (rfp_approval_status pending, or declined+approving) AND compares the callback createdAt
  // to the round's freshness markers — so a 'failed' arriving after the deal is already 'approved' (or stamped by a
  // newer round) is a no-op. We can't cancel an in-flight HTTP here; ordering is enforced where it can be.
  const db = await getDb();
  const supersedeBefore = typeof payload.createdAt === "string" ? payload.createdAt : null;
  if (supersedeBefore) {
    await db.execute(sql`
      DELETE FROM bidboard_callback_outbox
       WHERE source_system = ${input.sourceSystem}
         AND source_deal_id = ${input.sourceDealId}
         AND rfp_approval_request_id IS NULL
         AND status = 'pending'
         AND payload->>'createdAt' IS NOT NULL
         AND (payload->>'createdAt')::timestamptz <= ${supersedeBefore}::timestamptz
    `);
  }
  await storage.enqueueBidboardCallback({
    sourceSystem: input.sourceSystem,
    sourceDealId: input.sourceDealId,
    rfpApprovalRequestId: null,
    payload,
    targetUrl,
  });
}

// callbackAt (finding AA3): the callback's createdAt should be the COMMAND's receipt time (≈ the CRM vote
// time, when the endpoint inserted the outbox row) — NOT when the worker finished. A stale in-flight callback
// stamped with "now" would look newer than the CRM's replacement round and defeat the CRM-side createdAt-vs-
// requested_at/reviewed_at freshness. Callers pass the outbox row's created_at.
async function enqueueFailedCallback(input: CreateFromRfpInput, error: string, callbackAt?: string): Promise<void> {
  const procoreCompanyId = await resolveProcoreCompanyIdForCallback();
  await enqueueCreateFromRfpCallback(input, {
    status: "failed",
    sourceDealId: input.sourceDealId,
    projectNumber: input.deal.projectNumber,
    procoreCompanyId,
    error,
    createdAt: callbackAt ?? new Date().toISOString(),
  });
}

// finding (make a delivered 'failed' result TERMINAL, not just logged): for a GENUINE create failure (perform threw,
// NO project created) deliver the failed callback AND mark the command terminal ('failed') in ONE transaction, so
// they can never diverge. The old sequence — enqueue the callback, THEN markCreateCommandFailedResilient — left a
// residual: if the callback enqueued but all 3 status writes then failed (a blip right after the insert), the row
// stayed 'processing' and a later stale-reclaim could re-run perform and CREATE a project the CRM was already told
// 'failed'. As one tx it's all-or-nothing: either the callback is queued for durable delivery AND the row is terminal
// (never reclaimed → never re-created), or the tx rolls back and NOTHING landed (no callback, row still 'processing')
// so the caller resets it for a clean reclaim that re-delivers + re-marks together. The callback DELIVERY stays
// async/durable (the bidboard_callback_outbox worker); only its ENQUEUE (insert) is made atomic with the status flip.
//
// The insert is a RAW insert (not storage.enqueueBidboardCallback) so it can run inside this tx's connection — for a
// voting row (NULL rfp_approval_request_id) storage's method is a plain insert anyway (its onConflictDoNothing keys
// on rfp_approval_request_id, which never conflicts for NULLs), so this is equivalent. The scoped supersede DELETE
// mirrors enqueueCreateFromRfpCallback. Throws (for the caller to reset+reclaim) if the callback URL is missing or
// the tx fails to commit.
async function deliverFailedCallbackAndMarkTerminal(
  input: CreateFromRfpInput,
  message: string,
  callbackAt: string | undefined,
  rowId: number,
): Promise<void> {
  const targetUrl = buildBidBoardCreatedCallbackTargetUrl();
  if (!targetUrl) {
    // Same contract as enqueueCreateFromRfpCallback: a missing base URL is RETRYABLE (throw so the caller resets +
    // reclaims once TROCK_CRM_BASE_URL is configured), never a silent drop that would strand the vote.
    throw new Error("TROCK_CRM_BASE_URL not configured; cannot enqueue create-from-rfp failed callback");
  }
  const procoreCompanyId = await resolveProcoreCompanyIdForCallback();
  const payload = {
    status: "failed" as const,
    sourceDealId: input.sourceDealId,
    projectNumber: input.deal.projectNumber,
    procoreCompanyId,
    error: message,
    createdAt: callbackAt ?? new Date().toISOString(),
  };
  const supersedeBefore = typeof payload.createdAt === "string" ? payload.createdAt : null;
  const db = await getDb();
  await db.transaction(async (tx: any) => {
    // Supersede older pending request-less callbacks (same scoped DELETE as enqueueCreateFromRfpCallback), inside the
    // tx so it commits atomically with the new callback + terminal status.
    if (supersedeBefore) {
      await tx.execute(sql`
        DELETE FROM bidboard_callback_outbox
         WHERE source_system = ${input.sourceSystem}
           AND source_deal_id = ${input.sourceDealId}
           AND rfp_approval_request_id IS NULL
           AND status = 'pending'
           AND payload->>'createdAt' IS NOT NULL
           AND (payload->>'createdAt')::timestamptz <= ${supersedeBefore}::timestamptz
      `);
    }
    await tx.execute(sql`
      INSERT INTO bidboard_callback_outbox (source_system, source_deal_id, rfp_approval_request_id, payload, target_url, status)
      VALUES (${input.sourceSystem}, ${input.sourceDealId}, NULL, ${JSON.stringify(payload)}::jsonb, ${targetUrl}, 'pending')
    `);
    await tx.execute(sql`
      UPDATE bidboard_create_outbox SET status = 'failed', processed_at = NOW(), last_error = ${message} WHERE id = ${rowId}
    `);
  });
}

// Enqueue a durable 'created' callback. finding: the CRM's created-callback handler REQUIRES procore_company_id
// (it 422s a 'created' that omits it, which would then 422-LOOP forever while this command is already marked
// 'done' — the project would exist with no CRM link). So a missing company id is RETRYABLE: throw before enqueuing
// so the command reclaims until procore_config.companyId / PROCORE_COMPANY_ID is configured, rather than sending an
// unusable 'created'. (Failed callbacks don't need it and stay best-effort.)
async function enqueueCreatedCallback(input: CreateFromRfpInput, bidboardProjectId: string, callbackAt?: string): Promise<void> {
  const procoreCompanyId = await resolveProcoreCompanyIdForCallback();
  if (!procoreCompanyId) {
    throw new Error("Procore company id not configured (procore_config.companyId / PROCORE_COMPANY_ID); cannot enqueue a 'created' callback the CRM would 422");
  }
  await enqueueCreateFromRfpCallback(input, {
    status: "created" as const,
    sourceDealId: input.sourceDealId,
    bidboardProjectId,
    projectNumber: input.deal.projectNumber,
    procoreCompanyId,
    // finding AA3: stamp with the command receipt time so a stale in-flight 'created' can't look newer than a
    // later CRM round + slip past the CRM's createdAt-vs-requested_at/reviewed_at freshness.
    createdAt: callbackAt ?? new Date().toISOString(),
  });
}

// The actual create work, run by the worker under serial processing. Returns a discriminated outcome (finding):
//   "created"  — a new BidBoard project was created + a 'created' callback enqueued.
//   "adopted"  — a project already existed for this deal; re-sent the 'created' (adopt) callback.
//   "failed"   — a PRE-create terminal branch (ineligible / conflict / ownership / revised-number) enqueued a
//                'failed' callback and did NOT create a project.
// Throws on a create failure that produced no callback (the caller delivers the failed callback + marks the
// command failed/retryable). The caller uses the outcome to mark the command terminal WITHOUT assuming a normal
// return implies a project was created. callbackAt stamps every callback with the command's receipt time (AA3).
export async function performCreateFromRfpVote(input: CreateFromRfpInput, callbackAt?: string): Promise<"created" | "adopted" | "failed"> {
  const { createBidBoardProjectFromDeal } = await import("../playwright/bidboard");
  const projectNumber = input.deal.projectNumber;

  // finding: create-from-rfp is a NON-service voting path — it hard-codes the non-service "Estimate in Progress"
  // stage below. Derive the EFFECTIVE type the way the rest of the RFP flow does: the project NUMBER's type digit is
  // canonical (e.g. DFW-4-… is service even when a stale project_types says otherwise), falling back to the payload
  // projectType. The service-RFP REFUSAL (type "4") is applied AFTER the mapping-first adopt block below (finding
  // Macroscope), NOT here — an already-created project must be adopted idempotently, never flipped to a false 'failed'.
  const effectiveProjectType = parseProjectTypeFromNumber(input.deal.projectNumber ?? "") ?? input.deal.projectType?.trim();

  // [Idempotent adopt / reclaim-after-create] If a BidBoard project ALREADY exists for THIS source deal — a prior
  // attempt created it + wrote the mapping, but a LATER step failed (the 'created' callback persist, or
  // markCreateCommandDone) and the command was reclaimed — do NOT re-check eligibility or re-create. Re-send the
  // 'created' (adopt) callback idempotently. This guarantees a transient post-create error, OR the deal having
  // since left Opportunity, can never flip an already-created project into a 'failed' CRM result (the CRM harmlessly
  // ignores a 'created' for a cancelled deal via its status-not-null guard, but must never be told the create
  // failed when the project exists). A revised projectNumber is the Y2 conflict and is refused, not adopted.
  // finding (robust against duplicate source-deal mapping rows): use the BID-BOARD-LINKED lookup, not the plain
  // by-sourceDealId read. This repo tolerates legacy DUPLICATE sync_mappings rows for one source deal; the plain read
  // returns a single UNORDERED row, so a partial/portfolio row with a NULL bidboard_project_id could shadow a sibling
  // row that DOES link this deal to a BidBoard project. Missing that link, a vote carrying a revised number would
  // fall through and create a SECOND project for the same deal. getBidboardMappingBySourceDealId filters to rows that
  // carry a bid-board id (mirroring getBidboardMappingByProcoreProjectNumber), so this adopt/refuse guard sees the
  // real linked project.
  const existingMapping = await storage.getBidboardMappingBySourceDealId(input.sourceSystem as any, input.sourceDealId);
  if (existingMapping?.bidboardProjectId) {
    // finding Y2 + ambiguous-adopt: only re-send the 'created' (adopt) callback when the requested number MATCHES
    // the mapping's recorded number. A DIFFERENT number is the Y2 revised-number conflict; a MISSING recorded
    // number (a legacy/partial or cross-path mapping — note create-from-rfp always carries a number, so a null here
    // means the row was written by another path) is AMBIGUOUS: we can't confirm the existing project is the one the
    // CRM asked to create, so we must not silently adopt it under the requested number. Both are refused for manual
    // resolution rather than adopted. (No requested number → nothing to reconcile → adopt as before.)
    if (projectNumber && existingMapping.procoreProjectNumber !== projectNumber) {
      await enqueueFailedCallback(
        input,
        `Deal ${input.sourceDealId} already has BidBoard project ${existingMapping.bidboardProjectId} under number ${existingMapping.procoreProjectNumber ?? "(unknown)"}; refusing to adopt it under requested number ${projectNumber} without a verified match`,
        callbackAt,
      );
      return "failed";
    }
    await enqueueCreatedCallback(input, existingMapping.bidboardProjectId, callbackAt);
    return "adopted";
  }

  // finding (Macroscope — service-RFP refusal AFTER the mapping-first adopt): create-from-rfp creates only in the
  // hard-coded non-service "Estimate in Progress" stage, so a service RFP (type "4" by the canonical project-number
  // digit) must NOT be created here — its own service flow ("Service – Estimating" + Colby) owns it. But this refusal
  // has to run AFTER the adopt block: if a project ALREADY exists for this deal (reclaim-after-create, or a
  // service-flow-created project), adopting it (re-sending the 'created' callback) is idempotent and correct, whereas
  // refusing here would flip an existing project to a FALSE 'failed' and leave the CRM/SyncHub inconsistent. By this
  // point no bid-board mapping exists for the deal, so a type-4 RFP is a genuine would-be create in the wrong stage —
  // refuse it. (A revised-number conflict on an existing project is already handled by the Y2 refusal above.)
  if (effectiveProjectType === "4") {
    await enqueueFailedCallback(
      input,
      `Deal ${input.sourceDealId} is a service RFP (project type 4); create-from-rfp is a non-service path and will not create it in the non-service "Estimate in Progress" stage`,
      callbackAt,
    );
    return "failed";
  }

  // Eligibility recheck IMMEDIATELY before the create (findings T3 + V4): by now the command may have waited in
  // the queue, and the CRM deal could have been deleted or moved out of Opportunity. Fail-open on a config/5xx
  // check failure (checkRfpApprovalSourceEligibility returns eligible:true then), matching the normal path.
  const eligibility = await checkRfpApprovalSourceEligibility({
    sourceSystem: input.sourceSystem,
    sourceDealId: input.sourceDealId,
  });
  if (!eligibility.eligible) {
    await enqueueFailedCallback(input, eligibility.reason || "Source CRM deal is no longer eligible for BidBoard creation", callbackAt);
    return "failed";
  }

  // [Collision guard] (findings S3/S4) — block a conflicting email/override approval for the same project/deal.
  const inFlightApproval =
    (await storage.getRfpApprovalRequestByProjectNumberAndStatus(projectNumber, "pending"))
    ?? (await storage.getRfpApprovalRequestByProjectNumberAndStatus(projectNumber, RFP_OVERRIDE_APPROVING_STATUS))
    ?? (await storage.getRfpApprovalRequestByProjectNumberAndStatus(projectNumber, "approved"))
    ?? (await storage.getRfpApprovalRequestBySourceDealAndStatus(input.sourceSystem, input.sourceDealId, "pending"))
    ?? (await storage.getRfpApprovalRequestBySourceDealAndStatus(input.sourceSystem, input.sourceDealId, RFP_OVERRIDE_APPROVING_STATUS))
    // finding X6: also block an already-APPROVED RFP for the SAME source deal. If this deal was approved earlier
    // with project number A and a later vote arrives with a revised number B, createBidBoardProjectFromDeal would
    // adopt the existing source-deal mapping and send a 'created' callback for B pointing at A's old project.
    // Refuse so it stops for manual resolution instead.
    ?? (await storage.getRfpApprovalRequestBySourceDealAndStatus(input.sourceSystem, input.sourceDealId, "approved"));
  if (inFlightApproval) {
    await enqueueFailedCallback(
      input,
      `Project ${projectNumber} / deal ${input.sourceDealId} already has a conflicting RFP approval (request ${inFlightApproval.id}, status ${inFlightApproval.status}); not creating from vote`,
      callbackAt,
    );
    return "failed";
  }

  // [Ownership guard] (finding V1) — refuse to adopt a BidBoard project owned by a DIFFERENT deal. Because the
  // worker is SERIAL, a command sharing a project number is processed only AFTER the first wrote its mapping, so
  // this check now sees that mapping and refuses (the racy pre-lock window the advisory approach had is gone).
  const numberOwner = await storage.getBidboardMappingByProcoreProjectNumber(projectNumber);
  if (
    numberOwner?.bidboardProjectId &&
    !(numberOwner.sourceSystem === input.sourceSystem && numberOwner.sourceDealId === input.sourceDealId)
  ) {
    await enqueueFailedCallback(
      input,
      `Project ${projectNumber} is already linked to ${numberOwner.sourceSystem} deal ${numberOwner.sourceDealId} (BidBoard ${numberOwner.bidboardProjectId}); refusing to adopt for deal ${input.sourceDealId}`,
      callbackAt,
    );
    return "failed";
  }

  // (The same-deal revised-number guard, finding Y2, now runs FIRST via the mapping-first adopt block above — a
  // mapping-exists deal never reaches here.)

  // finding (sibling-recovery guard): the ownership guard above only sees MAPPED projects. A prior round for THIS
  // deal may have created a Procore project whose mapping isn't persisted yet ('reclaiming') or an unconfirmed
  // maybe-created project ('needs_manual') — neither is visible via getBidboardMappingByProcoreProjectNumber. If we
  // created now we'd DUPLICATE that project. So before creating, refuse when a sibling outbox row for the same deal
  // is in a recovery state. This blocks the duplicate INDEPENDENT of drain id-ordering and of the reclaiming row
  // still being claimable (which lapses at max_attempts) — restoring the block the id-ordering alone can't
  // guarantee. The rep re-triggers once the prior round is reconciled/resolved.
  const siblingRecovery = await findSiblingRecoveryRow(input);
  if (siblingRecovery) {
    await enqueueFailedCallback(
      input,
      `Deal ${input.sourceDealId} has an unresolved prior create round (${siblingRecovery.status}${siblingRecovery.recovered_project_id ? `, BidBoard project ${siblingRecovery.recovered_project_id}` : ""}); resolve it before creating a new round to avoid a duplicate project`,
      callbackAt,
    );
    return "failed";
  }

  const d = input.deal;
  const normalizedDealData: Record<string, any> = {
    dealname: d.name,
    project_number: d.projectNumber,
    // finding: forward the CANONICAL type to the BidBoard create, not the raw (possibly stale) payload projectType.
    // The project NUMBER's digit is authoritative (e.g. DFW-2-… is roofing even if project_types says "9"), exactly
    // as the normal approval path resolves it — otherwise the created project carries the wrong type.
    project_types: effectiveProjectType,
    amount: d.amount,
    estimator: d.estimator,
    company_name: d.companyName,
    contact_name: d.contactName,
    client_email: d.clientEmail,
    client_phone: d.clientPhone,
    address: d.address?.street,
    city: d.address?.city,
    state: d.address?.state,
    zip: d.address?.zip,
    country: d.address?.country,
    description: d.description,
    bid_due_date: d.dueDate,
    attachments: input.attachments,
    project_location: d.address?.street,
    due_date: d.dueDate,
    notes: d.description,
  };

  const result = await createBidBoardProjectFromDeal({
    sourceSystem: input.sourceSystem,
    sourceDealId: input.sourceDealId,
    bidboardStage: "Estimate in Progress",
    normalizedDealData,
    options: { syncDocuments: true },
  });

  if (!result.success || !result.projectId) {
    // finding: distinguish an INDETERMINATE post-click outcome from a genuine no-project failure. When the create
    // UI click succeeded but confirmation/API lookup couldn't verify it, createBidBoardProjectFromDeal returns
    // { success:false, error:"Could not confirm project creation" } — a project MAY exist. Routing that to the
    // generic failure path (terminal 'failed' callback + retryable) can tell the CRM the vote failed while Procore
    // holds the project, and a retry can create a DUPLICATE. Throw the recoverable UnconfirmedCreateError instead:
    // the drain leaves the command re-drainable + sends NO callback (createBidBoardProjectFromDeal adopts the
    // existing project by number on re-drain), matching the override path's indeterminate handling.
    if (/could not confirm project creation/i.test(result.error ?? "")) {
      throw new UnconfirmedCreateError(result.error ?? "Could not confirm project creation");
    }
    // finding Y1: a genuine create FAILURE (Playwright/UI error, ambiguous existing project, ...) must stay
    // RETRYABLE. Throw so processBidboardCreateOutbox marks the command 'failed' (which enqueueBidboardCreateCommand
    // re-queues on the CRM rep's same-sourceEventId retry) + delivers a failed callback — rather than returning
    // normally, which would mark it 'done' and make the retry a silent no-op needing manual DB surgery.
    throw new Error(result.error || "BidBoard project creation failed");
  }

  // finding: createBidBoardProjectFromDeal can return success:true even when storage.createSyncMapping was caught +
  // only logged, leaving NO mapping for THIS project. That mapping is what the mapping-first adopt + ownership
  // guards rely on. Verify by the JUST-CREATED project id (result.projectId) + owner, NOT by source deal: this repo
  // tolerates legacy DUPLICATE sync_mappings rows per source deal, so a by-sourceDealId lookup could return an OLDER
  // row and wrongly "prove" the new project is mapped when it isn't — we'd then send a 'created' + mark done while
  // the new project stays unmapped and invisible to the guards. Require a mapping FOR result.projectId owned by this
  // command; if it's missing (or owned by another deal), throw so the command stays recoverable (the reconcile then
  // persists it / routes an owner-mismatch to manual) rather than committing a 'created' the guards can't protect.
  //
  // finding (treat a post-create verify-lookup error as created-but-unmapped, NOT a create failure): the project WAS
  // created (result.projectId is set). If this verification query itself THROWS (transient DB blip), letting it
  // propagate would fall into the drain's GENERIC catch, whose by-sourceDealId probe could then find no mapping (if
  // the internal createSyncMapping was the very step that failed) and emit a terminal 'failed' callback for a project
  // that EXISTS. Route the throw into the created-but-unmapped RECOVERY path instead (CreatedMappingMissingError):
  // reconcile keys on result.projectId, is idempotent (adopts the mapping if it persisted, writes it if not, refuses
  // an owner mismatch), and never re-runs the Playwright create — so no false 'failed' and no duplicate.
  let persistedMapping: Awaited<ReturnType<typeof storage.getSyncMappingByBidboardProjectId>>;
  try {
    persistedMapping = await storage.getSyncMappingByBidboardProjectId(result.projectId);
  } catch (lookupErr: any) {
    throw new CreatedMappingMissingError(
      `BidBoard project ${result.projectId} created for deal ${input.sourceDealId} but its mapping could not be verified (${lookupErr?.message || lookupErr}); leaving the command recoverable rather than risking a false 'failed'`,
      result.projectId,
      buildBidboardMappingPayload(input, result.projectId, result.projectName, result.proposalId),
    );
  }
  const persistedForThisDeal = persistedMapping?.bidboardProjectId
    && persistedMapping.sourceSystem === input.sourceSystem
    && persistedMapping.sourceDealId === input.sourceDealId;
  if (!persistedForThisDeal) {
    // Distinct RECOVERABLE error (not a create failure). Carry the created project id + the exact mapping row so the
    // drain can persist the mapping DIRECTLY (storage.createSyncMapping) instead of re-running this Playwright
    // create — a re-run could create a SECOND project if the exact-number lookup transiently errors.
    throw new CreatedMappingMissingError(
      `BidBoard project ${result.projectId} created for deal ${input.sourceDealId} but its sync mapping was not persisted; leaving the command recoverable rather than sending an unguarded 'created'`,
      result.projectId,
      buildBidboardMappingPayload(input, result.projectId, result.projectName, result.proposalId),
    );
  }

  await enqueueCreatedCallback(input, result.projectId, callbackAt);
  return "created";
}

// The sync-mapping row that createBidBoardProjectFromDeal writes internally (the write that gets caught + only
// logged when it fails). Used both at the throw site (with the live result's name/proposalId) and on the cross-tick
// reclaim of a 'reclaiming' row (reconstructed from the stored payload + recovered project id — the name/proposalId
// metadata isn't persisted across ticks, so it falls back to the deal name, which is cosmetic for the mapping).
function buildBidboardMappingPayload(
  input: CreateFromRfpInput,
  bidboardProjectId: string,
  bidboardProjectName?: string,
  proposalId?: string,
): Parameters<typeof storage.createSyncMapping>[0] {
  return {
    sourceSystem: input.sourceSystem,
    sourceDealId: input.sourceDealId,
    hubspotDealId: input.sourceSystem === "hubspot" ? input.sourceDealId : null,
    hubspotDealName: input.deal.name,
    bidboardProjectId,
    bidboardProjectName: bidboardProjectName ?? input.deal.name,
    procoreProjectNumber: input.deal.projectNumber || null,
    projectPhase: "bidboard",
    lastSyncAt: new Date(),
    lastSyncStatus: input.sourceSystem === "hubspot" ? "created_from_hubspot" : "created_from_trock_crm",
    lastSyncDirection: "hubspot_to_procore",
    metadata: proposalId ? { proposalId } : undefined,
  };
}

// Recovery for CreatedMappingMissingError: the Procore/BidBoard project was created but its sync mapping wasn't
// persisted. Reconcile the mapping DIRECTLY — never re-run performCreateFromRfpVote, which re-enters the Playwright
// create path and could create a SECOND project for the same accepted vote (createBidBoardProjectFromDeal proceeds
// to create when its exact-number lookup errors), or emit a false 'failed' if the deal left Opportunity mid-
// recovery. Idempotent: if the mapping now exists (a prior attempt or concurrent path wrote it) the write is
// skipped. Returns "reconciled" once the mapping is persisted AND the 'created' callback is enqueued; throws (for
// the caller to retry, capped) ONLY when the mapping write can't land; returns "callback_pending" when the mapping
// IS persisted but only the callback enqueue failed — the caller must route THAT to the UNCAPPED post-create
// callback-delivery reclaim, NOT the capped mapping-reconcile path (retrying the write is pointless, and capping a
// MAPPED project's callback at max_attempts would strand its 'created' notification once config is fixed).
async function reconcileCreatedMappingMissing(
  error: CreatedMappingMissingError,
  input: CreateFromRfpInput,
  callbackAt: string,
): Promise<"reconciled" | "callback_pending" | "owned_by_other"> {
  // finding: key idempotency + success on the PROJECT we actually created (error.bidboardProjectId), NOT a
  // sourceDealId lookup. This repo tolerates legacy DUPLICATE sync_mappings rows for one source deal, so a
  // by-sourceDealId read can return a DIFFERENT duplicate (or one lacking the created project) — we could then
  // stop draining even though the mapping exists, or send a 'created' callback pointing at the WRONG project. The
  // unique index is on bidboardProjectId, so the by-project read is the authoritative "is it persisted?" check,
  // and the callback always reports error.bidboardProjectId (the project this command created).
  const byProject = await storage.getSyncMappingByBidboardProjectId(error.bidboardProjectId);
  let ownerMapping = byProject;
  if (!byProject?.bidboardProjectId) {
    try {
      await storage.createSyncMapping(error.mappingPayload); // writes the mapping to THIS command's deal
    } catch (writeErr: any) {
      // A concurrent insert (unique violation on bidboardProjectId) means the mapping for THIS project is now
      // persisted — confirm by project id before surfacing the error so we don't loop on a write that landed.
      const after = await storage.getSyncMappingByBidboardProjectId(error.bidboardProjectId);
      if (!after?.bidboardProjectId) throw writeErr;
      ownerMapping = after; // whoever won the race — verify it's still THIS deal below
    }
  }
  // finding: the mapping for this project must belong to THIS command's deal. If the project was manually re-linked
  // or adopted by a DIFFERENT deal while this row was in recovery, a pre-existing / race-won mapping records another
  // owner — reporting 'created' for input.sourceDealId would misattribute another deal's project. Refuse to manual
  // resolution rather than send a wrong 'created'. (After our OWN successful createSyncMapping, ownerMapping stays
  // the pre-write byProject=undefined, so this check is skipped — the row we just wrote is ours by construction.)
  if (ownerMapping?.bidboardProjectId && (ownerMapping.sourceSystem !== input.sourceSystem || ownerMapping.sourceDealId !== input.sourceDealId)) {
    log(`[bidboard-create] recovered project ${error.bidboardProjectId} is now mapped to ${ownerMapping.sourceSystem} deal ${ownerMapping.sourceDealId}, not ${input.sourceSystem} ${input.sourceDealId}; needs manual resolution`, "sync");
    return "owned_by_other";
  }
  // The mapping is now persisted (the guards protect the project). Send the 'created' callback. If ONLY the callback
  // enqueue fails (e.g. TROCK_CRM_BASE_URL / procore company id missing), do NOT surface it as a mapping-reconcile
  // failure — the mapping is done; signal callback_pending so the caller routes to the uncapped reclaim.
  try {
    await enqueueCreatedCallback(input, error.bidboardProjectId, callbackAt);
  } catch (cbErr: any) {
    log(`[bidboard-create] mapping for project ${error.bidboardProjectId} persisted but 'created' callback enqueue failed (${cbErr?.message || cbErr}); routing to uncapped callback-delivery reclaim`, "sync");
    return "callback_pending";
  }
  return "reconciled";
}

// Shared recovery for a created-but-unmapped project, used both in-tick (the CreatedMappingMissingError catch) and
// across ticks (a re-claimed 'reclaiming' row). Reconcile the mapping DIRECTLY (never re-run perform → never
// double-create) up to 3 times. On success mark the command done. On persistent failure park it 'reclaiming' (a
// non-supersedable, id-ordered-blocking status carrying the project id) so the NEXT tick re-claims it before any
// later same-number command — UNLESS this row has exhausted its attempts (claimNext gates on attempt_count <
// max_attempts, so it would never be re-claimed), in which case ESCALATE it to 'needs_manual' so it surfaces for an
// operator instead of sitting 'reclaiming' silently. Either way the sibling-recovery guard keeps blocking a fresh
// same-deal create (both statuses are checked), so a duplicate can't slip in after exhaustion. `row` carries the
// post-claim attempt_count + max_attempts.
async function runMappingReconcile(
  row: { id: number; attempt_count: number; max_attempts: number },
  error: CreatedMappingMissingError,
  input: CreateFromRfpInput,
  callbackAt: string,
): Promise<"reconciled" | "blocked"> {
  let outcome: "reconciled" | "callback_pending" | "owned_by_other" | null = null;
  for (let attempt = 1; attempt <= 3 && outcome === null; attempt++) {
    try {
      outcome = await reconcileCreatedMappingMissing(error, input, callbackAt);
    } catch (recErr: any) {
      log(`[bidboard-create] Command ${row.id} mapping reconcile attempt ${attempt} failed (${recErr?.message || recErr})`, "sync");
    }
  }
  if (outcome === "reconciled") {
    // The mapping + 'created' callback are done; only the DONE bookkeeping remains. Retry it, and if it still fails
    // (finding) RESET attempt_count so the stale-reclaim isn't capped: otherwise a markDone failure on the LAST
    // allowed attempt would strand the row 'processing' with attempt_count >= max_attempts — never re-claimed and
    // (enqueue won't refresh a processing row) unrecoverable if the enqueued callback later dies. Reset lets the
    // reclaim re-run perform → mapping-first adopt → re-send callback + markDone, uncapped.
    let done = false;
    for (let attempt = 1; attempt <= 3 && !done; attempt++) {
      try { await markCreateCommandDone(row.id); done = true; } catch (bookErr: any) {
        if (attempt === 3) log(`[bidboard-create] Command ${row.id} mapping reconciled but markDone failed after 3 tries (${bookErr?.message || bookErr}); resetting attempts for uncapped reclaim`, "sync");
      }
    }
    if (!done) { try { await resetCreateCommandForReclaim(row.id, `mapping reconciled + callback sent; markDone pending reclaim`); } catch { /* best-effort */ } }
    return "reconciled";
  }
  if (outcome === "owned_by_other") {
    // The created project is now mapped to ANOTHER deal (manual re-link / adopt during recovery). Retrying can't fix
    // ownership and we must NOT send a 'created' for this deal. Park 'needs_manual' immediately (no callback) — and
    // stop the drain (return "blocked") so a human resolves the misattribution.
    try { await markNeedsManual(row.id, `recovered project ${error.bidboardProjectId} is mapped to another deal; needs manual resolution`); } catch { /* best-effort */ }
    return "blocked";
  }
  if (outcome === "callback_pending") {
    // The mapping IS persisted (the ownership guard now protects the project, so no duplicate risk) — only the
    // 'created' callback couldn't be enqueued. Route to the UNCAPPED post-create callback-delivery reclaim (leave
    // 'processing' + reset attempt_count) rather than the capped reclaiming/needs_manual path: the stale-reclaim
    // re-runs perform → mapping-first adopt → re-sends the 'created' callback once the config is fixed, uncapped.
    try { await resetCreateCommandForReclaim(row.id, `mapping persisted for project ${error.bidboardProjectId}; 'created' callback pending reclaim`); } catch { /* best-effort */ }
    return "reconciled"; // handled for the drain: the row is safe (mapping exists) and will re-deliver the callback
  }
  const exhausted = Number(row.attempt_count) >= Number(row.max_attempts);
  const proposalId = (error.mappingPayload as any)?.metadata?.proposalId as string | undefined;
  // Park the row RESILIENTLY: this write carries the recovery marker (status + payload.__recoveredProjectId /
  // __recoveredProposalId). If it silently failed, the row would drop to bare 'processing' with no marker — then the
  // stale-reclaim would route it to perform (not reconcile) and could DUPLICATE the created project. Retry so a
  // transient blip can't drop it.
  let parked = false;
  for (let attempt = 1; attempt <= 3 && !parked; attempt++) {
    try {
      if (exhausted) {
        if (attempt === 1) log(`[bidboard-create] Command ${row.id} created project ${error.bidboardProjectId} but mapping is UNRECOVERABLE after ${row.attempt_count} attempts; escalating to 'needs_manual'`, "sync");
        await markNeedsManual(row.id, `created project ${error.bidboardProjectId} but mapping unrecoverable after ${row.attempt_count} attempts; needs manual resolution`, error.bidboardProjectId);
      } else {
        await markReclaiming(row.id, error.bidboardProjectId, proposalId, `created but mapping missing after retries: ${error.message}`);
      }
      parked = true;
    } catch (parkErr: any) {
      if (attempt === 3) log(`[bidboard-create] Command ${row.id} could not park recovery row after 3 tries (${parkErr?.message || parkErr}); attempting status-only fallback`, "sync");
    }
  }
  if (!parked) {
    // finding: the marker write (with jsonb_set) still failed. As a LAST RESORT do a status-only write to
    // 'needs_manual' — no jsonb, so it's the simplest possible UPDATE (likeliest to land if anything can), and it
    // takes the row OUT of the auto-reclaim (needs_manual is never claimed). That prevents the worse failure mode:
    // a bare-'processing' row being stale-reclaimed into a full perform re-run that DUPLICATES the created project.
    // The project id is preserved in last_error for the operator. (If even this can't land, the DB is fully down and
    // the worker makes no progress at all, so no reclaim/create happens either.)
    try {
      const db = await getDb();
      await db.execute(sql`
        UPDATE bidboard_create_outbox
           SET status = 'needs_manual', processed_at = NOW(),
               last_error = ${`created project ${error.bidboardProjectId} but recovery marker unpersistable; needs manual resolution (project id ${error.bidboardProjectId})`}
         WHERE id = ${row.id}
      `);
      log(`[bidboard-create] Command ${row.id} parked 'needs_manual' via status-only fallback (marker not persisted); project ${error.bidboardProjectId} needs manual mapping`, "sync");
    } catch (finalErr: any) {
      log(`[bidboard-create] Command ${row.id} could not park even status-only (${finalErr?.message || finalErr}); left 'processing' — DB appears down so the worker will not reclaim/create until it recovers`, "sync");
    }
  }
  return "blocked";
}

const CREATE_WORKER_LOCK_KEY = "bidboard_create_from_rfp_worker";

export async function processBidboardCreateOutbox(deps: { performImpl?: typeof performCreateFromRfpVote } = {}): Promise<{ processed: number }> {
  if (createWorkerRunning) return { processed: 0 };
  createWorkerRunning = true;
  const perform = deps.performImpl ?? performCreateFromRfpVote;
  let processed = 0;
  // finding X2: serialize the DRAIN across app instances with a single global advisory lock held on a dedicated
  // connection for the whole drain. FOR UPDATE SKIP LOCKED alone lets instance A claim row 1 while instance B
  // claims row 2 — two same-project creates could then both see no mapping before either writes one. The global
  // lock guarantees only ONE instance's worker creates at a time, so performCreateFromRfpVote is truly serial and
  // the ownership guard's ordering holds. Non-blocking (pg_try_advisory_lock): a second instance's tick just
  // skips. Holding one connection in a background worker (not a request thread) is fine — no request-pool
  // exhaustion. NOTE: pool.connect is dynamically imported so the test's ../db mock (drizzle-only) isn't required
  // to expose a pool — when absent, we fall back to non-cross-instance draining.
  let lockClient: { query: (text: string, params?: any[]) => Promise<any>; release: (err?: any) => void } | null = null;
  let locked = false;
  try {
    const dbModule: any = await import("../db");
    if (dbModule.pool?.connect) {
      lockClient = await dbModule.pool.connect();
      // Parameterized (not interpolated) even though CREATE_WORKER_LOCK_KEY is a constant — keeps the raw-SQL clean.
      const res = await lockClient!.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS locked`, [CREATE_WORKER_LOCK_KEY]);
      locked = Boolean((res.rows ?? res)[0]?.locked);
      if (!locked) return { processed: 0 }; // another instance is draining
    }

    // Drain the queue one command at a time (serial). Track the ids claimed in THIS pass so claimNext never re-serves
    // a row we already handled here — in particular a 'reclaiming' row we parked + continued past (finding Macroscope:
    // prevents burning all max_attempts on it within one long pass, independent of pass duration).
    const claimedThisPass = new Set<number>();
    for (;;) {
      const row = await claimNextBidboardCreateCommand(claimedThisPass);
      if (!row) break;
      claimedThisPass.add(Number(row.id));
      const input = (row.payload ?? {}) as CreateFromRfpInput;
      // The command's receipt time (≈ CRM vote time) stamps every callback (finding AA3).
      const callbackAt = row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString();

      // finding: a re-claimed 'reclaiming' row already created a Procore project (id persisted in the payload) whose
      // mapping wasn't yet written. Reconcile that mapping DIRECTLY by the stored id — NEVER re-run perform, which
      // could create a SECOND project when the exact-number lookup is inconclusive. On persistent failure it stays
      // 'reclaiming' (retried across ticks after a backoff); later same-deal/same-number commands are blocked from
      // duplicating it by the sibling-recovery guard in perform, so the drain can CONTINUE past it (finding Macroscope).
      const recoveredProjectId = (row.payload as any)?.__recoveredProjectId as string | undefined;
      if (recoveredProjectId) {
        // Carry the proposalId stamped by markReclaiming so the rebuilt mapping keeps metadata.proposalId (downstream
        // portfolio automation reads it for BidBoard detail URLs).
        const recoveredProposalId = (row.payload as any)?.__recoveredProposalId as string | undefined;
        const recoveryErr = new CreatedMappingMissingError(
          `reclaiming BidBoard project ${recoveredProjectId} for deal ${input.sourceDealId} (mapping not yet persisted)`,
          recoveredProjectId,
          buildBidboardMappingPayload(input, recoveredProjectId, undefined, recoveredProposalId || undefined),
        );
        log(`[bidboard-create] Command ${row.id} re-claimed 'reclaiming' project ${recoveredProjectId}; reconciling its mapping (no re-create)`, "sync");
        const result = await runMappingReconcile(row, recoveryErr, input, callbackAt);
        processed += 1;
        // finding (Macroscope): CONTINUE rather than break — the row is parked ('reclaiming' with a retry backoff, or
        // escalated 'needs_manual'), and any later same-deal/same-number command is refused by perform's
        // sibling-recovery guard, so an unreconciled row can't duplicate the project. Breaking here would let this
        // low-id row (re-claimed first every tick) starve ALL later commands — including unrelated deals — until it
        // is manually resolved. Continue so unrelated commands drain.
        continue;
      }

      // finding AA1: keep the CREATE and the DONE bookkeeping in SEPARATE try/catches. A create failure (perform
      // throws) must deliver a failed callback + mark the command failed. But if perform SUCCEEDED (project
      // created + 'created' callback enqueued) and only markCreateCommandDone throws (transient DB error), we must
      // NOT enqueue a failed callback (which would delete the real 'created') — the project exists. Leave the row
      // 'processing' so the stale-reclaim path re-runs it idempotently (adopt-guard + latest-callback-wins).
      let outcome: "created" | "adopted" | "failed";
      try {
        outcome = await perform(input, callbackAt);
      } catch (error: any) {
        const message = error?.message || String(error);
        // finding: a create that SUCCEEDED but whose sync mapping wasn't persisted is RECOVERABLE, not a failure —
        // the project exists, so never emit a 'failed' callback (which would report a false failure). Reconcile the
        // mapping DIRECTLY (storage.createSyncMapping via the payload carried on the error), IMMEDIATELY — before
        // draining later commands, since the worker is serial and until the mapping is written a NEXT same-
        // projectNumber command would see no numberOwner and could adopt this unlinked project for the WRONG deal.
        // Direct reconcile (not a perform re-run) can never create a SECOND project [F6] nor return a false 'failed'
        // [F5]; a transient DB blip is covered by a few bounded retries.
        if (error instanceof CreatedMappingMissingError) {
          // Reconcile the mapping DIRECTLY (never re-run perform → never double-create [F6], never a false 'failed'
          // [F5]). On persistent failure the helper parks the row 'reclaiming' (carrying the project id, id-ordered
          // + non-supersedable) so the next tick re-claims it before any later same-number command and no newer
          // same-deal round can retire it and orphan the project.
          log(`[bidboard-create] Command ${row.id} created project ${error.bidboardProjectId} but the mapping wasn't persisted (${message}); reconciling the mapping directly`, "sync");
          const result = await runMappingReconcile(row, error, input, callbackAt);
          processed += 1;
          // finding (Macroscope): CONTINUE, don't break — the row is parked ('reclaiming' w/ backoff, or
          // 'needs_manual'), and the sibling-recovery guard in perform refuses any later same-deal/same-number create,
          // so continuing can't duplicate the unmapped project. Breaking would starve every later command (incl.
          // unrelated deals) behind this low-id row until it's manually resolved.
          continue;
        }
        // finding: an INDETERMINATE create ("Could not confirm project creation") — a project MAY exist but its id is
        // UNKNOWN. This is NOT a genuine failure: do NOT emit a 'failed' callback (the CRM would be told the vote
        // failed while Procore may hold the project). And do NOT auto re-drain it: re-running perform would call
        // createBidBoardProjectFromDeal again, which CREATES on an inconclusive number lookup (indexing lag / Procore
        // blip — the very conditions that produced the unconfirmed result), DUPLICATING the maybe-created project.
        // Park it 'needs_manual' (not claimed, not supersedable, no callback) for human resolution — matching the
        // override-approve path's indeterminate handling.
        if (error instanceof UnconfirmedCreateError) {
          log(`[bidboard-create] Command ${row.id} create is UNCONFIRMED (${message}); parking 'needs_manual' for resolution (no 'failed' callback — a project may exist; no auto re-drain — would risk a duplicate)`, "sync");
          // finding: park RESILIENTLY. If markNeedsManual silently failed, the row would stay 'processing' with no
          // recovery marker — the stale-reclaim would then re-run perform (risking a duplicate of the maybe-created
          // project) and later commands would proceed unguarded. Retry; if it can't be parked, STOP the drain (do
          // not continue to later commands) so nothing runs while this row is unguarded.
          let parked = false;
          for (let attempt = 1; attempt <= 3 && !parked; attempt++) {
            try { await markNeedsManual(row.id, `create unconfirmed, may exist; needs manual resolution: ${message}`); parked = true; }
            catch (parkErr: any) { if (attempt === 3) log(`[bidboard-create] Command ${row.id} could not park 'needs_manual' after 3 tries (${parkErr?.message || parkErr}); pinning unclaimable`, "sync"); }
          }
          processed += 1;
          if (parked) continue;
          // finding (Macroscope): markNeedsManual failed, so the row is still 'processing' — a stale-reclaim would
          // re-run perform and could DUPLICATE the maybe-created project (sibling-recovery doesn't cover 'processing').
          // As a last resort PIN it unclaimable (attempt_count = max_attempts) so claimNext can NEVER reclaim it into a
          // perform re-run; it sits 'processing' at max for an operator. (needs_manual would also block later
          // same-number commands via sibling-recovery — the pin only prevents THIS row's re-run — but that broader
          // guard needs the status write that just failed; the pin closes the flagged own-re-run duplicate.)
          const pinned = await markCommandUnclaimable(row.id, `unconfirmed create; needs_manual park failed — pinned unclaimable for manual resolution: ${message}`);
          if (!pinned) log(`[bidboard-create] CRITICAL: Command ${row.id} unconfirmed create could NOT be parked or pinned unclaimable; a stale-reclaim may re-run it — manual check needed for deal ${input.sourceDealId}`, "sync");
          break; // unguarded — stop so no later command runs before this row is safely parked/pinned
        }
        // finding: if the project was ALREADY created (a mapping exists for this source deal) but a LATER step
        // threw — the 'created' callback persist, or a transient DB error — this is NOT a create failure. Emitting a
        // 'failed' callback here would tell the CRM the create failed even though the project exists. Leave the row
        // 'processing' (from claimNext) so the stale-reclaim re-runs it and adopts via perform's mapping-first path
        // (which re-sends the 'created' callback), rather than marking it failed + reporting a false failure.
        let createdMapping: any = null;
        let mappingLookupFailed = false;
        try {
          // finding: use the BID-BOARD-LINKED lookup (not the plain by-sourceDealId read) for the same duplicate-row
          // reason as the adopt guard — a partial null-bidboard duplicate row must not shadow the real linked project
          // and make a created project look un-created (which would emit a false 'failed' for a project that exists).
          createdMapping = await storage.getBidboardMappingBySourceDealId(input.sourceSystem as any, input.sourceDealId);
        } catch (lookupErr: any) {
          // finding: the mapping LOOKUP itself errored (transient DB), so we CANNOT prove no project was created.
          // Treating that as "no mapping -> genuine create failure" would risk a false 'failed' callback for a
          // project that may exist. Keep the command recoverable instead.
          mappingLookupFailed = true;
          log(`[bidboard-create] Command ${row.id} mapping lookup failed (${lookupErr?.message || lookupErr}); treating as recoverable, not a create failure`, "sync");
        }
        if (createdMapping?.bidboardProjectId || mappingLookupFailed) {
          const detail = createdMapping?.bidboardProjectId
            ? `created project ${createdMapping.bidboardProjectId} but a post-create step failed`
            : `mapping lookup indeterminate`;
          log(`[bidboard-create] Command ${row.id} ${detail} (${message}); leaving 'processing' for reclaim`, "sync");
          // finding: reset attempt_count so the callback-delivery / re-check recovery isn't capped by max_attempts.
          try { await resetCreateCommandForReclaim(row.id, `${detail}; pending reclaim: ${message}`); } catch { /* best-effort */ }
          processed += 1;
          continue;
        }
        // Genuine create failure (NO project created). Deliver the failure callback AND mark the command terminal
        // ('failed') ATOMICALLY (finding): the two must land together or not at all. If they could diverge — callback
        // delivered but the status write then failed — the row would stay 'processing' and a later stale-reclaim
        // could re-run perform and CREATE a project the CRM was already told 'failed' (the old resilient-mark +
        // CRITICAL-log left exactly this residual). deliverFailedCallbackAndMarkTerminal does both in ONE transaction:
        // on commit the callback is durably queued AND the row is terminal (never reclaimed → never re-created); on
        // ANY failure (missing callback URL, or the tx rolls back) NOTHING landed — leave the row 'processing' +
        // reset attempt_count so a clean reclaim re-runs and re-attempts BOTH together (the create may then succeed,
        // or the failed callback + terminal mark finally land once the transient condition clears). A 'created' can
        // therefore never follow a delivered 'failed' for the same command.
        log(`[bidboard-create] Command ${row.id} create for deal ${input.sourceDealId} failed: ${message}`, "sync");
        try {
          await deliverFailedCallbackAndMarkTerminal(input, message, callbackAt, row.id);
        } catch (deliverErr: any) {
          log(`[bidboard-create] Command ${row.id} failed; atomic failed-callback+terminal did not land (${deliverErr?.message || deliverErr}); leaving 'processing' for reclaim`, "sync");
          // finding (Macroscope): the reset is now RESILIENT (retries internally). If it STILL can't land (extended DB
          // outage) the row would strand 'processing' at max_attempts (no terminal, no callback — claimNext needs
          // attempt < max, enqueue won't refresh a processing row). As a last resort SURFACE it as 'needs_manual' for
          // an operator (the CRM wasn't auto-notified of the failure), rather than silently stranding it. CRITICAL-log
          // if even that can't write (DB fully down — claimNext can't reclaim either, so nothing re-runs until it heals).
          const reset = await resetCreateCommandForReclaim(row.id, `create failed; failed callback + terminal pending reclaim: ${message}`);
          if (!reset) {
            let surfaced = false;
            for (let attempt = 1; attempt <= 3 && !surfaced; attempt++) {
              try { await markNeedsManual(row.id, `create failed but neither the failed-callback+terminal delivery nor the reclaim reset could land; needs manual resolution: ${message}`); surfaced = true; }
              catch { /* retry a transient blip */ }
            }
            if (!surfaced) log(`[bidboard-create] CRITICAL: Command ${row.id} failed but could NOT deliver a terminal callback, reset for reclaim, OR surface needs_manual — DB appears down; manual check needed for deal ${input.sourceDealId}`, "sync");
          }
          processed += 1;
          continue;
        }
        processed += 1;
        continue;
      }
      // finding J: perform returned WITHOUT throwing. Distinguish a create from a pre-create terminal refusal — a
      // normal return does NOT imply a project was created. A "failed" outcome enqueued a 'failed' callback and made
      // NO project, so mark the command terminal via markCreateCommandFailed (NOT markCreateCommandDone): if that
      // bookkeeping then failed and the row were left 'processing', a reclaim could CREATE a project after the CRM
      // already received a terminal 'failed' result for this vote.
      if (outcome === "failed") {
        // Mark terminal RESILIENTLY (finding): a bookkeeping throw must not leave a REFUSED command 'processing',
        // where a reclaim re-runs the create path and could create a project after the CRM already got 'failed'
        // (once the eligibility/conflict condition changes).
        // finding (Macroscope): do NOT ignore the false return. If all 3 retries fail the row stays 'processing' at
        // (possibly) max_attempts — the status flip is silently lost and the vote is stranded. RESET it for reclaim so
        // the reclaim re-attempts the terminal mark. A DETERMINISTIC refusal (service/conflict/ownership/
        // revised-number/sibling) re-refuses on reclaim and self-heals to 'failed'. A TIME-VARYING one (eligibility
        // flipped back) may instead CREATE on reclaim — the desired outcome for an approved vote whose deal briefly
        // left Opportunity. That create's 'created' callback (same receipt-time createdAt) supersedes the earlier
        // 'failed' ONLY while it is still pending (the <= supersede, M3); if the 'failed' was already DELIVERED
        // ('sent') before the >=10-min reclaim — the common case — correctness then rests on the CRM's receiver-side
        // handling of a later equal-createdAt 'created' after a delivered 'failed' (the same accepted receiver-side
        // ordering residual documented on the supersede DELETE). No duplicate/orphan risk (the reclaim's create stays
        // gated by mapping-first adopt + ownership + sibling-recovery) — the residual is at worst a stale 'failed' UI
        // terminal for a project that exists, cleared by a manual re-trigger.
        const marked = await markCreateCommandFailedResilient(row.id, "create refused before project creation (ineligible / conflict / ownership / revised-number)");
        if (!marked) {
          log(`[bidboard-create] Command ${row.id} refused but could NOT mark terminal after retries; resetting for reclaim so the status flip isn't silently lost`, "sync");
          try { await resetCreateCommandForReclaim(row.id, "refused; terminal mark pending reclaim"); } catch { /* best-effort */ }
        }
        processed += 1;
        continue;
      }
      // "created" or "adopted" — the project exists + a 'created' callback was enqueued.
      try {
        await markCreateCommandDone(row.id);
      } catch (bookErr: any) {
        // Create + 'created' callback already happened; a failed markDone must NOT flip this to a failure. Leave it
        // 'processing' for the stale-reclaim to finish (re-running adopts idempotently via perform's mapping-first).
        // finding: RESET attempt_count so the stale-reclaim is NOT capped. If this create/adopt landed on the row's
        // FINAL allowed claim (attempt_count == max_attempts) and markDone then failed, the row would sit
        // 'processing' with attempt_count >= max_attempts forever — claimNextBidboardCreateCommand only reclaims
        // attempt_count < max_attempts, and a same-sourceEventId retry skips a 'processing' row — so a later
        // lost/dead 'created' callback could never be recovered even though the project exists. Resetting lets the
        // reclaim re-run perform's mapping-first adopt (idempotent, no duplicate) to re-send the callback + mark done.
        log(`[bidboard-create] Command ${row.id} created OK but markDone failed (will re-reconcile, uncapped): ${bookErr?.message || bookErr}`, "sync");
        try { await resetCreateCommandForReclaim(row.id, `created but markDone failed; pending reclaim: ${bookErr?.message || bookErr}`); } catch { /* best-effort */ }
      }
      processed += 1;
    }
    return { processed };
  } finally {
    if (lockClient) {
      let unlockErr: any = null;
      if (locked) {
        try {
          await lockClient.query(`SELECT pg_advisory_unlock(hashtext($1))`, [CREATE_WORKER_LOCK_KEY]);
        } catch (e: any) {
          // finding (Macroscope): a swallowed unlock failure must NOT return the connection to the pool. This is a
          // SESSION-level advisory lock (pg_try_advisory_lock, not xact-scoped), and pg's release() does not close the
          // session — so if the connection is still alive but the unlock query failed, the lock stays HELD on that
          // idle pooled connection. A later reused connection would keep the lock, and every subsequent drain's
          // pg_try_advisory_lock would see it held and skip indefinitely. Pass the error to release() below so the pool
          // DESTROYS this connection (terminating its session + dropping the stuck lock) instead of reusing it.
          unlockErr = e;
          log(`[bidboard-create] advisory unlock failed (${e?.message || e}); destroying the pooled connection so its session lock can't wedge later drains`, "sync");
        }
      }
      // release(err) destroys the client (pool discards it) when err is truthy; release()/release(undefined) returns
      // it to the pool normally on a clean unlock.
      lockClient.release(unlockErr ?? undefined);
    }
    createWorkerRunning = false;
  }
}

export function startBidboardCreateWorker(intervalMs = 15_000): void {
  if (createWorkerTimer) return;
  createWorkerTimer = setInterval(() => {
    processBidboardCreateOutbox().catch((error) => {
      log(`[bidboard-create] Worker tick failed: ${error?.message || error}`, "sync");
    });
  }, intervalMs);
  log(`[bidboard-create] Worker started (${intervalMs}ms)`, "sync");
}

export function stopBidboardCreateWorker(): void {
  if (!createWorkerTimer) return;
  clearInterval(createWorkerTimer);
  createWorkerTimer = null;
}
