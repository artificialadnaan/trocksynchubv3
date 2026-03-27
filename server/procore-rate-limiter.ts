/**
 * Procore Rate Limiter
 * ====================
 * Token bucket rate limiter for Procore API calls.
 * Max 50 requests/minute (safe margin under Procore's ~60/min = 3,600/hr limit).
 * Queues requests when at capacity instead of rejecting them.
 */

const MAX_TOKENS = 50;          // burst capacity
const REFILL_RATE = 50;         // tokens per minute
const REFILL_INTERVAL_MS = 60 * 1000;
const QUEUE_WARN_THRESHOLD = 10; // log warning when queue depth hits this

interface QueueItem {
  resolve: () => void;
}

let tokens = MAX_TOKENS;
let queueDepth = 0;
const waitQueue: QueueItem[] = [];

// Refill tokens every minute
setInterval(() => {
  tokens = MAX_TOKENS;
  // Drain the queue — wake up waiting callers up to the new token count
  while (tokens > 0 && waitQueue.length > 0) {
    const item = waitQueue.shift()!;
    tokens--;
    queueDepth--;
    item.resolve();
  }
}, REFILL_INTERVAL_MS);

/**
 * Acquire a rate-limit token before making a Procore API call.
 * Returns immediately if tokens are available, otherwise waits in queue.
 */
export async function acquireRateLimitToken(): Promise<void> {
  if (tokens > 0) {
    tokens--;
    return;
  }

  // No tokens — enqueue and wait for next refill cycle
  queueDepth++;
  if (queueDepth >= QUEUE_WARN_THRESHOLD) {
    console.warn(`[procore-rate-limiter] Queue depth ${queueDepth} — Procore API requests are backing up`);
  }

  return new Promise<void>((resolve) => {
    waitQueue.push({ resolve });
  });
}

/**
 * Wraps a fetch call with rate limit token acquisition.
 * Drop-in replacement for fetch() for all Procore API calls.
 */
export async function rateLimitedFetch(url: string, options: RequestInit): Promise<Response> {
  await acquireRateLimitToken();
  return fetch(url, options);
}

/**
 * Returns current rate limiter state for diagnostics.
 */
export function getRateLimiterState(): { tokens: number; queueDepth: number; maxTokens: number } {
  return { tokens, queueDepth, maxTokens: MAX_TOKENS };
}

// ─── Webhook-updated project tracking ────────────────────────────────────────

const webhookUpdatedProjects = new Set<string>();

/**
 * Mark a project ID as having been updated via webhook in the current polling interval.
 * Call this from webhooks.ts when a Procore project webhook is processed.
 */
export function markProjectWebhookUpdated(projectId: string): void {
  webhookUpdatedProjects.add(projectId);
}

/**
 * Returns true if this project was updated via webhook since the last polling cycle.
 */
export function wasProjectWebhookUpdated(projectId: string): boolean {
  return webhookUpdatedProjects.has(projectId);
}

/**
 * Clear the webhook-updated set after a polling cycle completes.
 */
export function clearWebhookUpdatedProjects(): void {
  const count = webhookUpdatedProjects.size;
  webhookUpdatedProjects.clear();
  if (count > 0) {
    console.log(`[procore-rate-limiter] Cleared ${count} webhook-updated project IDs after polling cycle`);
  }
}
