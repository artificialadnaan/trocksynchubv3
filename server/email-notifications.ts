import { storage } from './storage';
import { sendEmail, renderTemplate } from './email-service';
import { getDealOwnerInfo } from './hubspot';

export async function sendRoleAssignmentEmails(
  newAssignments: Array<{
    procoreProjectId: string;
    projectName: string;
    roleName: string;
    assigneeId: string;
    assigneeName: string;
    assigneeEmail: string;
    assigneeCompany: string;
  }>
): Promise<{ sent: number; skipped: number; failed: number }> {
  const template = await storage.getEmailTemplate('project_role_assignment');
  if (!template || !template.enabled) {
    console.log('[email] Project role assignment template is disabled, skipping notifications');
    return { sent: 0, skipped: newAssignments.length, failed: 0 };
  }

  let sent = 0, skipped = 0, failed = 0;

  for (const assignment of newAssignments) {
    if (!assignment.assigneeEmail) {
      skipped++;
      continue;
    }

    const dedupeKey = `role_assignment:${assignment.procoreProjectId}:${assignment.roleName}:${assignment.assigneeId}`;

    const alreadySent = await storage.checkEmailDedupeKey(dedupeKey);
    if (alreadySent) {
      console.log(`[email] Skipping duplicate: ${dedupeKey}`);
      skipped++;
      continue;
    }

    const variables: Record<string, string> = {
      assigneeName: assignment.assigneeName || assignment.assigneeEmail,
      projectName: assignment.projectName || 'Unknown Project',
      roleName: assignment.roleName,
      assigneeEmail: assignment.assigneeEmail,
      projectId: assignment.procoreProjectId,
      companyId: '598134325683880',
      projectUrl: `https://us02.procore.com/webclients/host/companies/598134325683880/projects/${assignment.procoreProjectId}/tools/projecthome`,
    };

    const subject = renderTemplate(template.subject, variables);
    const htmlBody = renderTemplate(template.bodyHtml, variables);

    const result = await sendEmail({
      to: assignment.assigneeEmail,
      subject,
      htmlBody,
      fromName: 'T-Rock Sync Hub',
    });

    try {
      await storage.createEmailSendLog({
        templateKey: 'project_role_assignment',
        recipientEmail: assignment.assigneeEmail,
        recipientName: assignment.assigneeName,
        subject,
        dedupeKey,
        status: result.success ? 'sent' : 'failed',
        errorMessage: result.error || null,
        metadata: {
          messageId: result.messageId,
          projectId: assignment.procoreProjectId,
          projectName: assignment.projectName,
          roleName: assignment.roleName,
          assigneeCompany: assignment.assigneeCompany,
        },
        sentAt: new Date(),
      });
    } catch (logErr: any) {
      if (logErr.message?.includes('unique constraint')) {
        console.log(`[email] Dedupe key already exists: ${dedupeKey}`);
        skipped++;
        continue;
      }
      throw logErr;
    }

    if (result.success) {
      sent++;
      console.log(`[email] Sent role assignment notification to ${assignment.assigneeEmail} for ${assignment.projectName} (${assignment.roleName})`);
    } else {
      failed++;
      console.error(`[email] Failed to send to ${assignment.assigneeEmail}: ${result.error}`);
    }
  }

  console.log(`[email] Role assignment notifications: ${sent} sent, ${skipped} skipped, ${failed} failed`);

  if (sent > 0 || failed > 0) {
    await storage.createAuditLog({
      action: 'email_notifications_sent',
      entityType: 'email',
      source: 'automation',
      status: failed > 0 ? 'partial' : 'success',
      details: { templateKey: 'project_role_assignment', sent, skipped, failed },
    });
  }

  return { sent, skipped, failed };
}

export async function sendStageChangeEmail(params: {
  hubspotDealId: string;
  dealName: string;
  procoreProjectId: string;
  procoreProjectName: string;
  oldStage: string;
  newStage: string;
  hubspotStageName: string;
}): Promise<{ sent: boolean; ownerEmail: string | null; error?: string }> {
  const template = await storage.getEmailTemplate('stage_change_notification');
  if (!template || !template.enabled) {
    console.log('[email] Stage change notification template is disabled, skipping');
    return { sent: false, ownerEmail: null, error: 'template_disabled' };
  }

  const ownerInfo = await getDealOwnerInfo(params.hubspotDealId);
  if (!ownerInfo.ownerEmail) {
    console.log(`[email] No deal owner found for deal ${params.hubspotDealId}, skipping stage change email`);
    return { sent: false, ownerEmail: null, error: 'no_deal_owner' };
  }

  const dedupeKey = `stage_change:${params.procoreProjectId}:${params.newStage}:${Date.now()}`;

  const variables: Record<string, string> = {
    ownerName: ownerInfo.ownerName || ownerInfo.ownerEmail,
    dealName: params.dealName || 'Unknown Deal',
    procoreProjectName: params.procoreProjectName || 'Unknown Project',
    oldStage: params.oldStage || 'Unknown',
    newStage: params.newStage || 'Unknown',
    hubspotStageName: params.hubspotStageName || 'Unknown',
    procoreProjectId: params.procoreProjectId,
    hubspotDealId: params.hubspotDealId,
    hubspotDealUrl: `https://app-na2.hubspot.com/contacts/245227962/record/0-3/${params.hubspotDealId}`,
    procoreProjectUrl: `https://us02.procore.com/webclients/host/companies/598134325683880/projects/${params.procoreProjectId}/tools/projecthome`,
  };

  const subject = renderTemplate(template.subject, variables);
  const htmlBody = renderTemplate(template.bodyHtml, variables);

  const result = await sendEmail({
    to: ownerInfo.ownerEmail,
    subject,
    htmlBody,
    fromName: 'T-Rock Sync Hub',
  });

  try {
    await storage.createEmailSendLog({
      templateKey: 'stage_change_notification',
      recipientEmail: ownerInfo.ownerEmail,
      recipientName: ownerInfo.ownerName || ownerInfo.ownerEmail,
      subject,
      dedupeKey,
      status: result.success ? 'sent' : 'failed',
      errorMessage: result.error || null,
      metadata: {
        hubspotDealId: params.hubspotDealId,
        dealName: params.dealName,
        procoreProjectId: params.procoreProjectId,
        oldStage: params.oldStage,
        newStage: params.newStage,
      },
      sentAt: new Date(),
    });
  } catch (logErr: any) {
    console.error(`[email] Failed to log stage change email:`, logErr.message);
  }

  if (result.success) {
    console.log(`[email] Stage change notification sent to ${ownerInfo.ownerEmail} for ${params.dealName} (${params.oldStage} → ${params.newStage})`);
  } else {
    console.error(`[email] Failed to send stage change notification to ${ownerInfo.ownerEmail}: ${result.error}`);
  }

  return { sent: result.success, ownerEmail: ownerInfo.ownerEmail, error: result.error };
}
