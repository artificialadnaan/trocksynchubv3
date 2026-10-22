/**
 * Shared, cross-replica record of consumed OAuth states (H4b follow-up to Codex P2 on #121, 68's ruling).
 * Railway deploys overlap old and new replicas, so an in-process map cannot decide "has this state been used". The authority is ONE
 * statement against the shared PostgreSQL: `INSERT ... ON CONFLICT DO NOTHING RETURNING`. The primary key makes the insert atomic across
 * replicas and connections: exactly one caller gets the row back; every other caller (any replica, any restart) gets nothing.
 * Only a sha256 of provider+state is stored, never the state itself. Rows are pruned once past their expiry.
 */
let ensured: Promise<void> | null = null;

async function getPool(): Promise<{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }> {
  // Imported lazily: ../db throws at import time without DATABASE_URL.
  return (await import("../db")).pool as any;
}

function ensureTable(pool: Awaited<ReturnType<typeof getPool>>): Promise<void> {
  // Additive and idempotent (this repo creates small tables at first use / startup instead of auto-applying migrations); retried after a failure.
  ensured ??= pool
    .query(
      `CREATE TABLE IF NOT EXISTS oauth_state_consumed (
         state_hash text PRIMARY KEY,
         expires_at_ms bigint NOT NULL
       )`,
    )
    .then(() => undefined)
    .catch((e) => {
      ensured = null;
      throw e;
    });
  return ensured;
}

/** True only for the single caller that recorded this state hash first. Throws if the shared store is unavailable (callers fail closed). */
export async function claimOAuthStateOnce(stateHash: string, expiresAtMs: number, nowMs: number): Promise<boolean> {
  const pool = await getPool();
  await ensureTable(pool);
  const res = await pool.query(
    `INSERT INTO oauth_state_consumed (state_hash, expires_at_ms) VALUES ($1, $2)
     ON CONFLICT (state_hash) DO NOTHING RETURNING state_hash`,
    [stateHash, expiresAtMs],
  );
  const won = res.rows.length === 1;
  if (won) {
    // Housekeeping only (correctness never depends on it): a pruned row is past its TTL, where the session's own expiry check already refuses.
    await pool.query(`DELETE FROM oauth_state_consumed WHERE expires_at_ms < $1`, [nowMs]).catch(() => undefined);
  }
  return won;
}
