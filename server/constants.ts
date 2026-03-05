/**
 * Shared constants and helpers for project types.
 * Project numbers follow format DFW-{typeDigit}-{sequence}-{suffix} (e.g. DFW-2-06426-ah).
 */

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
