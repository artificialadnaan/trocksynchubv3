/**
 * Shared constants and helpers for project types.
 * Project numbers follow format DFW-{typeDigit}-{sequence}-{suffix} (e.g. DFW-2-06426-ah).
 */

/** Default Procore company ID — used as fallback when not configured in automation_config */
export const DEFAULT_PROCORE_COMPANY_ID = "598134325683880";

export const PROJECT_TYPES: Record<string, string> = {
  "1": "Exterior Renovation",
  "2": "Interior Renovation",
  "3": "Roofing",
  "4": "Service",
  "5": "Commercial",
  "6": "Hospitality",
  "7": "Emergency",
  "8": "Development",
  "9": "Residential",
};

// Match the office prefix generically, not just DFW: the CRM also generates ATL-… numbers (e.g. ATL-5-06326-af),
// and hard-coding DFW would make an ATL-4-… service RFP parse as null and mis-route as non-service.
const PROJECT_NUMBER_PREFIX_RE = /^[A-Za-z]{2,4}-(\d+)-/;

/** Extract the type digit from a project number (e.g. DFW-2-06426-ah → "2", ATL-4-… → "4"). */
export function parseProjectTypeFromNumber(projectNumber: string): string | null {
  const match = projectNumber?.match(PROJECT_NUMBER_PREFIX_RE);
  return match ? match[1] : null;
}

/** Replace the type digit in a project number with a new one (any office prefix). */
export function replaceProjectTypeInNumber(projectNumber: string, newTypeDigit: string): string {
  return projectNumber.replace(/^([A-Za-z]{2,4}-)\d+(-)/, `$1${newTypeDigit}$2`);
}

// Same shape as PROJECT_NUMBER_PREFIX_RE but capturing the OFFICE rather than the type digit, so the
// two readings of a project number stay in one file and cannot drift apart.
const PROJECT_NUMBER_OFFICE_RE = /^([A-Za-z]{2,4})-\d+-/;

/** Extract the office prefix from a project number (DFW-4-06426-ah → "DFW"), upper-cased. */
export function parseOfficePrefixFromNumber(projectNumber: string): string | null {
  const match = projectNumber?.match(PROJECT_NUMBER_OFFICE_RE);
  return match ? match[1].toUpperCase() : null;
}

/**
 * The TROCK Core tenant that RFP approvals belong to.
 *
 * A SINGLE VALUE, and that is the correction. This used to be a prefix → tenant MAP, on the reading
 * that a project number's prefix names the OFFICE that runs the job — so `ATL-…` was mapped to null
 * and every Atlanta-prefixed service RFP was refused as "no Core tenant".
 *
 * The prefix does not mean that. It records the MARKET the work is in; Atlanta jobs are run out of the
 * DFW office like everything else. So the refusal was answering a question nobody asked: those
 * approvals had an office all along, and two real ones were rejected for it.
 *
 * Deriving a tenant from the prefix is therefore not a mapping that needs another entry — it is the
 * wrong input. One operating office, one tenant, stated once. If a second office ever runs its own
 * jobs, that is a deliberate change here with a real second tenant behind it, not a row added to a
 * table that was already asking the wrong thing.
 */
const CORE_RFP_TENANT = "dallas";

/**
 * The Core tenant an approved RFP is delivered to.
 *
 * Takes no argument BY DESIGN. The previous signature accepted the project-number prefix, which is
 * what made "which office runs this?" look like a lookup on the wrong column; removing the parameter
 * means a caller cannot reintroduce that reading without changing this function.
 */
export function coreRfpTenant(): string {
  return CORE_RFP_TENANT;
}

/**
 * The CANONICAL project-type digit an RFP approval will actually CREATE — the single source of truth
 * shared by processRfpApproval (which selects the service vs non-service BidBoard stage from it), the
 * approve/decline-route authorization gates, AND the notification routing (review email + pending
 * digest), so they can never drift. Lives here in the dependency-free constants module (next to
 * parseProjectTypeFromNumber) so the PURE pendingRfpDigest builder can use it WITHOUT pulling in the
 * DB-coupled rfp-approval module; rfp-approval re-exports it to preserve its existing import sites.
 *
 * The precedence MIRRORS processRfpApproval's finalProjectTypeDigit derivation EXACTLY:
 *   currentTypeDigit = parseProjectTypeFromNumber(project_number) ?? dealData.project_types ?? ''
 *   base             = currentTypeDigit || editedFields.project_types || dealData.project_types || '2'
 *   - if the approver edited project_types into a DIFFERENT routing group, the edited type wins
 *     (processRfpApproval additionally rewrites the project number in that branch);
 *   - otherwise the project-number-derived digit dominates. So a row with project_types '2' but a
 *     project_number 'DFW-4-...' resolves to '4' — the SERVICE type the approval would actually
 *     create, which the routed-type ('2') gate alone would miss.
 *
 * Returns the digit as a string (always at least '2' in practice via the fallback); null only if no
 * digit can be derived at all.
 */
export function resolveEffectiveRfpProjectType(
  dealData: Record<string, any> | null,
  editedFields?: Record<string, any> | null,
): string | null {
  const currentProjectNumber = (dealData?.project_number ?? '') as string;
  const currentTypeDigit = parseProjectTypeFromNumber(currentProjectNumber) ?? dealData?.project_types ?? '';
  const submittedProjectType = editedFields?.project_types;

  let finalProjectTypeDigit = currentTypeDigit || submittedProjectType || dealData?.project_types || '2';
  if (submittedProjectType && submittedProjectType !== currentTypeDigit) {
    finalProjectTypeDigit = submittedProjectType;
  } else if (currentProjectNumber && !submittedProjectType && currentTypeDigit) {
    finalProjectTypeDigit = currentTypeDigit;
  }
  return finalProjectTypeDigit ? String(finalProjectTypeDigit) : null;
}
