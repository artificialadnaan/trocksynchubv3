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
 *
 * ONE collection at a time per process (PR #139 review): a request arriving while one runs shares its result, so repeated
 * polls can't stack transactions. The 10 s deadline covers the WHOLE collection (getting a connection included): when it
 * passes, the leased connection is DESTROYED (pg release(true)), which ends the backend's statement too; a statement
 * timeout alone caps each statement, not the run. The collection's own late rejection is caught, never unhandled.
 */
import { createHash, createHmac, timingSafeEqual } from "crypto";
import type { Express, Request, RequestHandler, Response } from "express";
import { collectSynchubSnapshot } from "../health/collect-synchub";
import type { Snapshot } from "../health/snapshot-contract";

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

/** A pooled connection held for one collection: its querier, and its release (destroy = drop it instead of pooling it). */
export interface SnapshotLease {
  db: any;
  release(destroy: boolean): void;
}

/** One connection from the shared pool, wrapped for drizzle; its transaction runs on this client alone. */
async function leaseFromPool(): Promise<SnapshotLease> {
  const [{ pool }, { drizzle }] = await Promise.all([import("../db"), import("drizzle-orm/node-postgres")]);
  const client = await pool.connect();
  return { db: drizzle(client), release: (destroy) => client.release(destroy) };
}

export function createHealthSnapshotHandler(
  deps: {
    collect?: (db: any) => Promise<Snapshot>;
    acquire?: () => Promise<SnapshotLease>;
    deadlineMs?: number;
  } = {},
): RequestHandler {
  const collect = deps.collect ?? ((db: any) => collectSynchubSnapshot({ db }));
  const acquire = deps.acquire ?? leaseFromPool;
  const deadlineMs = deps.deadlineMs ?? HEALTH_SNAPSHOT_DEADLINE_MS;
  let inFlight: Promise<Snapshot> | null = null;

  /** The running collection, or a new one: lease, collect, release; the deadline destroys the lease. */
  function collectOnce(): Promise<Snapshot> {
    if (inFlight) return inFlight;
    const run = (async () => {
      const held: { lease: SnapshotLease | null; expired: boolean } = { lease: null, expired: false };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          held.expired = true;
          reject(new Error("deadline"));
        }, deadlineMs);
      });
      const work = (async () => {
        const lease = await acquire();
        if (held.expired) {
          // Leased after the deadline: never used, so it goes back to the pool as is.
          lease.release(false);
          throw new Error("deadline");
        }
        held.lease = lease;
        return collect(lease.db);
      })();
      // Destroying the connection rejects the collection after the race is settled: caught here, never unhandled.
      work.catch(() => undefined);
      let failed = false;
      try {
        return await Promise.race([work, deadline]);
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        // A failed or overdue collection may still hold its connection mid-statement: destroy it rather than pool it.
        held.lease?.release(failed);
      }
    })();
    inFlight = run;
    const clear = () => {
      if (inFlight === run) inFlight = null;
    };
    run.then(clear, clear);
    return run;
  }

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

    try {
      sendJson(res, 200, await collectOnce());
    } catch (error: any) {
      // The reason is a fixed word: an error message could carry table data.
      unavailable(res, error?.message === "deadline" ? "deadline" : "collection_failed");
    }
  };
}

export function registerHealthSnapshotRoutes(app: Express): void {
  app.post(HEALTH_SNAPSHOT_PATH, createHealthSnapshotHandler());
}
