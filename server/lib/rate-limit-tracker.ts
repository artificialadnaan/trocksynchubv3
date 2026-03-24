/**
 * Rate Limit Tracker
 * Tracks API rate limit state from response headers for HubSpot and Procore.
 * Provides backpressure delays when approaching limits.
 */

export interface RateLimitState {
  remaining: number | null;
  limit: number | null;
  resetAt: number | null; // epoch ms
  lastUpdated: number;
  provider: string;
}

const rateLimitState: Record<string, RateLimitState> = {
  hubspot: { remaining: null, limit: null, resetAt: null, lastUpdated: 0, provider: "hubspot" },
  procore: { remaining: null, limit: null, resetAt: null, lastUpdated: 0, provider: "procore" },
};

/**
 * Parse rate limit headers from API response and update in-memory state.
 * HubSpot uses: X-HubSpot-RateLimit-Daily-Remaining, X-HubSpot-RateLimit-Daily
 * Procore uses: X-Rate-Limit-Remaining, X-Rate-Limit-Limit
 */
export function updateRateLimits(provider: "hubspot" | "procore", headers: Headers | Record<string, string>): void {
  const get = (name: string): string | null => {
    if (headers instanceof Headers) return headers.get(name);
    // Plain object (case-insensitive lookup)
    const lower = name.toLowerCase();
    for (const [key, val] of Object.entries(headers)) {
      if (key.toLowerCase() === lower) return val;
    }
    return null;
  };

  let remaining: number | null = null;
  let limit: number | null = null;
  let resetAt: number | null = null;

  if (provider === "hubspot") {
    const rem = get("X-HubSpot-RateLimit-Daily-Remaining") || get("X-HubSpot-RateLimit-Remaining");
    const lim = get("X-HubSpot-RateLimit-Daily") || get("X-HubSpot-RateLimit-Max");
    remaining = rem ? parseInt(rem, 10) : null;
    limit = lim ? parseInt(lim, 10) : null;
  } else if (provider === "procore") {
    const rem = get("X-Rate-Limit-Remaining") || get("RateLimit-Remaining");
    const lim = get("X-Rate-Limit-Limit") || get("RateLimit-Limit");
    const reset = get("X-Rate-Limit-Reset") || get("RateLimit-Reset");
    remaining = rem ? parseInt(rem, 10) : null;
    limit = lim ? parseInt(lim, 10) : null;
    resetAt = reset ? parseInt(reset, 10) * 1000 : null; // convert to ms
  }

  if (remaining !== null || limit !== null) {
    rateLimitState[provider] = {
      remaining,
      limit,
      resetAt,
      lastUpdated: Date.now(),
      provider,
    };
  }
}

/**
 * Get current rate limit state for all providers.
 */
export function getRateLimitStates(): Record<string, RateLimitState> {
  return { ...rateLimitState };
}

/**
 * Calculate backpressure delay in ms based on current rate limit state.
 * Procore allows 100 requests per 60s. Throttle aggressively to avoid 429s.
 */
export function getBackpressureDelay(provider: "hubspot" | "procore"): number {
  const state = rateLimitState[provider];
  if (!state || state.remaining === null || state.limit === null || state.limit === 0) return 0;

  const ratio = state.remaining / state.limit;
  if (ratio < 0.05) return 10000; // < 5% remaining: wait 10s
  if (ratio < 0.15) return 5000;  // < 15% remaining: wait 5s
  if (ratio < 0.30) return 2000;  // < 30% remaining: wait 2s
  if (ratio < 0.50) return 500;   // < 50% remaining: wait 500ms
  return 0;
}

/**
 * Apply backpressure delay if needed. Call before making API requests.
 */
export async function applyBackpressure(provider: "hubspot" | "procore"): Promise<void> {
  const delay = getBackpressureDelay(provider);
  if (delay > 0) {
    console.log(`[rate-limit] ${provider} backpressure: delaying ${delay}ms (remaining: ${rateLimitState[provider]?.remaining}/${rateLimitState[provider]?.limit})`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

/**
 * Fetch with automatic 429 retry. Waits for Retry-After header or defaults to 60s.
 * Max 3 retries before giving up.
 */
export async function fetchWithRateLimitRetry(
  url: string,
  options: RequestInit,
  provider: "hubspot" | "procore",
  maxRetries = 3
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await applyBackpressure(provider);
    const response = await fetch(url, options);

    if (response.status === 429 && attempt < maxRetries) {
      const retryAfter = response.headers.get("Retry-After");
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60000;
      console.log(`[rate-limit] ${provider} 429 rate limited — waiting ${Math.round(waitMs / 1000)}s before retry ${attempt + 1}/${maxRetries}`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      continue;
    }

    // Update rate limit state from response headers
    updateRateLimits(provider, response.headers);
    return response;
  }

  throw new Error(`${provider} rate limit: exceeded ${maxRetries} retries`);
}
