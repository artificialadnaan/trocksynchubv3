/**
 * Resolve a SyncHub RFP request stuck in `approving` (runbook r5 §3; S0b-2b). Ops only, under an a4 GO that names the id.
 *
 *   npx tsx scripts/rfp-resolve-approving.ts --id <requestId>                                   # dry-run (default): prints, writes nothing
 *   npx tsx scripts/rfp-resolve-approving.ts --id <requestId> --apply --resolution found --project <procoreProjectId>
 *   npx tsx scripts/rfp-resolve-approving.ts --id <requestId> --apply --resolution recreate
 *
 * The logic lives in server/sync/rfp-resolve-approving.ts. The Procore token is read as stored and NEVER refreshed.
 *
 * S0b-2b RED: stub.
 */
console.error("rfp-resolve-approving: not implemented (S0b-2b red)");
process.exit(2);
