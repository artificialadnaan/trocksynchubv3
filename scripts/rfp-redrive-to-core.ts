/**
 * ONE-DEAL operator re-drive of an approval already created on Procore to Core (REDRIVE-DESIGN.r2; S1b). Ops only, under an
 * a4 GO that names the deal. No bulk mode.
 *
 *   npx tsx scripts/rfp-redrive-to-core.ts --deal <crm deal id> --source-event-id <id> --go <a4 GO id> --actor <name>   # dry-run
 *   npx tsx scripts/rfp-redrive-to-core.ts ... --actor <name> --apply                                                  # writes
 *   For an approval decided before CRM PR-B (its stored E1 has no office / approvalKind / approval block), each is REQUIRED
 *   and attested by the GO: --office dallas|atlanta --approval-kind vote --approval-evidence <json file>
 *   (the evidence: {roundEventId, approvals, rejections, invitedVoterCount, decidedAt, source:"<path> <sha256>"}; the
 *   source is recorded, never opened).
 *
 * The logic lives in server/sync/rfp-redrive-to-core.ts. It never calls Procore or Core: the Core receiver flag is attested
 * by the GO. Exit 0 = a dry-run whose preconditions all pass, or an applied re-drive; 1 = refused; 2 = bad arguments.
 */
import { runRedriveToCore } from "../server/sync/rfp-redrive-to-core";

async function main(): Promise<number> {
  const { db, pool } = await import("../server/db");
  try {
    const res = await runRedriveToCore(process.argv.slice(2), { db: db as any, out: (line) => console.log(line) });
    return res.code;
  } finally {
    await pool.end().catch(() => {});
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`rfp-redrive-to-core: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
