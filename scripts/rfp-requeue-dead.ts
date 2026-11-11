/**
 * Requeue ONE dead RFP Core outbox row (CONTRACT v2.4 §10 "Requeue CLI"; S1b). Ops only; each --apply is its own a4 GO
 * naming the id.
 *
 *   npx tsx scripts/rfp-requeue-dead.ts --outbox create|followup --id <row id> --destination procore|core           # dry-run
 *   npx tsx scripts/rfp-requeue-dead.ts --outbox create|followup --id <row id> --destination procore|core --apply --go <GO>
 *
 * The logic lives in server/sync/rfp-requeue-dead.ts. Exit 0 = a dry-run whose checks all pass, or an applied requeue;
 * 1 = refused; 2 = bad arguments.
 */
import { runRequeueDead } from "../server/sync/rfp-requeue-dead";

async function main(): Promise<number> {
  const { db, pool } = await import("../server/db");
  try {
    const res = await runRequeueDead(process.argv.slice(2), { db: db as any, out: (line) => console.log(line) });
    return res.code;
  } finally {
    await pool.end().catch(() => {});
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`rfp-requeue-dead: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
