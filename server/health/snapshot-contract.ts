import { z } from "zod";

/**
 * trock.integration-health.snapshot.v1 — the one shape every system reports its connections in (CONTRACT r1 b4616ca1 +
 * ADDENDUM-1 1fe1d1f1, owner text 1974ad1c). SyncHub sends MEASUREMENTS only; T-Rock Core decides the state, so a producer
 * can never paint itself green. snapshot.v1.schema.json beside this file is the cross-repo file of record (the same bytes
 * Core and the CRM carry; tests/health-snapshot-contract.test.ts pins its sha). This zod mirror is a port of Core S1's
 * (core/src/modules/integrations/health/contract.ts): SyncHub has no ajv, so ADDENDUM-1 asks for a mirror that agrees with
 * Core's golden fixtures (__fixtures__, byte copies).
 *
 * `null` is "not measured" and `0` is "measured zero" everywhere; the two are never interchangeable.
 */

export const SNAPSHOT_SCHEMA = "trock.integration-health.snapshot.v1";
export const SNAPSHOT_SCHEMA_SHA256 = "53639e8d33f3cdc80ceb0808e154928ed709044aff27bca24dd4bc581d3311b5";

export const HEALTH_SYSTEMS = ["synchub", "crm", "expense", "core"] as const;
export type HealthSystem = (typeof HEALTH_SYSTEMS)[number];

// The JSON schema's patterns, verbatim (ECMA-262, no inline flags).
const TS_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$/;
const UNSAFE_TEXT_RE =
  /([Bb]earer |BEARER |[Tt]oken=|access_token|refresh_token|eyJ[A-Za-z0-9_-]{10,}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|https?:\/\/[^ ]*\?)/;
const UNSAFE_URL_RE = /([Tt]oken|TOKEN|\/rfp-review\/|[?&](t|key|sig|code)=)/;
const CODE_RE = /^[A-Za-z0-9_.:-]+$/;

const ts = z.string().regex(TS_RE);
const tsOrNull = ts.nullable();
const countOrNull = z.number().int().min(0).nullable();
const safeText = z
  .string()
  .max(200)
  .refine((s) => !UNSAFE_TEXT_RE.test(s), "carries a credential, email address or URL query");
const safeUrlOrNull = z
  .string()
  .max(300)
  .regex(/^https:\/\//)
  .refine((s) => !UNSAFE_URL_RE.test(s), "is a token-bearing link")
  .nullable();
const healthError = z
  .object({ code: z.string().max(80).regex(CODE_RE), at: tsOrNull, message_safe: safeText.nullable() })
  .strict()
  .nullable();
const delivery = z
  .object({
    direction: z.enum(["out", "in"]),
    pending: countOrNull,
    oldest_pending_at: tsOrNull,
    failed_24h: countOrNull,
    failed_7d: countOrNull,
    exhausted: countOrNull,
    last_delivered_at: tsOrNull,
  })
  .strict();
const record = z
  .object({
    kind: z.string().max(60).regex(/^[a-z0-9_]+$/),
    id: z.string().max(80).regex(CODE_RE),
    state: z.string().max(40).regex(CODE_RE),
    url: safeUrlOrNull,
  })
  .strict();
const extraValue = z.union([z.null(), z.boolean(), z.number(), z.string().max(60).regex(/^[A-Za-z0-9_.:-]*$/)]);

export const connectionSchema = z
  .object({
    key: z.string().max(80).regex(/^(synchub|crm|expense|core)\.[a-z0-9_.]+$/),
    label: z.string().max(120),
    peer: z.string().max(60),
    direction: z.enum(["outbound", "inbound", "pull", "bidirectional"]),
    purpose: z.string().max(200),
    impact: z.string().max(200),
    paused: z.object({ reason: safeText, since: tsOrNull }).strict().nullable(),
    connection: z
      .object({
        credential_present: z.boolean().nullable(),
        expires_at: tsOrNull,
        last_auth_ok_at: tsOrNull,
        last_auth_error: healthError,
      })
      .strict(),
    processing: z
      .object({
        last_attempt_at: tsOrNull,
        last_success_at: tsOrNull,
        cadence_seconds: z.number().int().min(1).nullable(),
        next_run_at: tsOrNull,
        last_error: healthError,
      })
      .strict(),
    delivery: z.array(delivery).max(2),
    records: z.array(record).max(20),
    correction_url: safeUrlOrNull,
    extra: z
      .record(z.string().regex(/^[a-z0-9_.:-]{1,60}$/), extraValue)
      .refine((o) => Object.keys(o).length <= 20, "has more than 20 keys"),
  })
  .strict();

export const snapshotSchema = z
  .object({
    schema: z.literal(SNAPSHOT_SCHEMA),
    system: z.enum(HEALTH_SYSTEMS),
    generated_at: ts,
    producer_commit: z.string().regex(/^[0-9a-f]{7,40}$/).nullable(),
    connections: z.array(connectionSchema).max(100),
  })
  .strict();

export type SnapshotConnection = z.infer<typeof connectionSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type HealthError = NonNullable<SnapshotConnection["processing"]["last_error"]>;
export type DeliveryMeasure = SnapshotConnection["delivery"][number];

/**
 * Core's acceptance rule, applied here before answering: the JSON schema's shape plus ADDENDUM-1's one rule the schema can't
 * express, that every connection key starts with the snapshot's own system.
 */
export function validateSnapshot(raw: unknown): { ok: true; snapshot: Snapshot } | { ok: false; errors: string[] } {
  const parsed = snapshotSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  const errors = parsed.data.connections
    .map((c, i) => (c.key.startsWith(`${parsed.data.system}.`) ? null : `connections.${i}.key: not a ${parsed.data.system} key`))
    .filter((e): e is string => e !== null);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, snapshot: parsed.data };
}

/**
 * Reduce a stored error string to the contract's message_safe: email addresses, bearer credentials, JWT-shaped tokens,
 * credential fields and URL queries are cut, whitespace collapsed, and the result capped at 200 characters. Anything that
 * still trips the schema's guard is dropped (null) rather than sent; the error's code still carries the signal.
 */
export function safeMessage(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let s = raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\bbearer\s+\S+/gi, "[credential]")
    .replace(/eyJ[A-Za-z0-9_.-]{10,}/g, "[token]")
    .replace(/\b(?:access_token|refresh_token|token|secret|password)\s*[=:]\s*\S*/gi, "[redacted]")
    .replace(/\b(?:access_token|refresh_token)\b/gi, "[credential field]")
    .replace(/(https?:\/\/[^\s?]*)\?\S*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > 200) s = `${s.slice(0, 199)}…`;
  if (s === "" || UNSAFE_TEXT_RE.test(s)) return null;
  return s;
}

/** A timestamp in the contract's form (UTC, `Z`), or null. Accepts a Date, an ISO string or epoch milliseconds. */
export function isoOrNull(value: Date | string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** An error code the schema accepts (`^[A-Za-z0-9_.:-]+$`, ≤ 80), or the fallback. */
export function safeCode(raw: string | null | undefined, fallback: string): string {
  const s = (raw ?? "").trim();
  return s !== "" && s.length <= 80 && CODE_RE.test(s) ? s : fallback;
}
