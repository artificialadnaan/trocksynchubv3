/**
 * Wrapper around fetch() that adds a timeout via AbortController.
 * Prevents API calls from hanging indefinitely.
 *
 * SCOPE, precisely: this timer can only bound the part of an exchange that ends when the Response
 * resolves — i.e. when the HEADERS arrive. It is cleared in the finally below, so a server that
 * answers and then stalls mid-body leaves the caller's `response.json()` running unguarded until
 * undici's own five-minute body timeout. That is not fixable here: a function that RETURNS a Response
 * cannot know when the caller has finished reading it.
 *
 * A caller whose deadline must outlive the headers therefore owns its own AbortController and passes
 * `options.signal` (see server/sync/core-ingress-client.ts, whose 5 s bound has to cover the body read
 * because the Core handoff is awaited in front of the Procore create). fetch() is given OUR signal,
 * not theirs, so an abort on the caller's signal is forwarded onto it — otherwise their deadline could
 * never reach the request at all.
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = 30000
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const callerSignal = options.signal;
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    // Deliberately NOT detached when this function returns: the caller's deadline has to keep reaching
    // the request while it reads the body, which is the entire point. `once` disposes of it after
    // firing, and an unfired one dies with the signal — so the contract is a PER-REQUEST signal (one
    // controller per exchange, as core-ingress-client creates), not a long-lived shared one, which
    // would accumulate a listener per in-flight call.
    else callerSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error: any) {
    if (error.name === 'AbortError') {
      throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
