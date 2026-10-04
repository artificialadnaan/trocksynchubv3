// The service-retype gate (trockcrm#1479) and the approval's resolved field view it checks. Pure, and kept out of
// rfp-approval.ts so the approve route runs the REAL gate even where tests mock the processor module.
import { parseProjectTypeFromNumber, replaceProjectTypeInNumber, resolveEffectiveRfpProjectType } from './constants';
import { buildServiceRfpApprovedBody } from './sync/service-rfp-core-outbox';

/**
 * The one resolved view of an approval's field values. BOTH the TROCK Core payload and the Procore Playwright create
 * are built from it, so the two systems cannot be told different things about one approval; the service-retype gate
 * checks the same object.
 */
export function buildApprovalEditedFieldsOverride(
  dealData: Record<string, any>,
  editedFields: Record<string, string>,
  finalProjectTypeDigit: string,
): Record<string, string> {
  return {
    // The CRM activity log travels here rather than via normalizedDealData, which is passed
    // ONLY for trock_crm — a hubspot-sourced request that carried crmActivityLog would
    // otherwise be persisted in deal_data and then silently dropped before the create, so the
    // field would be "accepted but unused" on that path. editedFieldsOverride is passed for
    // BOTH source systems, so routing it through here keeps accepted == used everywhere.
    // (In practice only the CRM sends the field today; this removes the divergence rather than
    // documenting it.)
    ...(dealData.crm_activity_log ? { crm_activity_log: String(dealData.crm_activity_log) } : {}),
    // Enriched dealData fields as fallbacks (description, company, contact, address from HubSpot API associations)
    ...(dealData.description ? { description: String(dealData.description) } : {}),
    ...(dealData.company_name ? { company_name: String(dealData.company_name) } : {}),
    ...(dealData.contact_name ? { contact_name: String(dealData.contact_name) } : {}),
    ...(dealData.address ? { address: String(dealData.address) } : {}),
    ...(dealData.city ? { city: String(dealData.city) } : {}),
    ...(dealData.state ? { state: String(dealData.state) } : {}),
    ...(dealData.zip ? { zip: String(dealData.zip) } : {}),
    // User-edited fields override the enriched fallbacks
    ...editedFields,
    project_types: finalProjectTypeDigit,
  };
}

/**
 * trockcrm#1479: an approver can retype a non-service CRM RFP to Service (type 4) on the approval form. The CRM's
 * service readiness gate never saw it as service, so the Core handoff would then be refused — after the deal was
 * already moved and the BidBoard project created. Decide it up front with the SAME builder the handoff uses, so the
 * two can never disagree about what Core needs. Returns what is missing, or null when the approval may proceed.
 *
 * CRM-sourced only: a HubSpot deal has no uuid identity Core can store, so the handoff never applies to it (that is
 * a separate, pre-existing limit, unchanged here). An RFP that was ALREADY service passed the CRM's own gate.
 */
export function serviceRetypeRefusal(request: any, editedFields: Record<string, string>): string | null {
  if (request?.sourceSystem !== 'trock_crm') return null;
  const dealData = (request.dealData || {}) as Record<string, any>;
  const baselineType = resolveEffectiveRfpProjectType(dealData);
  const createdType = resolveEffectiveRfpProjectType(dealData, editedFields) || '2';
  if (createdType !== '4' || baselineType === '4') return null;

  // The project number exactly as processRfpApproval rewrites it.
  const currentProjectNumber = String(dealData.project_number ?? '');
  const currentTypeDigit = parseProjectTypeFromNumber(currentProjectNumber) ?? dealData.project_types ?? '';
  const submitted = editedFields.project_types;
  const projectNumber = submitted && submitted !== currentTypeDigit
    ? replaceProjectTypeInNumber(currentProjectNumber, submitted)
    : currentProjectNumber;

  const built = buildServiceRfpApprovedBody({
    sourceSystem: request.sourceSystem,
    sourceDealId: String(request.sourceDealId ?? ''),
    rfpRequestId: request.id,
    projectNumber,
    dealData,
    editedFieldsOverride: buildApprovalEditedFieldsOverride(dealData, editedFields, createdType),
  });
  return built.ok ? null : built.detail;
}

export function serviceRetypeRefusedMessage(detail: string): string {
  return `This RFP can't be approved as a Service job (type 4): TROCK Core needs more than it has (${detail}). ` +
    'Complete the deal in the CRM and send it as a service RFP from there, or approve it under its original type.';
}
