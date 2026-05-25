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
  webhookLogId: number;
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
