/**
 * RFP Phase 2 routing (CONTRACT v2.2 §2): which destination an approved RFP's create command goes to.
 *
 * ROUTE(r) = "core" iff ALL hold, else "procore" (today's behaviour):
 *   (a) RFP_NONSERVICE_DESTINATION === "core";
 *   (b) the command arrived on create-from-rfp, sourceSystem "trock_crm", decision "approved";
 *   (c) approvalKind === "vote" (a genuine CRM 2-of-3 vote; overrides / email / HubSpot never route to Core);
 *   (d) the effective type digit ≠ "4" (the number's digit wins, as the create worker derives it; service keeps its path);
 *   (e) the project number is CRM-format, matched exactly on the wire value;
 *   (f) the E1 office slug is in RFP_CORE_OFFICES (CONTRACT v2.4 c6 / c6.1), matched exactly on the wire value.
 *       LEGACY IMPLEMENTATION DETAIL, not a business rule (owner 2026-11-13, dcd308cf): DFW and ATL are project-number
 *       prefixes in ONE shared system, and every approved RFP reaches Core whatever its prefix. The CRM's office slugs
 *       (dallas, atlanta) both feed Core's one office, and production lists both (RFP_CORE_OFFICES=dallas,atlanta).
 * Pure: no I/O. Evaluated at first arrival (the stamp) and again on every re-attempt (the HELD rule).
 */
import { parseProjectTypeFromNumber } from "../constants";
import { log } from "../log";

export type RfpDestination = "procore" | "core";

/** The CRM generator's strict canonical form (CRM project-number-validation.ts:11-12). No case folding. */
export const CRM_FORMAT_PROJECT_NUMBER_RE = /^(DFW|ATL)-[1-9]-[0-9]{5}-[a-z]+$/;

export type RfpCreateIngress = "create-from-rfp" | "rfp-request" | "override" | "hubspot";

export interface RouteInput {
  ingress: RfpCreateIngress;
  sourceSystem: string;
  decision?: string | null;
  approvalKind?: string | null;
  /** E1's office slug (CRM resolveTenantOfficeSlug), e.g. "dallas". */
  office?: string | null;
  deal: { projectNumber?: string | null; projectType?: string | null };
}

/** The raw setting as read from the environment (unset ⇒ undefined ⇒ procore). */
export function rfpNonserviceDestinationSetting(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.RFP_NONSERVICE_DESTINATION;
}

/** The offices the Core path may serve (c6): exact lowercase slugs. Anything else in RFP_CORE_OFFICES is ignored. */
export const RFP_CORE_OFFICE_SLUGS: readonly string[] = ["dallas", "atlanta"];
const NO_CORE_OFFICES: ReadonlySet<string> = new Set();

/** RFP_CORE_OFFICES as a set: a comma list, each entry trimmed and lowercased; unset or empty ⇒ no office (everything procore). */
export function parseRfpCoreOffices(raw: string | undefined): { offices: ReadonlySet<string>; unknown: string[] } {
  const offices = new Set<string>();
  const unknown: string[] = [];
  for (const entry of (raw ?? "").split(",")) {
    const slug = entry.trim().toLowerCase();
    if (!slug) continue;
    if (RFP_CORE_OFFICE_SLUGS.includes(slug)) offices.add(slug);
    else if (!unknown.includes(slug)) unknown.push(slug);
  }
  return { offices, unknown };
}

const warnedCoreOffices = new Set<string>();

/** The office list as read from the environment; an unknown slug is logged once per process per distinct value. */
export function rfpCoreOfficesSetting(env: Record<string, string | undefined> = process.env): ReadonlySet<string> {
  const raw = env.RFP_CORE_OFFICES;
  const { offices, unknown } = parseRfpCoreOffices(raw);
  if (unknown.length > 0 && !warnedCoreOffices.has(raw ?? "")) {
    warnedCoreOffices.add(raw ?? "");
    log(`[rfp-routing] RFP_CORE_OFFICES names unknown office(s) ${unknown.join(", ")}: ignored (known: ${RFP_CORE_OFFICE_SLUGS.join(", ")})`, "rfp");
  }
  return offices;
}

export function effectiveTypeDigit(deal: RouteInput["deal"]): string | null {
  return parseProjectTypeFromNumber(deal.projectNumber ?? "") ?? (deal.projectType?.trim() || null);
}

export function routeRfpCreate(r: RouteInput, setting: string | undefined, coreOffices: ReadonlySet<string> = NO_CORE_OFFICES): RfpDestination {
  if (setting !== "core") return "procore"; // (a)
  if (r.ingress !== "create-from-rfp" || r.sourceSystem !== "trock_crm" || r.decision !== "approved") return "procore"; // (b)
  if (r.approvalKind !== "vote") return "procore"; // (c)
  if (effectiveTypeDigit(r.deal) === "4") return "procore"; // (d)
  const n = r.deal.projectNumber;
  if (typeof n !== "string" || !CRM_FORMAT_PROJECT_NUMBER_RE.test(n)) return "procore"; // (e)
  if (typeof r.office !== "string" || !coreOffices.has(r.office)) return "procore"; // (f)
  return "core";
}

/** The command-row status of a core-stamped create: never claimable by the Procore worker (claim filters destination). */
export const RFP_ROUTED_CORE_STATUS = "routed_core";
/** The command-row status when a re-attempt's stamp ≠ ROUTE NOW (§2 HELD). A person resolves it. */
export const RFP_HELD_DESTINATION_CHANGED_STATUS = "held_destination_changed";
/** A create held because the deal already has the OTHER destination's footprint (§10). A person resolves it. Used on the
 *  command row (a procore create) and on the Core row (a core create; the command row then stays routed). */
export const RFP_HELD_CROSS_DESTINATION_STATUS = "held_cross_destination";
