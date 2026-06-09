import crypto from "crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db";
import { fetchWithTimeout } from "./lib/fetch-with-timeout";
import { trockcrmRelayOutbox, type TrockcrmRelayOutbox } from "@shared/schema";

const DEFAULT_RELAY_URL = "https://api-production-ad218.up.railway.app/api/webhooks/synchub/procore-project-created";
const MAX_ATTEMPTS = 20;
const RESPONSE_BODY_LIMIT = 4_000;
const BACKOFF_MS = [
  30_000,
  120_000,
  600_000,
  3_600_000,
  6 * 60 * 60 * 1000,
  12 * 60 * 60 * 1000,
];

export type TrockCrmRelayPayload = {
  eventType: "procore.project.created";
  source: "synchub";
  procore: {
    companyId: string;
    portfolioProjectId: string;
    projectNumber: string;
    projectName: string;
  };
  synchub: {
    webhookLogId: string;
    syncMappingId: string;
    bidboardProjectId: string | null;
    hubspotDealId: string | null;
    receivedAt: string;
    enrichedAt: string;
  };
  rawProcoreWebhook: {
    id: string;
    reason: string;
    resource_type: string;
    resource_id: string;
  };
};

export type TrockCrmProjectStageChangedRelayPayload = {
  eventType: "procore.project.stage_changed";
  source: "synchub";
  procore: {
    companyId: string;
    portfolioProjectId: string;
    projectNumber: string;
    projectName: string;
    previousStage: string;
    currentStage: string;
  };
  stageChange: {
    previousStage: string;
    newStage: string;
    detectedAt: string;
    webhookTimestamp: string | null;
  };
  synchub: {
    webhookLogId: string;
    syncMappingId: string | null;
    bidboardProjectId: string | null;
    hubspotDealId: string | null;
    receivedAt: string;
    enrichedAt: string;
  };
  rawProcoreWebhook: {
    [key: string]: unknown;
  };
};

export type TrockCrmRelayOutboxPayload =
  | TrockCrmRelayPayload
  | TrockCrmProjectStageChangedRelayPayload;

export type RelayStore = {
  insertOutbox?: (row: Record<string, unknown>) => Promise<{ id: number }>;
  hasProjectCreatedRelay?: (procorePortfolioProjectId: string) => Promise<boolean>;
  claimReadyOutbox?: (limit: number, now: Date, processingStaleBefore: Date) => Promise<Array<Pick<TrockcrmRelayOutbox, "id" | "payload" | "attempts">>>;
  markSent?: (id: number, data: { responseStatus: number; responseBody?: string | null; sentAt: Date }) => Promise<void>;
  markFailed?: (id: number, data: { attempts: number; error: string; responseStatus?: number | null; responseBody?: string | null; nextRetryAt: Date; attemptedAt: Date }) => Promise<void>;
  markAbandoned?: (id: number, data: { attempts?: number; error: string; responseStatus?: number | null; responseBody?: string | null; attemptedAt: Date }) => Promise<void>;
};

type ProcessResult = "sent" | "failed" | "abandoned";

function relayEnabled() {
  return process.env.TROCKCRM_RELAY_ENABLED !== "false";
}

function relaySecret() {
  return process.env.SYNCHUB_RELAY_SECRET?.trim() || "";
}

function isStageChangedPayload(payload: unknown): payload is TrockCrmProjectStageChangedRelayPayload {
  return Boolean(
    payload &&
    typeof payload === "object" &&
    (payload as { eventType?: unknown }).eventType === "procore.project.stage_changed"
  );
}

function relayUrl() {
  return process.env.TROCKCRM_RELAY_URL?.trim() || DEFAULT_RELAY_URL;
}

function stageChangeRelayUrl() {
  return process.env.TROCKCRM_STAGE_CHANGE_RELAY_URL?.trim() || "";
}

function resolveRelayUrl(payload: unknown) {
  return isStageChangedPayload(payload) ? stageChangeRelayUrl() : relayUrl();
}

function relayLog(message: string) {
  console.log(message);
}

function truncateResponseBody(body: string | null | undefined) {
  if (!body) return null;
  return body.length > RESPONSE_BODY_LIMIT ? body.slice(0, RESPONSE_BODY_LIMIT) : body;
}

function rowsFromDbResult(result: unknown): any[] {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: unknown[] }).rows;
  }
  return [];
}

export function signTrockCrmRelayBody(body: string, secret: string) {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function calculateTrockCrmRelayBackoff(attempts: number) {
  return BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1];
}

export function buildTrockCrmProjectCreatedPayload(input: {
  webhookLog: { id: number | string; createdAt?: Date | string | null; payload?: any };
  syncMapping: { id: number | string; bidboardProjectId?: string | null; hubspotDealId?: string | null };
  procoreProject: {
    id?: string | number | null;
    company_id?: string | number | null;
    company?: { id?: string | number | null } | null;
    project_number?: string | null;
    name?: string | null;
    display_name?: string | null;
  };
  enrichedAt?: Date;
}): TrockCrmRelayPayload {
  const raw = input.webhookLog.payload ?? {};
  const portfolioProjectId = String(input.procoreProject.id ?? raw.resource_id ?? "");
  return {
    eventType: "procore.project.created",
    source: "synchub",
    procore: {
      companyId: String(input.procoreProject.company_id ?? input.procoreProject.company?.id ?? raw.company_id ?? ""),
      portfolioProjectId,
      projectNumber: String(input.procoreProject.project_number ?? ""),
      projectName: String(input.procoreProject.name ?? input.procoreProject.display_name ?? ""),
    },
    synchub: {
      webhookLogId: String(input.webhookLog.id),
      syncMappingId: String(input.syncMapping.id),
      bidboardProjectId: input.syncMapping.bidboardProjectId ?? null,
      hubspotDealId: input.syncMapping.hubspotDealId ?? null,
      receivedAt: new Date(input.webhookLog.createdAt ?? Date.now()).toISOString(),
      enrichedAt: (input.enrichedAt ?? new Date()).toISOString(),
    },
    rawProcoreWebhook: {
      id: String(raw.id ?? ""),
      reason: String(raw.reason ?? "create"),
      resource_type: String(raw.resource_type ?? "Projects"),
      resource_id: String(raw.resource_id ?? portfolioProjectId),
    },
  };
}

function optionalNumericId(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function optionalString(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function cleanStage(value: string): string {
  return value.trim();
}

export function buildTrockCrmProjectStageChangedPayload(input: {
  webhookLog: { id: number | string; createdAt?: Date | string | null; payload?: any };
  syncMapping?: { id?: number | string | null; bidboardProjectId?: string | null; hubspotDealId?: string | null } | null;
  procoreProject: {
    procoreId?: string | number | null;
    id?: string | number | null;
    companyId?: string | number | null;
    company_id?: string | number | null;
    projectNumber?: string | null;
    project_number?: string | null;
    name?: string | null;
    displayName?: string | null;
    display_name?: string | null;
  };
  previousStage: string;
  newStage: string;
  detectedAt?: Date;
}): TrockCrmProjectStageChangedRelayPayload {
  const raw = input.webhookLog.payload ?? {};
  const detectedAt = input.detectedAt ?? new Date();
  const previousStage = cleanStage(input.previousStage);
  const newStage = cleanStage(input.newStage);
  const portfolioProjectId = String(
    input.procoreProject.procoreId ??
    input.procoreProject.id ??
    raw.project_id ??
    raw.resource_id ??
    ""
  );
  return {
    eventType: "procore.project.stage_changed",
    source: "synchub",
    procore: {
      companyId: String(input.procoreProject.companyId ?? input.procoreProject.company_id ?? raw.company_id ?? ""),
      portfolioProjectId,
      projectNumber: String(input.procoreProject.projectNumber ?? input.procoreProject.project_number ?? ""),
      projectName: String(input.procoreProject.name ?? input.procoreProject.displayName ?? input.procoreProject.display_name ?? ""),
      previousStage,
      currentStage: newStage,
    },
    stageChange: {
      previousStage,
      newStage,
      detectedAt: detectedAt.toISOString(),
      webhookTimestamp: optionalString(raw.timestamp),
    },
    synchub: {
      webhookLogId: String(input.webhookLog.id),
      syncMappingId: input.syncMapping?.id == null ? null : String(input.syncMapping.id),
      bidboardProjectId: input.syncMapping?.bidboardProjectId ?? null,
      hubspotDealId: input.syncMapping?.hubspotDealId ?? null,
      receivedAt: new Date(input.webhookLog.createdAt ?? Date.now()).toISOString(),
      enrichedAt: detectedAt.toISOString(),
    },
    rawProcoreWebhook: { ...raw },
  };
}

export async function enqueueTrockCrmProjectStageChangedRelay(input: {
  store?: RelayStore;
  webhookLog: { id: number | string; createdAt?: Date | string | null; payload?: any };
  syncMapping?: { id?: number | string | null; bidboardProjectId?: string | null; hubspotDealId?: string | null } | null;
  procoreProject: Parameters<typeof buildTrockCrmProjectStageChangedPayload>[0]["procoreProject"];
  previousStage: string;
  newStage: string;
  detectedAt?: Date;
}): Promise<{ enqueued: true; outboxId: number } | { enqueued: false; reason: "missing_stage_change_relay_url" | "insert_failed" }> {
  try {
    if (!stageChangeRelayUrl()) return { enqueued: false, reason: "missing_stage_change_relay_url" };
    const payload = buildTrockCrmProjectStageChangedPayload(input);
    return await enqueueTrockCrmRelayOutbox({
      store: input.store,
      webhookLogId: Number(input.webhookLog.id),
      syncMappingId: optionalNumericId(input.syncMapping?.id),
      procorePortfolioProjectId: payload.procore.portfolioProjectId,
      projectNumber: payload.procore.projectNumber,
      payload,
    }) as { enqueued: true; outboxId: number } | { enqueued: false; reason: "insert_failed" };
  } catch (err) {
    relayLog(`[TrockCRMRelay] Failed to enqueue project stage-change relay: ${err instanceof Error ? err.message : String(err)}`);
    return { enqueued: false, reason: "insert_failed" };
  }
}

export function createDbRelayStore(): Required<RelayStore> {
  return {
    async insertOutbox(row) {
      const [result] = await db
        .insert(trockcrmRelayOutbox)
        .values(row as any)
        .returning({ id: trockcrmRelayOutbox.id });
      return result;
    },
    // Has a `procore.project.created` relay EVER been enqueued for this portfolio project (any
    // status — rows persist after send via markSent)? This is the authoritative "relay emitted"
    // idempotency signal, independent of syncMappings.portfolioProjectId (which runPhase2 sets
    // mid-automation, so it can't be trusted as proof the relay was sent).
    async hasProjectCreatedRelay(procorePortfolioProjectId) {
      const rows = await db
        .select({ id: trockcrmRelayOutbox.id })
        .from(trockcrmRelayOutbox)
        .where(and(
          eq(trockcrmRelayOutbox.procorePortfolioProjectId, procorePortfolioProjectId),
          sql`${trockcrmRelayOutbox.payload}->>'eventType' = 'procore.project.created'`,
        ))
        .limit(1);
      return rows.length > 0;
    },
    async claimReadyOutbox(limit, now, processingStaleBefore) {
      const result = await db.transaction(async (tx) => tx.execute(sql`
        WITH claimed AS (
          SELECT id
          FROM ${trockcrmRelayOutbox}
          WHERE (
            status = 'pending'
            OR (
              status = 'failed'
              AND (next_retry_at IS NULL OR next_retry_at <= ${now})
            )
            OR (
              status = 'processing'
              AND last_attempt_at <= ${processingStaleBefore}
            )
          )
          ORDER BY created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        )
        UPDATE ${trockcrmRelayOutbox}
        SET
          status = 'processing',
          attempts = attempts + 1,
          last_attempt_at = ${now},
          last_error = NULL,
          next_retry_at = NULL
        FROM claimed
        WHERE ${trockcrmRelayOutbox}.id = claimed.id
        RETURNING
          ${trockcrmRelayOutbox}.id,
          ${trockcrmRelayOutbox}.payload,
          ${trockcrmRelayOutbox}.attempts
      `));
      return rowsFromDbResult(result) as Array<Pick<TrockcrmRelayOutbox, "id" | "payload" | "attempts">>;
    },
    async markSent(id, data) {
      await db.update(trockcrmRelayOutbox).set({
        status: "sent",
        lastAttemptAt: data.sentAt,
        lastError: null,
        lastResponseStatus: data.responseStatus,
        lastResponseBody: truncateResponseBody(data.responseBody),
        sentAt: data.sentAt,
        nextRetryAt: null,
      }).where(eq(trockcrmRelayOutbox.id, id));
    },
    async markFailed(id, data) {
      await db.update(trockcrmRelayOutbox).set({
        status: "failed",
        attempts: data.attempts,
        lastAttemptAt: data.attemptedAt,
        lastError: data.error,
        lastResponseStatus: data.responseStatus ?? null,
        lastResponseBody: truncateResponseBody(data.responseBody),
        nextRetryAt: data.nextRetryAt,
      }).where(eq(trockcrmRelayOutbox.id, id));
    },
    async markAbandoned(id, data) {
      await db.update(trockcrmRelayOutbox).set({
        status: "abandoned",
        attempts: data.attempts,
        lastAttemptAt: data.attemptedAt,
        lastError: data.error,
        lastResponseStatus: data.responseStatus ?? null,
        lastResponseBody: truncateResponseBody(data.responseBody),
        nextRetryAt: null,
      }).where(eq(trockcrmRelayOutbox.id, id));
    },
  };
}

export async function enqueueTrockCrmRelayOutbox(input: {
  store?: RelayStore;
  webhookLogId: number | null;
  syncMappingId: number | null;
  procorePortfolioProjectId: string;
  projectNumber: string;
  payload: TrockCrmRelayOutboxPayload;
}): Promise<{ enqueued: true; outboxId: number } | { enqueued: false; reason: "disabled" | "missing_secret" | "insert_failed" }> {
  try {
    const store = input.store ?? createDbRelayStore();
    const row = await store.insertOutbox!({
      webhookLogId: input.webhookLogId,
      syncMappingId: input.syncMappingId,
      procorePortfolioProjectId: input.procorePortfolioProjectId,
      projectNumber: input.projectNumber,
      payload: input.payload,
      status: "pending",
      attempts: 0,
      nextRetryAt: null,
    });
    return { enqueued: true, outboxId: row.id };
  } catch (err) {
    relayLog(`[TrockCRMRelay] Failed to enqueue relay: ${err instanceof Error ? err.message : String(err)}`);
    return { enqueued: false, reason: "insert_failed" };
  }
}

type Phase2RelayStorage = {
  getSyncMappingByProcoreProjectNumber: (n: string) => Promise<any>;
  getSyncMappings: () => Promise<any[]>;
};

/**
 * Enqueue the `procore.project.created` relay for a portfolio project on Phase-2 completion.
 *
 * WHY THIS EXISTS: the `projects.create` webhook handler only enqueues this relay in its
 * "no pending Phase-2 job" *fallback* branch. The normal automation registers a pending Phase-2 job
 * (right after Phase-1) BEFORE the create-webhook arrives, so the webhook claims that job and runs
 * Phase-2 down the `if (pending)` branch — never reaching the relay enqueue. (And the PRIMARY path
 * direct-chains Phase 2 via runPhase2 inside runPhase1WithRetry, also bypassing it.) Result: the CRM
 * public photo link was silently skipped for ~every automation-portfolio'd project. Calling this on
 * every Phase-2 success makes the relay fire reliably, independent of branch / queue timing.
 *
 * Idempotency & correctness:
 *  - Resolve the mapping by **project_number** (derived from the actual portfolioProjectId), NOT by a
 *    passed bid-board id: the webhook claims the OLDEST pending job, which may belong to a different
 *    project, so a bid-board-id lookup could attach the relay to the wrong deal.
 *  - The once-guard is **outbox existence** (a prior `procore.project.created` row for this project),
 *    NOT syncMappings.portfolioProjectId — runPhase2 sets that field mid-automation, so it is not
 *    proof the relay was emitted. No mapping mutation here (avoids losing the relay on a transient
 *    insert failure). The CRM consumer is independently idempotent as a backstop.
 */
export async function enqueueProjectCreatedRelayForPortfolioProject(input: {
  portfolioProjectId: string;
  webhookLog?: { id: number | string; createdAt?: Date | string | null; payload?: any } | null;
  deps?: {
    storage?: Phase2RelayStorage;
    fetchProcoreProjectDetail?: (id: string) => Promise<any>;
    store?: RelayStore;
  };
}): Promise<{ enqueued: boolean; reason?: string; outboxId?: number }> {
  const portfolioProjectId = String(input.portfolioProjectId ?? "");
  if (!portfolioProjectId) return { enqueued: false, reason: "missing_portfolio_project_id" };

  const storage: Phase2RelayStorage = input.deps?.storage ?? (await import("./storage")).storage;
  const fetchDetail = input.deps?.fetchProcoreProjectDetail ?? (await import("./procore")).fetchProcoreProjectDetail;
  const store = input.deps?.store ?? createDbRelayStore();

  // The CRM resolves the deal by project_number, so Procore project detail is required.
  let project: any = null;
  try {
    project = await fetchDetail(portfolioProjectId);
  } catch (err) {
    relayLog(`[TrockCRMRelay] Phase 2 relay: could not fetch Procore project ${portfolioProjectId}: ${err instanceof Error ? err.message : String(err)}`);
    return { enqueued: false, reason: "project_detail_failed" };
  }
  const projectNumber = optionalString(project?.project_number);
  if (!projectNumber) return { enqueued: false, reason: "no_project_number" };

  // Resolve the mapping by project_number — authoritative for THIS portfolio project (see note above).
  let mapping = await storage.getSyncMappingByProcoreProjectNumber(projectNumber);
  // Among duplicate rows sharing this project_number, prefer one that actually carries the bid-board
  // link — getSyncMappingByProcoreProjectNumber can return an arbitrary portfolio-only/legacy
  // duplicate with bidboardProjectId null (matches the fallback in triggerPortfolioAutomationFromStageChange).
  if (!mapping?.bidboardProjectId) {
    const all = await storage.getSyncMappings();
    mapping = all.find((m: any) => m.procoreProjectNumber === projectNumber && m.bidboardProjectId) ?? mapping;
  }
  if (!mapping?.bidboardProjectId) return { enqueued: false, reason: "no_bidboard_mapping" };

  // Once-guard keyed on the outbox (the real "relay emitted" signal), not mapping.portfolioProjectId.
  if (store.hasProjectCreatedRelay && (await store.hasProjectCreatedRelay(portfolioProjectId))) {
    return { enqueued: false, reason: "already_relayed" };
  }

  const payload = buildTrockCrmProjectCreatedPayload({
    webhookLog: input.webhookLog ?? {
      id: 0,
      createdAt: new Date(),
      payload: { resource_id: portfolioProjectId, reason: "phase2_complete", resource_type: "Projects" },
    },
    syncMapping: mapping,
    procoreProject: { ...project, id: portfolioProjectId },
    enrichedAt: new Date(),
  });

  const res = await enqueueTrockCrmRelayOutbox({
    store,
    webhookLogId: optionalNumericId(input.webhookLog?.id),
    syncMappingId: optionalNumericId(mapping.id),
    procorePortfolioProjectId: portfolioProjectId,
    projectNumber,
    payload,
  });
  return res.enqueued ? { enqueued: true, outboxId: res.outboxId } : { enqueued: false, reason: res.reason };
}

export async function processTrockCrmRelayOutboxEntry(input: {
  store?: RelayStore;
  fetchImpl?: typeof fetch;
  row: Pick<TrockcrmRelayOutbox, "id" | "payload" | "attempts">;
  now?: Date;
}): Promise<ProcessResult> {
  const secret = relaySecret();
  const store = input.store ?? createDbRelayStore();
  const now = input.now ?? new Date();
  const attempts = Math.max(Number(input.row.attempts ?? 0), 1);
  const body = JSON.stringify(input.row.payload);
  const fetchImpl = input.fetchImpl ?? ((url, init) => fetchWithTimeout(String(url), init, 30_000));
  const url = resolveRelayUrl(input.row.payload);

  if (!secret) {
    await store.markFailed!(input.row.id, {
      attempts,
      error: "SYNCHUB_RELAY_SECRET missing",
      nextRetryAt: new Date(now.getTime() + calculateTrockCrmRelayBackoff(attempts)),
      attemptedAt: now,
    });
    return "failed";
  }

  if (!url) {
    const error = "TROCKCRM_STAGE_CHANGE_RELAY_URL missing";
    await store.markAbandoned!(input.row.id, { attempts, error, attemptedAt: now });
    return "abandoned";
  }

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-synchub-signature": signTrockCrmRelayBody(body, secret),
      },
      body,
    });
    const responseBody = truncateResponseBody(await response.text().catch(() => ""));
    if (response.ok) {
      await store.markSent!(input.row.id, { responseStatus: response.status, responseBody, sentAt: now });
      return "sent";
    }

    const error = `trockcrm responded ${response.status}`;
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      await store.markAbandoned!(input.row.id, {
        attempts,
        error,
        responseStatus: response.status,
        responseBody,
        attemptedAt: now,
      });
      return "abandoned";
    }

    if (attempts >= MAX_ATTEMPTS) {
      await store.markAbandoned!(input.row.id, {
        attempts,
        error,
        responseStatus: response.status,
        responseBody,
        attemptedAt: now,
      });
      return "abandoned";
    }

    await store.markFailed!(input.row.id, {
      attempts,
      error,
      responseStatus: response.status,
      responseBody,
      nextRetryAt: new Date(now.getTime() + calculateTrockCrmRelayBackoff(attempts)),
      attemptedAt: now,
    });
    return "failed";
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (attempts >= MAX_ATTEMPTS) {
      await store.markAbandoned!(input.row.id, { attempts, error, attemptedAt: now });
      return "abandoned";
    }
    await store.markFailed!(input.row.id, {
      attempts,
      error,
      nextRetryAt: new Date(now.getTime() + calculateTrockCrmRelayBackoff(attempts)),
      attemptedAt: now,
    });
    return "failed";
  }
}

export async function processTrockCrmRelayOutboxBatch(input: {
  store?: RelayStore;
  fetchImpl?: typeof fetch;
  limit?: number;
} = {}) {
  if (!relayEnabled()) return { processed: 0, sent: 0, failed: 0, abandoned: 0 };
  const store = input.store ?? createDbRelayStore();
  const now = new Date();
  const processingStaleBefore = new Date(now.getTime() - 5 * 60 * 1000);
  const rows = await store.claimReadyOutbox!(input.limit ?? 25, now, processingStaleBefore);
  const result = { processed: 0, sent: 0, failed: 0, abandoned: 0 };
  for (const row of rows) {
    const status = await processTrockCrmRelayOutboxEntry({ store, fetchImpl: input.fetchImpl, row });
    result.processed += 1;
    result[status] += 1;
  }
  return result;
}

export async function listTrockCrmRelayOutbox(filters: {
  webhookLogIds?: number[];
  status?: string;
  limit?: number;
  offset?: number;
} = {}) {
  const conditions = [];
  if (filters.webhookLogIds?.length) conditions.push(inArray(trockcrmRelayOutbox.webhookLogId, filters.webhookLogIds));
  if (filters.status) conditions.push(eq(trockcrmRelayOutbox.status, filters.status));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  return db
    .select()
    .from(trockcrmRelayOutbox)
    .where(where)
    .orderBy(asc(trockcrmRelayOutbox.createdAt))
    .limit(filters.limit ?? 100)
    .offset(filters.offset ?? 0);
}
