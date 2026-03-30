import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import { fetchWithTimeout } from './lib/fetch-with-timeout';
import path from 'path';
import { storage } from './storage';
import { getHubSpotClient, getAccessToken, updateHubSpotDeal, updateHubSpotDealStage, getDealOwnerInfo } from './hubspot';
import { parseProjectTypeFromNumber, replaceProjectTypeInNumber } from './constants';
import { resolveHubspotStageId } from './procore-hubspot-sync';
import { sendEmail, renderTemplate } from './email-service';
import { log } from './index';

/** Upload a file to HubSpot Files API and associate it with a deal. */
async function uploadFileToHubSpotAndAttachToDeal(
  localPath: string,
  fileName: string,
  dealId: string
): Promise<void> {
  const token = await getAccessToken();
  const base = 'https://api.hubapi.com';
  const fileBuffer = await fs.readFile(localPath);

  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer]), fileName);
  formData.append('options', JSON.stringify({ access: 'PRIVATE' }));
  formData.append('folderPath', '/rfp-attachments');

  const uploadRes = await fetchWithTimeout(`${base}/files/v3/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    throw new Error(`HubSpot file upload failed: ${uploadRes.status} ${errText}`);
  }
  const uploadJson = (await uploadRes.json()) as { id?: string };
  const fileId = String(uploadJson.id ?? '');
  if (!fileId) throw new Error('HubSpot file upload did not return file id');

  // Associate file with deal: from deal → to file. Use "deals" and "files" object types.
  // (0-4 was incorrectly interpreted as engagement; "files" is the correct type.)
  try {
    const client = await getHubSpotClient();
    await client.crm.associations.v4.basicApi.create(
      'deals',
      dealId,
      'files',
      fileId,
      [{ associationCategory: 'HUBSPOT_DEFINED' as any, associationTypeId: 3 }]
    );
    log(`[rfp-approval] Associated file ${fileId} with deal ${dealId}`, 'rfp');
  } catch (assocErr: any) {
    const msg = assocErr?.message || String(assocErr);
    // Downgrade to warning when HubSpot returns invalid contact (e.g. deal has stale contact ref); file-deal link still works
    if (/CONTACT.*not valid|not valid.*CONTACT/i.test(msg)) {
      console.warn(`[rfp-approval] File-deal association skipped (invalid contact): ${msg}`);
    } else {
      log(`[rfp-approval] HubSpot file-deal association failed: ${msg}`, 'rfp');
    }
    // Non-fatal — file was uploaded successfully, association is best-effort
  }
}

function getRfpReviewRecipients(projectType: string | null | undefined): string[] {
  const type = String(projectType || '').trim();
  if (type === '4') {
    // Project type 4: James + Colby
    return ['jhelms@trockgc.com', 'cburling@trockgc.com'];
  }
  // All other project types: Sidney + James
  return ['sgibson@trockgc.com', 'jhelms@trockgc.com'];
}

const RFP_DEAL_PROPERTIES = [
  'dealname', 'amount', 'dealstage', 'pipeline', 'closedate',
  'bid_due_date', 'due_date', 'proposal_due_date',
  'hubspot_owner_id', 'project_types', 'project_number',
  'project_location', 'city', 'state', 'zip', 'country',
  'description', 'project_description', 'project_description_briefly_describe_the_project',
  'project_description__briefly_describe_the_project_',
  'address', 'project_location', 'company_name', 'client_email', 'client_phone', 'estimator', 'notes',
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
  let descriptionFromProps = props.description || props.project_description || props.project_description_briefly_describe_the_project
    || props.hs_project_description || props.hs_description
    || (() => { const k = Object.keys(props).find(x => x.toLowerCase().includes('description')); return k ? props[k] : ''; })();
  if (!descriptionFromProps) {
    try {
      const cached = await storage.getHubspotDealByHubspotId(dealId);
      const cp = (cached?.properties || {}) as Record<string, any>;
      descriptionFromProps = cp.description || cp.project_description || cp.project_description_briefly_describe_the_project
        || cp.hs_project_description || cp.hs_description
        || (() => { const k = Object.keys(cp).find(x => x.toLowerCase().includes('description')); return k ? cp[k] : ''; })() || '';
    } catch { /* ignore */ }
  }
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
    address: props.address || props.project_location || '',
    city: props.city || '',
    state: props.state || '',
    zip: props.zip || '',
    country: props.country || '',
    description: descriptionFromProps,
    notes: props.notes || '',
    closedate: props.closedate || '',
    bid_due_date: props.bid_due_date || props.due_date || '',
    proposal_due_date: props.proposal_due_date || '',
    project_description__briefly_describe_the_project_: props.project_description__briefly_describe_the_project_ || '',
    estimator: props.estimator || '',
    company_name: companyName,
    client_email: contactEmail,
    client_phone: contactPhone,
    contact_name: props.contact_name || '',
    hubspot_owner_id: props.hubspot_owner_id || '',
    pipeline: props.pipeline || '',
    dealstage: props.dealstage || '',
    attachments: await fetchDealAttachments(dealId, props),
  };
}

async function fetchDealAttachmentsFromFiles(dealId: string): Promise<Array<{ name: string; url: string; type?: string; size?: number }>> {
  const list: Array<{ name: string; url: string; type?: string; size?: number }> = [];
  try {
    const token = await getAccessToken();
    const base = 'https://api.hubapi.com';
    const headers = { Authorization: `Bearer ${token}` };
    const assocRes = await fetchWithTimeout(`${base}/crm/v4/objects/deal/${dealId}/associations/files`, { headers });
    if (!assocRes.ok) return list;
    const assoc = (await assocRes.json()) as { results?: Array<{ id?: string; type?: string }> };
    const fileIds = (assoc.results || []).map((r) => r.id).filter(Boolean) as string[];
    for (const fileId of fileIds) {
      try {
        const fileRes = await fetchWithTimeout(`${base}/files/v3/files/${fileId}`, { headers });
        if (!fileRes.ok) continue;
        const file = (await fileRes.json()) as { url?: string; defaultHostingUrl?: string; name?: string; extension?: string; size?: number };
        const url = file.url || file.defaultHostingUrl;
        if (url) {
          list.push({
            name: file.name || `file-${fileId}${file.extension ? '.' + file.extension : ''}`,
            url,
            size: file.size,
          });
        }
      } catch { /* skip file */ }
    }
  } catch (e: any) {
    log(`[rfp-approval] Failed to fetch deal attachments from files: ${e.message}`, 'rfp');
  }
  return list;
}

async function fetchDealAttachments(dealId: string, props: Record<string, any>): Promise<Array<{ name: string; url: string; type?: string; size?: number }>> {
  const fromProps = fetchAttachmentsFromProps(props);
  const fromNotes = await fetchDealAttachmentsFromNotes(dealId);
  const fromFiles = await fetchDealAttachmentsFromFiles(dealId);
  const seen = new Set<string>();
  const list: Array<{ name: string; url: string; type?: string; size?: number }> = [];
  for (const a of [...fromProps, ...fromNotes, ...fromFiles]) {
    const key = `${a.url}|${a.name}`;
    if (!seen.has(key)) { seen.add(key); list.push(a); }
  }
  return list;
}

async function fetchDealAttachmentsFromNotes(dealId: string): Promise<Array<{ name: string; url: string; type?: string; size?: number }>> {
  const list: Array<{ name: string; url: string; type?: string; size?: number }> = [];
  try {
    const token = await getAccessToken();
    const base = 'https://api.hubapi.com';
    const headers = { Authorization: `Bearer ${token}` };
    const assocRes = await fetchWithTimeout(`${base}/crm/v4/objects/deal/${dealId}/associations/notes`, { headers });
    if (!assocRes.ok) return list;
    const assoc = (await assocRes.json()) as { results?: Array<{ id?: string; toObjectId?: string } | string> };
    const noteIds = (assoc.results || []).map((r) => (typeof r === 'string' ? r : r?.id || r?.toObjectId)).filter(Boolean) as string[];
    for (const noteId of noteIds) {
      const noteRes = await fetchWithTimeout(`${base}/crm/v3/objects/notes/${noteId}?properties=hs_attachment_ids`, { headers });
      if (!noteRes.ok) continue;
      const note = (await noteRes.json()) as { properties?: { hs_attachment_ids?: string } };
      const idsStr = note.properties?.hs_attachment_ids || '';
      const ids = idsStr.split(';').map((s) => s.trim()).filter(Boolean);
      for (const fileId of ids) {
        try {
          const fileRes = await fetchWithTimeout(`${base}/files/v3/files/${fileId}`, { headers });
          if (!fileRes.ok) continue;
          const file = (await fileRes.json()) as { url?: string; defaultHostingUrl?: string; name?: string; extension?: string; size?: number };
          const url = file.url || file.defaultHostingUrl;
          if (url) {
            list.push({
              name: file.name || `file-${fileId}${file.extension ? '.' + file.extension : ''}`,
              url,
              size: file.size,
            });
          }
        } catch { /* skip file */ }
      }
    }
  } catch (e: any) {
    log(`[rfp-approval] Failed to fetch deal attachments from notes: ${e.message}`, 'rfp');
  }
  return list;
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
    const DEFAULT_HUBSPOT_PORTAL_ID = '45644695';
    const portalId = (hubspotConfig?.value as any)?.portalId?.trim() || DEFAULT_HUBSPOT_PORTAL_ID;
    const hubspotDealUrl = `https://app-na2.hubspot.com/contacts/${portalId}/record/0-3/${hubspotDealId}?eschref=%2Fcontacts%2F${portalId}%2Fobjects%2F0-3%2Fviews%2Fall%2Flist%3Fquery%3Drfp`;

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
    if (!template || !template.enabled) {
      log('[rfp-approval] RFP review email template is disabled', 'rfp');
      return { success: true, token };
    }

    const esc = (s: any) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const attachments = (dealData.attachments || []) as Array<{ name: string; url?: string }>;
    const attachmentListHtml = attachments.length > 0
      ? attachments.map(a => `<a href="${(a.url || '#').replace(/"/g, '&quot;')}" style="color:#d11921;text-decoration:underline;font-family:Arial,Helvetica,sans-serif;">${esc(a.name || 'Attachment')}</a>`).join('<br>')
      : '<span style="color:#94a3b8;">None</span>';

    const dealName = esc(dealData.dealname || 'Unknown Deal');
    const projectNumber = esc(dealData.project_number || 'N/A');
    const projectType = esc(dealData.project_types || 'N/A');
    const amount = dealData.amount ? `$${Number(dealData.amount).toLocaleString('en-US')}` : 'N/A';
    const companyName = esc(dealData.company_name || 'N/A');
    const location = esc([dealData.address, dealData.city, dealData.state, dealData.zip].filter(Boolean).join(', ') || 'N/A');
    const description = esc(dealData.description || dealData.notes || 'N/A');
    const estimator = esc(dealData.estimator || 'N/A');
    const ownerName = esc(ownerInfo.ownerName || 'N/A');

    const row = (label: string, value: string, isHtml = false) =>
      `<tr>
        <td style="padding:10px 16px;border-bottom:1px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;width:160px;vertical-align:top;">${label}</td>
        <td style="padding:10px 16px;border-bottom:1px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1e293b;vertical-align:top;">${isHtml ? value : value}</td>
      </tr>`;

    const subject = `Review Required: ${dealData.dealname || 'New RFP'}`;
    const htmlBody = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <!--[if mso]><style>table{border-collapse:collapse;}td{font-family:Arial,Helvetica,sans-serif;}</style><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f1f5f9;">
    <tr><td align="center" style="padding:24px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0;">
        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#1a1a2e,#16213e);padding:28px 32px;text-align:center;">
            <!--[if mso]><v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false" style="width:600px;height:80px;"><v:fill type="gradient" color="#1a1a2e" color2="#16213e" angle="135"/><v:textbox inset="0,0,0,0" style="mso-fit-shape-to-text:true"><![endif]-->
            <img src="https://trockgc.com/wp-content/uploads/2024/10/T-Rock-Logo-Main-2.png" alt="T-Rock GC" width="160" style="display:block;margin:0 auto;max-width:160px;height:auto;" />
            <!--[if mso]></v:textbox></v:rect><![endif]-->
          </td>
        </tr>
        <!-- Red accent bar -->
        <tr><td style="background:#d11921;height:4px;font-size:1px;line-height:1px;">&nbsp;</td></tr>
        <!-- Title -->
        <tr>
          <td style="padding:28px 32px 8px 32px;">
            <h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:700;color:#1a1a2e;">New RFP Review Required</h1>
            <p style="margin:8px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#64748b;line-height:1.5;">A new deal requires your review and approval before a BidBoard project is created.</p>
          </td>
        </tr>
        <!-- Deal name banner -->
        <tr>
          <td style="padding:8px 32px 20px 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fef2f2;border-left:4px solid #d11921;border-radius:4px;">
              <tr><td style="padding:14px 18px;font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:700;color:#1a1a2e;">${dealName}</td></tr>
            </table>
          </td>
        </tr>
        <!-- Details table -->
        <tr>
          <td style="padding:0 32px 24px 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e2e8f0;border-radius:6px;overflow:hidden;">
              ${row('Project Type', projectType)}
              ${row('Project Number', projectNumber)}
              ${row('Amount', amount)}
              ${row('Company', companyName)}
              ${row('Location', location)}
              ${row('Estimator', estimator)}
              ${row('Deal Owner', ownerName)}
              ${row('Description', description)}
              ${row('Attachments', attachmentListHtml, true)}
            </table>
          </td>
        </tr>
        <!-- CTA Buttons -->
        <tr>
          <td style="padding:0 32px 12px 32px;" align="center">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="border-radius:6px;background:#d11921;" align="center">
                  <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${reviewUrl}" style="height:44px;v-text-anchor:middle;width:220px;" arcsize="14%" strokecolor="#d11921" fillcolor="#d11921"><center style="color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;"><![endif]-->
                  <a href="${reviewUrl}" target="_blank" style="display:inline-block;padding:12px 32px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:6px;background:#d11921;">Review &amp; Approve</a>
                  <!--[if mso]></center></v:roundrect><![endif]-->
                </td>
                <td style="width:12px;">&nbsp;</td>
                <td style="border-radius:6px;border:2px solid #e2e8f0;" align="center">
                  <a href="${hubspotDealUrl}" target="_blank" style="display:inline-block;padding:10px 24px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#64748b;text-decoration:none;border-radius:6px;">View in HubSpot</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="padding:20px 32px;border-top:1px solid #e2e8f0;">
            <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#94a3b8;text-align:center;">Sent by T-Rock Sync Hub &bull; This is an automated notification</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    const rfpRecipients = getRfpReviewRecipients(dealData.project_types);
    console.log(`[rfp-approval] Project type: ${dealData.project_types || 'none'}, recipients: ${rfpRecipients.join(', ')}`);
    for (const recipient of rfpRecipients) {
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
      details: { token, recipients: rfpRecipients, dealName: dealData.dealname },
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

    // Retry guard: check if a previous attempt already created a BidBoard project for this deal
    const existingMapping = await storage.getSyncMappingByHubspotDealId(hubspotDealId);
    if (existingMapping?.bidboardProjectId) {
      log(`[rfp-approval] Retry detected — BidBoard project ${existingMapping.bidboardProjectId} already exists for deal ${hubspotDealId}. Marking approved.`, 'rfp');
      await storage.updateRfpApprovalRequest(request.id, {
        status: 'approved',
        approvedBy: approverEmail,
        approvedAt: new Date(),
        bidboardProjectId: existingMapping.bidboardProjectId,
      });
      return { success: true, bidboardProjectId: existingMapping.bidboardProjectId };
    }

    // Check if project type changed — update project number and HubSpot immediately
    const submittedProjectType = editedFields.project_types;
    const currentProjectNumber = (dealData.project_number ?? '') as string;
    const currentTypeDigit = parseProjectTypeFromNumber(currentProjectNumber) ?? dealData.project_types ?? '';

    let finalProjectNumber = currentProjectNumber;
    let finalProjectTypeDigit = currentTypeDigit || submittedProjectType || dealData.project_types || '2';

    if (submittedProjectType && submittedProjectType !== currentTypeDigit) {
      const updatedProjectNumber = replaceProjectTypeInNumber(currentProjectNumber, submittedProjectType);
      finalProjectNumber = updatedProjectNumber;
      finalProjectTypeDigit = submittedProjectType;

      try {
        await updateHubSpotDeal(hubspotDealId, {
          project_number: updatedProjectNumber,
          project_types: submittedProjectType,
        });
        log(`[rfp-approval] Updated project number: ${currentProjectNumber} → ${updatedProjectNumber}`, 'rfp');
      } catch (err: any) {
        log(`[rfp-approval] Warning: Failed to update project number in HubSpot: ${err.message}`, 'rfp');
        // Non-fatal — continue with BidBoard creation
      }
    } else if (currentProjectNumber && !submittedProjectType && currentTypeDigit) {
      finalProjectTypeDigit = currentTypeDigit;
    }

    const changedFields: Record<string, string> = {};
    for (const [key, value] of Object.entries(editedFields)) {
      if (value !== undefined && value !== dealData[key]) {
        changedFields[key] = value;
      }
    }

    if (Object.keys(changedFields).length > 0) {
      const hubspotUpdateProps: Record<string, string> = {};
      const ALLOWED_HUBSPOT_KEYS = ['dealname', 'amount', 'project_types', 'project_number', 'project_location',
        'address', 'city', 'state', 'zip', 'country', 'description', 'estimator',
        'notes', 'due_date', 'client_email', 'client_phone', 'company_name'];
      for (const [key, value] of Object.entries(changedFields)) {
        if (ALLOWED_HUBSPOT_KEYS.includes(key)) {
          hubspotUpdateProps[key] = value;
        }
      }
      // Sync custom HubSpot properties when form fields change
      if (changedFields.description !== undefined) {
        hubspotUpdateProps.project_description__briefly_describe_the_project_ = changedFields.description;
      }
      // bid_due_date: map to closedate (HubSpot native) and proposal_due_date (custom)
      if (changedFields.bid_due_date !== undefined) {
        const dateStr = changedFields.bid_due_date;
        if (dateStr && /^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
          const date = new Date(dateStr);
          hubspotUpdateProps.closedate = date.getTime().toString();
          hubspotUpdateProps.proposal_due_date = date.getTime().toString();
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

    const isService = String(finalProjectTypeDigit) === '4';
    const targetStageName = isService ? 'Service - Estimating' : 'Estimating';

    const resolvedStage = await resolveHubspotStageId(targetStageName);
    if (resolvedStage) {
      await updateHubSpotDealStage(hubspotDealId, resolvedStage.stageId);
      log(`[rfp-approval] Deal ${hubspotDealId} moved to stage "${resolvedStage.stageName}" (type=${finalProjectTypeDigit})`, 'rfp');
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

    const TEMP_DIR = process.env.TEMP_DIR || '.playwright-temp';
    const tempPaths: string[] = [];
    let attachmentsToSync: Array<{ name: string; url?: string; localPath?: string; type?: string; size?: number }> | undefined;
    if (options && Array.isArray(options.attachmentsOverride)) {
      attachmentsToSync = [];
      for (const a of options.attachmentsOverride) {
        if (a._new) continue;
        if (a.url) attachmentsToSync.push({ name: a.name || 'attachment', url: a.url });
      }
      for (let i = 0; i < (options.newFiles || []).length; i++) {
        const f = options.newFiles![i];
        await fs.mkdir(TEMP_DIR, { recursive: true });
        const tmpPath = path.join(TEMP_DIR, `rfp-new-${randomUUID()}-${(f.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_')}`);
        await fs.writeFile(tmpPath, f.buffer);
        tempPaths.push(tmpPath);
        attachmentsToSync.push({ name: f.originalname || 'attachment', localPath: tmpPath, type: f.mimetype, size: f.size });
      }
      if (tempPaths.length > 0) {
        log(`[rfp-approval] Stored ${tempPaths.length} new attachment(s) temporarily until BidBoard upload completes`, 'rfp');
      }
    }

    let bidboardProjectId: string | undefined;
    let bidboardFailed = false;
    try {
      const { createBidBoardProjectFromDeal } = await import('./playwright/bidboard');
      const bidboardStage = isService ? 'Service – Estimating' : 'Estimate in Progress';
      const bbResult = await createBidBoardProjectFromDeal(hubspotDealId, bidboardStage, {
        syncDocuments: true,
        attachmentsOverride: attachmentsToSync,
        projectNumberOverride: finalProjectNumber || editedFields.project_number || (dealData.project_number as string) || undefined,
        editedFieldsOverride: {
          ...editedFields,
          project_types: finalProjectTypeDigit,
        },
        proposalId: (editedFields.proposal_id || dealData.proposalId) as string | undefined,
      });
      if (bbResult.success && bbResult.projectId) {
        bidboardProjectId = bbResult.projectId;
        log(`[rfp-approval] BidBoard project created: ${bidboardProjectId} for deal ${hubspotDealId}`, 'rfp');

        // Upload _new attachments to HubSpot and associate with deal (BidBoard upload succeeded)
        const newAttachments = (attachmentsToSync || []).filter((a) => a.localPath);
        for (const att of newAttachments) {
          if (!att.localPath || !att.name) continue;
          try {
            await uploadFileToHubSpotAndAttachToDeal(att.localPath, att.name, hubspotDealId);
            log(`[rfp-approval] Uploaded ${att.name} to HubSpot and attached to deal ${hubspotDealId}`, 'rfp');
          } catch (hubErr: any) {
            console.error(`[rfp-approval] Failed to upload ${att.name} to HubSpot:`, hubErr.message);
          }
        }
      } else {
        bidboardFailed = true;
        console.error(`[rfp-approval] HubSpot updated successfully but BidBoard creation failed for deal ${hubspotDealId}: ${bbResult.error}`);
      }
    } catch (bbErr: any) {
      bidboardFailed = true;
      console.error(`[rfp-approval] BidBoard creation error for deal ${hubspotDealId}:`, bbErr.message);
    } finally {
      // Temp files are only deleted AFTER createBidBoardProjectFromDeal completes (including document sync).
      // This ensures attachments remain available until they have been uploaded to BidBoard.
      for (const p of tempPaths) {
        try { await fs.unlink(p); } catch { /* ignore */ }
      }
      if (tempPaths.length > 0) {
        log(`[rfp-approval] Cleaned up ${tempPaths.length} temporary attachment file(s)`, 'rfp');
      }
    }

    if (bidboardFailed) {
      // Even though BidBoard failed, HubSpot was already updated (stage, fields).
      // Mark as approved so retries don't re-run HubSpot updates and create duplicate projects.
      await storage.updateRfpApprovalRequest(request.id, {
        status: 'approved',
        editedFields: changedFields,
        approvedBy: approverEmail,
        approvedAt: new Date(),
        bidboardProjectId: bidboardProjectId || null,
      });
      return {
        success: false,
        error: 'HubSpot updated but BidBoard project creation failed. Request marked approved to prevent duplicate retries.',
        bidboardProjectId,
      };
    }

    const approvedAttachmentsForStorage = (attachmentsToSync || []).map(a => ({
      name: a.name,
      url: a.url || undefined,
      _new: !!a.localPath,
    }));

    await storage.updateRfpApprovalRequest(request.id, {
      status: 'approved',
      editedFields: changedFields,
      approvedAttachments: approvedAttachmentsForStorage,
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
        approvedAttachments: approvedAttachmentsForStorage,
        projectType: finalProjectTypeDigit,
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
