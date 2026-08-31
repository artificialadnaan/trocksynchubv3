// The signed POST to TROCK Core's approved-service-RFP ingress.
//
// Core's route is POST /webhooks/crm/:office/service-rfp/v1 and its authentication differs from every
// other outbound call SyncHub makes, in three ways that are easy to get wrong:
//
//  1. The header is `x-trock-signature`, NOT SyncHub's usual `x-rfp-request-signature`. Core reads
//     only the former, and reads exactly ONE canonical `sha256=<64 lowercase hex>` value.
//  2. The signed preimage is DOMAIN-SEPARATED: domain ‖ 0x00 ‖ method ‖ 0x00 ‖ path ‖ 0x00 ‖ body.
//     Core has a second ingress (won-deals) on the same router; without the binding, a value pasted
//     into both secret slots at provisioning time would make the two routes signature-interchangeable.
//  3. Core enforces a 32-byte minimum secret, so a shorter one can never verify. We refuse to send
//     rather than emit a request that is guaranteed to 401.
import crypto from "crypto";
import { fetchWithTimeout } from "../lib/fetch-with-timeout";

export const SERVICE_RFP_CONTRACT_VERSION = "trock.crm.service-rfp-approved.v1";

/** Core's own minimum. Enforced here so a short secret fails loudly at the producer, not as a 401. */
const MIN_INGRESS_SECRET_BYTES = 32;

/** Core is on the critical path of an email approval; 5 s then fall through to the retry worker. */
export const SERVICE_RFP_INGRESS_TIMEOUT_MS = 5_000;

export interface ServiceRfpAddress {
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

/** The exact wire body Core's parser accepts — an exact key set, no extras. */
export interface ServiceRfpApprovedBody {
  version: typeof SERVICE_RFP_CONTRACT_VERSION;
  office: string;
  occurredAt: string;
  rfp: { requestId: number; approvedAt: string };
  deal: { id: string; rfpProjectNumber: string };
  company: { id: string; name: string };
  primaryContact: { name: string; email: string; businessPhone: string | null };
  bid: {
    title: string;
    estimatedValue: string | null;
    dueAt: string | null;
    description: string | null;
    notes: string | null;
  };
  property: { id: string; name: string; address: ServiceRfpAddress | null };
}

export function buildServiceRfpIngressTargetUrl(
  office: string,
  baseUrl = process.env.CORE_INGRESS_BASE_URL,
): string | null {
  const trimmed = baseUrl?.trim().replace(/\/+$/, "");
  if (!trimmed || !office) return null;
  // HTTPS ONLY. This body carries the customer's name, contact email and site address, and the HMAC
  // authenticates the bytes without concealing them — over plain http the whole payload is readable on
  // the wire. A misconfigured base URL is the realistic way that happens, so it is refused at the point
  // the URL is built rather than trusted to be right. Returning null keeps the feature inert, which is
  // the same shape an absent secret already takes.
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  return `${trimmed}/webhooks/crm/${encodeURIComponent(office)}/service-rfp/v1`;
}

/**
 * The current ingress secret, or null when it is absent or too short for Core to accept. Returning
 * null (rather than throwing) is what keeps this whole feature INERT until it is provisioned.
 */
export function resolveServiceRfpIngressSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = (env.SERVICE_RFP_INGRESS_SECRET_CURRENT ?? "").trim();
  if (!secret) return null;
  return Buffer.byteLength(secret, "utf8") >= MIN_INGRESS_SECRET_BYTES ? secret : null;
}

/**
 * `sha256=<hex>` over domain ‖ 0x00 ‖ method ‖ 0x00 ‖ path ‖ 0x00 ‖ rawBody.
 *
 * `path` must be the path actually requested, and `rawBody` the exact bytes actually sent — the
 * caller passes both from the same values it hands to fetch, never re-derived or re-serialized.
 */
export function signServiceRfpIngress(input: { path: string; rawBody: string; secret: string }): string {
  const NUL = Buffer.from([0]);
  const preimage = Buffer.concat([
    Buffer.from(SERVICE_RFP_CONTRACT_VERSION, "utf8"), NUL,
    Buffer.from("POST", "utf8"), NUL,
    Buffer.from(input.path, "utf8"), NUL,
    Buffer.from(input.rawBody, "utf8"),
  ]);
  return `sha256=${crypto.createHmac("sha256", input.secret).update(preimage).digest("hex")}`;
}

export type ServiceRfpIngressOutcome =
  /** Core accepted and created/adopted the bid. */
  | { kind: "sent"; status: number; bidId: string | null }
  /** Worth trying again unchanged — the row stays pending on the backoff schedule. */
  | { kind: "retryable"; status?: number; error: string }
  /** Will never be accepted as-is. The row goes terminal and an alert is raised. */
  | { kind: "terminal"; status?: number; error: string };

/**
 * Classify a Core response. The refusal shapes are load-bearing and deliberately NOT uniform:
 *
 *  - 404 means the ingress flag is still off (Core serves the route dark). That is a provisioning
 *    state an operator will flip, so it is RETRYABLE — treating it as terminal would dead-letter every
 *    approval made during the window between deploying SyncHub and flipping the flag.
 *  - 503 means Core has no secret yet — same reasoning.
 *  - 409 is a real conflict carrying a closed-vocabulary reason (live_project, job_type_diverged,
 *    contact_email_owned_elsewhere, company_inactive). Retrying cannot change it.
 *  - Any other deterministic 4xx (400/401/413/415) is a bad request or a bad signature; it will not be
 *    accepted as-is, so it is terminal and alerts, matching this repo's `request_rejected` posture.
 *
 * The body reads are best-effort by construction: a read that is malformed OR cut short by the
 * deadline in postServiceRfpApproved yields the same `{}`, so the STATUS decides the outcome in every
 * case. That is why a 2xx whose body never finished arriving is still `sent` — Core committed on the
 * status line — it merely carries no bidId.
 *
 * WHAT A REPOST ACTUALLY DOES, because the earlier wording here said it "would create a second bid" and
 * that has not been true since Core's ingress became idempotent. Core keys idempotency on
 * `serviceRfpSemanticDigest`, an ordered projection of what the delivery MEANS that deliberately EXCLUDES
 * `occurredAt` — the transport stamp this client re-stamps on every attempt. So a redelivery of the same
 * approval hashes identically and Core answers `outcome: "noop"` with the SAME bidId; only a genuine
 * correction (different semantic content) re-enters the newest-wins update path.
 *
 * That is load-bearing for the two ambiguous cases this classifier creates, and the reason neither needs an
 * in-flight state machine or a reconciliation pass:
 *   • a POST that TIMES OUT after Core committed is retried, and the retry is a no-op;
 *   • a 2xx whose local "mark sent" write fails leaves the row `pending`, and the worker's redelivery is a
 *     no-op too.
 * The stale claim mattered: read literally it says automatic retry is unsafe, which invites building
 * machinery against a problem Core already solved. `tests/service-rfp-core-redelivery.test.ts` pins both.
 */
async function classifyResponse(response: Response): Promise<ServiceRfpIngressOutcome> {
  if (response.ok) {
    const body = (await response.json().catch(() => ({}))) as { bidId?: unknown };
    return { kind: "sent", status: response.status, bidId: typeof body.bidId === "string" ? body.bidId : null };
  }

  if (response.status === 409) {
    const body = (await response.json().catch(() => ({}))) as { reason?: unknown };
    const reason = typeof body.reason === "string" ? body.reason : "unknown";
    return { kind: "terminal", status: 409, error: `Core refused the approval: ${reason}` };
  }

  // Every remaining branch ignores the body, so it must be DISCARDED rather than left dangling: an
  // unread response body keeps undici from reusing the connection, and the retryable branch below is the
  // one that repeats — a provisioning gap answering 404/503 on every attempt would leak a connection per
  // try until the dispatcher pool is exhausted.
  await response.body?.cancel().catch(() => {});

  if (response.status === 404 || response.status === 408 || response.status === 429 || response.status >= 500) {
    return { kind: "retryable", status: response.status, error: `Core ingress returned ${response.status}` };
  }

  return { kind: "terminal", status: response.status, error: `Core ingress rejected the request with ${response.status}` };
}

/**
 * POST one approved-service-RFP body. Never throws — a transport failure (unreachable host, DNS,
 * timeout) is an ordinary retryable outcome, because a Core problem must never reach the caller and
 * block the Procore create.
 *
 * The response body is read only for `bidId` and the conflict `reason`; nothing else about it, and
 * nothing about the request body or its signature, is returned or logged.
 */
export async function postServiceRfpApproved(
  input: { targetUrl: string; body: ServiceRfpApprovedBody; secret: string },
  deps: { fetchImpl?: typeof fetchWithTimeout } = {},
): Promise<ServiceRfpIngressOutcome> {
  const rawBody = JSON.stringify(input.body);
  // The signed path is read back off the URL we are about to request rather than rebuilt from the
  // office, so a base URL carrying a path prefix signs what Core will actually see.
  let path: string;
  try {
    path = new URL(input.targetUrl).pathname;
  } catch {
    return { kind: "terminal", error: `CORE_INGRESS_BASE_URL does not form a valid URL: ${input.targetUrl}` };
  }

  // ONE deadline over the WHOLE exchange — connect, headers AND body read. fetchWithTimeout's own
  // timer stops guarding the moment the Response resolves, which is when the headers land; a Core that
  // answered 200 and then stalled mid-body would leave classifyResponse's `response.json()` waiting on
  // undici's five-MINUTE body timeout. This call is awaited in front of the Playwright Bid Board
  // create, so that would not just delay Core — it would park the whole email approval behind a
  // stalled socket, which is precisely what the advertised 5 s bound exists to prevent.
  //
  // The deadline is owned HERE because only this function knows when the exchange is actually over.
  // Aborting (rather than abandoning the read) is what releases the connection: the signal is
  // forwarded onto the controller fetch() was given, so the pending body read rejects and the socket
  // is destroyed instead of lingering.
  const deadline = new AbortController();
  const expiry = setTimeout(() => deadline.abort(), SERVICE_RFP_INGRESS_TIMEOUT_MS);
  try {
    const response = await (deps.fetchImpl ?? fetchWithTimeout)(
      input.targetUrl,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-trock-signature": signServiceRfpIngress({ path, rawBody, secret: input.secret }),
        },
        body: rawBody,
        signal: deadline.signal,
      },
      SERVICE_RFP_INGRESS_TIMEOUT_MS,
    );
    return await classifyResponse(response);
  } catch (error: any) {
    return { kind: "retryable", error: error?.message || String(error) };
  } finally {
    // Both layers are told the same 5 s; clearing here keeps a fast success from leaving a live timer
    // behind it.
    clearTimeout(expiry);
  }
}
