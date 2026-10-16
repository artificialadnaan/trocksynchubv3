/**
 * Core's signed, read-only fetch of SyncHub's Procore ACCESS token
 * =================================================================
 *
 *   POST /api/internal/procore/access-token
 *   x-trock-timestamp: <unix seconds>   x-trock-signature: sha256=<hex>
 *   canonical = "v1\n<ts>\nPOST\n/api/internal/procore/access-token\n<sha256hex(raw body)>"
 *   signature = HMAC-SHA256(CORE_PROCORE_TOKEN_READ_SECRET, canonical)
 *
 * Core's existing scheme, byte for byte (trock-core core/src/modules/qb-sync/expense-reference-client.ts). The path in
 * the canonical string is this LITERAL path, never req.path (Express matches paths case-insensitively). The body hash is
 * over the raw bytes the global JSON parser captured (server/json-body.ts); a request with no captured body (no body,
 * or a non-JSON content type) is hashed as the empty string. The body itself is ignored.
 *
 * SyncHub stays the ONLY caller of Procore's /oauth/token: this route asks getAccessToken(), which refreshes through
 * the advisory-locked path when needed. It answers only { accessToken, expiresAt, companyId } and never the refresh
 * token or any client credential. Fails closed: secret unset/blank/< 32 bytes -> 503; bad signature or a timestamp
 * outside +-300 s -> 401; no token with >= 5 min left (after one retry) -> 503.
 *
 * The success body is written with res.send, not res.json: the /api request logger in server/index.ts echoes every
 * res.json body into the logs, and the access token must not land there.
 */
import { createHash, createHmac, timingSafeEqual } from "crypto";
import type { Express, Request, RequestHandler, Response } from "express";
import { getAccessToken, getCompanyId } from "../procore";
import { storage } from "../storage";

export const PROCORE_TOKEN_READ_PATH = "/api/internal/procore/access-token";
export const CORE_PROCORE_TOKEN_READ_SECRET_ENV = "CORE_PROCORE_TOKEN_READ_SECRET";
const MIN_SECRET_BYTES = 32;
const MAX_SKEW_SECONDS = 300;
/** Never serve a token with less than this left (Core re-fetches below 2 minutes and on a 401). */
const MIN_SERVED_VALIDITY_MS = 5 * 60_000;
// Integer Unix seconds: no sign, no leading zeros, at most 15 digits (exact as a Number). Mirrors Expense's verifier.
const TIMESTAMP_RE = /^(0|[1-9][0-9]{0,14})$/;
const SIGNATURE_RE = /^sha256=([0-9a-f]{64})$/;

/** The configured secret, or null (unset, blank, or shorter than 32 bytes), which disables the route. */
export function getCoreProcoreTokenReadSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[CORE_PROCORE_TOKEN_READ_SECRET_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return null;
  if (Buffer.byteLength(raw, "utf8") < MIN_SECRET_BYTES) return null;
  return raw;
}

export function canonicalTokenReadString(timestamp: string, rawBody: Buffer): string {
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  return ["v1", timestamp, "POST", PROCORE_TOKEN_READ_PATH, bodyHash].join("\n");
}

/** Exactly one header value, or null (absent, repeated, or not a string). */
function singleHeader(req: Request, name: string): string | null {
  const distinct = (req as any).headersDistinct?.[name];
  if (Array.isArray(distinct)) return distinct.length === 1 && typeof distinct[0] === "string" ? distinct[0] : null;
  const value = req.headers?.[name];
  return typeof value === "string" ? value : null;
}

export function verifyCoreTokenReadSignature(input: {
  timestamp: string | null;
  signature: string | null;
  rawBody: Buffer;
  secret: string;
  nowMs: number;
}): "ok" | "stale" | "bad_signature" {
  const { timestamp, signature } = input;
  if (timestamp === null || signature === null) return "bad_signature";
  if (!TIMESTAMP_RE.test(timestamp)) return "bad_signature";
  const match = SIGNATURE_RE.exec(signature);
  if (!match) return "bad_signature";
  const provided = Buffer.from(match[1], "hex");
  if (provided.length !== 32) return "bad_signature";
  if (Math.abs(Math.floor(input.nowMs / 1000) - Number(timestamp)) > MAX_SKEW_SECONDS) return "stale";
  const expected = createHmac("sha256", input.secret).update(canonicalTokenReadString(timestamp, input.rawBody), "utf8").digest();
  return timingSafeEqual(expected, provided) ? "ok" : "bad_signature";
}

function sendJson(res: Response, status: number, body: Record<string, unknown>): void {
  res.status(status);
  res.set("Cache-Control", "no-store");
  res.type("application/json");
  res.send(JSON.stringify(body));
}

function unavailable(res: Response, reason: string): void {
  console.warn(`[procore-token-read] 503 procore_token_unavailable: ${reason}`);
  sendJson(res, 503, { error: "procore_token_unavailable", reason });
}

/** A short plain reason for a getAccessToken() failure. The error message itself is not logged or returned. */
function reasonFor(err: unknown): string {
  const message = err instanceof Error ? err.message : "";
  if (message.startsWith("No Procore OAuth token")) return "no Procore login is stored";
  if (message.startsWith("Procore token expired and no refresh token")) return "the Procore login expired and cannot be refreshed";
  if (message.startsWith("Failed to refresh Procore token")) return "the Procore token refresh failed";
  return "the Procore token could not be read";
}

export const handleProcoreTokenRead: RequestHandler = async (req, res) => {
  const secret = getCoreProcoreTokenReadSecret();
  if (secret === null) {
    sendJson(res, 503, { error: "core_token_read_not_configured" });
    return;
  }
  const rawBody = Buffer.isBuffer((req as any).rawBody) ? ((req as any).rawBody as Buffer) : Buffer.alloc(0);
  const verdict = verifyCoreTokenReadSignature({
    timestamp: singleHeader(req, "x-trock-timestamp"),
    signature: singleHeader(req, "x-trock-signature"),
    rawBody,
    secret,
    nowMs: Date.now(),
  });
  if (verdict !== "ok") {
    sendJson(res, 401, { error: verdict === "stale" ? "stale_timestamp" : "invalid_signature" });
    return;
  }

  // Two tries: getAccessToken({ minValidityMs }) refreshes (under the cross-replica lock) a token with less than
  // 5 minutes left; if the stored row is still short of that (another replica's pair, or a race), ask once more.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await getAccessToken({ minValidityMs: MIN_SERVED_VALIDITY_MS });
    } catch (err) {
      unavailable(res, reasonFor(err));
      return;
    }

    let row: Awaited<ReturnType<typeof storage.getOAuthToken>>;
    try {
      row = await storage.getOAuthToken("procore");
    } catch {
      unavailable(res, "the Procore token could not be read");
      return;
    }
    if (!row?.accessToken) {
      unavailable(res, "no Procore login is stored");
      return;
    }
    const expiresAt = row.expiresAt ? new Date(row.expiresAt) : null;
    const fresh = expiresAt !== null && !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() > Date.now() + MIN_SERVED_VALIDITY_MS;
    if (!fresh) continue;

    let companyId: string;
    try {
      companyId = await getCompanyId();
    } catch {
      unavailable(res, "the Procore company is not configured");
      return;
    }
    console.log(`[procore-token-read] served the Procore access token to Core (expires ${expiresAt!.toISOString()})`);
    // The stored row's pair: a newer token may have been written since getAccessToken() returned.
    sendJson(res, 200, { accessToken: row.accessToken, expiresAt: expiresAt!.toISOString(), companyId });
    return;
  }
  unavailable(res, "the Procore token has less than 5 minutes left and could not be refreshed");
};

export function registerProcoreTokenReadRoutes(app: Express): void {
  app.post(PROCORE_TOKEN_READ_PATH, handleProcoreTokenRead);
}
