/**
 * RFP Phase 2 (CONTRACT v2.2 §10, S0b-2a; runbook STUCK-APPROVING r5; d9 rulings in lanes/rfp-routing/QUESTIONS-ee.md):
 * processRfpApproval's (path P3) DECISION + CLAIM, taken in ONE SHORT transaction right before the Playwright create:
 * the per-deal lock, a re-read of the request row, the Core footprint, then either the claim or a hold.
 *   - email (V3): pending → `approving` (+ rfp_approval_approving.started_at), the create-in-progress footprint;
 *   - override (force; V2 / V4): the route already claimed `override_approving`; the row must still be in it;
 *   - a Core footprint ⇒ `held_cross_destination` + the hold callback (F1) in the same transaction; the caller alerts;
 *   - the request moved on (a double click, a decline, a reset) ⇒ not claimable, no create;
 *   - 0027 absent ⇒ "legacy": today's path, unchanged (no Core footprint can exist without 0027);
 *   - the preflight query ERRORS ⇒ it throws (fail closed: the row stays pending, the caller alerts with the real error).
 * markRfpApprovingSubmitted commits rfp_approval_approving.submit_at before createBidBoardProject starts: the positive
 * evidence the stuck-approving runbook needs (NULL ⇒ the create never started).
 * Nothing here is held across a network call: the caller does its HubSpot / CRM work before, and Playwright after.
 */
import { sql } from "drizzle-orm";
import { RFP_OVERRIDE_APPROVING_STATUS } from "@shared/schema";
import { parseProjectTypeFromNumber, replaceProjectTypeInNumber } from "../constants";
import { lockRfpCreateDeal, readCoreFootprint, readDealCreateCommands, readProcoreFootprint } from "./rfp-create-lock";
import { preflightRfpCoreTablesOrThrow } from "./rfp-core-preflight";
import { RFP_HELD_CROSS_DESTINATION_STATUS } from "./rfp-destination";

type Executor = { execute: (q: any) => Promise<any>; transaction?: (fn: (tx: any) => Promise<any>) => Promise<any> };

export const RFP_APPROVING_STATUS = "approving";

export type RfpCreateClaimInput = {
  requestId: number;
  sourceSystem: string;
  sourceDealId: string;
  force: boolean;
  /** The F1 written in the hold's own transaction (trock_crm requests only; a HubSpot request has no CRM callback). */
  holdCallback?: { targetUrl: string; payload: Record<string, unknown> } | null;
  /** S0b-2b (d9 QA): the approval's own inputs, recorded on rfp_approval_approving with the claim (runbook r5 §3B). */
  recorded?: RecordedApprovalInputs;
};

/** What the resolve CLI's `recreate` replays. `approvedAttachments.override` null = no override (the deal's own files). */
export type RecordedApprovalInputs = {
  approvedBy: string;
  editedFields: Record<string, unknown>;
  approvedAttachments: { override: Array<{ name: string; url?: string; _new?: boolean }> | null };
  force: boolean;
  /** When every pre-create HubSpot / CRM step reported success; null when one did not (recreate then refuses). */
  hubspotDoneAt: Date | null;
};

export type RfpCreateClaim =
  | { outcome: "legacy" }
  | { outcome: "claimed" }
  | { outcome: "not_claimable"; status: string }
  | { outcome: "held_cross_destination"; footprint: string[] };

async function defaultDb(): Promise<Executor> {
  return (await import("../db")).db as unknown as Executor;
}

function firstRow(res: any): any | undefined {
  return (Array.isArray(res) ? res : (res?.rows ?? []))[0];
}

export async function claimRfpRequestForCreate(input: RfpCreateClaimInput, db?: Executor): Promise<RfpCreateClaim> {
  const exec = db ?? (await defaultDb());
  // On the PASSED db and before the transaction, so an errored probe throws here (never "missing", never legacy).
  if ((await preflightRfpCoreTablesOrThrow(exec)) !== "present") return { outcome: "legacy" };
  return exec.transaction!(async (tx: any): Promise<RfpCreateClaim> => {
    await lockRfpCreateDeal(tx, input.sourceDealId);
    const row = firstRow(await tx.execute(sql`SELECT status FROM rfp_approval_requests WHERE id = ${input.requestId} FOR UPDATE`));
    const claimable = input.force ? RFP_OVERRIDE_APPROVING_STATUS : "pending";
    if (!row || row.status !== claimable) return { outcome: "not_claimable", status: row?.status ?? "missing" };
    const footprint = await readCoreFootprint(tx, input.sourceSystem, input.sourceDealId);
    if (footprint.length > 0) {
      await tx.execute(sql`UPDATE rfp_approval_requests SET status = ${RFP_HELD_CROSS_DESTINATION_STATUS} WHERE id = ${input.requestId}`);
      if (input.holdCallback) {
        await tx.execute(sql`
          INSERT INTO bidboard_callback_outbox (source_system, source_deal_id, rfp_approval_request_id, payload, target_url, status)
          VALUES (${input.sourceSystem}, ${input.sourceDealId}, ${input.requestId}, ${JSON.stringify(input.holdCallback.payload)}::jsonb,
                  ${input.holdCallback.targetUrl}, 'pending')
          ON CONFLICT (rfp_approval_request_id) DO UPDATE
            SET payload = EXCLUDED.payload, target_url = EXCLUDED.target_url, status = 'pending'
        `);
      }
      return { outcome: "held_cross_destination", footprint };
    }
    if (!input.force) {
      await tx.execute(sql`UPDATE rfp_approval_requests SET status = ${RFP_APPROVING_STATUS} WHERE id = ${input.requestId}`);
    }
    // The original approval's inputs ride the same statement (d9 QA (a)); absent ⇒ NULLs, and recreate then refuses.
    const rec = input.recorded;
    const approvedBy = rec ? rec.approvedBy : null;
    const editedFields = rec ? JSON.stringify(rec.editedFields) : null;
    const approvedAttachments = rec ? JSON.stringify(rec.approvedAttachments) : null;
    const force = rec ? rec.force : null;
    // Stamped on the database clock at the claim (which runs after those steps); the caller's Date only says "they succeeded".
    const hubspotDone = rec?.hubspotDoneAt != null;
    await tx.execute(sql`
      INSERT INTO rfp_approval_approving (request_id, started_at, submit_at, approved_by, edited_fields, approved_attachments, force, hubspot_done_at)
      VALUES (${input.requestId}, now() AT TIME ZONE 'UTC', NULL, ${approvedBy}, ${editedFields}::jsonb, ${approvedAttachments}::jsonb, ${force},
              CASE WHEN ${hubspotDone}::boolean THEN now() AT TIME ZONE 'UTC' END)
      ON CONFLICT (request_id) DO UPDATE
        SET started_at = now() AT TIME ZONE 'UTC', submit_at = NULL, approved_by = EXCLUDED.approved_by, edited_fields = EXCLUDED.edited_fields,
            approved_attachments = EXCLUDED.approved_attachments, force = EXCLUDED.force, hubspot_done_at = EXCLUDED.hubspot_done_at
    `);
    return { outcome: "claimed" };
  });
}

/** Commits submit_at (its own statement) before createBidBoardProject starts. Called only after a "claimed" outcome. */
export async function markRfpApprovingSubmitted(requestId: number, db?: Executor): Promise<void> {
  const exec = db ?? (await defaultDb());
  await exec.execute(sql`UPDATE rfp_approval_approving SET submit_at = now() AT TIME ZONE 'UTC' WHERE request_id = ${requestId}`);
}

/**
 * N6 (a4 078c37ce residual; a4 8ea49d91): the email path's claim, taken BEFORE its first HubSpot write. pending → approving in ONE
 * conditional write, so a second approval or a decline that read the row as pending is refused instead of writing HubSpot again.
 * With 0027 present it also stamps rfp_approval_approving on the database clock: the stuck sweep ages a claim a crash left by it,
 * and the stamp (started_at, as text so no precision is lost) is what the final write and a release must still find, so a stalled
 * approval whose claim was released and taken again can never finish on the new one. `{ claimed: false }`: nothing was written.
 * The side row also keeps the KEYS this attempt may write to HubSpot (edited_fields, keys only), merged with any earlier released
 * attempt's: a release keeps the row, so `released` + `footprint` tell the next decision which HubSpot fields an interrupted attempt
 * may have left behind (a4 ADD-1 ba1d1a25, Greptile P1 4650915940); the row goes only when a decision completes.
 */
export type RfpApprovalClaim =
  | { claimed: false }
  | { claimed: true; stamp: string | null; released: boolean } & AttemptRecord;
/**
 * The side row's edited_fields (a4 ADD-1 / ADD-2, round 4):
 * - the footprint: the form keys an attempt changes (true);
 * - `_before`: HubSpot's values of every property an attempt may write (and `dealstage`), read BEFORE its first write, the earliest
 *   value per property kept for good, so a later decision restores what HubSpot really held, never deal_data's copy (which, for a
 *   HubSpot request, has no stage, due dates or description: d6 T1);
 * - `_before_unknown`: the properties whose value could not be read (a fresh approval still goes on, as main did).
 */
export type AttemptRecord = { footprint: string[]; before: Record<string, string>; unknown: string[] };
const BEFORE_KEY = "_before";
const BEFORE_UNKNOWN_KEY = "_before_unknown";
function readFootprint(editedFields: unknown): AttemptRecord {
  const o = (editedFields && typeof editedFields === "object" ? editedFields : {}) as Record<string, unknown>;
  const before = o[BEFORE_KEY] && typeof o[BEFORE_KEY] === "object" ? (o[BEFORE_KEY] as Record<string, unknown>) : {};
  const unknown = Array.isArray(o[BEFORE_UNKNOWN_KEY]) ? (o[BEFORE_UNKNOWN_KEY] as unknown[]).map(String) : [];
  return {
    footprint: Object.keys(o).filter((k) => !k.startsWith("_")),
    before: Object.fromEntries(Object.entries(before).map(([k, v]) => [k, String(v ?? "")])),
    unknown: unknown.filter((k) => !(k in before)),
  };
}
export async function claimRfpRequestForApproval(requestId: number, editedKeys: string[] = [], db?: Executor): Promise<RfpApprovalClaim> {
  const exec = db ?? (await defaultDb());
  // The same probe the stuck sweep makes (an error throws: fail closed, nothing claimed).
  const sideTable = Boolean(firstRow(await exec.execute(sql`SELECT to_regclass('public.rfp_approval_approving')::text AS t`))?.t);
  return exec.transaction!(async (tx: any): Promise<RfpApprovalClaim> => {
    const claimed = firstRow(await tx.execute(sql`
      UPDATE rfp_approval_requests SET status = ${RFP_APPROVING_STATUS}
       WHERE id = ${requestId} AND status = 'pending' AND bidboard_project_id IS NULL
      RETURNING id
    `));
    if (!claimed) return { claimed: false };
    if (!sideTable) return { claimed: true, stamp: null, released: false, footprint: [], before: {}, unknown: [] };
    const prior = firstRow(await tx.execute(sql`SELECT edited_fields FROM rfp_approval_approving WHERE request_id = ${requestId} FOR UPDATE`));
    const record = prior ? readFootprint(prior.edited_fields) : { footprint: [], before: {}, unknown: [] };
    const keys = JSON.stringify({
      ...Object.fromEntries([...new Set([...record.footprint, ...editedKeys])].filter((k) => !k.startsWith("_")).map((k) => [k, true])),
      [BEFORE_KEY]: record.before,
      [BEFORE_UNKNOWN_KEY]: record.unknown,
    });
    // This claim owns the row from here: anything a reset override left (its recorded approver and inputs) is cleared, so the row
    // has the N6 claim shape the stuck sweep releases (CodeRabbit on #143).
    const side = firstRow(await tx.execute(sql`
      INSERT INTO rfp_approval_approving (request_id, started_at, submit_at, edited_fields)
      VALUES (${requestId}, now() AT TIME ZONE 'UTC', NULL, ${keys}::jsonb)
      ON CONFLICT (request_id) DO UPDATE SET started_at = now() AT TIME ZONE 'UTC', submit_at = NULL, edited_fields = EXCLUDED.edited_fields,
        approved_by = NULL, approved_attachments = NULL, force = NULL, hubspot_done_at = NULL
      RETURNING started_at::text AS stamp
    `));
    return { claimed: true, stamp: side.stamp as string, released: Boolean(prior), ...record };
  });
}

/**
 * A pending request an interrupted approval attempt left behind (its claim released; the side row kept): the HubSpot keys that
 * attempt may have written. `released: false` when there is none (or 0027 is absent).
 */
export async function releasedApprovalAttempt(
  requestId: number, db?: Executor,
): Promise<{ released: boolean } & AttemptRecord> {
  const exec = db ?? (await defaultDb());
  if (!firstRow(await exec.execute(sql`SELECT to_regclass('public.rfp_approval_approving')::text AS t`))?.t) return { released: false, footprint: [], before: {}, unknown: [] };
  const row = firstRow(await exec.execute(sql`
    SELECT a.edited_fields FROM rfp_approval_approving a JOIN rfp_approval_requests r ON r.id = a.request_id
     WHERE a.request_id = ${requestId} AND r.status = 'pending' AND a.submit_at IS NULL AND a.approved_by IS NULL
  `));
  return row ? { released: true, ...readFootprint(row.edited_fields) } : { released: false, footprint: [], before: {}, unknown: [] };
}

/**
 * Records HubSpot's values from BEFORE this attempt's first write, on THIS claim's row: `values` merged in with the earliest value per
 * property kept (an earlier attempt's reading wins); `unknownProps` (the read failed) added to `_before_unknown`.
 */
export async function recordHubSpotBefore(
  requestId: number, stamp: string, values: Record<string, string>, unknownProps: string[], db?: Executor,
): Promise<void> {
  const exec = db ?? (await defaultDb());
  await exec.execute(sql`
    UPDATE rfp_approval_approving
       SET edited_fields = jsonb_set(
             jsonb_set(coalesce(edited_fields, '{}'::jsonb), ${"{" + BEFORE_KEY + "}"}::text[],
                       ${JSON.stringify(values)}::jsonb || coalesce(edited_fields -> ${BEFORE_KEY}, '{}'::jsonb)),
             ${"{" + BEFORE_UNKNOWN_KEY + "}"}::text[],
             coalesce(edited_fields -> ${BEFORE_UNKNOWN_KEY}, '[]'::jsonb) || ${JSON.stringify(unknownProps)}::jsonb)
     WHERE request_id = ${requestId} AND started_at = ${stamp}::timestamp
  `);
}

/** Does THIS claim still hold the row? Asked right before each HubSpot write, so a holder whose claim was released writes nothing more. */
export async function rfpApprovalClaimStillHeld(requestId: number, stamp: string, db?: Executor): Promise<boolean> {
  const exec = db ?? (await defaultDb());
  return Boolean(firstRow(await exec.execute(sql`
    SELECT 1 AS held FROM rfp_approval_requests r JOIN rfp_approval_approving a ON a.request_id = r.id
     WHERE r.id = ${requestId} AND r.status = ${RFP_APPROVING_STATUS} AND a.started_at = ${stamp}::timestamp
  `)));
}

/** The SQL condition "this claim still holds the row": its side row carries the stamp the claim wrote (no stamp: 0027 absent). */
export function rfpApprovalClaimHeld(requestId: number, stamp: string | null) {
  return stamp === null
    ? sql`true`
    : sql`EXISTS (SELECT 1 FROM rfp_approval_approving a WHERE a.request_id = ${requestId} AND a.started_at = ${stamp}::timestamp)`;
}

/**
 * A handled failure after the claim: approving → pending, only while THIS claim still holds the row. Its side row STAYS: it is the
 * marker the next decision reads (releasedApprovalAttempt) to reconcile what the attempt may have written to HubSpot.
 */
export async function releaseRfpApprovalClaim(requestId: number, stamp: string | null, db?: Executor): Promise<boolean> {
  const exec = db ?? (await defaultDb());
  return exec.transaction!(async (tx: any) => {
    const released = firstRow(await tx.execute(sql`
      UPDATE rfp_approval_requests SET status = 'pending'
       WHERE id = ${requestId} AND status = ${RFP_APPROVING_STATUS} AND bidboard_project_id IS NULL AND ${rfpApprovalClaimHeld(requestId, stamp)}
      RETURNING id
    `));
    return Boolean(released);
  });
}

/** After the final write: the claim's own side row is done with, its footprint reconciled (a submitted create's row stays). */
export async function clearRfpApprovalClaimRow(requestId: number, stamp: string | null, db?: Executor): Promise<void> {
  if (stamp === null) return;
  const exec = db ?? (await defaultDb());
  await exec.execute(sql`
    DELETE FROM rfp_approval_approving WHERE request_id = ${requestId} AND submit_at IS NULL AND started_at = ${stamp}::timestamp
  `);
}

/**
 * For the reset route's rfp_request_override_reset alert (d9 5a): may the override being reset already have created a project?
 * syncMapping = a Bid Board mapping for the deal; createCommand = a Procore create command in flight / done for it. Read from the
 * Procore footprint (0027 required). Informational only: with 0027 absent, or on any read error, both read false and the reset
 * proceeds exactly as today.
 */
export async function describeOverrideResetFootprint(
  sourceSystem: string, sourceDealId: string, db?: Executor,
): Promise<{ syncMapping: boolean; createCommand: boolean }> {
  try {
    const exec = db ?? (await defaultDb());
    if ((await preflightRfpCoreTablesOrThrow(exec)) !== "present") return { syncMapping: false, createCommand: false };
    return await exec.transaction!(async (tx: any) => {
      const footprint = await readProcoreFootprint(tx, sourceSystem, sourceDealId);
      return {
        syncMapping: footprint.includes("sync_mapping"),
        createCommand: footprint.some((f) => f.startsWith("command:")),
      };
    });
  } catch {
    return { syncMapping: false, createCommand: false };
  }
}

// ── S0b-2b: the stuck-approving resolver's reads and its two locked writes (runbook r5 §3; d9 QA / QB) ─────────────────────

/** The recorded original-approval inputs, by side-table column. */
export const RECORDED_APPROVAL_FIELDS = ["approved_by", "edited_fields", "approved_attachments", "force"] as const;

/** One request as the resolver sees it: the row, its rfp_approval_approving row, and what the original approval recorded. */
export type ApprovingFacts = {
  requestId: number;
  token: string;
  status: string;
  sourceSystem: string;
  sourceDealId: string;
  projectNumber: string | null;
  dealData: Record<string, unknown>;
  hasSideRow: boolean;
  ageMinutes: number | null;
  /** started_at older than 30 minutes, on the database clock. */
  olderThan30: boolean;
  /** started_at as epoch ms. The columns are `timestamp` (0027) holding a UTC wall clock: every writer stores now() AT TIME ZONE 'UTC'
   *  and every reader interprets them AT TIME ZONE 'UTC', so no session time zone shifts them (CodeRabbit 4529556652). */
  startedAtMs: number | null;
  submitAt: string | null;
  recorded: RecordedApprovalInputs | null;
  /** The RECORDED_APPROVAL_FIELDS that are set. */
  recordedFields: string[];
  preCreateStepsRecorded: boolean;
};

/**
 * The project number the original approval created under, so the resolver's search (i) and the found-finalise's sync mapping
 * and CRM `created` callback all name the SAME number (Codex P2 on #127). Base: the recorded edited number, else the request's,
 * else the deal's. processRfpApproval renumbers when the approver changed the type, so a recorded type edit renumbers it here too.
 */
export function effectiveApprovingProjectNumber(facts: Pick<ApprovingFacts, "projectNumber" | "dealData" | "recorded">): string | null {
  const str = (v: unknown) => (v === undefined || v === null || String(v).trim() === "" ? null : String(v).trim());
  const edited = (facts.recorded?.editedFields ?? {}) as Record<string, unknown>;
  const base = str(edited.project_number) ?? str(facts.projectNumber) ?? str(facts.dealData.project_number);
  const editedType = str(edited.project_types);
  const currentType = base ? (parseProjectTypeFromNumber(base) ?? str(facts.dealData.project_types)) : null;
  return base && editedType && editedType !== currentType ? replaceProjectTypeInNumber(base, editedType) : base;
}

export async function readApprovingFacts(requestId: number, db?: Executor): Promise<ApprovingFacts | null> {
  const exec = db ?? (await defaultDb());
  const r = firstRow(await exec.execute(sql`
    SELECT r.id, r.token, r.status, r.source_system, r.source_deal_id, r.project_number, r.deal_data,
           a.request_id IS NOT NULL AS has_side,
           floor(extract(epoch FROM ((now() AT TIME ZONE 'UTC') - a.started_at)) / 60)::int AS age_minutes,
           COALESCE(a.started_at < (now() AT TIME ZONE 'UTC') - interval '30 minutes', false) AS older_than_30,
           (extract(epoch FROM a.started_at AT TIME ZONE 'UTC') * 1000)::bigint AS started_ms,
           to_char(a.submit_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS submit_at,
           a.approved_by, a.edited_fields, a.approved_attachments, a.force,
           a.hubspot_done_at IS NOT NULL AS hubspot_done, (extract(epoch FROM a.hubspot_done_at AT TIME ZONE 'UTC') * 1000)::bigint AS hubspot_done_ms
      FROM rfp_approval_requests r
      LEFT JOIN rfp_approval_approving a ON a.request_id = r.id
     WHERE r.id = ${requestId}
  `));
  if (!r) return null;
  const recordedFields = RECORDED_APPROVAL_FIELDS.filter((f) => r[f] !== null && r[f] !== undefined);
  const complete = recordedFields.length === RECORDED_APPROVAL_FIELDS.length;
  return {
    requestId: Number(r.id),
    token: String(r.token),
    status: String(r.status),
    sourceSystem: String(r.source_system),
    sourceDealId: String(r.source_deal_id),
    projectNumber: r.project_number ?? null,
    dealData: (r.deal_data ?? {}) as Record<string, unknown>,
    hasSideRow: Boolean(r.has_side),
    ageMinutes: r.age_minutes == null ? null : Number(r.age_minutes),
    olderThan30: Boolean(r.older_than_30),
    startedAtMs: r.started_ms == null ? null : Number(r.started_ms),
    submitAt: r.submit_at ?? null,
    recorded: complete
      ? {
          approvedBy: String(r.approved_by),
          editedFields: (r.edited_fields ?? {}) as Record<string, unknown>,
          approvedAttachments: r.approved_attachments as RecordedApprovalInputs["approvedAttachments"],
          force: Boolean(r.force),
          hubspotDoneAt: r.hubspot_done_ms == null ? null : new Date(Number(r.hubspot_done_ms)),
        }
      : null,
    recordedFields,
    preCreateStepsRecorded: Boolean(r.hubspot_done),
  };
}

/**
 * Why `recreate` may NOT replay this row, or null when it may (runbook r5 §3B; d9 QA (b) / (c), QB). Footprints are checked
 * separately, under the lock. The same rules gate the dry-run's decision B and the locked re-claim.
 */
export function approvingRecreateRefusal(f: Pick<ApprovingFacts, "status" | "hasSideRow" | "olderThan30" | "submitAt" | "recorded" | "recordedFields" | "preCreateStepsRecorded">): string | null {
  if (f.status !== RFP_APPROVING_STATUS) return `the request is ${f.status}, not approving`;
  if (!f.hasSideRow) return "no rfp_approval_approving row: its age can't be proven (d9 QB)";
  if (!f.olderThan30) return "younger than 30 min: it may still be mid-create";
  if (f.submitAt !== null) return "submit_at is set: the create may have started";
  if (!f.recorded) {
    const missing = RECORDED_APPROVAL_FIELDS.filter((x) => !f.recordedFields.includes(x));
    return `original approval inputs not recorded (missing: ${missing.join(", ")})`;
  }
  if (f.recorded.force) return "the recorded approval is an override: out of scope (runbook r5 covers approving only)";
  if (!f.preCreateStepsRecorded) return "pre-create steps not recorded (hubspot_done_at is NULL)";
  if ((f.recorded.approvedAttachments?.override ?? []).some((a) => a._new)) {
    return "an uploaded attachment cannot be replayed (its bytes were temporary)";
  }
  return null;
}

/** The deal's footprint other than this request's own `approving` row (the live unique index allows only one per deal). */
export async function readApprovingResolveFootprint(tx: Executor, sourceSystem: string, sourceDealId: string): Promise<string[]> {
  const procore = (await readProcoreFootprint(tx, sourceSystem, sourceDealId)).filter((f) => f !== `request:${RFP_APPROVING_STATUS}`);
  return [...procore, ...(await readDealCreateCommands(tx, sourceSystem, sourceDealId)), ...(await readCoreFootprint(tx, sourceSystem, sourceDealId))];
}

export type ApprovingRecreateClaim = RfpCreateClaim | { outcome: "refused"; error: string };

/**
 * `recreate`'s re-claim (runbook r5 §3B; d9 QA (b)): under the deal lock, the row must still be a replayable `approving` row
 * (approvingRecreateRefusal), a Core footprint holds it exactly as the normal claim does, and ANY other footprint refuses it.
 * On success started_at restarts (a new attempt the stuck alert can time); the recorded inputs stay as they were.
 */
export async function reclaimApprovingForRecreate(
  input: { requestId: number; sourceSystem: string; sourceDealId: string; holdCallback?: { targetUrl: string; payload: Record<string, unknown> } | null },
  db?: Executor,
): Promise<ApprovingRecreateClaim> {
  const exec = db ?? (await defaultDb());
  if ((await preflightRfpCoreTablesOrThrow(exec)) !== "present") return { outcome: "refused", error: "0027 is not applied: there is no approving record to replay" };
  return exec.transaction!(async (tx: any): Promise<ApprovingRecreateClaim> => {
    await lockRfpCreateDeal(tx, input.sourceDealId);
    firstRow(await tx.execute(sql`SELECT id FROM rfp_approval_requests WHERE id = ${input.requestId} FOR UPDATE`));
    const facts = await readApprovingFacts(input.requestId, tx);
    if (!facts) return { outcome: "not_claimable", status: "missing" };
    const refusal = approvingRecreateRefusal(facts);
    if (refusal) return { outcome: "refused", error: `Recreate refused: ${refusal}` };
    const core = await readCoreFootprint(tx, input.sourceSystem, input.sourceDealId);
    if (core.length > 0) {
      await tx.execute(sql`UPDATE rfp_approval_requests SET status = ${RFP_HELD_CROSS_DESTINATION_STATUS} WHERE id = ${input.requestId}`);
      if (input.holdCallback) {
        await tx.execute(sql`
          INSERT INTO bidboard_callback_outbox (source_system, source_deal_id, rfp_approval_request_id, payload, target_url, status)
          VALUES (${input.sourceSystem}, ${input.sourceDealId}, ${input.requestId}, ${JSON.stringify(input.holdCallback.payload)}::jsonb,
                  ${input.holdCallback.targetUrl}, 'pending')
          ON CONFLICT (rfp_approval_request_id) DO UPDATE
            SET payload = EXCLUDED.payload, target_url = EXCLUDED.target_url, status = 'pending'
        `);
      }
      return { outcome: "held_cross_destination", footprint: core };
    }
    const other = await readApprovingResolveFootprint(tx, input.sourceSystem, input.sourceDealId);
    if (other.length > 0) return { outcome: "refused", error: `Recreate refused: a footprint exists for the deal (${other.join(", ")})` };
    await tx.execute(sql`UPDATE rfp_approval_approving SET started_at = now() AT TIME ZONE 'UTC' WHERE request_id = ${input.requestId}`);
    return { outcome: "claimed" };
  });
}

/**
 * `found` (runbook r5 §3A): finalise a STUCK `approving` request against the ONE Procore project the checks found, the way a
 * successful create would, with NO Procore write: approved + bidboard_project_id, the sync mapping, the CRM `created` callback.
 * Under the deal lock, only a row still `approving`; refused (nothing written) when the project is already mapped to another deal.
 */
export async function finaliseApprovingFoundRecord(
  input: {
    requestId: number;
    sourceSystem: string;
    sourceDealId: string;
    bidboardProjectId: string;
    approvedBy: string;
    projectNumber: string | null;
    dealName: string | null;
    callback: { targetUrl: string; payload: Record<string, unknown>; maxAttempts: number } | null;
  },
  db?: Executor,
): Promise<{ success: boolean; error?: string }> {
  const exec = db ?? (await defaultDb());
  return exec.transaction!(async (tx: any) => {
    await lockRfpCreateDeal(tx, input.sourceDealId);
    const row = firstRow(await tx.execute(sql`SELECT status FROM rfp_approval_requests WHERE id = ${input.requestId} FOR UPDATE`));
    if (!row || row.status !== RFP_APPROVING_STATUS) return { success: false, error: `the request is ${row?.status ?? "missing"}, not approving` };
    const mapped = (await tx.execute(sql`SELECT source_system, source_deal_id FROM sync_mappings WHERE bidboard_project_id = ${input.bidboardProjectId}`));
    const mappedRows: any[] = Array.isArray(mapped) ? mapped : (mapped?.rows ?? []);
    if (mappedRows.some((m) => m.source_system !== input.sourceSystem || m.source_deal_id !== input.sourceDealId)) {
      return { success: false, error: `Bid Board project ${input.bidboardProjectId} is already mapped to another deal` };
    }
    // CodeRabbit 4534112648: under the deal lock, a deal that already maps to a DIFFERENT Bid Board project (a mapping that
    // appeared after the dry-run) is refused, never given a second mapping. A mapping to the found project itself is fine.
    const dealMapped = await tx.execute(sql`
      SELECT bidboard_project_id FROM sync_mappings
       WHERE source_system = ${input.sourceSystem} AND source_deal_id = ${input.sourceDealId}
         AND length(trim(bidboard_project_id)) > 0 AND bidboard_project_id <> ${input.bidboardProjectId}
    `);
    const other = (Array.isArray(dealMapped) ? dealMapped : (dealMapped?.rows ?? [])) as Array<{ bidboard_project_id: string }>;
    if (other.length > 0) {
      return { success: false, error: `the deal already maps to Bid Board project ${other.map((r) => r.bidboard_project_id).join(", ")}` };
    }
    await tx.execute(sql`
      UPDATE rfp_approval_requests
         SET status = 'approved', bidboard_project_id = ${input.bidboardProjectId}, approved_by = ${input.approvedBy}, approved_at = now()
       WHERE id = ${input.requestId} AND status = ${RFP_APPROVING_STATUS}
    `);
    if (mappedRows.length === 0) {
      await tx.execute(sql`
        INSERT INTO sync_mappings (source_system, source_deal_id, hubspot_deal_id, hubspot_deal_name, bidboard_project_id,
                                   procore_project_number, project_phase, last_sync_at, last_sync_status, last_sync_direction)
        VALUES (${input.sourceSystem}, ${input.sourceDealId}, ${input.sourceSystem === "hubspot" ? input.sourceDealId : null}, ${input.dealName},
                ${input.bidboardProjectId}, ${input.projectNumber}, 'bidboard', now(),
                ${input.sourceSystem === "hubspot" ? "created_from_hubspot" : "created_from_trock_crm"}, 'hubspot_to_procore')
      `);
    }
    if (input.callback) {
      await tx.execute(sql`
        INSERT INTO bidboard_callback_outbox (source_system, source_deal_id, rfp_approval_request_id, payload, target_url, status,
                                              attempt_count, max_attempts, next_attempt_at)
        VALUES (${input.sourceSystem}, ${input.sourceDealId}, ${input.requestId}, ${JSON.stringify(input.callback.payload)}::jsonb,
                ${input.callback.targetUrl}, 'pending', 0, ${input.callback.maxAttempts}, now())
        ON CONFLICT (rfp_approval_request_id) DO NOTHING
      `);
    }
    return { success: true };
  });
}
