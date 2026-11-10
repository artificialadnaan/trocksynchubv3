/**
 * RFP Phase 2, S1a: the two signed POSTs the Core path makes. Never throws: a transport failure (DNS, refused, timeout,
 * a redirect) is an ordinary `{ kind: "transport" }` result, which every drain classifies as retryable.
 *   - postCoreSigned (E2 / E5): `x-trock-signature` over domain ‖ 0x00 ‖ POST ‖ 0x00 ‖ path ‖ 0x00 ‖ raw body (signCoreIngress,
 *     core-ingress-client.ts), the path read back off the URL actually requested.
 *   - postCrmSigned (E4 / N1): bid-board-created's `x-rfp-request-signature: sha256=<HMAC(raw body)>` (signPayload,
 *     bidboard-callback-worker.ts; RFP_REQUEST_SYNC_SECRET = the CRM's SYNCHUB_SHARED_SECRET).
 * Both: redirect "error" (a 307/308 would replay the body and signature elsewhere) and ONE deadline over the whole
 * exchange, headers and body read (fetchWithTimeout's own timer stops at the headers; see core-ingress-client.ts).
 */
import { fetchWithTimeout } from "../lib/fetch-with-timeout";
import { signPayload } from "./bidboard-callback-worker";
import { signCoreIngress } from "./core-ingress-client";

/** One exchange, headers AND body, ends within this. The drains are sequential: one stall must not hold a tick. */
export const RFP_CORE_HTTP_DEADLINE_MS = 10_000;

export type FetchLike = (url: string, init: RequestInit, timeoutMs?: number) => Promise<Response>;

export type PostResult =
  | { kind: "response"; status: number; body: unknown }
  | { kind: "transport"; error: string };

async function postJson(
  targetUrl: string,
  rawBody: string,
  headers: Record<string, string>,
  deps: { fetchImpl?: FetchLike },
): Promise<PostResult> {
  const deadline = new AbortController();
  const expiry = setTimeout(() => deadline.abort(), RFP_CORE_HTTP_DEADLINE_MS);
  try {
    const response = await (deps.fetchImpl ?? fetchWithTimeout)(
      targetUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: rawBody,
        redirect: "error",
        signal: deadline.signal,
      },
      RFP_CORE_HTTP_DEADLINE_MS,
    );
    // Best effort: a malformed or cut-short body reads as {}, so the STATUS decides in every case.
    const text = await response.text().catch(() => "");
    let body: unknown = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
    return { kind: "response", status: response.status, body };
  } catch (error: any) {
    return { kind: "transport", error: error?.message || String(error) };
  } finally {
    clearTimeout(expiry);
  }
}

export async function postCoreSigned(
  input: { targetUrl: string; domain: string; rawBody: string; secret: string },
  deps: { fetchImpl?: FetchLike } = {},
): Promise<PostResult> {
  let path: string;
  try {
    path = new URL(input.targetUrl).pathname;
  } catch {
    return { kind: "transport", error: `not a valid URL: ${input.targetUrl}` };
  }
  const signature = signCoreIngress({ domain: input.domain, path, rawBody: input.rawBody, secret: input.secret });
  return postJson(input.targetUrl, input.rawBody, { "x-trock-signature": signature }, deps);
}

export async function postCrmSigned(
  input: { targetUrl: string; rawBody: string; secret: string },
  deps: { fetchImpl?: FetchLike } = {},
): Promise<PostResult> {
  return postJson(input.targetUrl, input.rawBody, { "x-rfp-request-signature": signPayload(input.rawBody, input.secret) }, deps);
}
