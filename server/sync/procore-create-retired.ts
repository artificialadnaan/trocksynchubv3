/**
 * PROCORE PROJECT CREATION IS RETIRED (owner 2026-11-13: "We no longer use Procore for new projects"; a4 afa14cfd).
 *
 * Nothing in SyncHub creates a Procore Bid Board project or a Procore portfolio project any more. The two places that
 * did it (createBidBoardProjectFromDeal, the Bid Board create; runPhase1WithRetry, "Add to Portfolio") refuse at their
 * first line with this error, before a browser opens or a Procore call is made, so every caller that is left (the
 * create-from-rfp worker, the HubSpot trigger, the manual create-from-deal route, the stage-sync portfolio trigger) ends
 * in its own existing failure handling: visible, and never a retry that could reach Procore. An RFP approval no longer
 * calls the create at all (processRfpApproval): a service RFP completes on its Core card and the CRM's `approved`
 * callback. Read-only Procore work (the archive capture, syncs, exports) is untouched.
 */
export const PROCORE_CREATE_RETIRED_ERROR =
  "Procore project creation is retired (owner 2026-11-13): no Procore project was created. The job belongs in T-Rock Core.";

/**
 * Always true in the product: there is no setting, variable or route that turns Procore creation back on. It is a function,
 * not a bare constant, only so the suites that still exercise the retired create machinery itself (createBidBoardProjectFromDeal,
 * the portfolio Add to Portfolio step) can stub it off for their own assertions.
 */
export function procoreCreateRetired(): boolean {
  return true;
}

export function isProcoreCreateRetiredError(error: unknown): boolean {
  return typeof error === "string" && error.startsWith("Procore project creation is retired");
}

/**
 * THE PROCORE BID BOARD STAGE SYNC IS RETIRED (Fable, 2026-11-14, on the owner's Procore retirement): T-Rock Core owns the Bid
 * Board and its stages. runBidBoardStageSync used to export Procore's Bid Board (Playwright) and push every row to the CRM ingest
 * and Core's ingest; its Settings switch (off since 11-11) stopped only the timer, so a manual "Sync Now" still ran it. It now
 * returns at its first line with this error, before any export, browser or push, whichever route calls it.
 */
export const BID_BOARD_STAGE_SYNC_RETIRED_ERROR =
  "The Procore Bid Board stage sync is retired: T-Rock Core owns the Bid Board. Nothing was exported or pushed.";

/** Always true in the product; a function only so the suites that test the stage-sync logic itself can stub it off. */
export function bidBoardStageSyncRetired(): boolean {
  return true;
}
