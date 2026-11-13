/**
 * Tell the CRM about service RFPs a failed Procore create stranded (owner 2026-11-13, b0cb0c4f item 3; a4 afa14cfd). Ops
 * only, under an a4 GO after its dry-run preview.
 *
 *   npx tsx scripts/rfp-reconcile-approved-callbacks.ts            # dry-run (default): prints the plan, writes nothing
 *   npx tsx scripts/rfp-reconcile-approved-callbacks.ts --apply    # enqueues the CRM `approved` callback for willNotify
 *
 * A candidate is an APPROVED CRM request with no Procore project. It is told only when Core CONFIRMED its card and it has
 * no CRM callback yet; the statement and its idempotency live in server/sync/rfp-approved-callback.ts, shared with the
 * approval itself, so a second --apply enqueues nothing. A request whose Core handoff was refused or never happened, and a
 * non-service request, is listed and left untouched: a genuine Core gap stays visible for a person. No reset, no
 * re-approval, no Core write, no Procore call. Exit 0 = a plan printed / applied; 1 = an error; 2 = bad arguments.
 */
import { applyApprovedCallbackReconcile, planApprovedCallbackReconcile } from "../server/sync/rfp-approved-callback";

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== "--apply")) {
    console.error("usage: rfp-reconcile-approved-callbacks.ts [--apply]");
    return 2;
  }
  const apply = args.includes("--apply");
  const plan = await planApprovedCallbackReconcile();
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", plan }, null, 1));
  if (!apply) return 0;
  const enqueued = await applyApprovedCallbackReconcile(plan);
  console.log(JSON.stringify({ enqueued, skipped: plan.willNotify.filter((id) => !enqueued.includes(id)) }, null, 1));
  return 0;
}

main()
  .then(async (code) => {
    const { pool } = await import("../server/db");
    await pool.end().catch(() => {});
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(`rfp-reconcile-approved-callbacks: ${error?.message || error}`);
    process.exit(1);
  });
