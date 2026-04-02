import { storage } from './storage';
import { getHubSpotClient, getAccessToken } from './hubspot';
import { fetchWithTimeout } from './lib/fetch-with-timeout';
import { sendEmail, renderTemplate } from './email-service';
import { db } from './db';
import { projectNumberRegistry } from '@shared/schema';
import { eq, desc, like } from 'drizzle-orm';

/** Julian date format: DDDYY (e.g. 06326 = 63rd day of 2026) */
function generateJulianDate(createDate: Date): string {
  const year = createDate.getFullYear();
  const startOfYear = new Date(year, 0, 1);
  const diff = createDate.getTime() - startOfYear.getTime();
  const oneDay = 1000 * 60 * 60 * 24;
  const dayOfYear = Math.floor(diff / oneDay) + 1;
  const dayOfYearFormatted = dayOfYear.toString().padStart(3, '0');
  const twoDigitYear = year.toString().slice(-2);
  return dayOfYearFormatted + twoDigitYear;
}

/** Map project_location to office code: DFW or ATL */
function resolveOfficeCode(projectLocation: string | null | undefined): 'DFW' | 'ATL' {
  const loc = String(projectLocation || '').trim().toUpperCase();
  if (loc.includes('ATL')) return 'ATL';
  return 'DFW'; // Default to DFW
}

/** Map project_types dropdown to numeric code (1-9). 4=Service, 9=Residential, etc. */
function resolveProjectTypeCode(projectTypes: string | null | undefined): string {
  const val = String(projectTypes || '').trim();
  if (/^[1-9]$/.test(val)) return val;
  return '9'; // Default to Residential if not set
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

async function findHighestSuffixForDate(julianDate: string, office: string): Promise<string | null> {
  // Find the highest suffix across ALL project types for this date+office combo
  // e.g., search for DFW-%-08326 so DFW-4-08326-aa and DFW-5-08326-ab share the same sequence
  const pattern = `${office}-%-${julianDate}`;
  const existing = await db.select({ suffix: projectNumberRegistry.suffix })
    .from(projectNumberRegistry)
    .where(like(projectNumberRegistry.baseNumber, pattern))
    .orderBy(desc(projectNumberRegistry.suffix));

  if (existing.length === 0) return null;
  return existing[0].suffix;
}

async function getOwnerDetails(ownerId: string): Promise<{ name: string; email: string } | null> {
  if (!ownerId) return null;
  try {
    const accessToken = await getAccessToken();
    const response = await fetchWithTimeout(`https://api.hubapi.com/crm/v3/owners/${ownerId}`, {
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
    'project_location', 'project_types', 'estimator',
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
  const office = resolveOfficeCode(props.project_location);
  const projectType = resolveProjectTypeCode(props.project_types);
  const julianDate = generateJulianDate(createDate);
  const baseNumber = `${office}-${projectType}-${julianDate}`;
  const highestSuffix = await findHighestSuffixForDate(julianDate, office);
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
    projectTypes: props.project_types || null,
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
      office,
      projectType,
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

  const variables: Record<string, string> = {
    dealName: params.dealName,
    projectNumber: params.projectNumber,
    ownerName: params.ownerName,
    ownerEmail: params.ownerEmail || '',
    officeLocation: params.officeLocation,
    estimator: params.estimator,
    hubspotDealId: params.hubspotDealId,
    hubspotDealUrl: `https://app-na2.hubspot.com/contacts/45644695/record/0-3/${params.hubspotDealId}`,
  };

  const subject = renderTemplate(template.subject, variables);
  const htmlBody = renderTemplate(template.bodyHtml, variables);

  const dedupeKey = `project_number:${params.hubspotDealId}`;
  const alreadySent = await storage.checkEmailDedupeKey(dedupeKey);

  // Send to deal owner if available and not already sent
  const recipientEmail = params.ownerEmail;
  if (recipientEmail && !alreadySent) {
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

  // Always notify kscheidegger + sbohen on every new deal (separate dedup per recipient)
  const additionalRecipients = ['kscheidegger@trockgc.com', 'sbohen@trockgc.com'];
  for (const extra of additionalRecipients) {
    if (extra === recipientEmail) continue;
    const extraDedupeKey = `project_number:${params.hubspotDealId}:${extra}`;
    const extraAlreadySent = await storage.checkEmailDedupeKey(extraDedupeKey);
    if (extraAlreadySent) continue;
    try {
      const result = await sendEmail({
        to: extra,
        subject,
        htmlBody,
        fromName: 'T-Rock Sync Hub',
      });
      await storage.createEmailSendLog({
        templateKey: 'new_deal_project_number',
        recipientEmail: extra,
        subject,
        status: result.success ? 'sent' : 'failed',
        dedupeKey: extraDedupeKey,
        metadata: { dealName: params.dealName, projectNumber: params.projectNumber },
      });
      console.log(`[project-number] New deal notification sent to ${extra}`);
    } catch (err: any) {
      console.error(`[project-number] Failed to notify ${extra}:`, err.message);
    }
  }
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
