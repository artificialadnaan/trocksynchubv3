/**
 * How an RFP request's status reads to a person (S0b-2b, runbook r5 §1; a4 condition 3; d9 Q10). One definition for every
 * surface (the review page, the reports API, CSV / PDF, the email pill, the dashboard badge), so they cannot drift apart.
 * `approving` (a Bid Board create in progress) reads "Creating Bid Board project…": never blank, never "pending". Every other
 * status reads exactly as it did before; a missing one reads "—".
 */
export const RFP_APPROVING_LABEL = "Creating Bid Board project…";

/**
 * What a person reads when an approval already holds the request (`approving`, N6; a4 8ea49d91 (3)): a decline, a second
 * approval and the review page all say this one line, never a silent drop or a status word.
 */
export const RFP_BEING_APPROVED_MESSAGE = "This is being approved right now. Try again in a minute.";

/** A decision on a request an interrupted attempt may have left half-written in HubSpot, while HubSpot can't be read (a4 ADD-1). */
export const RFP_HUBSPOT_UNREACHABLE_MESSAGE = "HubSpot can't be reached to check this request. Try again in a minute.";

/** An approval stopped by its own safety check after the stuck sweep freed the request (a4 ADD-2 F-143-2). */
export const RFP_APPROVAL_STOPPED_MESSAGE = "This approval took too long and was stopped before it finished. Open the request and approve it again.";

/**
 * A decline after an interrupted approval whose pre-write HubSpot stage was never recorded, while HubSpot still shows the approved stage
 * (a4 ADD-2): it names the one step the person takes, in HubSpot, before declining.
 */
export const RFP_STAGE_UNKNOWN_MESSAGE = "HubSpot still shows this deal as approved. Move it to the right stage in HubSpot, then decline here.";

/** The statuses that mean a Bid Board create is in progress (the summary chips' in-progress count). */
export const RFP_IN_PROGRESS_STATUSES: readonly string[] = ["approving", "override_approving"];

export function rfpStatusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  return status === "approving" ? RFP_APPROVING_LABEL : status;
}
