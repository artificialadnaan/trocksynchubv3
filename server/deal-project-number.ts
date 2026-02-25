import { storage } from './storage';
import { getHubSpotClient, getAccessToken } from './hubspot';
import { sendEmail, renderTemplate } from './gmail';
import { db } from './db';
import { projectNumberRegistry } from '@shared/schema';
import { eq, like, desc } from 'drizzle-orm';

function generateBaseProjectNumber(createDate: Date): string {
  const year = createDate.getFullYear();
  const startOfYear = new Date(year, 0, 1);
  const diff = createDate.getTime() - startOfYear.getTime();
  const oneDay = 1000 * 60 * 60 * 24;
  const dayOfYear = Math.floor(diff / oneDay) + 1;
  const dayOfYearFormatted = dayOfYear.toString().padStart(3, '0');
  const twoDigitYear = year.toString().slice(-2);
  return dayOfYearFormatted + twoDigitYear;
}

function getNextSuffix(existingSuffix: string | null): string {
  if (!existingSuffix) return 'aa';
  const chars = existingSuffix.split('');
  let i = chars.length - 1;
  while (i >= 0) {
    if (chars[i] < 'z') {
      chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1);
      return chars.join('');
    }
    chars[i] = 'a';
    i--;
  }
  return 'a' + chars.join('');
}

async function findHighestSuffix(baseNumber: string): Promise<string | null> {
  const existing = await db.select({ suffix: projectNumberRegistry.suffix })
    .from(projectNumberRegistry)
    .where(eq(projectNumberRegistry.baseNumber, baseNumber))
    .orderBy(desc(projectNumberRegistry.suffix));
  
  if (existing.length === 0) return null;
  return existing[0].suffix;
}

async function getOwnerDetails(ownerId: string): Promise<{ name: string; email: string } | null> {
  if (!ownerId) return null;
  try {
    const accessToken = await getAccessToken();
    const response = await fetch(`https://api.hubapi.com/crm/v3/owners/${ownerId}`, {
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' }
    });
    if (!response.ok) return null;
    const owner = await response.json();
    const name = [owner.firstName, owner.lastName].filter(Boolean).join(' ');
    return { name: name || owner.email, email: owner.email };
  } catch (e) {
    console.error('[project-number] Failed to get owner details:', e);
    return null;
  }
}

export async function assignProjectNumber(hubspotDealId: string): Promise<{
  success: boolean;
  projectNumber?: string;
  alreadyAssigned?: boolean;
  message: string;
}> {
  const existingEntry = await db.select()
    .from(projectNumberRegistry)
    .where(eq(projectNumberRegistry.hubspotDealId, hubspotDealId))
    .limit(1);

  if (existingEntry.length > 0) {
    return {
      success: true,
      projectNumber: existingEntry[0].fullProjectNumber,
      alreadyAssigned: true,
      message: `Deal already has project number ${existingEntry[0].fullProjectNumber}`,
    };
  }

  const client = await getHubSpotClient();
  const dealResponse = await client.crm.deals.basicApi.getById(hubspotDealId, [
    'dealname', 'createdate', 'hubspot_owner_id', 'project_number',
    'project_location', 'estimator',
  ]);
  const props = dealResponse.properties || {};

  if (props.project_number) {
    return {
      success: true,
      projectNumber: props.project_number,
      alreadyAssigned: true,
      message: `Deal already has project number ${props.project_number} in HubSpot`,
    };
  }

  const createDate = props.createdate ? new Date(props.createdate) : new Date();
  const baseNumber = generateBaseProjectNumber(createDate);
  const highestSuffix = await findHighestSuffix(baseNumber);
  const suffix = getNextSuffix(highestSuffix);
  const fullProjectNumber = `${baseNumber}-${suffix}`;

  let ownerDetails: { name: string; email: string } | null = null;
  if (props.hubspot_owner_id) {
    ownerDetails = await getOwnerDetails(props.hubspot_owner_id);
  }

  await db.insert(projectNumberRegistry).values({
    hubspotDealId,
    hubspotDealName: props.dealname || null,
    baseNumber,
    suffix,
    fullProjectNumber,
    officeLocation: props.project_location || null,
    projectTypes: null,
    estimator: props.estimator || null,
    ownerName: ownerDetails?.name || null,
    ownerEmail: ownerDetails?.email || null,
    createdDate: createDate,
  });

  await client.crm.deals.basicApi.update(hubspotDealId, {
    properties: { project_number: fullProjectNumber },
  });

  console.log(`[project-number] Assigned ${fullProjectNumber} to deal ${hubspotDealId} (${props.dealname})`);

  try {
    await sendNewDealNotification({
      dealName: props.dealname || 'Unnamed Deal',
      projectNumber: fullProjectNumber,
      ownerName: ownerDetails?.name || 'Unassigned',
      ownerEmail: ownerDetails?.email || null,
      officeLocation: props.project_location || '',
      estimator: props.estimator || '',
      hubspotDealId,
    });
  } catch (emailErr: any) {
    console.error('[project-number] Email notification failed:', emailErr.message);
  }

  await storage.createAuditLog({
    action: 'project_number_assigned',
    entityType: 'deal',
    entityId: hubspotDealId,
    source: 'hubspot',
    status: 'success',
    details: {
      dealName: props.dealname,
      projectNumber: fullProjectNumber,
      baseNumber,
      suffix,
      ownerName: ownerDetails?.name,
      ownerEmail: ownerDetails?.email,
    },
  });

  return {
    success: true,
    projectNumber: fullProjectNumber,
    alreadyAssigned: false,
    message: `Assigned project number ${fullProjectNumber} to ${props.dealname}`,
  };
}

async function sendNewDealNotification(params: {
  dealName: string;
  projectNumber: string;
  ownerName: string;
  ownerEmail: string | null;
  officeLocation: string;
  estimator: string;
  hubspotDealId: string;
}) {
  const template = await storage.getEmailTemplate('new_deal_project_number');
  if (!template || !template.enabled) {
    console.log('[project-number] Email template disabled, skipping notification');
    return;
  }

  const recipientEmail = params.ownerEmail;
  if (!recipientEmail) {
    console.log('[project-number] No recipient email available, skipping notification');
    return;
  }

  const dedupeKey = `project_number:${params.hubspotDealId}`;
  const alreadySent = await storage.checkEmailDedupeKey(dedupeKey);
  if (alreadySent) {
    console.log(`[project-number] Already sent notification for ${dedupeKey}`);
    return;
  }

  const variables: Record<string, string> = {
    dealName: params.dealName,
    projectNumber: params.projectNumber,
    ownerName: params.ownerName,
    ownerEmail: params.ownerEmail || '',
    officeLocation: params.officeLocation,
    estimator: params.estimator,
    hubspotDealId: params.hubspotDealId,
    hubspotDealUrl: `https://app.hubspot.com/contacts/45644695/deal/${params.hubspotDealId}`,
  };

  const subject = renderTemplate(template.subject, variables);
  const htmlBody = renderTemplate(template.bodyHtml, variables);

  const result = await sendEmail({
    to: recipientEmail,
    subject,
    htmlBody,
    fromName: 'T-Rock Sync Hub',
  });

  await storage.createEmailSendLog({
    templateKey: 'new_deal_project_number',
    recipientEmail,
    subject,
    status: result.success ? 'sent' : 'failed',
    dedupeKey,
    metadata: { dealName: params.dealName, projectNumber: params.projectNumber },
  });
}

export async function processNewDealWebhook(hubspotDealId: string): Promise<void> {
  const config = await storage.getAutomationConfig('deal_project_number');
  if (!config?.value || !(config.value as any).enabled) {
    return;
  }

  try {
    const result = await assignProjectNumber(hubspotDealId);
    if (!result.alreadyAssigned) {
      console.log(`[project-number] Webhook: ${result.message}`);
    }
  } catch (e: any) {
    console.error(`[project-number] Failed to assign project number for deal ${hubspotDealId}:`, e.message);
  }
}

export async function getProjectNumberRegistry(filters: {
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<{ data: any[]; total: number }> {
  const limit = filters.limit || 50;
  const offset = filters.offset || 0;

  let query = db.select().from(projectNumberRegistry);
  let countQuery = db.select({ count: projectNumberRegistry.id }).from(projectNumberRegistry);

  const rows = await query.orderBy(desc(projectNumberRegistry.assignedAt)).limit(limit).offset(offset);
  const countResult = await countQuery;

  return { data: rows, total: countResult.length > 0 ? rows.length + offset : 0 };
}
