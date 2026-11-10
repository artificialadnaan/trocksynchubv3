/**
 * RFP Phase 2, S1a: the two signed POSTs the Core path makes (E2 / E5 to Core, E4 / N1 to the CRM).
 * S1a RED: exported stubs only, no behaviour (nothing is sent). GREEN implements them.
 */
export const RFP_CORE_HTTP_DEADLINE_MS = 10_000;

export type FetchLike = (url: string, init: RequestInit, timeoutMs?: number) => Promise<Response>;

export type PostResult =
  | { kind: "response"; status: number; body: unknown }
  | { kind: "transport"; error: string };

export async function postCoreSigned(
  _input: { targetUrl: string; domain: string; rawBody: string; secret: string },
  _deps: { fetchImpl?: FetchLike } = {},
): Promise<PostResult> {
  return { kind: "transport", error: "not implemented (S1a RED stub)" };
}

export async function postCrmSigned(
  _input: { targetUrl: string; rawBody: string; secret: string },
  _deps: { fetchImpl?: FetchLike } = {},
): Promise<PostResult> {
  return { kind: "transport", error: "not implemented (S1a RED stub)" };
}
