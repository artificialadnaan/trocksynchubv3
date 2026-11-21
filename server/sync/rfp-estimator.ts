// L69 (a4 40810897, OK a92858a3): THE ESTIMATOR AN APPROVAL HANDS T-ROCK CORE, resolved ONCE by the approval (so its status email and its
// review page can say what happened) and passed to the handoff as `estimatorEmail`.
//
//   - The CRM's confirmed assignment first: the email the CRM sent with the RFP (#1869, from its deals.estimator_user_id), kept at intake as
//     deal_data.estimator_email, while the approval did not change the estimator. "Did not change" uses the handoff's own field rule
//     (effectiveField: a trimmed non-empty edit wins, else the stored value), so no edit, a blank edit, or the same name re-picked keeps it.
//   - Otherwise the picked name's EXACT estimator_list entry (resolveSelectedEstimatorEmail's rule, as before).
//   - No email either way is never silent: one plain line. The RFP still goes (warn, not wait): "the handoff is never blocked"
//     (service-rfp-core-outbox.ts), and Core seats the owner only, the card reading "Estimator: Not set" until a person sets it.
import { log } from "../log"; // never "../index": that boots the server

export const ESTIMATOR_WARNING = {
  noListEmail: "This estimator has no email in SyncHub's estimator list; add it there, or pick another.",
  none: "No estimator was picked; set one on the bid in T-Rock Core.",
  listUnreadable: "SyncHub's estimator list can't be read right now; set the estimator on the bid in T-Rock Core.",
} as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL = 320;

/** An estimator email as Core takes it: trimmed, lower-cased, a plain address; anything else is null. */
export function validEstimatorEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email && email.length <= MAX_EMAIL && EMAIL_RE.test(email) ? email : null;
}

export type ApprovalEstimator = { email: string | null; warning: string | null; source: "crm" | "list" | "none" };
export type ApprovalEstimatorInput = {
  rfpRequestId: number;
  dealData: Record<string, any>;
  editedFieldsOverride: Record<string, any>;
};

type EstimatorEntry = { name?: unknown; email?: unknown };

async function readEstimatorList(): Promise<EstimatorEntry[]> {
  const { storage } = await import("../storage");
  const config = await storage.getAutomationConfig("estimator_list");
  const estimators = (config?.value as { estimators?: unknown } | undefined)?.estimators;
  return Array.isArray(estimators) ? (estimators as EstimatorEntry[]) : [];
}

function effectiveEstimatorName(input: ApprovalEstimatorInput): string {
  const edited = input.editedFieldsOverride?.estimator;
  if (edited && String(edited).trim()) return String(edited).trim();
  return String(input.dealData?.estimator ?? "").trim();
}

export async function resolveApprovalEstimator(
  input: ApprovalEstimatorInput,
  readList: () => Promise<EstimatorEntry[]> = readEstimatorList,
): Promise<ApprovalEstimator> {
  const stored = String(input.dealData?.estimator ?? "").trim();
  const picked = effectiveEstimatorName(input);
  const crmEmail = validEstimatorEmail(input.dealData?.estimator_email);
  if (crmEmail && picked === stored) return { email: crmEmail, warning: null, source: "crm" };
  if (!picked) {
    log(`[rfp-estimator] RFP request ${input.rfpRequestId}: no estimator was picked and none was kept from the CRM; Core gets none`, "sync");
    return { email: null, warning: ESTIMATOR_WARNING.none, source: "none" };
  }
  let list: EstimatorEntry[];
  try {
    list = await readList();
  } catch (error: any) {
    log(`[rfp-estimator] RFP request ${input.rfpRequestId}: estimator_list unavailable (${error?.message || error}); Core gets no estimator`, "sync");
    return { email: null, warning: ESTIMATOR_WARNING.listUnreadable, source: "none" };
  }
  const hit = list.find((e) => typeof e?.name === "string" && e.name.trim() === picked);
  const email = validEstimatorEmail(hit?.email);
  if (!email) {
    log(`[rfp-estimator] RFP request ${input.rfpRequestId}: the picked estimator has no estimator_list email; Core gets none`, "sync");
    return { email: null, warning: ESTIMATOR_WARNING.noListEmail, source: "none" };
  }
  return { email, warning: null, source: "list" };
}
