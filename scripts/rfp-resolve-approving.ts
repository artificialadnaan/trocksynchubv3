/**
 * Resolve a SyncHub RFP request stuck in `approving` (runbook r5 §3; S0b-2b). Ops only, under an a4 GO that names the id.
 *
 *   npx tsx scripts/rfp-resolve-approving.ts --id <requestId>                                   # dry-run (default): prints, writes nothing
 *   npx tsx scripts/rfp-resolve-approving.ts --id <requestId> --apply --resolution found --project <procoreProjectId>
 *   npx tsx scripts/rfp-resolve-approving.ts --id <requestId> --apply --resolution recreate
 *
 * The logic lives in server/sync/rfp-resolve-approving.ts. Its own Procore searches use the token as stored and NEVER renew
 * it: an expired token stops the run with `error`. `--resolution recreate` re-enters the app's normal create step, so it
 * refuses unless the stored token has RECREATE_MIN_TOKEN_MS (35 min) left: the create step then never reaches a renewal (d9 QC).
 * Exit 0 = a dry-run that reached a decision, or an applied resolution; 1 = refused / STOP; 2 = bad arguments.
 */
import { applyResolveApproving, dryRunResolveApproving, parseResolveArgs } from "../server/sync/rfp-resolve-approving";

const USAGE = "usage: rfp-resolve-approving.ts --id <requestId> [--apply --resolution found --project <id> | --apply --resolution recreate]";

async function main(): Promise<number> {
  const args = parseResolveArgs(process.argv.slice(2));
  if ("error" in args) {
    console.error(`rfp-resolve-approving: ${args.error}\n${USAGE}`);
    return 2;
  }
  const { pool } = await import("../server/db");
  const { storage } = await import("../server/storage");
  const { DEFAULT_PROCORE_COMPANY_ID } = await import("../server/constants");
  const { acquireRateLimitToken } = await import("../server/procore-rate-limiter");
  const { fetchWithTimeout } = await import("../server/lib/fetch-with-timeout");
  const { finaliseApprovingFound, recreateApprovingRequest } = await import("../server/rfp-approval");

  // Company + environment only, straight from the stored Procore config row: the client secret is never read or decrypted.
  const config = ((await pool.query(
    `SELECT value->>'companyId' AS company_id, value->>'environment' AS environment FROM automation_config WHERE key = 'procore_config'`,
  )).rows[0] ?? {}) as { company_id?: string | null; environment?: string | null };
  const companyId = String(config.company_id || DEFAULT_PROCORE_COMPANY_ID);
  const procoreBaseUrl = config.environment === "sandbox" ? "https://sandbox.procore.com" : "https://api.procore.com";

  const deps = {
    db: pool,
    readStoredToken: async () => {
      const t = await storage.getOAuthToken("procore");
      if (!t) return undefined;
      return { accessToken: t.accessToken ?? null, expiresAt: t.expiresAt ? new Date(t.expiresAt) : null };
    },
    procoreGet: async (url: string, accessToken: string) => {
      await acquireRateLimitToken();
      const res = await fetchWithTimeout(url, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "Procore-Company-Id": companyId },
      });
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      return { status: res.status, data };
    },
    procoreBaseUrl,
    companyId,
    out: (line: string) => console.log(line),
    finaliseFound: finaliseApprovingFound,
    recreate: recreateApprovingRequest,
    ...((process.env.BIDBOARD_CRM_ALERT_RECIPIENT ?? "").trim()
      ? { alert: { recipient: process.env.BIDBOARD_CRM_ALERT_RECIPIENT!.trim(), send: (await import("../server/email-service")).sendEmail as any } }
      : {}),
  };

  try {
    if (!args.apply) {
      const report = await dryRunResolveApproving(args.id, deps);
      return report.refused || report.decision === "C_stop" ? 1 : 0;
    }
    const res = await applyResolveApproving(args, deps);
    return res.applied ? 0 : 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`rfp-resolve-approving: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
