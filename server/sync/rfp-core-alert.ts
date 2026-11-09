/**
 * Ops alerts for RFP Phase 2 routing (CONTRACT v2.2 §2 / §10): held_destination_changed, held_cross_destination,
 * approval_kind_conflict, missing Core tables, dead deliveries, orphan / link-refused Core bids.
 * Never throws: an alert failure must not change a routing outcome.
 */
export type RfpCoreAlertCode =
  | "destination_changed_hold"
  | "cross_destination_hold"
  | "approval_kind_conflict"
  | "core_tables_missing"
  | "core_create_dead"
  | "crm_link_dead"
  | "core_bid_orphan"
  | "core_bid_link_refused"
  | "core_confirm_delayed"
  | "core_request_rejected"
  | "crm_notice_dead";

export async function raiseRfpCoreAlert(_code: RfpCoreAlertCode, _detail: Record<string, unknown>): Promise<void> {
  // RED STUB (S0a): replaced by the debounced ops alert
}
