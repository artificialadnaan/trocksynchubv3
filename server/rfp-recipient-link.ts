// Recipient-bound RFP review links (#47).
//
// One RFP has ONE request token, and every routed approver used to get the same /rfp-review/<token> link, then TYPE
// an email the approve/decline routes checked against the LIVE approver config. A forwarded or leaked link plus a
// guessable approver address therefore passed. Each link a recipient receives (the review email and the evening
// pending digest, both already sent one recipient at a time) now carries
//
//   ?r=<base64url(recipient)>.<base64url(routedType)>.<base64url(HMAC-SHA256(key, token + "\n" + recipient + "\n" + routedType))>
//
// and approve/decline act AS that signed recipient: there is no typed email any more.
//  - The signature IS the send-time snapshot: only an address the RFP was actually sent to can act for the project
//    type it was ROUTED by, whatever the live config says now. The routed type is signed INTO the capability
//    (Codex P1, round 2): the review page refreshes a HubSpot deal's data, project type included, so the type stored
//    on the request can change after the link went out. Any type other than the signed one (a refreshed type, or one
//    EDITED on the page) has no snapshot and is checked against the live config.
//  - FORWARDING IS DELEGATION: a forwarded signed link still acts as its ORIGINAL recipient (it is that person's
//    capability); the audit row records that recipient. Approvers should not forward review emails they would not
//    act on themselves.
//  - The key is HKDF-SHA256 over SESSION_SECRET with info "rfp-review-v1". Rotating SESSION_SECRET therefore
//    invalidates every outstanding review link (a known event: the next evening digest re-sends fresh links).
//  - An unsigned (pre-#47) link is refused; the digest re-sends signed links for every pending RFP.
import crypto from "node:crypto";

const HKDF_INFO = "rfp-review-v1";

function linkKey(secret: string | undefined): Buffer {
  if (!secret?.trim()) throw new Error("SESSION_SECRET is required to sign RFP review links");
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), HKDF_INFO, 32));
}

export function normalizeRecipient(email: string): string {
  return String(email ?? "").trim().toLowerCase();
}

/** The routed type as signed: the type digit resolveEffectiveRfpProjectType gave at send time, "" when it had none. */
export function normalizeRoutedType(type: string | null | undefined): string {
  return String(type ?? "").trim();
}

const ROUTED_TYPE_RE = /^[0-9A-Za-z_-]{0,16}$/;

function mac(key: Buffer, token: string, recipient: string, routedType: string): Buffer {
  return crypto.createHmac("sha256", key).update(`${token}\n${recipient}\n${routedType}`, "utf8").digest();
}

/** The `r` value for one recipient of one RFP token, routed (and so authorized) by `routedType`. */
export function signRecipientLink(
  token: string,
  email: string,
  routedType: string | null,
  secret: string | undefined = process.env.SESSION_SECRET,
): string {
  const recipient = normalizeRecipient(email);
  if (!recipient) throw new Error("A recipient email is required to sign an RFP review link");
  const type = normalizeRoutedType(routedType);
  if (!ROUTED_TYPE_RE.test(type)) throw new Error("Unsignable RFP routed type");
  const key = linkKey(secret);
  return [
    Buffer.from(recipient, "utf8").toString("base64url"),
    Buffer.from(type, "utf8").toString("base64url"),
    mac(key, token, recipient, type).toString("base64url"),
  ].join(".");
}

/** What a valid `r` grants: the recipient it was issued to, for the project type the RFP was routed by when sent. */
export type RecipientCapability = { recipient: string; routedType: string };

/** The capability a valid `r` carries for this token, or null (missing, malformed, wrong token, forged). */
export function verifyRecipientCapability(
  token: string,
  r: unknown,
  secret: string | undefined = process.env.SESSION_SECRET,
): RecipientCapability | null {
  if (typeof r !== "string" || r.length > 2048) return null;
  const parts = r.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[2]) return null;
  let recipient: string;
  let routedType: string;
  let given: Buffer;
  try {
    recipient = Buffer.from(parts[0], "base64url").toString("utf8");
    routedType = Buffer.from(parts[1], "base64url").toString("utf8");
    given = Buffer.from(parts[2], "base64url");
  } catch {
    return null;
  }
  if (!recipient || recipient !== normalizeRecipient(recipient)) return null;
  if (routedType !== normalizeRoutedType(routedType) || !ROUTED_TYPE_RE.test(routedType)) return null;
  let key: Buffer;
  try {
    key = linkKey(secret);
  } catch {
    return null;
  }
  const expected = mac(key, token, recipient, routedType);
  if (given.length !== expected.length) return null;
  return crypto.timingSafeEqual(given, expected) ? { recipient, routedType } : null;
}

/** The recipient a valid `r` was issued to for this token, or null. See verifyRecipientCapability. */
export function verifyRecipientLink(
  token: string,
  r: unknown,
  secret: string | undefined = process.env.SESSION_SECRET,
): string | null {
  return verifyRecipientCapability(token, r, secret)?.recipient ?? null;
}

/** The review URL one recipient receives. */
export function recipientReviewUrl(baseUrl: string, token: string, email: string, routedType: string | null, secret?: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/rfp-review/${token}?r=${signRecipientLink(token, email, routedType, secret)}`;
}
