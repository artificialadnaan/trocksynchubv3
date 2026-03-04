import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { storage } from './storage';
import { getHubSpotClient, updateHubSpotDeal, updateHubSpotDealStage, getDealOwnerInfo } from './hubspot';
import { resolveHubspotStageId } from './procore-hubspot-sync';
import { sendEmail, renderTemplate } from './email-service';
import { log } from './index';

const RFP_REVIEW_RECIPIENTS = [
  'sgibson@trockgc.com',
  'jhelms@trockgc.com',
  'bbell@trockgc.com',
  'adnaan.iqbal@gmail.com',
];

const RFP_DEAL_PROPERTIES = [
  'dealname', 'amount', 'dealstage', 'pipeline', 'closedate',
  'hubspot_owner_id', 'project_types', 'project_number',
  'project_location', 'city', 'state', 'zip', 'country',
  'description', 'project_description', 'project_description_briefly_describe_the_project',
  'address', 'company_name', 'client_email', 'client_phone', 'estimator', 'notes',
  'attachments', 'deal_attachments',
];

export async function fetchFullDealFromHubSpot(dealId: string): Promise<Record<string, any>> {
  const client = await getHubSpotClient();
  const deal = await client.crm.deals.basicApi.getById(
    dealId,
    RFP_DEAL_PROPERTIES,
    undefined,
    ['companies', 'contacts']
  );

  const props = deal.properties || {};
  let companyName = props.company_name || '';
  let contactEmail = props.client_email || '';
  let contactPhone = props.client_phone || '';

  const associations = (deal as any).associations || {};
  const companyIds = associations.companies?.results?.map((a: any) => String(a.id)) || [];
  const contactIds = associations.contacts?.results?.map((a: any) => String(a.id)) || [];

  if (companyIds.length > 0 && !companyName) {
    try {
      const company = await client.crm.companies.basicApi.getById(companyIds[0], ['name', 'phone', 'address', 'city', 'state', 'zip']);
      const cProps = company.properties || {};
      companyName = companyName || cProps.name || '';
      if (!props.address) props.address = cProps.address || '';
      if (!props.city) props.city = cProps.city || '';
      if (!props.state) props.state = cProps.state || '';
      if (!props.zip) props.zip = cProps.zip || '';
    } catch (e: any) {
      console.warn(`[rfp-approval] Failed to fetch company ${companyIds[0]}:`, e.message);
    }
  }

  if (contactIds.length > 0 && (!contactEmail || !contactPhone)) {
    try {
      const contact = await client.crm.contacts.basicApi.getById(contactIds[0], ['email', 'phone', 'firstname', 'lastname']);
      const ctProps = contact.properties || {};
      contactEmail = contactEmail || ctProps.email || '';
      contactPhone = contactPhone || ctProps.phone || '';
      if (!props.contact_name) props.contact_name = `${ctProps.firstname || ''} ${ctProps.lastname || ''}`.trim();
    } catch (e: any) {
      console.warn(`[rfp-approval] Failed to fetch contact ${contactIds[0]}:`, e.message);
    }
  }

  return {
    hubspotDealId: dealId,
    dealname: props.dealname || '',
    amount: props.amount || '',
    project_types: props.project_types || '',
    project_number: props.project_number || '',
    project_location: props.project_location || '',
    address: props.address || '',
    city: props.city || '',
    state: props.state || '',
    zip: props.zip || '',
    country: props.country || '',
    description: props.description || props.project_description || props.project_description_briefly_describe_the_project || (() => { const k = Object.keys(props).find(x => x.toLowerCase().includes('description')); return k ? props[k] : ''; })(),
    notes: props.notes || '',
    closedate: props.closedate || '',
    estimator: props.estimator || '',
    company_name: companyName,
    client_email: contactEmail,
    client_phone: contactPhone,
    contact_name: props.contact_name || '',
    hubspot_owner_id: props.hubspot_owner_id || '',
    pipeline: props.pipeline || '',
    dealstage: props.dealstage || '',
    attachments: fetchAttachmentsFromProps(props),
  };
}

function fetchAttachmentsFromProps(props: Record<string, any>): Array<{ name: string; url: string; type?: string; size?: number }> {
  const list: Array<{ name: string; url: string; type?: string; size?: number }> = [];
  const raw = props.attachments || props.deal_attachments;
  if (Array.isArray(raw)) {
    for (const a of raw) {
      if (a && (a.url || a.fileUrl)) {
        list.push({
          name: a.name || a.fileName || 'attachment',
          url: a.url || a.fileUrl,
          type: a.type || a.mimeType,
          size: a.size,
        });
      }
    }
  } else if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const a of parsed) {
          if (a && (a.url || a.fileUrl)) {
            list.push({
              name: a.name || a.fileName || 'attachment',
              url: a.url || a.fileUrl,
              type: a.type || a.mimeType,
              size: a.size,
            });
          }
        }
      }
    } catch { /* ignore */ }
  }
  return list;
}

export async function createRfpApprovalRequest(
  hubspotDealId: string
): Promise<{ success: boolean; token?: string; error?: string }> {
  try {
    const existing = await storage.getRfpApprovalRequestByDealId(hubspotDealId);
    if (existing) {
      log(`[rfp-approval] Pending approval already exists for deal ${hubspotDealId}, skipping`, 'rfp');
      return { success: true, token: existing.token };
    }

    const dealData = await fetchFullDealFromHubSpot(hubspotDealId);
    const token = randomUUID();

    const ownerInfo = await getDealOwnerInfo(hubspotDealId);

    const hubspotConfig = await storage.getAutomationConfig('hubspot_config');
    const portalId = (hubspotConfig?.value as any)?.portalId || '';
    const hubspotDealUrl = portalId
      ? `https://app.hubspot.com/contacts/${portalId}/deal/${hubspotDealId}`
      : `https://app.hubspot.com/contacts/deal/${hubspotDealId}`;

    const appUrl = process.env.APP_URL || 'http://localhost:5000';
    const reviewUrl = `${appUrl}/rfp-review/${token}`;

    await storage.createRfpApprovalRequest({
      hubspotDealId,
      token,
      status: 'pending',
      dealData: {
        ...dealData,
        ownerName: ownerInfo.ownerName || '',
        ownerEmail: ownerInfo.ownerEmail || '',
        hubspotDealUrl,
      },
    });

    const template = await storage.getEmailTemplate('rfp_review');
    // #region agent log
    fetch('http://127.0.0.1:7661/ingest/4b6ff940-aff2-4741-a4b8-68a9fe5f9534',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'1eb215'},body:JSON.stringify({sessionId:'1eb215',location:'rfp-approval.ts:130',message:'email template lookup',data:{templateFound:!!template,templateEnabled:template?.enabled||false,templateKey:'rfp_review'},timestamp:Date.now(),hypothesisId:'H4'})}).catch(()=>{});
    // #endregion
    if (!template || !template.enabled) {
      log('[rfp-approval] RFP review email template is disabled', 'rfp');
      return { success: true, token };
    }

    const variables: Record<string, string> = {
      dealName: dealData.dealname,
      projectNumber: dealData.project_number,
      projectType: dealData.project_types,
      amount: dealData.amount,
      companyName: dealData.company_name,
      location: [dealData.address, dealData.city, dealData.state, dealData.zip].filter(Boolean).join(', '),
      description: dealData.description || dealData.notes || 'N/A',
      estimator: dealData.estimator || 'N/A',
      ownerName: ownerInfo.ownerName || 'N/A',
      hubspotDealUrl,
      reviewUrl,
    };

    const subject = renderTemplate(template.subject, variables);
    const htmlBody = renderTemplate(template.bodyHtml, variables);

    for (const recipient of RFP_REVIEW_RECIPIENTS) {
      try {
        const result = await sendEmail({
          to: recipient,
          subject,
          htmlBody,
          fromName: 'T-Rock Sync Hub',
        });

        await storage.createEmailSendLog({
          templateKey: 'rfp_review',
          recipientEmail: recipient,
          recipientName: null,
          subject,
          dedupeKey: `rfp_review:${hubspotDealId}:${recipient}:${token}`,
          status: result.success ? 'sent' : 'failed',
          errorMessage: result.error || null,
          metadata: { hubspotDealId, token },
          sentAt: new Date(),
        });

        log(`[rfp-approval] Email ${result.success ? 'sent' : 'failed'} to ${recipient} for deal ${hubspotDealId}`, 'rfp');
      } catch (emailErr: any) {
        console.error(`[rfp-approval] Failed to send email to ${recipient}:`, emailErr.message);
      }
    }

    await storage.createAuditLog({
      action: 'rfp_approval_request_created',
      entityType: 'deal',
      entityId: hubspotDealId,
      source: 'rfp-approval',
      status: 'success',
      details: { token, recipients: RFP_REVIEW_RECIPIENTS, dealName: dealData.dealname },
    });

    return { success: true, token };
  } catch (e: any) {
    console.error(`[rfp-approval] Error creating approval request for deal ${hubspotDealId}:`, e.message);
    return { success: false, error: e.message };
  }
}

export interface RfpApprovalAttachmentOptions {
  attachmentsOverride: Array<{ name: string; url?: string; _new?: boolean }>;
  newFiles: Array<{ buffer: Buffer; originalname: string; mimetype?: string; size?: number }>;
}

export async function processRfpApproval(
  token: string,
  editedFields: Record<string, string>,
  approverEmail: string,
  options?: { attachmentsOverride?: RfpApprovalAttachmentOptions['attachmentsOverride']; newFiles?: RfpApprovalAttachmentOptions['newFiles'] }
): Promise<{ success: boolean; error?: string; bidboardProjectId?: string }> {
  try {
    const request = await storage.getRfpApprovalRequestByToken(token);
    if (!request) return { success: false, error: 'Approval request not found' };
    if (request.status !== 'pending') return { success: false, error: `Request already ${request.status}` };

    const dealData = request.dealData as Record<string, any>;
    const hubspotDealId = request.hubspotDealId;

    const changedFields: Record<string, string> = {};
    for (const [key, value] of Object.entries(editedFields)) {
      if (value !== undefined && value !== dealData[key]) {
        changedFields[key] = value;
      }
    }

    if (Object.keys(changedFields).length > 0) {
      const hubspotUpdateProps: Record<string, string> = {};
      for (const [key, value] of Object.entries(changedFields)) {
        if (['dealname', 'amount', 'project_types', 'project_number', 'project_location',
             'address', 'city', 'state', 'zip', 'country', 'description', 'estimator',
             'notes', 'closedate', 'client_email', 'client_phone', 'company_name'].includes(key)) {
          hubspotUpdateProps[key] = value;
          if (key === 'description') {
            hubspotUpdateProps['project_description_briefly_describe_the_project'] = value;
            hubspotUpdateProps['project_description'] = value;
          }
        }
      }

      if (Object.keys(hubspotUpdateProps).length > 0) {
        const updateResult = await updateHubSpotDeal(hubspotDealId, hubspotUpdateProps);
        if (!updateResult.success) {
          console.error(`[rfp-approval] Failed to update HubSpot deal: ${updateResult.message}`);
        }
        log(`[rfp-approval] Updated HubSpot deal ${hubspotDealId} with ${Object.keys(hubspotUpdateProps).length} changed fields`, 'rfp');
      }
    }

    const finalProjectType = editedFields.project_types || dealData.project_types || '';
    const isService = String(finalProjectType) === '4';
    const targetStageName = isService ? 'Service - Estimating' : 'Estimating';

    const resolvedStage = await resolveHubspotStageId(targetStageName);
    if (resolvedStage) {
      await updateHubSpotDealStage(hubspotDealId, resolvedStage.stageId);
      log(`[rfp-approval] Deal ${hubspotDealId} moved to stage "${resolvedStage.stageName}" (type=${finalProjectType})`, 'rfp');
    } else {
      const altName = isService ? 'Service – Estimating' : 'Estimating';
      const altStage = await resolveHubspotStageId(altName);
      if (altStage) {
        await updateHubSpotDealStage(hubspotDealId, altStage.stageId);
        log(`[rfp-approval] Deal ${hubspotDealId} moved to stage "${altStage.stageName}" (alt match)`, 'rfp');
      } else {
        console.error(`[rfp-approval] Could not resolve HubSpot stage for "${targetStageName}"`);
      }
    }

    // Refresh local deal cache so BidBoard creation picks up any edits
    try {
      const { syncSingleHubSpotDeal } = await import('./hubspot');
      await syncSingleHubSpotDeal(hubspotDealId);
      log(`[rfp-approval] Local deal cache refreshed for ${hubspotDealId}`, 'rfp');
    } catch (syncErr: any) {
      console.error(`[rfp-approval] Failed to refresh deal cache: ${syncErr.message}`);
    }

    const tempPaths: string[] = [];
    let attachmentsToSync: Array<{ name: string; url?: string; localPath?: string; type?: string; size?: number }> | undefined;
    if (options?.attachmentsOverride?.length || options?.newFiles?.length) {
      attachmentsToSync = [];
      for (const a of options.attachmentsOverride || []) {
        if (a._new) continue;
        if (a.url) attachmentsToSync.push({ name: a.name || 'attachment', url: a.url });
      }
      for (let i = 0; i < (options.newFiles || []).length; i++) {
        const f = options.newFiles![i];
        const tmpDir = process.env.TEMP_DIR || '.playwright-temp';
        await fs.mkdir(tmpDir, { recursive: true });
        const tmpPath = path.join(tmpDir, `rfp-new-${randomUUID()}-${(f.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_')}`);
        await fs.writeFile(tmpPath, f.buffer);
        tempPaths.push(tmpPath);
        attachmentsToSync.push({ name: f.originalname || 'attachment', localPath: tmpPath, type: f.mimetype, size: f.size });
      }
    }

    let bidboardProjectId: string | undefined;
    try {
      const { createBidBoardProjectFromDeal } = await import('./playwright/bidboard');
      const bidboardStage = isService ? 'Service – Estimating' : 'Estimate in Progress';
      const bbResult = await createBidBoardProjectFromDeal(hubspotDealId, bidboardStage, {
        syncDocuments: true,
        attachmentsOverride: attachmentsToSync,
      });
      if (bbResult.success && bbResult.projectId) {
        bidboardProjectId = bbResult.projectId;
        log(`[rfp-approval] BidBoard project created: ${bidboardProjectId} for deal ${hubspotDealId}`, 'rfp');
      } else {
        console.error(`[rfp-approval] BidBoard creation failed for deal ${hubspotDealId}: ${bbResult.error}`);
      }
    } catch (bbErr: any) {
      console.error(`[rfp-approval] BidBoard creation error for deal ${hubspotDealId}:`, bbErr.message);
    }

    await storage.updateRfpApprovalRequest(request.id, {
      status: 'approved',
      editedFields: changedFields,
      approvedBy: approverEmail,
      approvedAt: new Date(),
      bidboardProjectId: bidboardProjectId || null,
    });

    await storage.createAuditLog({
      action: 'rfp_approval_approved',
      entityType: 'deal',
      entityId: hubspotDealId,
      source: 'rfp-approval',
      status: 'success',
      details: {
        token,
        approvedBy: approverEmail,
        changedFields,
        projectType: finalProjectType,
        targetStage: targetStageName,
        bidboardProjectId,
      },
    });

    return { success: true, bidboardProjectId };
  } catch (e: any) {
    console.error(`[rfp-approval] Error processing approval for token ${token}:`, e.message);
    return { success: false, error: e.message };
  }
}

export async function processRfpDecline(
  token: string,
  declinerEmail: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const request = await storage.getRfpApprovalRequestByToken(token);
    if (!request) return { success: false, error: 'Approval request not found' };
    if (request.status !== 'pending') return { success: false, error: `Request already ${request.status}` };

    await storage.updateRfpApprovalRequest(request.id, {
      status: 'declined',
      declinedBy: declinerEmail,
      declinedAt: new Date(),
    });

    await storage.createAuditLog({
      action: 'rfp_approval_declined',
      entityType: 'deal',
      entityId: request.hubspotDealId,
      source: 'rfp-approval',
      status: 'success',
      details: { token, declinedBy: declinerEmail },
    });

    log(`[rfp-approval] Deal ${request.hubspotDealId} RFP declined by ${declinerEmail}`, 'rfp');
    return { success: true };
  } catch (e: any) {
    console.error(`[rfp-approval] Error processing decline for token ${token}:`, e.message);
    return { success: false, error: e.message };
  }
}
