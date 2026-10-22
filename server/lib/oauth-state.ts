import crypto from "crypto";
import { claimOAuthStateOnce } from "./oauth-state-store";

/**
 * One-shot OAuth `state` bound to the signed-in admin's SESSION (security hardening H4 / H4b, 2026-10-22).
 * /authorize issues a random 32-byte state and keeps it in the caller's session under `<provider>OAuthState`; /callback consumes it:
 * it is deleted whether or not it matches (no retry, no replay), expires after 10 minutes, and is compared in constant time. A callback with
 * no matching state is refused before any token exchange, so a forged link or a stray code can never connect or replace a provider grant.
 */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

type SessionLike = Record<string, any> | undefined | null;
const keyOf = (provider: string) => `${provider}OAuthState`;

export function issueOAuthState(session: SessionLike, provider: string): string {
  if (!session) throw new Error("OAuth state needs a session");
  const state = crypto.randomBytes(32).toString("hex");
  session[keyOf(provider)] = { state, at: Date.now() };
  return state;
}

// The AUTHORITY on "already used" is the shared PostgreSQL (oauth-state-store.ts: an atomic INSERT ... ON CONFLICT DO NOTHING RETURNING), because
// deploys overlap replicas and each replica has its own memory. This in-process map is only a fast path that answers "already used" without a
// round trip; it never grants a pass. If the shared store errors, the callback is DENIED (fail closed).
const consumed = new Map<string, number>();
const consumedKey = (provider: string, state: string) => crypto.createHash("sha256").update(`${provider}\n${state}`).digest("hex");

export async function consumeOAuthState(session: SessionLike, provider: string, provided: unknown, now: number = Date.now()): Promise<boolean> {
  const pending = session?.[keyOf(provider)] as { state: string; at: number } | undefined;
  if (session) delete session[keyOf(provider)];
  if (!pending || now - pending.at > OAUTH_STATE_TTL_MS) return false;
  for (const [key, until] of consumed) if (until <= now) consumed.delete(key);
  const key = consumedKey(provider, pending.state);
  const expiresAt = pending.at + OAUTH_STATE_TTL_MS;
  if (consumed.has(key)) return false;
  consumed.set(key, expiresAt); // synchronous, before any await: same-process callers cannot both pass
  // Record the pending state as consumed in the shared store BEFORE comparing the presented value, so a mismatching callback also burns it for
  // every other replica that loaded the same session snapshot (consume-on-mismatch holds across replicas).
  try {
    if (!(await claimOAuthStateOnce(key, expiresAt, now))) return false;
  } catch {
    return false; // shared store unavailable: deny rather than risk a double exchange
  }
  if (typeof provided !== "string" || provided.length === 0) return false;
  const a = Buffer.from(pending.state, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (!(a.length === b.length && crypto.timingSafeEqual(a, b))) return false;
  return true;
}

/** The provider's authorize URL with `state` added (an existing `state` parameter is replaced). */
export function withOAuthState(url: string, state: string): string {
  const u = new URL(url);
  u.searchParams.set("state", state);
  return u.toString();
}
