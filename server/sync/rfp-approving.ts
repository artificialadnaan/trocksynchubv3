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
import { lockRfpCreateDeal, readCoreFootprint, readProcoreFootprint } from "./rfp-create-lock";
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
    await tx.execute(sql`
      INSERT INTO rfp_approval_approving (request_id, started_at, submit_at) VALUES (${input.requestId}, now(), NULL)
      ON CONFLICT (request_id) DO UPDATE SET started_at = now(), submit_at = NULL
    `);
    return { outcome: "claimed" };
  });
}

/** Commits submit_at (its own statement) before createBidBoardProject starts. Called only after a "claimed" outcome. */
export async function markRfpApprovingSubmitted(requestId: number, db?: Executor): Promise<void> {
  const exec = db ?? (await defaultDb());
  await exec.execute(sql`UPDATE rfp_approval_approving SET submit_at = now() WHERE request_id = ${requestId}`);
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
