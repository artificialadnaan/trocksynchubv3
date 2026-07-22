import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Bound every query so a wedged / failed-over / lock-contended Postgres can't hang a caller forever. The Bid
  // Board stage-sync cycle awaits recordPushOutcomeAndMaybeAlert (a few lightweight alert-state reads/upserts
  // plus an idempotent CREATE TABLE IF NOT EXISTS) INSIDE its `bidboardStageSyncRunning` guard; an unbounded
  // query there would hold the guard set and permanently starve every later interval (the guard clears only in
  // a finally after the await). This pool serves only lightweight OLTP + idempotent DDL, so a generous ceiling
  // bounds hangs without capping legitimate work; a timeout surfaces as an ordinary (already-swallowed) error.
  connectionTimeoutMillis: 10_000, // acquiring a connection from a wedged/failed-over server
  statement_timeout: 30_000, // server-side execution, incl. lock waits
  query_timeout: 30_000, // client-side per-query wait
});
export const db = drizzle(pool, { schema });
