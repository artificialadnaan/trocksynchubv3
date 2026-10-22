import crypto from "crypto";

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

export function consumeOAuthState(session: SessionLike, provider: string, provided: unknown, now: number = Date.now()): boolean {
  const pending = session?.[keyOf(provider)] as { state: string; at: number } | undefined;
  if (session) delete session[keyOf(provider)];
  if (!pending || now - pending.at > OAUTH_STATE_TTL_MS) return false;
  if (typeof provided !== "string" || provided.length === 0) return false;
  const a = Buffer.from(pending.state, "utf8");
  const b = Buffer.from(provided, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The provider's authorize URL with `state` added (an existing `state` parameter is replaced). */
export function withOAuthState(url: string, state: string): string {
  const u = new URL(url);
  u.searchParams.set("state", state);
  return u.toString();
}
