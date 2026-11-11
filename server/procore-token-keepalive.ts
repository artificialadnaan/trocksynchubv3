/**
 * Procore token keep-alive (owner 2026-11-11: SyncHub's Procore pollers go off, and the shared token must stay fresh
 * without them).
 *
 * getAccessToken() renews the stored token only when a caller finds it near expiry (procore.ts). The read-only borrowers
 * never call /oauth/token themselves: Core reads it through the signed route, and the migration capture reads
 * oauth_tokens directly. Until now the pollers' steady Procore calls were what kept the 90-minute token renewed.
 *
 * Every 10 minutes this timer asks for a token with at least 30 minutes left. A token with more left is returned as
 * stored, with no network call. Otherwise the existing advisory-locked refresh posts /oauth/token once. So the stored
 * token is renewed well before it expires. It never calls a Procore data API and never logs a token.
 */
import { getAccessToken } from "./procore";

export const PROCORE_TOKEN_KEEPALIVE_INTERVAL_MS = 10 * 60_000;
export const PROCORE_TOKEN_KEEPALIVE_MIN_VALIDITY_MS = 30 * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let tickRunning = false;

export async function runProcoreTokenKeepAliveTick(
  deps: { getAccessToken?: typeof getAccessToken } = {},
): Promise<"ok" | "failed"> {
  const get = deps.getAccessToken ?? getAccessToken;
  try {
    await get({ minValidityMs: PROCORE_TOKEN_KEEPALIVE_MIN_VALIDITY_MS });
    return "ok";
  } catch (error: any) {
    // The message only: getAccessToken's errors carry no token. The next tick tries again.
    console.warn(`[procore-token-keepalive] could not keep the Procore token fresh: ${error?.message || error}`);
    return "failed";
  }
}

export function startProcoreTokenKeepAlive(intervalMs = PROCORE_TOKEN_KEEPALIVE_INTERVAL_MS): void {
  if (timer) return;
  timer = setInterval(() => {
    if (tickRunning) return;
    tickRunning = true;
    void runProcoreTokenKeepAliveTick().finally(() => {
      tickRunning = false;
    });
  }, intervalMs);
  timer.unref?.();
  console.log(
    `[procore-token-keepalive] started: every ${Math.round(intervalMs / 60_000)} min, ` +
      `renews when less than ${PROCORE_TOKEN_KEEPALIVE_MIN_VALIDITY_MS / 60_000} min remain`,
  );
}

export function stopProcoreTokenKeepAlive(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
