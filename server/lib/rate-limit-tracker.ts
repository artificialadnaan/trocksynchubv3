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
 * Returns 0 if no delay needed, 1000 if < 10% remaining, 5000 if < 5% remaining.
 */
export function getBackpressureDelay(provider: "hubspot" | "procore"): number {
  const state = rateLimitState[provider];
  if (!state || state.remaining === null || state.limit === null || state.limit === 0) return 0;

  const ratio = state.remaining / state.limit;
  if (ratio < 0.05) return 5000;
  if (ratio < 0.10) return 1000;
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
