/**
 * How an RFP request's status reads to a person (S0b-2b, runbook r5 §1; a4 condition 3; d9 Q10). One definition for every
 * surface (the review page, the reports API, CSV / PDF, the email pill, the dashboard badge), so they cannot drift apart.
 * `approving` (a Bid Board create in progress) reads "Creating Bid Board project…": never blank, never "pending". Every other
 * status reads exactly as it did before; a missing one reads "—".
 */
export const RFP_APPROVING_LABEL = "Creating Bid Board project…";

/** The statuses that mean a Bid Board create is in progress (the summary chips' in-progress count). */
export const RFP_IN_PROGRESS_STATUSES: readonly string[] = ["approving", "override_approving"];

export function rfpStatusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  return status === "approving" ? RFP_APPROVING_LABEL : status;
}
