import { beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// Procore project creation is retired (owner 2026-11-13, b0cb0c4f; a4 afa14cfd): a service RFP completes on its T-Rock Core card,
// and the CRM is told with an `approved` callback. ONE statement decides and enqueues it (server/sync/rfp-approved-callback.ts):
// an APPROVED CRM request whose Core card was CONFIRMED, once per request (the outbox's unique index). The reconcile
// (scripts/rfp-reconcile-approved-callbacks.ts) plans the stranded requests and applies through the same statement.
// PGlite runs the statement as written. Synthetic data only (I7).
const dbHolder = vi.hoisted(() => ({ db: null as any }));
vi.mock("../server/db.ts", () => ({ get db() { return dbHolder.db; }, pool: undefined }));
vi.mock("../server/log.ts", () => ({ log: vi.fn() }));
vi.mock("../server/sync/bidboard-callback-worker.ts", () => ({
  buildBidBoardCreatedCallbackTargetUrl: () => "https://crm.example.test/api/internal/bid-board-created",
}));

const { enqueueRfpApprovedCallbackIfCoreConfirmed, planApprovedCallbackReconcile, applyApprovedCallbackReconcile } = await import(
  "../server/sync/rfp-approved-callback.ts"
);

const DDL = `
  CREATE TABLE rfp_approval_requests (
    id serial PRIMARY KEY, source_system text NOT NULL DEFAULT 'hubspot', source_deal_id text NOT NULL, project_number text,
    token text NOT NULL UNIQUE, status text NOT NULL DEFAULT 'pending', deal_data jsonb NOT NULL DEFAULT '{}'::jsonb,
    approved_by text, approved_at timestamp, bidboard_project_id text, created_at timestamp DEFAULT now()
  );
  CREATE TABLE service_rfp_core_outbox (
    id serial PRIMARY KEY, source_system text NOT NULL, source_deal_id text NOT NULL, rfp_request_id integer NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb, status text NOT NULL DEFAULT 'pending', core_bid_id text,
    created_at timestamp NOT NULL DEFAULT now(), sent_at timestamp
  );
  CREATE TABLE bidboard_callback_outbox (
    id serial PRIMARY KEY, source_system text NOT NULL, source_deal_id text NOT NULL, rfp_approval_request_id integer,
    payload jsonb NOT NULL, target_url text NOT NULL, status text NOT NULL DEFAULT 'pending',
    attempt_count integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 5, last_error text,
    last_attempt_at timestamp, next_attempt_at timestamp NOT NULL DEFAULT now(), created_at timestamp NOT NULL DEFAULT now(),
    sent_at timestamp
  );
  CREATE UNIQUE INDEX idx_bidboard_callback_outbox_rfp_request ON bidboard_callback_outbox(rfp_approval_request_id);
`;

let pg: PGlite;
beforeEach(async () => {
  pg = new PGlite();
  await pg.exec(DDL);
  dbHolder.db = drizzle(pg);
});

const deal = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function request(n: number, opts: { status?: string; service?: boolean; approved?: boolean; procore?: boolean; source?: string } = {}) {
  const status = opts.status ?? "approved";
  const pn = `DFW-${opts.service === false ? "2" : "4"}-7${String(n).padStart(4, "0")}-aa`;
  await pg.query(
    `INSERT INTO rfp_approval_requests (id, source_system, source_deal_id, project_number, token, status, approved_at, bidboard_project_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [n, opts.source ?? "trock_crm", deal(n), pn, `synthetic-token-${n}`, status,
      opts.approved === false || status !== "approved" ? null : "2026-11-13 16:22:11.970", opts.procore ? "900111" : null],
  );
}
async function coreOutbox(n: number, status: string, coreBidId: string | null, sentNumber?: string) {
  await pg.query(
    `INSERT INTO service_rfp_core_outbox (source_system, source_deal_id, rfp_request_id, status, core_bid_id, payload) VALUES ('trock_crm', $1, $2, $3, $4, $5::jsonb)`,
    [deal(n), n, status, coreBidId, JSON.stringify(sentNumber === undefined ? {} : { deal: { id: deal(n), rfpProjectNumber: sentNumber } })],
  );
}
const callbacks = async () =>
  (await pg.query<{ rfp_approval_request_id: number; payload: any; status: string }>(
    `SELECT rfp_approval_request_id, payload, status FROM bidboard_callback_outbox ORDER BY id`,
  )).rows;

describe("the CRM `approved` callback: approved request + Core-confirmed card, once", () => {
  it("enqueues ONE approved callback carrying the request, the deal, the Core bid and approvedAt, and no Procore field", async () => {
    await request(941);
    await coreOutbox(941, "sent", "d67ea851-0000-4000-8000-000000000941");
    expect(await enqueueRfpApprovedCallbackIfCoreConfirmed(941)).toBe(true);
    const rows = await callbacks();
    expect(rows).toHaveLength(1);
    expect(rows[0].rfp_approval_request_id).toBe(941);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].payload).toEqual({
      status: "approved",
      sourceDealId: deal(941),
      rfpApprovalRequestId: 941,
      projectNumber: "DFW-4-70941-aa",
      coreBidId: "d67ea851-0000-4000-8000-000000000941",
      approvedAt: "2026-11-13T16:22:11.970Z",
    });
  });

  it("tells nobody while Core has not confirmed the card (queued, refused or never handed off)", async () => {
    await request(1);
    await coreOutbox(1, "pending", null);
    await request(2);
    await coreOutbox(2, "crm_notify_refused", null);
    await request(3);
    expect(await enqueueRfpApprovedCallbackIfCoreConfirmed(1)).toBe(false);
    expect(await enqueueRfpApprovedCallbackIfCoreConfirmed(2)).toBe(false);
    expect(await enqueueRfpApprovedCallbackIfCoreConfirmed(3)).toBe(false);
    expect(await callbacks()).toEqual([]);
  });

  it("tells nobody about a request SyncHub has not recorded approved: Core may answer before the approval's write lands", async () => {
    await request(5, { status: "pending" });
    await coreOutbox(5, "crm_notify_accepted", "core-bid-5");
    expect(await enqueueRfpApprovedCallbackIfCoreConfirmed(5)).toBe(false);
    // The approval's write lands; its own call (or markSent's, whichever is second) now enqueues.
    await pg.query(`UPDATE rfp_approval_requests SET status = 'approved', approved_at = '2026-11-13 17:00:00' WHERE id = 5`);
    expect(await enqueueRfpApprovedCallbackIfCoreConfirmed(5)).toBe(true);
    expect((await callbacks()).map((r) => r.rfp_approval_request_id)).toEqual([5]);
  });

  it("is idempotent: a second call (a re-drive, markSent after the approval, the reconcile) enqueues nothing more", async () => {
    await request(6);
    await coreOutbox(6, "sent", "core-bid-6");
    expect(await enqueueRfpApprovedCallbackIfCoreConfirmed(6)).toBe(true);
    await pg.query(`UPDATE bidboard_callback_outbox SET status = 'sent' WHERE rfp_approval_request_id = 6`);
    expect(await enqueueRfpApprovedCallbackIfCoreConfirmed(6)).toBe(false);
    const rows = await callbacks();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("sent");
  });

  it("Codex P2 on #136: a type changed to service at approval tells the CRM the number Core recorded, and the reconcile finds it", async () => {
    // The request's column keeps the non-service number it was sent with; the approval rewrote it to service for Core.
    await request(943, { service: false });
    await coreOutbox(943, "sent", "core-bid-943", "DFW-4-70943-aa");
    const plan = await planApprovedCallbackReconcile();
    expect(plan.willNotify).toEqual([943]);
    expect(await enqueueRfpApprovedCallbackIfCoreConfirmed(943)).toBe(true);
    expect((await callbacks())[0].payload.projectNumber).toBe("DFW-4-70943-aa");
  });

  it("never tells a HubSpot-era request (only CRM requests have a CRM to tell)", async () => {
    await request(7, { source: "hubspot" });
    await coreOutbox(7, "sent", "core-bid-7");
    expect(await enqueueRfpApprovedCallbackIfCoreConfirmed(7)).toBe(false);
  });
});

describe("the reconcile: approved CRM requests a failed Procore create stranded", () => {
  it("plans willNotify for Core-confirmed service requests with no callback, and leaves the rest visible and untouched", async () => {
    await request(941);
    await coreOutbox(941, "sent", "core-bid-941");
    await request(481); // approved in June, never handed to Core
    await request(482, { service: false });
    await request(939, { procore: true }); // completed by the old 'created' callback: not a candidate
    await coreOutbox(939, "sent", "core-bid-939");
    await request(950);
    await coreOutbox(950, "sent", "core-bid-950");
    await enqueueRfpApprovedCallbackIfCoreConfirmed(950); // already told
    const plan = await planApprovedCallbackReconcile();
    expect(plan).toEqual({ willNotify: [941], coreNotConfirmed: [481], alreadyHasCallback: [950], nonService: [482] });
  });

  it("applies once: the first run enqueues 941, a second run enqueues nothing and resets nothing", async () => {
    await request(941);
    await coreOutbox(941, "sent", "core-bid-941");
    expect(await applyApprovedCallbackReconcile(await planApprovedCallbackReconcile())).toEqual([941]);
    await pg.query(`UPDATE bidboard_callback_outbox SET status = 'sent', sent_at = now() WHERE rfp_approval_request_id = 941`);
    // A second run (or one applied from a stale plan) adds nothing and never re-arms the delivered row.
    expect(await applyApprovedCallbackReconcile({ willNotify: [941], coreNotConfirmed: [], alreadyHasCallback: [], nonService: [] })).toEqual([]);
    const rows = await callbacks();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("sent");
    expect((await planApprovedCallbackReconcile()).willNotify).toEqual([]);
  });
});
