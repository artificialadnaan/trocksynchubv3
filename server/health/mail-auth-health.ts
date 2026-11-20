import { sql } from "drizzle-orm";
import { safeCode, safeMessage } from "./snapshot-contract";

/**
 * MAIL SIGN-IN HEALTH (integration-health S2, CONTRACT ADDENDUM-1 ruling 1): until now an Outlook / Gmail token refresh
 * failure went to the console only (microsoft.ts / gmail.ts), so nothing could show that the mailbox had stopped signing in
 * (INCIDENT-001, 11-05 → 11-13). Each refresh now leaves a record in automation_config key `mail_auth_health`:
 *
 *   { "outlook": { "last_ok_at": "…", "last_error": { "code": "AADSTS50079", "at": "…", "message_safe": "…" } }, "gmail": { … } }
 *
 * - A success sets last_ok_at and LEAVES last_error in place: the health snapshot compares the two times, so the last
 *   failure stays as evidence after a recovery.
 * - message_safe is sanitised BEFORE it is stored (no email address, credential, token or URL query); the code is the
 *   provider's (AADSTS…, invalid_grant …) or refresh_failed, never a guess.
 * - ONE statement merges only that provider's subtree, so an Outlook and a Gmail write can't overwrite each other.
 * - BEST-EFFORT: neither function ever throws or rejects. A failed write must never change a refresh's result.
 * The key holds no secret and does not end in `_oauth`, so storage's at-rest sealing leaves it alone.
 */

export const MAIL_AUTH_HEALTH_KEY = "mail_auth_health";
export type MailProvider = "outlook" | "gmail";

const DESCRIPTION = "Mail sign-in health (no secrets): the last OK and the last failure per provider";

async function getDb() {
  return (await import("../db")).db;
}

/** The provider's error code: an AADSTS number, else the OAuth `error` field, else refresh_failed. */
export function mailAuthErrorCode(message: string): string {
  const aadsts = /AADSTS\d+/.exec(message);
  if (aadsts) return aadsts[0];
  const oauth = /"error"\s*:\s*"([A-Za-z0-9_.:-]{1,60})"/.exec(message);
  if (oauth) return safeCode(oauth[1], "refresh_failed");
  return "refresh_failed";
}

/** The text worth keeping: the OAuth error_description when there is one, else the message, sanitised. */
export function mailAuthSafeMessage(message: string): string | null {
  const description = /"error_description"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(message);
  const text = description ? description[1].replace(/\\r|\\n/g, " ").replace(/\\"/g, '"') : message;
  return safeMessage(text);
}

async function mergeProvider(provider: MailProvider, patch: Record<string, unknown>, db?: any): Promise<void> {
  const conn = db ?? (await getDb());
  const patchJson = JSON.stringify(patch);
  await conn.execute(sql`
    INSERT INTO automation_config (key, value, description, is_active, updated_at)
    VALUES (${MAIL_AUTH_HEALTH_KEY}, jsonb_build_object(${provider}::text, ${patchJson}::jsonb), ${DESCRIPTION}, true, NOW())
    ON CONFLICT (key) DO UPDATE SET
      value = COALESCE(automation_config.value, '{}'::jsonb)
              || jsonb_build_object(${provider}::text, COALESCE(automation_config.value -> ${provider}::text, '{}'::jsonb) || ${patchJson}::jsonb),
      updated_at = NOW()
  `);
}

/** A refresh (or a first connect) succeeded. Never throws. */
export async function recordMailAuthOk(provider: MailProvider, options: { db?: any; now?: Date } = {}): Promise<void> {
  try {
    await mergeProvider(provider, { last_ok_at: (options.now ?? new Date()).toISOString() }, options.db);
  } catch (error: any) {
    try {
      console.warn(`[mail-auth-health] could not record the ${provider} sign-in success: ${error?.code || "write failed"}`);
    } catch {
      /* logging must not throw either */
    }
  }
}

/** A refresh failed. Stores the code and the sanitised message only. Never throws. */
export async function recordMailAuthFailure(
  provider: MailProvider,
  error: unknown,
  options: { db?: any; now?: Date } = {},
): Promise<void> {
  try {
    const message = error instanceof Error ? error.message : String(error ?? "");
    await mergeProvider(
      provider,
      {
        last_error: {
          code: mailAuthErrorCode(message),
          at: (options.now ?? new Date()).toISOString(),
          message_safe: mailAuthSafeMessage(message),
        },
      },
      options.db,
    );
  } catch (writeError: any) {
    try {
      console.warn(`[mail-auth-health] could not record the ${provider} sign-in failure: ${writeError?.code || "write failed"}`);
    } catch {
      /* logging must not throw either */
    }
  }
}
