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

/** Extract the type digit from a project number (e.g. DFW-2-06426-ah → "2"). */
export function parseProjectTypeFromNumber(projectNumber: string): string | null {
  const match = projectNumber?.match(/^DFW-(\d+)-/i);
  return match ? match[1] : null;
}

/** Replace the type digit in a project number with a new one. */
export function replaceProjectTypeInNumber(projectNumber: string, newTypeDigit: string): string {
  return projectNumber.replace(/^(DFW-)\d+(-)/i, `$1${newTypeDigit}$2`);
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
