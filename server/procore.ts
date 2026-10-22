/**
 * Procore Integration Module
 * ==========================
 * 
 * This module handles all interactions with the Procore Construction Management API.
 * It manages OAuth authentication, project data synchronization, and BidBoard operations.
 * 
 * Key Features:
 * - OAuth 2.0 authentication with automatic token refresh
 * - Full sync of projects, vendors, users, and bid packages
 * - BidBoard (estimating) data synchronization
 * - Role assignment tracking and notifications
 * - Change detection for stage transitions
 * 
 * Procore Project Lifecycle:
 * 1. BidBoard Phase: Projects in estimating (pre-award)
 *    - Synced via syncProcoreBidBoard()
 *    - Stage changes trigger HubSpot updates
 * 
 * 2. Portfolio Phase: Active projects (post-award)
 *    - Transitioned via Playwright automation
 *    - Documents, budgets, change orders tracked
 * 
 * API Endpoints Used:
 * - /rest/v1.0/projects: Project CRUD
 * - /rest/v1.0/companies/{id}/vendors: Vendor directory
 * - /rest/v1.0/companies/{id}/users: User management
 * - /rest/v1.1/projects/{id}/bid_packages: BidBoard data
 * 
 * Key Functions:
 * - getProcoreClient(): Returns authenticated API client
 * - runFullProcoreSync(): Syncs all Procore data to local database
 * - syncProcoreBidBoard(): Syncs BidBoard/estimating projects
 * - syncProcoreRoleAssignments(): Tracks project role changes
 * - getCompanyId(): Gets configured Procore company ID
 * 
 * @module procore
 */

import { storage } from './storage';
import { pool } from './db';
import type { PoolClient, QueryConfig } from 'pg';
import { DEFAULT_PROCORE_COMPANY_ID } from './constants';
import { fetchWithTimeout } from './lib/fetch-with-timeout';
import { openSecret, sealSecret } from './lib/secret-seal';
import { updateRateLimits, applyBackpressure } from './lib/rate-limit-tracker';
import { acquireRateLimitToken, wasProjectWebhookUpdated, clearWebhookUpdatedProjects } from './procore-rate-limiter';

/**
 * Gets Procore configuration from database.
 * Falls back to default company ID if not configured.
 */
async function getProcoreConfig(): Promise<{ companyId: string; environment: string; clientId: string; clientSecret: string }> {
  const config = await storage.getAutomationConfig("procore_config");
  if (!config?.value) {
    throw new Error("Procore not configured. Please save your Procore credentials in Settings.");
  }
  const val = config.value as any;
  return {
    companyId: val.companyId || DEFAULT_PROCORE_COMPANY_ID,
    environment: val.environment || "production",
    clientId: val.clientId || "",
    clientSecret: val.clientSecret || "",
  };
}

function getBaseUrl(environment: string): string {
  return environment === "sandbox" ? "https://sandbox.procore.com" : "https://api.procore.com";
}

/** The environment-aware Procore REST API base URL (production vs sandbox). Use instead of hardcoding. */
export async function getProcoreApiBaseUrl(): Promise<string> {
  const config = await getProcoreConfig();
  return getBaseUrl(config.environment);
}

function getLoginUrl(environment: string): string {
  return environment === "sandbox" ? "https://login-sandbox.procore.com" : "https://login.procore.com";
}

// Mutex: only one Procore token refresh at a time (refresh tokens are single-use)
let refreshPromise: Promise<string> | null = null;

/** By default a token with less than this much life left is refreshed first. Callers may ask for more. */
const DEFAULT_MIN_VALIDITY_MS = 60_000;

/**
 * A valid Procore access token, refreshed first (under the cross-replica lock) when it has less than
 * `minValidityMs` left. The default keeps the historical 60 s threshold; Core's token read asks for 5 minutes.
 */
export async function getAccessToken(opts: { minValidityMs?: number } = {}): Promise<string> {
  const minValidityMs = opts.minValidityMs ?? DEFAULT_MIN_VALIDITY_MS;
  const token = await storage.getOAuthToken("procore");
  if (!token?.accessToken) {
    throw new Error("No Procore OAuth token found. Please authenticate via OAuth first.");
  }

  // An unknown expiry (NULL) cannot be shown to have minValidityMs left: with a refresh token it is refreshed
  // (under the lock) so the row gets a real expiry. Without one, the stored token is returned as before.
  const expiresAtMs = token.expiresAt ? new Date(token.expiresAt).getTime() : null;
  const needsRefresh =
    expiresAtMs === null || Number.isNaN(expiresAtMs) ? Boolean(token.refreshToken) : expiresAtMs < Date.now() + minValidityMs;
  if (needsRefresh) {
    if (token.refreshToken) {
      return await refreshAccessToken(token.refreshToken, minValidityMs);
    }
    throw new Error("Procore token expired and no refresh token available. Please re-authenticate.");
  }

  return token.accessToken;
}

async function refreshAccessToken(refreshToken: string, minValidityMs: number): Promise<string> {
  // In-process mutex: callers in THIS process share one refresh. Across replicas the advisory lock below serialises.
  if (refreshPromise) {
    return refreshPromise;
  }

  const promise = refreshProcoreAccessTokenUnderLock(refreshToken, minValidityMs);
  refreshPromise = promise;
  try {
    return await promise;
  } finally {
    refreshPromise = null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The Procore OAuth row is written only under pg_advisory_xact_lock(hashtext('procore-oauth-refresh')), on ONE
// dedicated pool client, inside one transaction: the refresh (which spends the single-use refresh token) and the
// OAuth callback (which stores a freshly authorised pair). Timeouts, all above the 30 s Procore refresh fetch:
//   lock_timeout 40 s      a waiter gives up on a holder that is still talking to Procore
//   statement_timeout 45 s the pool's 30 s default would otherwise cancel a legitimate lock wait
//   query_timeout 50 s     the pool's client-side 30 s read timeout, raised for the lock query only
// ---------------------------------------------------------------------------------------------------------------
const PROCORE_OAUTH_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('procore-oauth-refresh'))";
/** The whole refresh exchange, headers AND body, must finish within this. */
const PROCORE_REFRESH_FETCH_TIMEOUT_MS = 30_000;
const PROCORE_LOCK_TIMEOUT_MS = 40_000;
const PROCORE_LOCK_STATEMENT_TIMEOUT_MS = 45_000;
const PROCORE_LOCK_QUERY_CLIENT_TIMEOUT_MS = 50_000;

class ProcoreOAuthLockWaitTimeout extends Error {}

/**
 * `start()`'s result, or a rejection as soon as `signal` aborts. The abort also reaches the request itself
 * (fetchWithTimeout forwards the caller's signal), so a real body read is cancelled; the race makes the bound hold
 * regardless. A THUNK, so an already-aborted deadline never starts the read, and nothing is left to reject unhandled.
 */
function beforeDeadline<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  const timedOut = () => new Error(`Procore token refresh timed out after ${PROCORE_REFRESH_FETCH_TIMEOUT_MS}ms`);
  if (signal.aborted) return Promise.reject(timedOut());
  let work: Promise<T>;
  try {
    work = start();
  } catch (err) {
    return Promise.reject(err);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(timedOut());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(signal.aborted ? timedOut() : e);
      },
    );
  });
}

function isLockWaitTimeout(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  const message = err instanceof Error ? err.message : "";
  // 55P03 lock_not_available (lock_timeout), 57014 query_canceled (statement_timeout), pg's client-side read timeout.
  return code === "55P03" || code === "57014" || /query read timeout/i.test(message);
}

/**
 * Run `work` inside BEGIN .. COMMIT on a dedicated client holding the Procore OAuth advisory lock. The client goes
 * back to the pool with a plain release() ONLY after a clean COMMIT; on any other path it is rolled back (best
 * effort) and destroyed with release(true), so a broken connection is never reused.
 */
async function withProcoreOAuthLock<T>(
  work: (client: PoolClient) => Promise<T>,
  onCommitError?: (err: unknown) => void,
): Promise<T> {
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL statement_timeout = ${PROCORE_LOCK_STATEMENT_TIMEOUT_MS}`);
    await client.query(`SET LOCAL lock_timeout = ${PROCORE_LOCK_TIMEOUT_MS}`);
    const lockQuery: QueryConfig & { query_timeout: number } = {
      text: PROCORE_OAUTH_LOCK_SQL,
      query_timeout: PROCORE_LOCK_QUERY_CLIENT_TIMEOUT_MS,
    };
    try {
      await client.query(lockQuery);
    } catch (err) {
      if (isLockWaitTimeout(err)) {
        throw new ProcoreOAuthLockWaitTimeout("Timed out waiting for the Procore OAuth lock (another refresh is running)");
      }
      throw err;
    }
    const result = await work(client);
    try {
      await client.query("COMMIT");
    } catch (err) {
      onCommitError?.(err);
      throw err;
    }
    committed = true;
    return result;
  } finally {
    if (!committed) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // the connection is unusable; it is destroyed below either way
      }
    }
    client.release(committed ? undefined : true);
  }
}

/** oauth_tokens.expires_at is `timestamp` (no zone) holding UTC wall-clock time, as drizzle writes it. */
function utcTimestampTextToMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const iso = value.trim().replace(" ", "T").replace(/(\.\d{3})\d+/, "$1");
  const ms = Date.parse(/(Z|[+-]\d\d(:?\d\d)?)$/.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** Upsert the Procore pair on the LOCKED client (same columns storage.upsertOAuthToken sets). */
async function upsertProcoreTokenPair(
  client: PoolClient,
  pair: { accessToken: string; refreshToken: string | null; expiresAt: Date },
): Promise<void> {
  await client.query(
    `INSERT INTO oauth_tokens (provider, access_token, refresh_token, token_type, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (provider) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       token_type = EXCLUDED.token_type,
       expires_at = EXCLUDED.expires_at,
       updated_at = now()`,
    // toISOString(): stored as UTC wall-clock time in the zone-less column, exactly as drizzle stores it.
    // H2: sealed at rest like storage.upsertOAuthToken (a plain pass-through until SECRETS_ENCRYPTION_KEY is set).
    ["procore", sealSecret(pair.accessToken), sealSecret(pair.refreshToken), "Bearer", pair.expiresAt.toISOString()],
  );
}

/**
 * Cross-replica single flight for the single-use Procore refresh token, under the Procore OAuth lock: re-read the
 * oauth_tokens row once the lock is held. If the stored access token has more than `minValidityMs` left (another
 * replica refreshed while we waited), return it without calling Procore. Otherwise POST /oauth/token with the refresh
 * token READ UNDER THE LOCK (never `callerRefreshToken`, which another replica may already have spent) and write the new
 * pair on the same client before COMMIT. If the lock wait itself times out, re-read the row and return it when it
 * is fresh; otherwise fail without calling Procore. Exported for tests; callers use getAccessToken().
 */
export async function refreshProcoreAccessTokenUnderLock(
  callerRefreshToken: string,
  minValidityMs: number = DEFAULT_MIN_VALIDITY_MS,
): Promise<string> {
  // Read before taking a connection + the lock, so no second pool connection is needed while the lock is held.
  const config = await getProcoreConfig();
  // Set once Procore has answered: from then on the old refresh token is SPENT, so failing to persist the new pair
  // leaves the stored pair stale (the next refresh will be refused and someone must reconnect Procore).
  let issued: { expiresAt: Date; attemptedAt: Date } | null = null;
  const logStalePair = (stage: string, err: unknown) => {
    if (!issued) return;
    const code = (err as { code?: unknown } | null)?.code;
    // Deliberately no token and no driver message (a driver error can echo parameter values).
    console.error(
      `[procore] ${stage} failed AFTER Procore issued a new token pair: the stored Procore token pair may be stale ` +
        `(the old refresh token is spent). New pair expiresAt=${issued.expiresAt.toISOString()}, ` +
        `attempted at ${issued.attemptedAt.toISOString()}` +
        `${typeof code === "string" ? `, error code ${code}` : ""}. If Procore calls start failing, reconnect Procore in Settings.`,
    );
  };
  try {
    const token = await withProcoreOAuthLock(async (client) => {
      const { rows } = await client.query(
        "SELECT access_token, refresh_token, expires_at::text AS expires_at FROM oauth_tokens WHERE provider = $1",
        ["procore"],
      );
      const rawRow = rows[0] as { access_token: string | null; refresh_token: string | null; expires_at: string | null } | undefined;
      // H2: open the sealed values (legacy plaintext passes through).
      const row = rawRow ? { ...rawRow, access_token: openSecret(rawRow.access_token), refresh_token: openSecret(rawRow.refresh_token) } : rawRow;
      if (!row?.access_token) {
        throw new Error("No Procore OAuth token found. Please authenticate via OAuth first.");
      }
      const expiresAtMs = utcTimestampTextToMs(row.expires_at);
      // Short-circuit ONLY on a stored access token that is fresh enough. A rotated pair (another replica refreshed,
      // so the row's refresh token differs from the caller's) that is itself near expiry is refreshed here: the
      // single-use protection is that only the refresh token READ UNDER THE LOCK is ever sent, never the caller's.
      if (expiresAtMs !== null && expiresAtMs > Date.now() + minValidityMs) {
        return row.access_token;
      }
      if (!row.refresh_token) {
        throw new Error("Procore token expired and no refresh token available. Please re-authenticate.");
      }
      const lockedRefreshToken = row.refresh_token;
      const loginUrl = getLoginUrl(config.environment);

      // ONE deadline for the whole exchange, body included. fetchWithTimeout's own timer stops once the headers
      // arrive, and a stalled body would otherwise hold this lock until undici's five-minute body timeout.
      const attemptedAt = new Date();
      const deadline = new AbortController();
      const deadlineTimer = setTimeout(() => deadline.abort(), PROCORE_REFRESH_FETCH_TIMEOUT_MS);
      let data: any;
      try {
        const response = await fetchWithTimeout(
          `${loginUrl}/oauth/token`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              grant_type: 'refresh_token',
              client_id: config.clientId,
              client_secret: config.clientSecret,
              refresh_token: lockedRefreshToken,
            }),
            signal: deadline.signal,
          },
          PROCORE_REFRESH_FETCH_TIMEOUT_MS,
        );

        if (!response.ok) {
          const errText = await beforeDeadline(() => response.text(), deadline.signal);
          throw new Error(`Failed to refresh Procore token: ${response.status} ${errText}`);
        }

        data = await beforeDeadline(() => response.json(), deadline.signal);
      } finally {
        clearTimeout(deadlineTimer);
      }
      const expiresAt = new Date(Date.now() + (data.expires_in || 7200) * 1000);
      issued = { expiresAt, attemptedAt };

      // Same client, same transaction, before COMMIT: Procore has now spent the old refresh token, so this write
      // must not depend on getting a second pool connection.
      try {
        await upsertProcoreTokenPair(client, {
          accessToken: data.access_token,
          refreshToken: data.refresh_token || lockedRefreshToken,
          expiresAt,
        });
      } catch (err) {
        logStalePair("Writing the refreshed Procore token pair", err);
        throw err;
      }
      return data.access_token as string;
    }, (err) => logStalePair("COMMIT of the refreshed Procore token pair", err));
    if (issued) console.log("Procore token refreshed successfully");
    return token;
  } catch (err) {
    if (!(err instanceof ProcoreOAuthLockWaitTimeout)) throw err;
    // Another replica held the lock past lock_timeout (it is mid-refresh). Its result may already be stored.
    const row = await storage.getOAuthToken("procore");
    if (row?.accessToken && row.expiresAt && new Date(row.expiresAt).getTime() > Date.now() + minValidityMs) {
      return row.accessToken;
    }
    throw new Error("Procore token refresh timed out waiting for another replica's refresh; try again shortly.");
  }
}

/**
 * Store a freshly authorised Procore pair (the OAuth callback) under the same lock as the refresh, so a reconnect
 * can never interleave with a refresh's re-read / spend / write.
 */
export async function storeProcoreTokenPairUnderLock(pair: {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
}): Promise<void> {
  await withProcoreOAuthLock((client) => upsertProcoreTokenPair(client, pair));
}

async function fetchProcorePages<T>(endpoint: string, companyId: string): Promise<T[]> {
  const accessToken = await getAccessToken();
  const config = await getProcoreConfig();
  const baseUrl = getBaseUrl(config.environment);
  const allResults: T[] = [];
  let page = 1;

  while (true) {
    await applyBackpressure("procore");
    const separator = endpoint.includes('?') ? '&' : '?';
    const url = `${baseUrl}${endpoint}${separator}per_page=100&page=${page}`;

    const response = await fetchWithTimeout(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
        'Procore-Company-Id': companyId,
      },
    });
    updateRateLimits("procore", response.headers);

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("Procore token expired or invalid. Please re-authenticate.");
      }
      const errText = await response.text();
      throw new Error(`Procore API error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) break;

    allResults.push(...data);
    if (data.length < 100) break;
    page++;
  }

  return allResults;
}

function detectChanges(existing: any, newData: any, fields: string[]): { field: string; oldValue: string; newValue: string }[] {
  const changes: { field: string; oldValue: string; newValue: string }[] = [];
  for (const field of fields) {
    const oldVal = String(existing[field] ?? '');
    const newVal = String(newData[field] ?? '');
    if (oldVal !== newVal) {
      changes.push({ field, oldValue: oldVal, newValue: newVal });
    }
  }
  return changes;
}

function projectDataFromApi(project: any): any {
  if (project.address && typeof project.address === 'object' && project.address.street !== undefined) {
    return {
      procoreId: String(project.id),
      name: project.name || null,
      displayName: project.name || null,
      projectNumber: null,
      address: project.address?.street || null,
      city: project.address?.city || null,
      stateCode: project.address?.state_code || null,
      zip: project.address?.zip || null,
      countryCode: project.address?.country_code || null,
      phone: null,
      active: project.status_name !== 'Inactive' ? true : false,
      stage: null,
      projectStageName: project.stage_name || null,
      startDate: null,
      completionDate: null,
      projectedFinishDate: null,
      estimatedValue: null,
      totalValue: null,
      storeNumber: null,
      deliveryMethod: null,
      workScope: null,
      companyId: null,
      companyName: null,
      properties: project,
      procoreUpdatedAt: null,
    };
  }
  return {
    procoreId: String(project.id),
    name: project.name || null,
    displayName: project.display_name || null,
    projectNumber: project.project_number || null,
    address: project.address || null,
    city: project.city || null,
    stateCode: project.state_code || null,
    zip: project.zip || null,
    countryCode: project.country_code || null,
    phone: project.phone || null,
    active: project.active ?? null,
    stage: project.stage || null,
    projectStageName: project.project_stage?.name || null,
    startDate: project.start_date || null,
    completionDate: project.completion_date || null,
    projectedFinishDate: project.projected_finish_date || null,
    estimatedValue: project.estimated_value ? String(project.estimated_value) : null,
    totalValue: project.total_value ? String(project.total_value) : null,
    storeNumber: project.store_number || null,
    deliveryMethod: project.delivery_method || null,
    workScope: project.work_scope || null,
    companyId: project.company?.id ? String(project.company.id) : null,
    companyName: project.company?.name || null,
    properties: project,
    procoreUpdatedAt: project.updated_at ? new Date(project.updated_at) : null,
  };
}

type RoleSyncProjectEntry = {
  procoreId: string;
  name: string;
  lastRoleCheckAt?: Date | null;
  procoreUpdatedAt?: Date | null;
  active?: boolean | null;
};

async function resolveRoleSyncProjectEntry(projectId: string): Promise<RoleSyncProjectEntry | null> {
  const existing = await storage.getProcoreProjectByProcoreId(projectId);
  if (existing) {
    return {
      procoreId: existing.procoreId,
      name: existing.name || '',
      lastRoleCheckAt: existing.lastRoleCheckAt,
      procoreUpdatedAt: existing.procoreUpdatedAt ?? null,
      active: existing.active,
    };
  }

  try {
    const detail = await fetchProcoreProjectDetail(projectId);
    const data = projectDataFromApi(detail);
    await storage.upsertProcoreProject(data);
    return {
      procoreId: data.procoreId,
      name: data.name || '',
      lastRoleCheckAt: data.lastRoleCheckAt ?? null,
      procoreUpdatedAt: data.procoreUpdatedAt ?? null,
      active: data.active ?? null,
    };
  } catch (err: any) {
    if (err.message?.includes('403') || err.message?.includes('404')) {
      return null;
    }
    throw err;
  }
}

export function collectMappedRoleSyncProjectIds(
  mappings: Array<{
    portfolioProjectId?: string | null;
    procoreProjectId?: string | null;
    bidboardProjectId?: string | null;
    projectPhase?: string | null;
  }>
): string[] {
  const ids = new Set<string>();
  for (const mapping of mappings) {
    const portfolioId = String(mapping.portfolioProjectId || '').trim();
    const legacyProcoreId = String(mapping.procoreProjectId || '').trim();
    const bidboardId = String(mapping.bidboardProjectId || '').trim();

    if (portfolioId) {
      ids.add(portfolioId);
      continue;
    }

    if (
      legacyProcoreId &&
      legacyProcoreId !== bidboardId &&
      String(mapping.projectPhase || '').trim().toLowerCase() !== 'bidboard'
    ) {
      ids.add(legacyProcoreId);
    }
  }
  return Array.from(ids);
}

export async function mergeMappedRoleSyncProjects(
  existingProjects: Map<string, RoleSyncProjectEntry>,
  mappings: Array<{
    portfolioProjectId?: string | null;
    procoreProjectId?: string | null;
    bidboardProjectId?: string | null;
    projectPhase?: string | null;
  }>,
  resolver: (projectId: string) => Promise<RoleSyncProjectEntry | null> = resolveRoleSyncProjectEntry
): Promise<Map<string, RoleSyncProjectEntry>> {
  for (const pid of collectMappedRoleSyncProjectIds(mappings)) {
    if (existingProjects.has(pid)) continue;
    const project = await resolver(pid);
    if (project) existingProjects.set(pid, project);
  }
  return existingProjects;
}

// Export helper functions for external use (e.g., procore-documents.ts)
export async function getCompanyId(): Promise<string> {
  const config = await getProcoreConfig();
  return config.companyId;
}

/** For debug endpoints: returns raw auth used by working Procore calls */
export async function getProcoreAuthForDebug(): Promise<{
  accessToken: string;
  companyId: string;
  baseUrl: string;
  environment: string;
}> {
  const accessToken = await getAccessToken();
  const config = await getProcoreConfig();
  const baseUrl = getBaseUrl(config.environment);
  return {
    accessToken,
    companyId: config.companyId,
    baseUrl,
    environment: config.environment,
  };
}

export async function getProcoreClient(): Promise<{
  get: (endpoint: string, options?: { params?: Record<string, any>; responseType?: string }) => Promise<{ data: any; headers?: any }>;
}> {
  const accessToken = await getAccessToken();
  const config = await getProcoreConfig();
  const baseUrl = getBaseUrl(config.environment);
  const companyId = config.companyId;

  return {
    async get(endpoint: string, options?: { params?: Record<string, any>; responseType?: string }) {
      // Handle both full URLs and relative endpoints
      const isFullUrl = endpoint.startsWith('http://') || endpoint.startsWith('https://');
      const url = isFullUrl ? new URL(endpoint) : new URL(`${baseUrl}${endpoint}`);
      
      // Add query params
      if (options?.params) {
        for (const [key, value] of Object.entries(options.params)) {
          if (value !== undefined && value !== null) {
            url.searchParams.set(key, String(value));
          }
        }
      }

      await acquireRateLimitToken();
      const response = await fetchWithTimeout(url.toString(), {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json',
          'Procore-Company-Id': companyId,
        },
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Procore API error ${response.status}: ${errText}`);
      }

      // Handle different response types
      if (options?.responseType === 'arraybuffer') {
        const buffer = await response.arrayBuffer();
        return { data: Buffer.from(buffer), headers: Object.fromEntries(response.headers.entries()) };
      }

      const data = await response.json();
      return { data, headers: Object.fromEntries(response.headers.entries()) };
    },
  };
}

export async function syncProcoreProjects(): Promise<{ synced: number; created: number; updated: number; changes: number; stageChanges: Array<{ procoreId: string; projectName: string; oldStage: string; newStage: string }>; skippedWebhookUpdated?: number }> {
  const config = await getProcoreConfig();
  const companyId = config.companyId;

  // ── Incremental sync: only fetch projects modified since last sync ──────────
  const FULL_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
  let updatedAtFilter: string | null = null;
  let isIncrementalSync = false;

  try {
    const lastSyncConfig = await storage.getAutomationConfig("procore_last_sync_at");
    const lastSyncAt = lastSyncConfig?.value as string | null | undefined;
    if (lastSyncAt) {
      const lastSyncMs = new Date(lastSyncAt).getTime();
      const ageMs = Date.now() - lastSyncMs;
      if (ageMs < FULL_SYNC_INTERVAL_MS) {
        updatedAtFilter = lastSyncAt;
        isIncrementalSync = true;
        console.log(`[procore] Incremental sync — fetching projects updated since ${lastSyncAt}`);
      } else {
        console.log(`[procore] Full sync — last sync was ${Math.round(ageMs / 3600000)}h ago (>24h threshold)`);
      }
    } else {
      console.log(`[procore] Full sync — no previous sync timestamp found`);
    }
  } catch (e: any) {
    console.warn(`[procore] Could not read last sync timestamp, falling back to full sync: ${e.message}`);
  }

  // Record the sync start time before fetching so we don't miss updates that happen mid-sync
  const syncStartedAt = new Date().toISOString();

  const companyProjectsEndpoint = updatedAtFilter
    ? `/rest/v1.0/companies/${companyId}/projects?per_page=500&active=true&updated_at=${encodeURIComponent(updatedAtFilter)}`
    : `/rest/v1.0/companies/${companyId}/projects?per_page=500&active=true`;

  const companyProjects = await fetchProcoreJson(companyProjectsEndpoint, companyId) as any[];
  console.log(`[procore] Company-level projects (active only): ${companyProjects.length}${isIncrementalSync ? ' (incremental)' : ''}`);

  const detailedEndpoint = updatedAtFilter
    ? `/rest/v1.0/projects?company_id=${companyId}&active=true&updated_at=${encodeURIComponent(updatedAtFilter)}`
    : `/rest/v1.0/projects?company_id=${companyId}&active=true`;

  const detailedProjects = await fetchProcorePages<any>(detailedEndpoint, companyId);
  console.log(`[procore] Detailed projects (user-level): ${detailedProjects.length}${isIncrementalSync ? ' (incremental)' : ''}`);

  const detailedMap = new Map<string, any>();
  for (const p of detailedProjects) {
    detailedMap.set(String(p.id), p);
  }

  let created = 0, updated = 0, changes = 0, skippedWebhookUpdated = 0;
  const stageChanges: Array<{ procoreId: string; projectName: string; oldStage: string; newStage: string }> = [];

  for (const project of companyProjects) {
    const procoreId = String(project.id);

    // Skip projects already handled by webhook in this polling interval
    if (wasProjectWebhookUpdated(procoreId)) {
      skippedWebhookUpdated++;
      continue;
    }

    const existing = await storage.getProcoreProjectByProcoreId(procoreId);
    const detailed = detailedMap.get(procoreId);
    const source = detailed || project;
    const data = projectDataFromApi(source);

    const trackFields = ['name', 'displayName', 'projectNumber', 'address', 'city', 'stateCode', 'zip', 'phone', 'active', 'stage', 'projectStageName', 'startDate', 'completionDate', 'projectedFinishDate', 'estimatedValue', 'totalValue', 'deliveryMethod', 'companyName'];

    if (existing) {
      const changedFields = detectChanges(existing, data, trackFields);
      for (const change of changedFields) {
        await storage.createProcoreChangeHistory({
          entityType: 'project',
          entityProcoreId: procoreId,
          changeType: 'field_update',
          fieldName: change.field,
          oldValue: change.oldValue,
          newValue: change.newValue,
          fullSnapshot: source,
          syncedAt: new Date(),
        });
        changes++;
        if (change.field === 'stage' || change.field === 'projectStageName') {
          // Skip same-stage "changes" — webhook can fire without an actual stage transition
          if (change.oldValue?.trim() === change.newValue?.trim()) continue;
          stageChanges.push({
            procoreId,
            projectName: data.name || 'Unknown',
            oldStage: change.oldValue,
            newStage: change.newValue,
          });
        }
      }
      if (changedFields.length > 0) updated++;
    } else {
      await storage.createProcoreChangeHistory({
        entityType: 'project',
        entityProcoreId: procoreId,
        changeType: 'created',
        fullSnapshot: source,
        syncedAt: new Date(),
      });
      created++;
      changes++;
    }

    await storage.upsertProcoreProject(data);
  }

  // Save sync timestamp and clear webhook-updated set after cycle completes
  try {
    await storage.upsertAutomationConfig({
      key: "procore_last_sync_at",
      value: syncStartedAt,
      description: "Timestamp of last successful Procore project sync (used for incremental sync filter)",
    });
  } catch (e: any) {
    console.warn(`[procore] Could not save last sync timestamp: ${e.message}`);
  }
  clearWebhookUpdatedProjects();

  if (skippedWebhookUpdated > 0) {
    console.log(`[procore] Skipped ${skippedWebhookUpdated} projects already updated via webhook this cycle`);
  }

  return { synced: companyProjects.length, created, updated, changes, stageChanges, skippedWebhookUpdated };
}

export async function syncProcoreVendors(): Promise<{ synced: number; created: number; updated: number; changes: number }> {
  const config = await getProcoreConfig();
  const companyId = config.companyId;

  const allVendors = await fetchProcorePages<any>(
    `/rest/v1.0/vendors?company_id=${companyId}`,
    companyId
  );

  let created = 0, updated = 0, changes = 0;

  for (const vendor of allVendors) {
    const procoreId = String(vendor.id);
    const existing = await storage.getProcoreVendorByProcoreId(procoreId);

    const data = {
      procoreId,
      name: vendor.name || null,
      abbreviatedName: vendor.abbreviated_name || null,
      address: vendor.address || null,
      city: vendor.city || null,
      stateCode: vendor.state_code || null,
      zip: vendor.zip || null,
      countryCode: vendor.country_code || null,
      emailAddress: vendor.email_address || null,
      businessPhone: vendor.business_phone || null,
      mobilePhone: vendor.mobile_phone || null,
      faxNumber: vendor.fax_number || null,
      website: vendor.website || null,
      legalName: vendor.legal_name || null,
      licenseNumber: vendor.license_number || null,
      isActive: vendor.is_active ?? null,
      tradeName: vendor.trade_name || null,
      laborUnion: vendor.labor_union || null,
      contactCount: vendor.contact_count ?? null,
      childrenCount: vendor.children_count ?? null,
      notes: vendor.notes || null,
      companyId: companyId,
      properties: vendor,
      procoreUpdatedAt: vendor.updated_at ? new Date(vendor.updated_at) : null,
    };

    const trackFields = ['name', 'abbreviatedName', 'address', 'city', 'stateCode', 'zip', 'emailAddress', 'businessPhone', 'mobilePhone', 'website', 'legalName', 'licenseNumber', 'isActive', 'tradeName', 'laborUnion'];

    if (existing) {
      const changedFields = detectChanges(existing, data, trackFields);
      for (const change of changedFields) {
        await storage.createProcoreChangeHistory({
          entityType: 'vendor',
          entityProcoreId: procoreId,
          changeType: 'field_update',
          fieldName: change.field,
          oldValue: change.oldValue,
          newValue: change.newValue,
          fullSnapshot: vendor,
          syncedAt: new Date(),
        });
        changes++;
      }
      if (changedFields.length > 0) updated++;
    } else {
      await storage.createProcoreChangeHistory({
        entityType: 'vendor',
        entityProcoreId: procoreId,
        changeType: 'created',
        fullSnapshot: vendor,
        syncedAt: new Date(),
      });
      created++;
      changes++;
    }

    await storage.upsertProcoreVendor(data);
  }

  return { synced: allVendors.length, created, updated, changes };
}

export async function syncProcoreUsers(): Promise<{ synced: number; created: number; updated: number; changes: number }> {
  const config = await getProcoreConfig();
  const companyId = config.companyId;

  const allUsers = await fetchProcorePages<any>(
    `/rest/v1.0/companies/${companyId}/users`,
    companyId
  );

  let created = 0, updated = 0, changes = 0;

  for (const user of allUsers) {
    const procoreId = String(user.id);
    const existing = await storage.getProcoreUserByProcoreId(procoreId);

    const data = {
      procoreId,
      name: user.name || null,
      firstName: user.first_name || null,
      lastName: user.last_name || null,
      emailAddress: user.email_address || null,
      jobTitle: user.job_title || null,
      businessPhone: user.business_phone || null,
      mobilePhone: user.mobile_phone || null,
      address: user.address || null,
      city: user.city || null,
      stateCode: user.state_code || null,
      zip: user.zip || null,
      countryCode: user.country_code || null,
      isActive: user.is_active ?? null,
      isEmployee: user.is_employee ?? null,
      lastLoginAt: user.last_login_at || null,
      employeeId: user.employee_id ? String(user.employee_id) : null,
      vendorId: user.vendor?.id ? String(user.vendor.id) : null,
      vendorName: user.vendor?.name || null,
      companyId: companyId,
      properties: user,
      procoreUpdatedAt: user.updated_at ? new Date(user.updated_at) : null,
    };

    const trackFields = ['name', 'firstName', 'lastName', 'emailAddress', 'jobTitle', 'businessPhone', 'mobilePhone', 'address', 'city', 'stateCode', 'zip', 'isActive', 'isEmployee', 'vendorName'];

    if (existing) {
      const changedFields = detectChanges(existing, data, trackFields);
      for (const change of changedFields) {
        await storage.createProcoreChangeHistory({
          entityType: 'user',
          entityProcoreId: procoreId,
          changeType: 'field_update',
          fieldName: change.field,
          oldValue: change.oldValue,
          newValue: change.newValue,
          fullSnapshot: user,
          syncedAt: new Date(),
        });
        changes++;
      }
      if (changedFields.length > 0) updated++;
    } else {
      await storage.createProcoreChangeHistory({
        entityType: 'user',
        entityProcoreId: procoreId,
        changeType: 'created',
        fullSnapshot: user,
        syncedAt: new Date(),
      });
      created++;
      changes++;
    }

    await storage.upsertProcoreUser(data);
  }

  return { synced: allUsers.length, created, updated, changes };
}

/**
 * Fetch and sync a single Procore user by ID.
 * Called by webhook handlers for real-time user updates.
 * Uses upsert to handle both create and update cases.
 */
export async function syncSingleProcoreUser(userId: string): Promise<{ success: boolean; action: 'created' | 'updated' | 'deleted' | 'error'; error?: string }> {
  try {
    const config = await getProcoreConfig();
    const companyId = config.companyId;
    const client = await getProcoreClient();
    
    let user;
    try {
      const response = await client.get(`/rest/v1.0/companies/${companyId}/users/${userId}`);
      user = response.data;
    } catch (fetchErr: any) {
      if (fetchErr.message?.includes('404')) {
        await storage.deleteProcoreUser(userId);
        console.log(`[procore] User ${userId} deleted (not found in Procore)`);
        return { success: true, action: 'deleted' };
      }
      throw fetchErr;
    }
    
    const procoreId = String(user.id);
    const existing = await storage.getProcoreUserByProcoreId(procoreId);
    
    const data = {
      procoreId,
      name: user.name || null,
      firstName: user.first_name || null,
      lastName: user.last_name || null,
      emailAddress: user.email_address || null,
      jobTitle: user.job_title || null,
      businessPhone: user.business_phone || null,
      mobilePhone: user.mobile_phone || null,
      address: user.address || null,
      city: user.city || null,
      stateCode: user.state_code || null,
      zip: user.zip || null,
      countryCode: user.country_code || null,
      isActive: user.is_active ?? null,
      isEmployee: user.is_employee ?? null,
      lastLoginAt: user.last_login_at || null,
      employeeId: user.employee_id ? String(user.employee_id) : null,
      vendorId: user.vendor?.id ? String(user.vendor.id) : null,
      vendorName: user.vendor?.name || null,
      companyId: companyId,
      properties: user,
      procoreUpdatedAt: user.updated_at ? new Date(user.updated_at) : null,
    };
    
    const action = existing ? 'updated' : 'created';
    const trackFields = ['name', 'firstName', 'lastName', 'emailAddress', 'jobTitle', 'businessPhone', 'mobilePhone', 'address', 'city', 'stateCode', 'zip', 'isActive', 'isEmployee', 'vendorName'];
    
    if (existing) {
      const changedFields = detectChanges(existing, data, trackFields);
      for (const change of changedFields) {
        await storage.createProcoreChangeHistory({
          entityType: 'user',
          entityProcoreId: procoreId,
          changeType: 'field_update',
          fieldName: change.field,
          oldValue: change.oldValue,
          newValue: change.newValue,
          fullSnapshot: user,
          syncedAt: new Date(),
        });
      }
    } else {
      await storage.createProcoreChangeHistory({
        entityType: 'user',
        entityProcoreId: procoreId,
        changeType: 'created',
        fullSnapshot: user,
        syncedAt: new Date(),
      });
    }
    
    await storage.upsertProcoreUser(data);
    console.log(`[procore] User ${procoreId} ${action} via webhook`);
    return { success: true, action };
  } catch (err: any) {
    console.error(`[procore] Failed to sync user ${userId}:`, err.message);
    return { success: false, action: 'error', error: err.message };
  }
}

async function fetchProcoreJson(endpoint: string, companyId: string, options?: { signal?: AbortSignal }): Promise<any> {
  const accessToken = await getAccessToken();
  const config = await getProcoreConfig();
  const baseUrl = getBaseUrl(config.environment);
  const url = `${baseUrl}${endpoint}`;
  await acquireRateLimitToken(); // Unified token bucket — all Procore calls share the same budget
  await applyBackpressure("procore");
  const response = await fetchWithTimeout(url, {
    signal: options?.signal,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
      'Procore-Company-Id': companyId,
    },
  });
  updateRateLimits("procore", response.headers);
  if (!response.ok) {
    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get('Retry-After') || '60', 10);
      console.warn(`[procore] 429 rate limited on ${endpoint}, waiting ${retryAfter}s`);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return fetchProcoreJson(endpoint, companyId, options); // Retry once
    }
    if (response.status === 401) throw new Error("Procore token expired or invalid.");
    const errText = await response.text();
    throw new Error(`Procore API error ${response.status}: ${errText}`);
  }
  return response.json();
}

/** Run async tasks in parallel with a concurrency limit. */
async function parallelWithLimit<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  async function worker(): Promise<void> {
    while (index < items.length) {
      const i = index++;
      try {
        results[i] = await fn(items[i]);
      } catch (err) {
        throw err;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) || 1 }, () => worker()));
  return results;
}

export async function fetchProcoreProjectStages(): Promise<any[]> {
  const config = await getProcoreConfig();
  const companyId = config.companyId;
  try {
    return await fetchProcoreJson(`/rest/v1.0/companies/${companyId}/project_stages`, companyId);
  } catch {
    const projects = await fetchProcoreJson(`/rest/v1.0/companies/${companyId}/projects?per_page=300`, companyId);
    const stageMap = new Map<number, string>();
    for (const p of projects) {
      if (p.project_stage?.id && p.project_stage?.name) {
        stageMap.set(p.project_stage.id, p.project_stage.name);
      }
    }
    return Array.from(stageMap.entries()).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }
}

export async function fetchProcoreProjectDetail(projectId: string): Promise<any> {
  const config = await getProcoreConfig();
  const companyId = config.companyId;
  return fetchProcoreJson(`/rest/v1.0/projects/${projectId}?company_id=${companyId}`, companyId);
}

export async function getProjectTeamMembers(projectId: string): Promise<Array<{
  name: string;
  email: string;
  role: string;
}>> {
  const config = await getProcoreConfig();
  const companyId = config.companyId;

  try {
    const raw = await fetchProcoreJson(
      `/rest/v1.0/project_roles?project_id=${projectId}&company_id=${companyId}&per_page=100`,
      companyId
    );
    const assignments = Array.isArray(raw) ? raw : (raw?.data ?? []);

    const teamMembers: Array<{ name: string; email: string; role: string }> = [];

    for (const assignment of assignments) {
      const roleName = assignment.role || 'Unknown Role';
      const assigneeId = assignment.user_id ? String(assignment.user_id) : (assignment.contact_id ? String(assignment.contact_id) : null);
      if (!assigneeId) continue;

      const nameParts = (assignment.name || '').split(' (');
      const assigneeName = nameParts[0] || '';
      let assigneeEmail = assignment.email_address || assignment.email || '';

      if (!assigneeEmail) {
        const user = await storage.getProcoreUserByProcoreId(assigneeId);
        assigneeEmail = user?.emailAddress || '';
      }

      teamMembers.push({
        name: assigneeName,
        email: assigneeEmail,
        role: roleName,
      });
    }

    return teamMembers;
  } catch (err: any) {
    console.error(`[procore] Error fetching team members for project ${projectId}:`, err.message);
    return [];
  }
}

export async function deactivateProject(projectId: string): Promise<boolean> {
  const accessToken = await getAccessToken();
  const config = await getProcoreConfig();
  const baseUrl = getBaseUrl(config.environment);
  const companyId = config.companyId;

  const response = await fetchWithTimeout(
    `${baseUrl}/rest/v1.0/projects/${projectId}?company_id=${companyId}`,
    {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Procore-Company-Id': companyId,
      },
      body: JSON.stringify({ project: { active: false } }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to deactivate project: ${response.status} ${errText}`);
  }

  console.log(`[procore] Project ${projectId} deactivated successfully`);
  return true;
}

export async function updateProcoreProject(
  projectId: string,
  fields: Record<string, any>
): Promise<any> {
  const accessToken = await getAccessToken();
  const config = await getProcoreConfig();
  const baseUrl = getBaseUrl(config.environment);
  const companyId = config.companyId;

  const body: any = { project: fields };

  const response = await fetchWithTimeout(
    `${baseUrl}/rest/v1.0/projects/${projectId}?company_id=${companyId}`,
    {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Procore-Company-Id': companyId,
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to update project: ${response.status} ${errText}`);
  }

  return response.json();
}

export async function updateProcoreBid(
  projectId: string,
  bidPackageId: string,
  bidId: string,
  fields: Record<string, any>
): Promise<any> {
  const accessToken = await getAccessToken();
  const config = await getProcoreConfig();
  const baseUrl = getBaseUrl(config.environment);
  const companyId = config.companyId;

  const response = await fetchWithTimeout(
    `${baseUrl}/rest/v1.0/projects/${projectId}/bid_packages/${bidPackageId}/bids/${bidId}`,
    {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Procore-Company-Id': companyId,
      },
      body: JSON.stringify({ bid: fields }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to update bid: ${response.status} ${errText}`);
  }

  return response.json();
}

export async function fetchProcoreBidDetail(
  projectId: string,
  bidPackageId: string,
  bidId: string
): Promise<any> {
  const config = await getProcoreConfig();
  const companyId = config.companyId;
  return fetchProcoreJson(
    `/rest/v1.0/projects/${projectId}/bid_packages/${bidPackageId}/bids/${bidId}`,
    companyId
  );
}

export async function proxyProcoreAttachment(url: string): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
  const response = await fetchWithTimeout(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Failed to fetch attachment: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const disposition = response.headers.get('content-disposition') || '';
  const filenameMatch = disposition.match(/filename="?([^";\n]+)"?/);
  const filename = filenameMatch?.[1] || 'attachment';
  return { buffer, contentType, filename };
}

export async function syncProcoreBidBoard(): Promise<{ bidPackages: number; bids: number; bidForms: number }> {
  const config = await getProcoreConfig();
  const companyId = config.companyId;

  const bidPackagesResp = await fetchProcoreJson(
    `/rest/v1.0/companies/${companyId}/bid_packages?per_page=100`,
    companyId
  );
  const allPackages = bidPackagesResp.bidPackages || bidPackagesResp || [];
  console.log(`Bid Board: fetched ${allPackages.length} bid packages`);

  let totalBids = 0;
  let totalForms = 0;

  const projectBidMap: Record<string, string[]> = {};
  for (const pkg of allPackages) {
    const projId = String(pkg.project_id);
    if (!projectBidMap[projId]) projectBidMap[projId] = [];
    projectBidMap[projId].push(String(pkg.id));
  }

  for (const pkg of allPackages) {
    const procoreId = String(pkg.id);
    await storage.upsertProcoreBidPackage({
      procoreId,
      projectId: pkg.project_id ? String(pkg.project_id) : null,
      projectName: pkg.project_name || null,
      projectLocation: pkg.project_location || null,
      title: pkg.title || null,
      number: pkg.number ?? null,
      bidDueDate: pkg.bid_due_date || null,
      formattedBidDueDate: pkg.formatted_bid_due_date || null,
      accountingMethod: pkg.accounting_method || null,
      open: pkg.open ?? null,
      hidden: pkg.hidden ?? null,
      sealed: pkg.sealed ?? null,
      hasBidDocs: pkg.has_bid_docs ?? null,
      acceptPostDueSubmissions: pkg.accept_post_due_submissions ?? null,
      allowBidderSum: pkg.allow_bidder_sum ?? null,
      enablePrebidWalkthrough: pkg.enable_prebid_walkthrough ?? null,
      enablePrebidRfiDeadline: pkg.enable_prebid_rfi_deadline ?? null,
      preBidRfiDeadlineDate: pkg.pre_bid_rfi_deadline_date || null,
      bidInvitesSentCount: pkg.bid_invites_sent_count ?? null,
      bidsReceivedCount: pkg.bids_received_count ?? null,
      bidEmailMessage: pkg.formatted_bid_email_message || null,
      bidWebMessage: pkg.formatted_bid_web_message || null,
      companyId: companyId,
      properties: pkg,
    });

    await storage.createProcoreChangeHistory({
      entityType: 'bid_package',
      entityProcoreId: procoreId,
      changeType: 'synced',
      fullSnapshot: pkg,
      syncedAt: new Date(),
    });
  }

  for (const [projId, pkgIds] of Object.entries(projectBidMap)) {
    for (const pkgId of pkgIds) {
      try {
        const bids = await fetchProcoreJson(
          `/rest/v1.0/projects/${projId}/bid_packages/${pkgId}/bids?per_page=100`,
          companyId
        );
        if (Array.isArray(bids)) {
          for (const bid of bids) {
            await storage.upsertProcoreBid({
              procoreId: String(bid.id),
              bidPackageId: bid.bid_package_id ? String(bid.bid_package_id) : null,
              bidPackageTitle: bid.bid_package_title || null,
              bidFormId: bid.bid_form_id ? String(bid.bid_form_id) : null,
              bidFormTitle: bid.bid_form_title || null,
              projectId: projId,
              projectName: bid.project?.name || null,
              projectAddress: bid.project?.address || null,
              vendorId: bid.vendor?.id ? String(bid.vendor.id) : null,
              vendorName: bid.vendor?.name || null,
              vendorTrades: bid.vendor?.trades || null,
              bidStatus: bid.bid_status || null,
              awarded: bid.awarded ?? null,
              submitted: bid.submitted ?? null,
              isBidderCommitted: bid.is_bidder_committed ?? null,
              lumpSumEnabled: bid.lump_sum_enabled ?? null,
              lumpSumAmount: bid.lump_sum_amount != null ? String(bid.lump_sum_amount) : null,
              bidderComments: bid.bidder_comments || null,
              dueDate: bid.due_date || null,
              invitationLastSentAt: bid.invitation_last_sent_at || null,
              bidRequesterName: bid.bid_requester ? `${bid.bid_requester.first_name || ''} ${bid.bid_requester.last_name || ''}`.trim() : null,
              bidRequesterEmail: bid.bid_requester?.email_address || null,
              bidRequesterCompany: bid.bid_requester?.company || null,
              requireNda: bid.require_nda ?? null,
              ndaStatus: bid.nda_status || null,
              showBidInEstimating: bid.show_bid_in_estimating ?? null,
              companyId: companyId,
              properties: bid,
              procoreCreatedAt: bid.created_at || null,
              procoreUpdatedAt: bid.updated_at || null,
            });
            totalBids++;
          }
        }
      } catch (e: any) {
        console.error(`Error fetching bids for project ${projId}/package ${pkgId}: ${e.message}`);
      }

      try {
        const forms = await fetchProcoreJson(
          `/rest/v1.0/projects/${projId}/bid_packages/${pkgId}/bid_forms?per_page=100`,
          companyId
        );
        if (Array.isArray(forms)) {
          for (const form of forms) {
            await storage.upsertProcoreBidForm({
              procoreId: String(form.id),
              bidPackageId: pkgId,
              projectId: projId,
              title: form.title || null,
              proposalId: form.proposal_id ? String(form.proposal_id) : null,
              proposalName: form.proposal_name || null,
              companyId: companyId,
              properties: form,
            });
            totalForms++;
          }
        }
      } catch (e: any) {
        console.error(`Error fetching bid forms for project ${projId}/package ${pkgId}: ${e.message}`);
      }
    }
  }

  console.log(`Bid Board sync complete: ${allPackages.length} packages, ${totalBids} bids, ${totalForms} forms`);
  return { bidPackages: allPackages.length, bids: totalBids, bidForms: totalForms };
}

// Mutex to prevent concurrent role assignment syncs
let roleAssignmentSyncInProgress = false;
const roleAssignmentSyncQueue: string[] = [];

// First sync after deploy: treat as baseline — don't report assignments as "new"
// to avoid spam when the role_assignments table gets truncated by db:push
let isFirstRoleSyncAfterStartup = true;

export async function syncProcoreRoleAssignments(projectIds?: string[], opts?: { fullSync?: boolean }): Promise<{ synced: number; newAssignments: Array<{ procoreProjectId: string; projectName: string; roleName: string; assigneeId: string; assigneeName: string; assigneeEmail: string; assigneeCompany: string }>; skipped?: boolean }> {
  // Prevent concurrent syncs to avoid duplicate emails.
  // Exception: if projectIds is explicitly provided (webhook-triggered single-project check),
  // bypass the mutex so it doesn't get dropped when a batch poll is running.
  if (roleAssignmentSyncInProgress && (!projectIds || projectIds.length === 0)) {
    console.log('[procore] Role assignment sync already in progress, skipping to prevent duplicates');
    return { synced: 0, newAssignments: [], skipped: true };
  }

  roleAssignmentSyncInProgress = true;
  const suppressNewAssignments = isFirstRoleSyncAfterStartup && !projectIds;

  try {
    const result = await performRoleAssignmentSync(projectIds, opts?.fullSync ?? false);

    if (suppressNewAssignments && result.newAssignments.length > 0) {
      console.log(`[procore] First sync after startup — suppressing ${result.newAssignments.length} "new" assignments (baseline sync, not real changes)`);
      result.newAssignments = [];
    }

    return result;
  } finally {
    roleAssignmentSyncInProgress = false;
    if (!projectIds) isFirstRoleSyncAfterStartup = false;
  }
}

const ROLE_SYNC_CONCURRENCY = 3; // Reduced from 5 to avoid rate limit bursts when multiple pollers run
const ROLE_SYNC_PER_REQUEST_TIMEOUT_MS = 10000; // 10s per API call

async function performRoleAssignmentSync(projectIds?: string[], fullSync: boolean = false): Promise<{ synced: number; newAssignments: Array<{ procoreProjectId: string; projectName: string; roleName: string; assigneeId: string; assigneeName: string; assigneeEmail: string; assigneeCompany: string }> }> {
  const config = await getProcoreConfig();
  const companyId = config.companyId;

  type ProjectEntry = RoleSyncProjectEntry;
  let projectsToSync: ProjectEntry[] = [];

  if (projectIds && projectIds.length > 0) {
    // Explicit project IDs always sync (webhooks, closeout automation)
    for (const pid of projectIds) {
      const p = await resolveRoleSyncProjectEntry(pid);
      if (p) projectsToSync.push(p);
    }
  } else {
    const { data: allProjects } = await storage.getProcoreProjects({ limit: 10000 });

    type ProjectMeta = { procoreId: string; name: string; lastRoleCheckAt?: Date | null; procoreUpdatedAt?: Date | null; active?: boolean | null };
    const allWithMeta: ProjectMeta[] = allProjects.map(p => ({
      procoreId: p.procoreId,
      name: p.name || '',
      lastRoleCheckAt: p.lastRoleCheckAt,
      procoreUpdatedAt: p.procoreUpdatedAt ?? null,
      active: p.active,
    }));

    // Also include any projects referenced in sync mappings that aren't in the main list
    const byId = new Map(allWithMeta.map(p => [p.procoreId, p]));
    const mappings = await storage.getSyncMappings();
    await mergeMappedRoleSyncProjects(byId, mappings);
    const allProjectsMeta = Array.from(byId.values());

    if (fullSync) {
      // Full sync: all projects regardless of active status or last check time
      projectsToSync = allProjectsMeta.map(p => ({ procoreId: p.procoreId, name: p.name }));
    } else {
      // Incremental sync: recently updated active projects + any project (active or not) overdue for stale check
      const now = new Date();
      const cutoff24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const cutoff7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const seenIds = new Set<string>();
      const recentlyUpdated: ProjectMeta[] = [];
      const staleRoleCheck: ProjectMeta[] = [];
      let skippedInactive = 0;

      for (const p of allProjectsMeta) {
        // Recently updated active projects
        if (p.active !== false && p.procoreUpdatedAt && p.procoreUpdatedAt >= cutoff24h) {
          recentlyUpdated.push(p);
          seenIds.add(p.procoreId);
        }
      }

      for (const p of allProjectsMeta) {
        // Projects not checked in 7+ days (regardless of active status — we never want to miss an assignment)
        const isStale = !p.lastRoleCheckAt || p.lastRoleCheckAt < cutoff7d;
        if (isStale && !seenIds.has(p.procoreId)) {
          staleRoleCheck.push(p);
          seenIds.add(p.procoreId);
        } else if (!seenIds.has(p.procoreId) && p.active === false) {
          // Inactive, up-to-date — skipped entirely
          skippedInactive++;
        }
      }

      projectsToSync = [...recentlyUpdated, ...staleRoleCheck].map(p => ({ procoreId: p.procoreId, name: p.name }));
      console.log(`[procore] Role sync: ${recentlyUpdated.length} recently updated + ${staleRoleCheck.length} stale check = ${projectsToSync.length} total (skipped ${skippedInactive} inactive up-to-date)`);
    }
  }

  console.log(`[procore] Syncing role assignments for ${projectsToSync.length} projects (${ROLE_SYNC_CONCURRENCY} concurrent)...`);
  let synced = 0;
  const newAssignments: Array<{ procoreProjectId: string; projectName: string; roleName: string; assigneeId: string; assigneeName: string; assigneeEmail: string; assigneeCompany: string }> = [];

  async function processProject(project: ProjectEntry): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ROLE_SYNC_PER_REQUEST_TIMEOUT_MS);
    try {
      let raw: any;
      try {
        raw = await fetchProcoreJson(
          `/rest/v1.0/project_roles?project_id=${project.procoreId}&company_id=${companyId}&per_page=100`,
          companyId,
          { signal: controller.signal }
        );
      } catch (rateErr: any) {
        clearTimeout(timeout);
        if (rateErr.message?.includes('429')) {
          console.log('[procore] Rate limited (429), waiting 60s before retrying project', project.procoreId);
          await new Promise(r => setTimeout(r, 60000));
          const c2 = new AbortController();
          const t2 = setTimeout(() => c2.abort(), ROLE_SYNC_PER_REQUEST_TIMEOUT_MS);
          raw = await fetchProcoreJson(
            `/rest/v1.0/project_roles?project_id=${project.procoreId}&company_id=${companyId}&per_page=100`,
            companyId,
            { signal: c2.signal }
          );
          clearTimeout(t2);
        } else if (rateErr.name === 'AbortError') {
          console.warn(`[procore] Timeout fetching roles for project ${project.procoreId}, skipping`);
          return;
        } else {
          throw rateErr;
        }
      }
      clearTimeout(timeout);
      const assignments = Array.isArray(raw) ? raw : (raw?.data ?? []);

      const existingAssignments = await storage.getProcoreRoleAssignmentsByProject(project.procoreId);
      const existingKeys = new Set(existingAssignments.map(a => `${a.roleName}||${a.assigneeId}`));

      for (const assignment of assignments) {
        const roleName = assignment.role || 'Unknown Role';
        const assigneeId = assignment.user_id ? String(assignment.user_id) : (assignment.contact_id ? String(assignment.contact_id) : null);
        if (!assigneeId) continue;
        const nameParts = (assignment.name || '').split(' (');
        const assigneeName = nameParts[0] || '';
        const assigneeCompany = nameParts[1] ? nameParts[1].replace(')', '') : '';
        let assigneeEmail = assignment.email_address || assignment.email || '';
        if (!assigneeEmail) {
          const user = await storage.getProcoreUserByProcoreId(assigneeId);
          assigneeEmail = user?.emailAddress || '';
        }

        const isNew = !existingKeys.has(`${roleName}||${assigneeId}`);

        await storage.upsertProcoreRoleAssignment({
          procoreProjectId: project.procoreId,
          projectName: project.name,
          roleId: assignment.id ? String(assignment.id) : null,
          roleName,
          assigneeId,
          assigneeName,
          assigneeEmail,
          assigneeCompany,
          properties: assignment,
          lastSyncedAt: new Date(),
        });

        if (isNew) {
          // Double-check email send log — if already notified, don't report as new
          // (survives role_assignments table truncation on deploy)
          const emailDedupeKey = `role_assignment:${project.procoreId}:${roleName}:${assigneeId}`;
          const alreadyNotified = await storage.checkEmailDedupeKey(emailDedupeKey);
          if (!alreadyNotified) {
            newAssignments.push({
              procoreProjectId: project.procoreId,
              projectName: project.name,
              roleName,
              assigneeId,
              assigneeName,
              assigneeEmail,
              assigneeCompany,
            });
          }
        }

        synced++;
      }
      await storage.updateProcoreProjectLastRoleCheck(project.procoreId);
    } catch (err: any) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        console.warn(`[procore] Timeout fetching roles for project ${project.procoreId}, skipping`);
        return;
      }
      if (err.message?.includes('403') || err.message?.includes('404')) {
        return;
      }
      throw err;
    }
  }

  await parallelWithLimit(projectsToSync, async (project) => {
    try {
      await processProject(project);
    } catch (err: any) {
      console.error(`[procore] Error fetching role assignments for project ${project.procoreId}:`, err.message);
    }
  }, ROLE_SYNC_CONCURRENCY);

  console.log(`[procore] Synced ${synced} role assignments, ${newAssignments.length} new assignments`);
  return { synced, newAssignments };
}

const ROLE_SYNC_BATCH_DELAY_MS = 200; // Smooth API rate between projects

export async function syncProcoreRoleAssignmentsBatch(
  batchSize: number,
  cursor: number
): Promise<{
  synced: number;
  newAssignments: Array<{
    procoreProjectId: string;
    projectName: string;
    roleName: string;
    assigneeId: string;
    assigneeName: string;
    assigneeEmail: string;
    assigneeCompany: string;
  }>;
  nextCursor: number;
  totalProjects: number;
  batchProcessed: number;
  skipped?: boolean;
}> {
  if (roleAssignmentSyncInProgress) {
    console.log('[procore] Role assignment sync already in progress, skipping batch');
    return {
      synced: 0,
      newAssignments: [],
      nextCursor: cursor,
      totalProjects: 0,
      batchProcessed: 0,
      skipped: true,
    };
  }

  roleAssignmentSyncInProgress = true;

  try {
    const config = await getProcoreConfig();
    const companyId = config.companyId;

    type ProjectEntry = RoleSyncProjectEntry;
    const { data: allProjects } = await storage.getProcoreProjects({ limit: 10000 });
    const activeWithMeta = allProjects
      .filter(p => p.active !== false)
      .map(p => ({
        procoreId: p.procoreId,
        name: p.name || '',
        lastRoleCheckAt: p.lastRoleCheckAt,
        procoreUpdatedAt: p.procoreUpdatedAt ?? null,
      }));
    const byId = new Map(activeWithMeta.map(p => [p.procoreId, p]));
    const mappings = await storage.getSyncMappings();
    await mergeMappedRoleSyncProjects(byId, mappings);
    const fullList: ProjectEntry[] = Array.from(byId.values())
      .map(p => ({ procoreId: p.procoreId, name: p.name }))
      .sort((a, b) => String(a.procoreId).localeCompare(String(b.procoreId), undefined, { numeric: true }));

    const totalProjects = fullList.length;
    if (totalProjects === 0) {
      return {
        synced: 0,
        newAssignments: [],
        nextCursor: 0,
        totalProjects: 0,
        batchProcessed: 0,
      };
    }

    // Prioritize webhook-updated projects: put them at the front of the batch
    const priorityIds = fullList
      .map(p => p.procoreId)
      .filter(id => wasProjectWebhookUpdated(id));
    const priorityProjects = priorityIds
      .map(id => fullList.find(p => p.procoreId === id)!)
      .filter(Boolean);
    const priorityIdSet = new Set(priorityIds);

    const effectiveCursor = cursor >= totalProjects ? 0 : cursor;
    const cursorSlice = fullList
      .slice(effectiveCursor, effectiveCursor + batchSize)
      .filter(p => !priorityIdSet.has(p.procoreId));

    const batch = [...priorityProjects, ...cursorSlice].slice(0, batchSize);
    const batchProcessed = batch.length;

    if (priorityProjects.length > 0) {
      console.log(`[procore] Batch includes ${priorityProjects.length} webhook-priority project(s): ${priorityIds.join(', ')}`);
    }

    if (batchProcessed === 0) {
      return {
        synced: 0,
        newAssignments: [],
        nextCursor: 0,
        totalProjects,
        batchProcessed: 0,
      };
    }

    const batchNum = Math.floor(effectiveCursor / batchSize) + 1;
    const totalBatches = Math.ceil(totalProjects / batchSize);
    console.log(`[procore] Syncing role assignments for ${batchProcessed} projects (batch ${batchNum}/${totalBatches}, cursor ${effectiveCursor})...`);

    let synced = 0;
    const newAssignments: Array<{
      procoreProjectId: string;
      projectName: string;
      roleName: string;
      assigneeId: string;
      assigneeName: string;
      assigneeEmail: string;
      assigneeCompany: string;
    }> = [];

    async function processProject(project: ProjectEntry): Promise<void> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), ROLE_SYNC_PER_REQUEST_TIMEOUT_MS);
      try {
        let raw: any;
        try {
          raw = await fetchProcoreJson(
            `/rest/v1.0/project_roles?project_id=${project.procoreId}&company_id=${companyId}&per_page=100`,
            companyId,
            { signal: controller.signal }
          );
        } catch (rateErr: any) {
          clearTimeout(timeout);
          if (rateErr.message?.includes('429')) {
            console.log('[procore] Rate limited (429), waiting 60s before retrying project', project.procoreId);
            await new Promise(r => setTimeout(r, 60000));
            const c2 = new AbortController();
            const t2 = setTimeout(() => c2.abort(), ROLE_SYNC_PER_REQUEST_TIMEOUT_MS);
            raw = await fetchProcoreJson(
              `/rest/v1.0/project_roles?project_id=${project.procoreId}&company_id=${companyId}&per_page=100`,
              companyId,
              { signal: c2.signal }
            );
            clearTimeout(t2);
          } else if (rateErr.name === 'AbortError') {
            console.warn(`[procore] Timeout fetching roles for project ${project.procoreId}, skipping`);
            return;
          } else {
            throw rateErr;
          }
        }
        clearTimeout(timeout);
        const assignments = Array.isArray(raw) ? raw : (raw?.data ?? []);

        const existingAssignments = await storage.getProcoreRoleAssignmentsByProject(project.procoreId);
        const existingKeys = new Set(existingAssignments.map(a => `${a.roleName}||${a.assigneeId}`));

        for (const assignment of assignments) {
          const roleName = assignment.role || 'Unknown Role';
          const assigneeId = assignment.user_id ? String(assignment.user_id) : (assignment.contact_id ? String(assignment.contact_id) : null);
          if (!assigneeId) continue;
          const nameParts = (assignment.name || '').split(' (');
          const assigneeName = nameParts[0] || '';
          const assigneeCompany = nameParts[1] ? nameParts[1].replace(')', '') : '';
          let assigneeEmail = assignment.email_address || assignment.email || '';
          if (!assigneeEmail) {
            const user = await storage.getProcoreUserByProcoreId(assigneeId);
            assigneeEmail = user?.emailAddress || '';
          }

          const isNew = !existingKeys.has(`${roleName}||${assigneeId}`);

          await storage.upsertProcoreRoleAssignment({
            procoreProjectId: project.procoreId,
            projectName: project.name,
            roleId: assignment.id ? String(assignment.id) : null,
            roleName,
            assigneeId,
            assigneeName,
            assigneeEmail,
            assigneeCompany,
            properties: assignment,
            lastSyncedAt: new Date(),
          });

          if (isNew) {
            const emailDedupeKey = `role_assignment:${project.procoreId}:${roleName}:${assigneeId}`;
            const alreadyNotified = await storage.checkEmailDedupeKey(emailDedupeKey);
            if (!alreadyNotified) {
            newAssignments.push({
              procoreProjectId: project.procoreId,
              projectName: project.name,
              roleName,
              assigneeId,
              assigneeName,
              assigneeEmail,
              assigneeCompany,
            });
            }
          }

          synced++;
        }
        await storage.updateProcoreProjectLastRoleCheck(project.procoreId);
      } catch (err: any) {
        clearTimeout(timeout);
        if (err.name === 'AbortError') {
          console.warn(`[procore] Timeout fetching roles for project ${project.procoreId}, skipping`);
          return;
        }
        if (err.message?.includes('403') || err.message?.includes('404')) {
          return;
        }
        throw err;
      }
    }

    await parallelWithLimit(batch, async (project) => {
      try {
        await processProject(project);
      } catch (err: any) {
        console.error(`[procore] Error fetching role assignments for project ${project.procoreId}:`, err.message);
      }
      await new Promise(r => setTimeout(r, ROLE_SYNC_BATCH_DELAY_MS));
    }, ROLE_SYNC_CONCURRENCY);

    // Clear webhook-priority flags now that we've processed this batch
    clearWebhookUpdatedProjects();

    const nextCursor = effectiveCursor + batchSize >= totalProjects ? 0 : effectiveCursor + batchSize;
    if (nextCursor === 0) {
      console.log(`[procore] Full rotation complete. Synced ${synced} role assignments, ${newAssignments.length} new assignments`);
    } else {
      console.log(`[procore] Synced ${synced} role assignments, ${newAssignments.length} new assignments (batch ${effectiveCursor}-${effectiveCursor + batchProcessed} of ${totalProjects})`);
    }

    return {
      synced,
      newAssignments,
      nextCursor,
      totalProjects,
      batchProcessed,
    };
  } finally {
    roleAssignmentSyncInProgress = false;
  }
}

export async function runFullProcoreSync(): Promise<{
  projects: { synced: number; created: number; updated: number; changes: number };
  vendors: { synced: number; created: number; updated: number; changes: number };
  users: { synced: number; created: number; updated: number; changes: number };
  bidBoard: { bidPackages: number; bids: number; bidForms: number };
  roleAssignments: { synced: number; newAssignments: number };
  purgedHistory: number;
  duration: number;
}> {
  const start = Date.now();

  const projects = await syncProcoreProjects();
  const [vendors, users] = await Promise.all([
    syncProcoreVendors(),
    syncProcoreUsers(),
  ]);
  const bidBoard = await syncProcoreBidBoard();

  let roleAssignmentResult = { synced: 0, newAssignments: [] as any[] };
  try {
    roleAssignmentResult = await syncProcoreRoleAssignments();
  } catch (err: any) {
    console.error(`[procore] Role assignment sync failed:`, err.message);
  }

  if (roleAssignmentResult.newAssignments.length > 0) {
    try {
      const { sendRoleAssignmentEmails, triggerKickoffForNewPmOnPortfolio } = await import('./email-notifications');
      await sendRoleAssignmentEmails(roleAssignmentResult.newAssignments);
      await triggerKickoffForNewPmOnPortfolio(roleAssignmentResult.newAssignments);
    } catch (err: any) {
      console.error(`[procore] Email notifications failed:`, err.message);
    }
  }

  if (projects.stageChanges && projects.stageChanges.length > 0) {
    console.log(`[procore] Detected ${projects.stageChanges.length} stage change(s) during polling, processing...`);
    
    // Check if stage sync automation is enabled (disabled by default)
    const stageSyncConfig = await storage.getAutomationConfig("procore_hubspot_stage_sync");
    const stageSyncEnabled = (stageSyncConfig?.value as any)?.enabled === true;
    
    if (!stageSyncEnabled) {
      console.log(`[procore] Stage sync disabled - skipping HubSpot updates for ${projects.stageChanges.length} stage change(s)`);
    } else {
      try {
        const { sendStageChangeEmail } = await import('./email-notifications');
        const { mapProcoreStageToHubspot, resolveHubspotStageId, getTerminalStageGuard } = await import('./procore-hubspot-sync');
        const { updateHubSpotDealStage } = await import('./hubspot');

        for (const sc of projects.stageChanges) {
          const mapping = await storage.getSyncMappingByProcoreProjectId(sc.procoreId);
          if (mapping?.hubspotDealId) {
            const hubspotStageLabel = mapProcoreStageToHubspot(sc.newStage);
            if (!hubspotStageLabel) {
              console.log(`[procore] Procore stage "${sc.newStage}" mapped to null — skipping HubSpot sync for ${sc.projectName}`);
              continue;
            }

            // Guard: don't overwrite terminal stages (Closed Won, Closed Lost, etc.)
            const terminalStage = await getTerminalStageGuard(mapping.hubspotDealId, hubspotStageLabel);
            if (terminalStage) {
              console.log(`[procore] BLOCKED: Deal ${mapping.hubspotDealId} is "${terminalStage}" — refusing to overwrite with "${hubspotStageLabel}" from polling stage "${sc.newStage}" (${sc.projectName})`);
              await storage.createAuditLog({
                action: 'polling_stage_change_blocked',
                entityType: 'project_stage',
                entityId: sc.procoreId,
                source: 'polling',
                status: 'skipped',
                details: { procoreId: sc.procoreId, projectName: sc.projectName, oldStage: sc.oldStage, newStage: sc.newStage, hubspotDealId: mapping.hubspotDealId, currentHubspotStage: terminalStage, blockedStage: hubspotStageLabel, reason: 'terminal_stage_guard' },
              });
              continue;
            }

            const resolvedStage = await resolveHubspotStageId(hubspotStageLabel);

            if (!resolvedStage) {
              console.log(`[procore] Could not resolve HubSpot stage for label: ${hubspotStageLabel}`);
              continue;
            }

            const hubspotStageId = resolvedStage.stageId;
            const hubspotStageName = resolvedStage.stageName;

            const updateResult = await updateHubSpotDealStage(mapping.hubspotDealId, hubspotStageId);
            console.log(`[procore] Polling stage change: HubSpot deal ${mapping.hubspotDealId} updated to ${hubspotStageName}: ${updateResult.message}`);

            const deal = await storage.getHubspotDealByHubspotId(mapping.hubspotDealId);
            await sendStageChangeEmail({
              hubspotDealId: mapping.hubspotDealId,
              dealName: deal?.dealName || mapping.hubspotDealName || 'Unknown Deal',
              procoreProjectId: sc.procoreId,
              procoreProjectName: sc.projectName,
              oldStage: sc.oldStage,
              newStage: sc.newStage,
              hubspotStageName,
            });

            await storage.createAuditLog({
              action: 'polling_stage_change_processed',
              entityType: 'project_stage',
              entityId: sc.procoreId,
              source: 'polling',
              status: 'success',
              details: { procoreId: sc.procoreId, projectName: sc.projectName, oldStage: sc.oldStage, newStage: sc.newStage, hubspotDealId: mapping.hubspotDealId, hubspotStageId, hubspotStageName },
            });
          } else {
            console.log(`[procore] Stage change for ${sc.projectName} (${sc.procoreId}) has no HubSpot mapping, skipping email`);
          }
        }
      } catch (err: any) {
        console.error(`[procore] Stage change email processing failed:`, err.message);
      }
    }

    // Send stage-specific notifications (portfolio stages) — only on real transitions
    for (const sc of projects.stageChanges) {
      if (!sc.oldStage) continue; // Skip first-time baseline entries
      try {
        const { processStageNotification } = await import('./stage-notifications');
        const mapping = await storage.getSyncMappingByProcoreProjectId(sc.procoreId);
        await processStageNotification({
          stage: sc.newStage,
          source: 'portfolio',
          projectName: sc.projectName,
          oldStage: sc.oldStage,
          procoreProjectId: sc.procoreId,
          hubspotDealId: mapping?.hubspotDealId,
        });
      } catch (err: any) {
        console.error(`[procore] Stage notification failed for ${sc.projectName}:`, err.message);
      }
    }
  }

  // Sync change orders and prime contracts to HubSpot deal amounts (respects sync_change_orders config)
  try {
    const { syncAllProjectChangeOrders } = await import('./change-order-sync');
    const changeOrderResult = await syncAllProjectChangeOrders();
    if (changeOrderResult.projectsUpdated > 0) {
      console.log(`[procore] Change order sync: ${changeOrderResult.projectsUpdated} deal amount(s) updated`);
    }
  } catch (err: any) {
    console.error(`[procore] Change order sync failed:`, err.message);
  }

  const purgedHistory = await storage.purgeProcoreChangeHistory(14);
  const duration = Date.now() - start;

  return {
    projects,
    vendors,
    users,
    bidBoard,
    roleAssignments: { synced: roleAssignmentResult.synced, newAssignments: roleAssignmentResult.newAssignments.length },
    purgedHistory,
    duration,
  };
}
