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
/**
 * Schema r2 (CONTRACT ADDENDUM-5, owner e69e6f71) = r1 + an optional per-connection `failed_ids`: the stable ids of every failed
 * item (<= 1000), so Core can alert on a NEW failed id even when the total is flat. snapshot.v1.r2.schema.json is its byte copy;
 * every r1 document is a valid r2 document. The mirror below is r2, and the route validates against it.
 */
export const SNAPSHOT_SCHEMA_R2_SHA256 = "cbad85ca3d669a410ff626a5bd0cfe4da05b59e085cdb0f00c8a712e4f5be869";
export const FAILED_IDS_MAX = 1000;

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
    failed_ids: z.array(z.string().max(80).regex(CODE_RE)).max(FAILED_IDS_MAX).optional(),
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
 * Reduce a stored error string to the contract's message_safe: URL userinfo, email addresses, bearer / Basic credentials,
 * JWT-shaped tokens, credential VALUES and URL queries are cut, an RFP review link's token segment is cut, whitespace is
 * collapsed, and the result is capped at 200 characters. Anything that still trips the schema's guard, or still holds a
 * credential key with its separator, is dropped (null); the error's code still carries the signal.
 *
 * Credential pairs (cleaner r3, d9's review of #139; the same design as Core and the CRM):
 * - KEY: a run of key characters (letters, digits, _ . -) split into segments at _ . - and at camelCase boundaries
 *   (refreshToken, AccountKey, Ocp-Apim-Subscription-Key, _password, connect.sid). It is a credential key when a segment
 *   is a credential word (token, password, secret, key, sid, ...; a plural or a trailing number counts) or the whole run
 *   holds a long one (jsessionid, hapikey). `code` counts only before "=" (an OAuth code), so `code: billing_x` stays.
 *   A short word must be a whole segment, so spin= / design= / signal= stay plain.
 * - SEPARATOR: ":", "=" or "=>", after up to 4 closing quotes / brackets / backticks (user[password]=, `token`=, \"key\":).
 * - VALUE, cut whole: an escaped-JSON string (read in escape pairs, so a quote escaped deeper never ends it), a quoted
 *   string, a [ ] / { } value to its matching close (nesting <= 4; unbalanced = the message is dropped), a Cookie /
 *   Set-Cookie header to the end of its line, else ONE bare token after = / =>, or a run to , ; } or the line end after :.
 * A ":" pair keeps its key (`password: [redacted]`); an "=" pair goes whole (`token=abc retry` -> `[redacted] retry`).
 * Every quantifier is bounded and the value scan is a single pass, so the time is linear in the (2000-character) input.
 */
const SEGMENT_WORDS = new Set([
  "token", "password", "passwd", "pwd", "pw", "pass", "passphrase", "secret", "credential", "credentials", "creds", "auth",
  "authorization", "key", "apikey", "otp", "pin", "jwt", "session", "sessid", "sid", "cookie", "signature", "sig",
  // r4 (d9 round 3): a bearer / ticket key is a credential key too (`bearer=…`, `{"bearer":…}`, `?ticket=…`).
  "bearer", "ticket",
]);
/** Long words that make a credential key wherever they sit in it (all-lower / all-upper names have no segment breaks). */
const RUN_WORDS = /token|password|passwd|passphrase|secret|credential|apikey|privatekey|accountkey|accesskey|sessionid|sessid/;
const PAIR_RE = /(?<![A-Za-z0-9_.-])(\\?["'`]?)([A-Za-z0-9_.-]{1,80})[\]\\"'`)]{0,4}\s*(=>?|:)\s*/g;
/** The fail-closed read: any number of closers, so a key nested deeper than the pair pass reads is still seen. */
const LEFT_RE = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{1,80})[\]\\"'`)]*\s*(=>?|:)(?!\s*\[redacted\])/g;

function isCredentialKey(key: string, sep: string): boolean {
  if (RUN_WORDS.test(key.replace(/[_.-]/g, "").toLowerCase())) return true;
  for (const part of key.split(/[_.-]+/)) {
    const segments = part.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(" ");
    for (const segment of segments) {
      const w = segment.toLowerCase().replace(/\d+$/, "");
      if (SEGMENT_WORDS.has(w) || (w.endsWith("s") && SEGMENT_WORDS.has(w.slice(0, -1)))) return true;
      if (w === "code" && sep !== ":") return true;
    }
  }
  return false;
}

/** The end of an escaped-JSON string whose opening \" ends at i, read in escape pairs; unterminated = the end. */
function escapedStringEnd(s: string, i: number): number {
  let j = i;
  while (j < s.length) {
    if (s[j] === "\\" && s[j + 1] === '"') return j + 2;
    if (s[j] === "\\" && s[j + 1] === "\\") j += s[j + 2] === "\\" && (s[j + 3] === "\\" || s[j + 3] === '"') ? 4 : 3;
    else j += s[j] === "\\" ? 2 : 1;
  }
  return s.length;
}

/** The end of a string quoted by q whose opening quote ends at i (backslash escapes skipped); unterminated = the end. */
function quotedEnd(s: string, i: number, q: string): number {
  for (let j = i; j < s.length; j++) {
    if (s[j] === "\\") j++;
    else if (s[j] === q) return j + 1;
  }
  return s.length;
}

/** The end of the [ ] / { } value opening at i, strings inside skipped; -1 when it does not close (or nests past 4). */
function bracketEnd(s: string, i: number): number {
  const want: string[] = [];
  for (let j = i; j < s.length; j++) {
    const c = s[j]!;
    if (c === "\\" && s[j + 1] === '"') j = escapedStringEnd(s, j + 2) - 1;
    else if (c === '"') j = quotedEnd(s, j + 1, '"') - 1;
    else if (c === "[" || c === "{") {
      want.push(c === "[" ? "]" : "}");
      if (want.length > 4) return -1;
    } else if (c === "]" || c === "}") {
      if (want.pop() !== c) return -1;
      if (want.length === 0) return j + 1;
    }
  }
  return -1;
}

function valueEnd(s: string, i: number, key: string, sep: string): number {
  const c = s[i];
  if (c === undefined) return i;
  // A cookie header or cookie-named key, whatever its separator (`cookies: a=1; s=…`, `cookie=a=1; s=…`, `headers.cookie: …`; r4):
  // every cookie in it may be a session, so the value is the rest of the line.
  if (/(?:^|[_.-])(?:set-)?cookies?$/i.test(key)) {
    const nl = s.slice(i).search(/[\r\n]/);
    return nl < 0 ? s.length : i + nl;
  }
  if (c === "\\" && s[i + 1] === '"') return escapedStringEnd(s, i + 2);
  if (c === '"' || c === "'" || c === "`") return quotedEnd(s, i + 1, c);
  if (c === "[" || c === "{") return bracketEnd(s, i);
  // After `:` a bare value runs to , ; } or the line end; after `=` / `=>` it is ONE token to whitespace, & or ; (r4, d9: a comma,
  // brace, quote or backslash inside the token is still the credential's: `password=ab,SECRET`, `password=\\hunter2`).
  const stop = s.slice(i).search(sep === ":" ? /[,;}\r\n]/ : /[\s&;]/);
  return stop < 0 ? s.length : i + stop;
}

/** Every credential pair's value cut; null when a value can't be bounded (an unclosed bracket) or a key is left behind. */
function cutCredentials(s: string): string | null {
  let out = "";
  let at = 0;
  PAIR_RE.lastIndex = 0;
  for (let m = PAIR_RE.exec(s); m !== null; m = PAIR_RE.exec(s)) {
    const [whole, quote, key, sep] = m as unknown as [string, string, string, string];
    if (!isCredentialKey(key, sep)) {
      PAIR_RE.lastIndex = m.index + whole.length;
      continue;
    }
    const end = valueEnd(s, m.index + whole.length, key, sep);
    if (end < 0) return null;
    out += s.slice(at, m.index) + (sep === ":" ? `${quote}${key}${quote}: [redacted]` : "[redacted]");
    at = end;
    PAIR_RE.lastIndex = end;
  }
  out += s.slice(at);
  LEFT_RE.lastIndex = 0;
  for (let m = LEFT_RE.exec(out); m !== null; m = LEFT_RE.exec(out)) if (isCredentialKey(m[1]!, m[2]!)) return null;
  return out;
}

/** A Basic credential is base64-looking (a digit, + / =, or mixed case); "basic authentication is disabled" is text. */
function cutBasic(s: string): string {
  return s.replace(/\bbasic\s+([A-Za-z0-9+/]{8,}={0,2})/gi, (all, b64: string) =>
    /[0-9+/=]/.test(b64) || (/[a-z]/.test(b64) && /[A-Z]/.test(b64)) ? "[credential]" : all,
  );
}

/** The cleaner's own placeholders, neutralised before the residue read (they name a cut, not a credential). */
const PLACEHOLDER_RE = /\/rfp-review\/\[link\]|\[(?:redacted|credential field|credential|token|email|link)\]/gi;
/** A word run (a key or a word); the scan is one linear pass. */
const RUN_RE = /[A-Za-z0-9_.-]+/g;
/** A separator right after a run: up to 4 closers, then `:`, `=` or `=>`. */
const SEP_AFTER_RE = /^[\]\\"'`)]{0,4}\s{0,4}(=>?|:)/;

/**
 * r4 (d6's ruling D6-RULING-139-CLEANER-FAIL-CLOSED, after d9's round 3): per-shape cutting does not converge, so after the passes
 * the CLEANED text is read for residue and the whole message is dropped (null) when ANY of these is still there:
 * (1) a credential word as a key segment: a run followed by a separator (`Bearer: x`, a kept `password: [redacted]`, an
 *     80+-character key), or a multi-segment run holding one (`refreshToken`, `db_password`, `x-api-key`) with or without one;
 *     a single prose word ("client secret expired", "Token has been expired") is not a key;
 * (2)+(3) any scheme's userinfo, query or fragment (`scheme://…@`, `…?`, `…#`), raw or %2F / \/-encoded;
 * (4) an rfp-review link in any form other than the cut `/rfp-review/[link]` (raw, %2F, \/, &#x2F;).
 * The error code carries the signal; dropping a message costs little, leaking one costs a lot.
 */
/** A single credential word (not a key run): the segment list, a plural of one, `basic`, or a long credential word. `code` is not one. */
function isCredentialWord(run: string): boolean {
  const w = run.toLowerCase();
  return SEGMENT_WORDS.has(w) || (w.endsWith("s") && SEGMENT_WORDS.has(w.slice(0, -1))) || w === "basic" || RUN_WORDS.test(w);
}

/** r4b (d6's ruling D6-RULING-139-R4-VALUE-SHAPE): a token that looks like a value, not prose: a digit, mixed case, 16+ key characters, or
 * (r4c) an internal symbol other than a letter, apostrophe or hyphen (`p@ss!word`). */
function looksLikeValue(token: string): boolean {
  const v = token.replace(/^[(\[{'"`]+/, "").replace(/[.,;:!?)\]}'"`]+$/, "");
  return /\d/.test(v) || (/[a-z]/.test(v) && /[A-Z]/.test(v)) || /^[A-Za-z0-9+/=_-]{16,}$/.test(v) || /[^A-Za-z'\u2019-]/.test(v);
}

function hasResidue(s: string): boolean {
  const t = s.replace(PLACEHOLDER_RE, " ");
  if (/rfp[-_ ]?review/i.test(t)) return true;
  if (/[a-z][a-z0-9+.-]*:(?:\/\/|%2f%2f|\\\/\\\/)\S*?[@?#]/i.test(t)) return true;
  RUN_RE.lastIndex = 0;
  for (let m = RUN_RE.exec(t); m !== null; m = RUN_RE.exec(t)) {
    const run = m[0].replace(/^[_.-]+|[_.-]+$/g, "");
    if (run === "") continue;
    const sep = SEP_AFTER_RE.exec(t.slice(m.index + m[0].length, m.index + m[0].length + 12));
    if (sep && isCredentialKey(run, sep[1]!)) return true;
    // r4b: a single credential word, whitespace (the text is collapsed to one space; tab / NBSP / newline included), then a
    // token shaped like a value (`password hunter2`, `token abc123def`, `Authorization Basic …`) leaves the value. Prose after it
    // ("client secret expired", "Token has been expired") stays; a misfire like `token 2 of 3` drops, the safe direction.
    // ...after spaces and punctuation, mixed, up to 12 (r4c, d9: `password,hunter2`, `(password) hunter2`, `password -> hunter2`,
    // `token | abc123def`, a fullwidth colon); a trailing . _ - is not part of the word. Not . ! ? (a new sentence may start
    // with a capital: `Invalid token. Please sign in again.` stays) or ASCII : / = (the separator rule's).
    const next = /(?: |[^\sA-Za-z0-9.!?:=]){1,12}([^ ]{1,80})/y;
    next.lastIndex = m.index + m[0].replace(/[_.-]+$/, "").length;
    const token = next.exec(t);
    if (token && isCredentialWord(run) && looksLikeValue(token[1]!)) return true;
    const segments = run.split(/[_.-]+/).flatMap((part) =>
      part.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(" "),
    );
    // ":" so a bare `code` segment (status_code, error_code) is not read as `code=`; every other credential word still counts.
    if (segments.filter((w) => w !== "").length >= 2 && isCredentialKey(run, ":")) return true;
  }
  return false;
}

/**
 * The most of a raw message any pass sees: the output is capped at 200 anyway, and a cut message drops its last, partial
 * token (a split email or URL is not left half-redacted).
 */
export const SAFE_MESSAGE_INPUT_MAX = 2000;

export function safeMessage(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let head = raw.slice(0, SAFE_MESSAGE_INPUT_MAX);
  if (raw.length > SAFE_MESSAGE_INPUT_MAX) head = head.replace(/\S*$/, "");
  const cut = cutCredentials(
    cutBasic(
      head
        // URL userinfo before the email rule, which would otherwise keep the user and cut only "pass@host".
        .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi, "$1")
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
        .replace(/\bbearer\s+\S+/gi, "[credential]"),
    ).replace(/eyJ[A-Za-z0-9_.-]{10,}/g, "[token]"),
  );
  if (cut === null) return null;
  let s = cut
    // Anywhere in a key (my_access_token), so a kept key name can't trip the guard and drop the whole message.
    .replace(/(?:access|refresh)_token/gi, "[credential field]")
    // An RFP review link's token segment never leaves (owner rule: no vote / approval link).
    .replace(/\/rfp-review\/[^\s/?#]+/gi, "/rfp-review/[link]")
    .replace(/(https?:\/\/[^\s?]*)\?\S*/g, "$1")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (hasResidue(s)) return null;
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
