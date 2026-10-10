// Recipient-bound RFP review links (#47).
//
// One RFP has ONE request token, and every routed approver used to get the same /rfp-review/<token> link, then TYPE
// an email the approve/decline routes checked against the LIVE approver config. A forwarded or leaked link plus a
// guessable approver address therefore passed. Each link a recipient receives (the review email and the evening
// pending digest, both already sent one recipient at a time) now carries
//
//   ?r=<base64url(recipient)>.<base64url(HMAC-SHA256(key, token + "\n" + recipient))>
//
// and approve/decline act AS that signed recipient: there is no typed email any more.
//  - The signature IS the send-time snapshot: only an address the RFP was actually sent to can act for its routed
//    type, whatever the live config says now. (A project type EDITED on the page is still checked live; no snapshot
//    exists for a type the RFP was not routed by.)
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

function mac(key: Buffer, token: string, recipient: string): Buffer {
  return crypto.createHmac("sha256", key).update(`${token}\n${recipient}`, "utf8").digest();
}

/** The `r` value for one recipient of one RFP token. */
export function signRecipientLink(token: string, email: string, secret: string | undefined = process.env.SESSION_SECRET): string {
  const recipient = normalizeRecipient(email);
  if (!recipient) throw new Error("A recipient email is required to sign an RFP review link");
  const key = linkKey(secret);
  return `${Buffer.from(recipient, "utf8").toString("base64url")}.${mac(key, token, recipient).toString("base64url")}`;
}

/** The recipient a valid `r` was issued to for this token, or null (missing, malformed, wrong token, forged). */
export function verifyRecipientLink(
  token: string,
  r: unknown,
  secret: string | undefined = process.env.SESSION_SECRET,
): string | null {
  if (typeof r !== "string" || r.length > 2048) return null;
  const dot = r.indexOf(".");
  if (dot <= 0 || dot !== r.lastIndexOf(".")) return null;
  let recipient: string;
  let given: Buffer;
  try {
    recipient = Buffer.from(r.slice(0, dot), "base64url").toString("utf8");
    given = Buffer.from(r.slice(dot + 1), "base64url");
  } catch {
    return null;
  }
  if (!recipient || recipient !== normalizeRecipient(recipient)) return null;
  let key: Buffer;
  try {
    key = linkKey(secret);
  } catch {
    return null;
  }
  const expected = mac(key, token, recipient);
  if (given.length !== expected.length) return null;
  return crypto.timingSafeEqual(given, expected) ? recipient : null;
}

/** The review URL one recipient receives. */
export function recipientReviewUrl(baseUrl: string, token: string, email: string, secret?: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/rfp-review/${token}?r=${signRecipientLink(token, email, secret)}`;
}
