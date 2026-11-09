/**
 * RFP Phase 2 routing (CONTRACT v2.2 §2): which destination an approved RFP's create command goes to.
 *
 * ROUTE(r) = "core" iff ALL hold, else "procore" (today's behaviour):
 *   (a) RFP_NONSERVICE_DESTINATION === "core";
 *   (b) the command arrived on create-from-rfp, sourceSystem "trock_crm", decision "approved";
 *   (c) approvalKind === "vote" (a genuine CRM 2-of-3 vote; overrides / email / HubSpot never route to Core);
 *   (d) the effective type digit ≠ "4" (the number's digit wins, as the create worker derives it; service keeps its path);
 *   (e) the project number is CRM-format, matched exactly on the wire value.
 * Pure: no I/O. Evaluated at first arrival (the stamp) and again on every re-attempt (the HELD rule).
 */
import { parseProjectTypeFromNumber } from "../constants";

export type RfpDestination = "procore" | "core";

/** The CRM generator's strict canonical form (CRM project-number-validation.ts:11-12). No case folding. */
export const CRM_FORMAT_PROJECT_NUMBER_RE = /^(DFW|ATL)-[1-9]-[0-9]{5}-[a-z]+$/;

export type RfpCreateIngress = "create-from-rfp" | "rfp-request" | "override" | "hubspot";

export interface RouteInput {
  ingress: RfpCreateIngress;
  sourceSystem: string;
  decision?: string | null;
  approvalKind?: string | null;
  deal: { projectNumber?: string | null; projectType?: string | null };
}

/** The raw setting as read from the environment (unset ⇒ undefined ⇒ procore). */
export function rfpNonserviceDestinationSetting(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.RFP_NONSERVICE_DESTINATION;
}

export function effectiveTypeDigit(deal: RouteInput["deal"]): string | null {
  return parseProjectTypeFromNumber(deal.projectNumber ?? "") ?? (deal.projectType?.trim() || null);
}

export function routeRfpCreate(r: RouteInput, setting: string | undefined): RfpDestination {
  if (setting !== "core") return "procore"; // (a)
  if (r.ingress !== "create-from-rfp" || r.sourceSystem !== "trock_crm" || r.decision !== "approved") return "procore"; // (b)
  if (r.approvalKind !== "vote") return "procore"; // (c)
  if (effectiveTypeDigit(r.deal) === "4") return "procore"; // (d)
  const n = r.deal.projectNumber;
  if (typeof n !== "string" || !CRM_FORMAT_PROJECT_NUMBER_RE.test(n)) return "procore"; // (e)
  return "core";
}

/** The command-row status of a core-stamped create: never claimable by the Procore worker (claim filters destination). */
export const RFP_ROUTED_CORE_STATUS = "routed_core";
/** The command-row status when a re-attempt's stamp ≠ ROUTE NOW (§2 HELD). A person resolves it. */
export const RFP_HELD_DESTINATION_CHANGED_STATUS = "held_destination_changed";
/** A create held because the deal already has the OTHER destination's footprint (§10). A person resolves it. Used on the
 *  command row (a procore create) and on the Core row (a core create; the command row then stays routed). */
export const RFP_HELD_CROSS_DESTINATION_STATUS = "held_cross_destination";
