/**
 * T-Rock Core's signed, read-only fetch of SyncHub's integration-health snapshot (S2)
 * =================================================================================
 *
 *   POST /api/internal/health/snapshot
 *   x-trock-timestamp: <unix seconds>   x-trock-signature: sha256=<hex>
 *   canonical = "v1\n<ts>\nPOST\n/api/internal/health/snapshot\n<sha256hex(raw body)>"
 *   signature = HMAC-SHA256(SYNCHUB_HEALTH_READ_SECRET_CURRENT or _PREVIOUS, canonical)
 *
 * The procore-token-read scheme byte for byte (CONTRACT ADDENDUM-1 ruling 3), with its OWN secret pair so a rotation never
 * breaks the read: a signature under CURRENT or PREVIOUS passes. The path in the canonical string is this LITERAL path, the
 * body hash is over the raw bytes the global JSON parser captured (empty when none), and the body itself is ignored.
 *
 * Fails closed: no usable CURRENT (unset, blank or < 32 bytes) -> 503 snapshot_unavailable; a bad or missing signature, or a
 * timestamp outside +-300 s -> 401 and nothing is read; any collection error, or more than 10 s -> 503, never a partial
 * snapshot. The collection is read-only (collect-synchub.ts). The body is written with res.send, not res.json: the /api
 * request logger in server/index.ts echoes every res.json body into the logs.
 */
import { createHash, createHmac, timingSafeEqual } from "crypto";
import type { Express, Request, RequestHandler, Response } from "express";
import { collectSynchubSnapshot } from "../health/collect-synchub";

export const HEALTH_SNAPSHOT_PATH = "/api/internal/health/snapshot";
export const HEALTH_READ_SECRET_CURRENT_ENV = "SYNCHUB_HEALTH_READ_SECRET_CURRENT";
export const HEALTH_READ_SECRET_PREVIOUS_ENV = "SYNCHUB_HEALTH_READ_SECRET_PREVIOUS";
const MIN_SECRET_BYTES = 32;
const MAX_SKEW_SECONDS = 300;
/** CONTRACT r1: a producer answers within 10 s. */
export const HEALTH_SNAPSHOT_DEADLINE_MS = 10_000;
// Integer Unix seconds: no sign, no leading zeros, at most 15 digits (exact as a Number). Mirrors procore-token-read.
const TIMESTAMP_RE = /^(0|[1-9][0-9]{0,14})$/;
const SIGNATURE_RE = /^sha256=([0-9a-f]{64})$/;

function usableSecret(raw: string | undefined): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  if (Buffer.byteLength(raw, "utf8") < MIN_SECRET_BYTES) return null;
  return raw;
}

/** The accepted secrets, CURRENT first. Empty when CURRENT is unusable, which disables the route. */
export function getHealthReadSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const current = usableSecret(env[HEALTH_READ_SECRET_CURRENT_ENV]);
  if (current === null) return [];
  const previous = usableSecret(env[HEALTH_READ_SECRET_PREVIOUS_ENV]);
  return previous === null || previous === current ? [current] : [current, previous];
}

export function canonicalHealthReadString(timestamp: string, rawBody: Buffer): string {
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  return ["v1", timestamp, "POST", HEALTH_SNAPSHOT_PATH, bodyHash].join("\n");
}

/** Exactly one header value, or null (absent, repeated, or not a string). */
function singleHeader(req: Request, name: string): string | null {
  const distinct = (req as any).headersDistinct?.[name];
  if (Array.isArray(distinct)) return distinct.length === 1 && typeof distinct[0] === "string" ? distinct[0] : null;
  const value = req.headers?.[name];
  return typeof value === "string" ? value : null;
}

export function verifyHealthReadSignature(input: {
  timestamp: string | null;
  signature: string | null;
  rawBody: Buffer;
  secrets: string[];
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
  const canonical = canonicalHealthReadString(timestamp, input.rawBody);
  let ok = false;
  for (const secret of input.secrets) {
    const expected = createHmac("sha256", secret).update(canonical, "utf8").digest();
    // Every secret is checked (no early exit), so the timing doesn't say which one matched.
    if (timingSafeEqual(expected, provided)) ok = true;
  }
  return ok ? "ok" : "bad_signature";
}

function sendJson(res: Response, status: number, body: unknown): void {
  res.status(status);
  res.set("Cache-Control", "no-store");
  res.type("application/json");
  res.send(JSON.stringify(body));
}

function unavailable(res: Response, reason: string): void {
  console.warn(`[health-snapshot] 503 snapshot_unavailable: ${reason}`);
  sendJson(res, 503, { error: "snapshot_unavailable", reason });
}

export function createHealthSnapshotHandler(
  deps: { collect?: typeof collectSynchubSnapshot; deadlineMs?: number } = {},
): RequestHandler {
  const collect = deps.collect ?? collectSynchubSnapshot;
  const deadlineMs = deps.deadlineMs ?? HEALTH_SNAPSHOT_DEADLINE_MS;
  return async (req, res) => {
    const secrets = getHealthReadSecrets();
    if (secrets.length === 0) {
      unavailable(res, "not_configured");
      return;
    }
    const rawBody = Buffer.isBuffer((req as any).rawBody) ? ((req as any).rawBody as Buffer) : Buffer.alloc(0);
    const verdict = verifyHealthReadSignature({
      timestamp: singleHeader(req, "x-trock-timestamp"),
      signature: singleHeader(req, "x-trock-signature"),
      rawBody,
      secrets,
      nowMs: Date.now(),
    });
    if (verdict !== "ok") {
      sendJson(res, 401, { error: verdict === "stale" ? "stale_timestamp" : "invalid_signature" });
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("deadline")), deadlineMs);
      });
      const snapshot = await Promise.race([collect(), deadline]);
      sendJson(res, 200, snapshot);
    } catch (error: any) {
      // The reason is a fixed word: an error message could carry table data.
      unavailable(res, error?.message === "deadline" ? "deadline" : "collection_failed");
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

export function registerHealthSnapshotRoutes(app: Express): void {
  app.post(HEALTH_SNAPSHOT_PATH, createHealthSnapshotHandler());
}
