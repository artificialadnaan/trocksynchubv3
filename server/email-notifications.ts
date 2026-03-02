/**
 * Email Notifications Module
 * ==========================
 * 
 * This module handles automated email notifications triggered by various
 * system events. It uses configurable templates and deduplication.
 * 
 * Notification Types:
 * 
 * 1. Role Assignment Notifications:
 *    - Sent when team members are assigned to projects
 *    - Includes links to Procore, HubSpot, and CompanyCam
 * 
 * 2. Project Kickoff Emails:
 *    - Sent when a project transitions to active (Portfolio)
 *    - Includes project team and relevant links
 * 
 * 3. Closeout Survey Emails:
 *    - Sent when a project reaches completion
 *    - Contains unique survey link for client feedback
 * 
 * 4. Weekly Summary Reports:
 *    - Periodic digest of sync activity
 *    - Sent to configured recipients
 * 
 * Features:
 * - Templated emails with variable substitution
 * - Deduplication to prevent duplicate sends
 * - Configurable enable/disable per template
 * - Email send logging for audit trails
 * 
 * Template Variables:
 * Common variables available in templates:
 * - {{assigneeName}}, {{projectName}}, {{roleName}}
 * - {{procoreUrl}}, {{hubspotUrl}}, {{companycamUrl}}
 * - {{ownerName}}, {{ownerEmail}}
 * 
 * Key Functions:
 * - sendRoleAssignmentEmails(): Notify team of role assignments
 * - sendKickoffEmails(): Notify team of project kickoff
 * - sendCloseoutSurveyEmail(): Send client satisfaction survey
 * - sendWeeklySummaryEmail(): Send periodic activity digest
 * 
 * @module email-notifications
 */

import { storage } from './storage';
import { sendEmail, renderTemplate } from './email-service';
import { getDealOwnerInfo } from './hubspot';
import { fetchProcoreProjectDetail, getProjectTeamMembers } from './procore';

/**
 * Sends email notifications for new project role assignments.
 * Each assignment triggers an email to the assignee with project details.
 * Deduplication prevents the same assignment notification from being sent twice.
 */
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

    const mapping = await storage.getSyncMappingByProcoreProjectId(assignment.procoreProjectId);
    
    const variables: Record<string, string> = {
      assigneeName: assignment.assigneeName || assignment.assigneeEmail,
      projectName: assignment.projectName || 'Unknown Project',
      roleName: assignment.roleName,
      assigneeEmail: assignment.assigneeEmail,
      projectId: assignment.procoreProjectId,
      companyId: '598134325683880',
      procoreUrl: `https://us02.procore.com/webclients/host/companies/598134325683880/projects/${assignment.procoreProjectId}/tools/projecthome`,
      hubspotUrl: mapping?.hubspotDealId ? `https://app-na2.hubspot.com/contacts/245227962/record/0-3/${mapping.hubspotDealId}` : 'https://app-na2.hubspot.com/contacts/245227962/objects/0-3',
      companycamUrl: mapping?.companycamProjectId ? `https://app.companycam.com/projects/${mapping.companycamProjectId}` : 'https://app.companycam.com/projects',
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

/**
 * When a new Project Manager is assigned to a Portfolio project (detected via role sync),
 * trigger the project kickoff email. Kickoff is sent from Portfolio, not BidBoard.
 */
export async function triggerKickoffForNewPmOnPortfolio(
  newAssignments: Array<{
    procoreProjectId: string;
    projectName: string;
    roleName: string;
    assigneeId: string;
    assigneeName: string;
    assigneeEmail: string;
    assigneeCompany: string;
  }>
): Promise<{ triggered: number; failed: number }> {
  const pmAssignments = newAssignments.filter((a) =>
    a.roleName.toLowerCase().includes('project manager')
  );
  if (pmAssignments.length === 0) return { triggered: 0, failed: 0 };

  let triggered = 0;
  let failed = 0;

  for (const assignment of pmAssignments) {
    try {
      const mapping = await storage.getSyncMappingByProcoreProjectId(assignment.procoreProjectId);
      if (!mapping) continue;
      const kickoffProjectId = mapping.portfolioProjectId || mapping.procoreProjectId;
      if (!kickoffProjectId) continue;

      const projectDetail = await fetchProcoreProjectDetail(kickoffProjectId);
      if (!projectDetail) continue;

      const teamMembers = await getProjectTeamMembers(kickoffProjectId);
      const formatDate = (d: string | null | undefined) => {
        if (!d) return 'TBD';
        try {
          const dt = new Date(d);
          return isNaN(dt.getTime()) ? 'TBD' : dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        } catch {
          return 'TBD';
        }
      };

      const result = await sendKickoffEmails({
        projectId: kickoffProjectId,
        hubspotDealId: mapping.hubspotDealId || undefined,
        projectName: projectDetail?.name || projectDetail?.display_name || assignment.projectName || 'Unknown Project',
        clientName: projectDetail?.company?.name || 'Unknown Client',
        projectAddress: projectDetail?.address || projectDetail?.location || 'TBD',
        scopeSummary: projectDetail?.work_scope || projectDetail?.description || 'See project details in Procore',
        startDate: formatDate(projectDetail?.start_date),
        endDate: formatDate(projectDetail?.end_date || projectDetail?.completion_date),
        teamMembers,
        nextStep: 'scheduling the project kickoff meeting',
      });

      if (result.sent > 0) {
        triggered++;
        console.log(`[email] Kickoff sent for new PM on Portfolio project ${assignment.procoreProjectId} (${assignment.projectName})`);
      } else if (result.failed > 0) {
        failed++;
      }
    } catch (err: any) {
      failed++;
      console.error(`[email] Failed to trigger kickoff for PM on ${assignment.procoreProjectId}:`, err.message);
    }
  }

  return { triggered, failed };
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
    try {
      await storage.createEmailSendLog({
        templateKey: 'stage_change_notification',
        recipientEmail: '(skipped)',
        recipientName: null,
        subject: `Stage change: ${params.dealName} (${params.oldStage} → ${params.newStage})`,
        dedupeKey: `stage_change_skipped:${params.hubspotDealId}:${params.newStage}:${Date.now()}`,
        status: 'skipped',
        errorMessage: 'template_disabled',
        metadata: {
          hubspotDealId: params.hubspotDealId,
          dealName: params.dealName,
          procoreProjectId: params.procoreProjectId,
          oldStage: params.oldStage,
          newStage: params.newStage,
          reason: 'template_disabled',
        },
        sentAt: new Date(),
      });
    } catch (logErr: any) {
      console.error('[email] Failed to log skipped stage change email:', logErr.message);
    }
    return { sent: false, ownerEmail: null, error: 'template_disabled' };
  }

  const ownerInfo = await getDealOwnerInfo(params.hubspotDealId);
  if (!ownerInfo.ownerEmail) {
    console.log(`[email] No deal owner found for deal ${params.hubspotDealId}, skipping stage change email`);
    try {
      await storage.createEmailSendLog({
        templateKey: 'stage_change_notification',
        recipientEmail: '(skipped)',
        recipientName: null,
        subject: `Stage change: ${params.dealName} (${params.oldStage} → ${params.newStage})`,
        dedupeKey: `stage_change_skipped:${params.hubspotDealId}:${params.newStage}:${Date.now()}`,
        status: 'skipped',
        errorMessage: 'no_deal_owner',
        metadata: {
          hubspotDealId: params.hubspotDealId,
          dealName: params.dealName,
          procoreProjectId: params.procoreProjectId,
          oldStage: params.oldStage,
          newStage: params.newStage,
          reason: 'no_deal_owner',
        },
        sentAt: new Date(),
      });
    } catch (logErr: any) {
      console.error('[email] Failed to log skipped stage change email:', logErr.message);
    }
    return { sent: false, ownerEmail: null, error: 'no_deal_owner' };
  }

  const dedupeKey = `stage_change:${params.procoreProjectId}:${params.newStage}:${Date.now()}`;

  const mapping = await storage.getSyncMappingByProcoreProjectId(params.procoreProjectId);

  const variables: Record<string, string> = {
    ownerName: ownerInfo.ownerName || ownerInfo.ownerEmail,
    dealName: params.dealName || 'Unknown Deal',
    projectName: params.procoreProjectName || params.dealName || 'Unknown Project',
    procoreProjectName: params.procoreProjectName || 'Unknown Project',
    projectId: params.procoreProjectId,
    previousStage: params.oldStage || 'Unknown',
    newStage: params.newStage || 'Unknown',
    hubspotStage: params.hubspotStageName || params.newStage || 'Unknown',
    hubspotStageName: params.hubspotStageName || 'Unknown',
    procoreProjectId: params.procoreProjectId,
    hubspotDealId: params.hubspotDealId,
    timestamp: new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
    procoreUrl: `https://us02.procore.com/webclients/host/companies/598134325683880/projects/${params.procoreProjectId}/tools/projecthome`,
    hubspotUrl: `https://app-na2.hubspot.com/contacts/245227962/record/0-3/${params.hubspotDealId}`,
    companycamUrl: mapping?.companycamProjectId ? `https://app.companycam.com/projects/${mapping.companycamProjectId}` : 'https://app.companycam.com/projects',
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

export async function sendKickoffEmails(params: {
  projectId: string;
  projectName: string;
  clientName: string;
  projectAddress?: string;
  scopeSummary?: string;
  startDate?: string;
  endDate?: string;
  teamMembers: Array<{
    name: string;
    email: string;
    role: string;
    phone?: string;
  }>;
  pmName?: string;
  pmEmail?: string;
  pmPhone?: string;
  superName?: string;
  superEmail?: string;
  superPhone?: string;
  primaryContact?: string;
  preferredMethod?: string;
  statusFrequency?: string;
  nextStep?: string;
  hubspotDealId?: string;
}): Promise<{ sent: number; skipped: number; failed: number }> {
  const template = await storage.getEmailTemplate('project_kickoff');
  if (!template || !template.enabled) {
    console.log('[email] Project kickoff template is disabled, skipping notifications');
    return { sent: 0, skipped: params.teamMembers.length, failed: 0 };
  }

  let sent = 0, skipped = 0, failed = 0;

  const pm = params.teamMembers.find(m => m.role.toLowerCase().includes('project manager'));
  const superMember = params.teamMembers.find(m => m.role.toLowerCase().includes('superintendent'));
  const pmName = params.pmName || pm?.name || 'TBD';
  const pmEmail = params.pmEmail || pm?.email || 'TBD';
  const pmPhone = params.pmPhone || pm?.phone || 'TBD';
  const superName = params.superName || superMember?.name || 'TBD';
  const superEmail = params.superEmail || superMember?.email || 'TBD';
  const superPhone = params.superPhone || superMember?.phone || 'TBD';

  // Send kickoff only to the project manager
  const recipients = pm ? [pm] : [];

  const mapping = await storage.getSyncMappingByProcoreProjectId(params.projectId);

  // Log when no PM so it appears in Send History as failed/skipped
  if (recipients.length === 0) {
    try {
      await storage.createEmailSendLog({
        templateKey: 'project_kickoff',
        recipientEmail: '(skipped)',
        recipientName: null,
        subject: `Project Kickoff: ${params.projectName || 'Unknown Project'}`,
        dedupeKey: `kickoff_skipped:${params.projectId}:${Date.now()}`,
        status: 'skipped',
        errorMessage: 'no_project_manager',
        metadata: {
          projectId: params.projectId,
          projectName: params.projectName,
          clientName: params.clientName,
          reason: 'no_project_manager',
        },
        sentAt: new Date(),
      });
    } catch (logErr: any) {
      console.error('[email] Failed to log skipped kickoff:', logErr.message);
    }
    return { sent: 0, skipped: 1, failed: 0 };
  }

  for (const member of recipients) {
    if (!member.email) {
      skipped++;
      try {
        await storage.createEmailSendLog({
          templateKey: 'project_kickoff',
          recipientEmail: '(skipped)',
          recipientName: member.name,
          subject: `Project Kickoff: ${params.projectName || 'Unknown Project'}`,
          dedupeKey: `kickoff_skipped_no_email:${params.projectId}:${member.role}:${Date.now()}`,
          status: 'skipped',
          errorMessage: 'pm_has_no_email',
          metadata: {
            projectId: params.projectId,
            projectName: params.projectName,
            role: member.role,
            reason: 'pm_has_no_email',
          },
          sentAt: new Date(),
        });
      } catch (logErr: any) {
        console.error('[email] Failed to log skipped kickoff:', logErr.message);
      }
      continue;
    }

    const dedupeKey = `kickoff:${params.projectId}:${member.role}:${member.email}`;

    const alreadySent = await storage.checkEmailDedupeKey(dedupeKey);
    if (alreadySent) {
      console.log(`[email] Skipping duplicate kickoff: ${dedupeKey}`);
      skipped++;
      continue;
    }

    const hubspotDealId = params.hubspotDealId || mapping?.hubspotDealId;

    const variables: Record<string, string> = {
      recipientName: member.name || member.email,
      projectName: params.projectName || 'Unknown Project',
      clientName: params.clientName || 'Unknown Client',
      projectAddress: params.projectAddress || 'TBD',
      scopeSummary: params.scopeSummary || 'See project details in Procore',
      startDate: params.startDate || 'TBD',
      endDate: params.endDate || 'TBD',
      roleName: member.role,
      pmName: pmName ?? 'TBD',
      pmEmail: pmEmail ?? 'TBD',
      pmPhone: pmPhone ?? 'TBD',
      superName: superName ?? 'TBD',
      superEmail: superEmail ?? 'TBD',
      superPhone: superPhone ?? 'TBD',
      primaryContact: params.primaryContact || pmName,
      preferredMethod: params.preferredMethod || 'Email',
      statusFrequency: params.statusFrequency || 'Weekly',
      nextStep: params.nextStep || 'scheduling the project kickoff meeting',
      procoreUrl: `https://us02.procore.com/webclients/host/companies/598134325683880/projects/${params.projectId}/tools/projecthome`,
      hubspotUrl: hubspotDealId ? `https://app-na2.hubspot.com/contacts/245227962/record/0-3/${hubspotDealId}` : 'https://app-na2.hubspot.com/contacts/245227962/objects/0-3',
      companycamUrl: mapping?.companycamProjectId ? `https://app.companycam.com/projects/${mapping.companycamProjectId}` : 'https://app.companycam.com/projects',
    };

    const subject = renderTemplate(template.subject, variables);
    const htmlBody = renderTemplate(template.bodyHtml, variables);

    let result: { success: boolean; error?: string; messageId?: string };
    try {
      result = await sendEmail({
        to: member.email,
        subject,
        htmlBody,
        fromName: 'T-Rock Sync Hub',
      });
    } catch (sendErr: any) {
      result = { success: false, error: sendErr?.message || String(sendErr) };
    }

    try {
      await storage.createEmailSendLog({
        templateKey: 'project_kickoff',
        recipientEmail: member.email,
        recipientName: member.name,
        subject,
        dedupeKey,
        status: result.success ? 'sent' : 'failed',
        errorMessage: result.error || null,
        metadata: {
          messageId: result.messageId,
          projectId: params.projectId,
          projectName: params.projectName,
          role: member.role,
          clientName: params.clientName,
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
      console.log(`[email] Sent kickoff notification to ${member.email} for ${params.projectName} (${member.role})`);
    } else {
      failed++;
      console.error(`[email] Failed to send kickoff to ${member.email}: ${result.error}`);
    }
  }

  console.log(`[email] Kickoff notifications: ${sent} sent, ${skipped} skipped, ${failed} failed`);

  if (sent > 0 || failed > 0) {
    await storage.createAuditLog({
      action: 'kickoff_emails_sent',
      entityType: 'email',
      source: 'automation',
      status: failed > 0 ? 'partial' : 'success',
      details: { templateKey: 'project_kickoff', projectId: params.projectId, sent, skipped, failed },
    });
  }

  return { sent, skipped, failed };
}

export async function sendBidBoardSyncSummary(params: {
  recipientEmails: string[];
  date: string;
  projectsScanned: number;
  stageChanges: number;
  portfolioTransitions: number;
  hubspotUpdates: number;
  changedProjects?: Array<{
    name: string;
    oldStage: string;
    newStage: string;
    procoreUrl: string;
    hubspotUrl?: string;
  }>;
}): Promise<{ sent: number; failed: number }> {
  const template = await storage.getEmailTemplate('bidboard_sync_summary');
  if (!template || !template.enabled) {
    console.log('[email] BidBoard sync summary template is disabled, skipping');
    return { sent: 0, failed: 0 };
  }

  let sent = 0, failed = 0;

  const appUrl = process.env.APP_URL || 'http://localhost:5000';

  let changedProjectsHtml = '';
  if (params.changedProjects && params.changedProjects.length > 0) {
    changedProjectsHtml = params.changedProjects.map(p => `
      <div style="background-color: rgba(255,255,255,0.1); border-radius: 8px; padding: 12px; margin-bottom: 8px;">
        <p style="color: #ffffff; font-size: 14px; font-weight: 600; margin: 0 0 4px 0;">${p.name}</p>
        <p style="color: #94a3b8; font-size: 12px; margin: 0;">
          ${p.oldStage} → <span style="color: #10b981;">${p.newStage}</span>
        </p>
        <p style="margin: 8px 0 0 0;">
          <a href="${p.procoreUrl}" style="color: #f97316; font-size: 11px; text-decoration: none;">Procore</a>
          ${p.hubspotUrl ? `<span style="color: #64748b;"> | </span><a href="${p.hubspotUrl}" style="color: #ff5c35; font-size: 11px; text-decoration: none;">HubSpot</a>` : ''}
        </p>
      </div>
    `).join('');
  }

  for (const email of params.recipientEmails) {
    if (!email) continue;

    const variables: Record<string, string> = {
      date: params.date,
      projectsScanned: String(params.projectsScanned),
      stageChanges: String(params.stageChanges),
      portfolioTransitions: String(params.portfolioTransitions),
      hubspotUpdates: String(params.hubspotUpdates),
      changedProjects: changedProjectsHtml,
      bidboardUrl: 'https://us02.procore.com/webclients/host/companies/598134325683880/projects',
      hubspotDealsUrl: 'https://app-na2.hubspot.com/contacts/245227962/objects/0-3/views/all/list',
      syncHubUrl: appUrl,
      nextSyncTime: '1 hour',
    };

    const subject = renderTemplate(template.subject, variables);
    const htmlBody = renderTemplate(template.bodyHtml, variables);

    const result = await sendEmail({
      to: email,
      subject,
      htmlBody,
      fromName: 'T-Rock Sync Hub',
    });

    if (result.success) {
      sent++;
      console.log(`[email] BidBoard sync summary sent to ${email}`);
    } else {
      failed++;
      console.error(`[email] Failed to send BidBoard sync summary to ${email}: ${result.error}`);
    }
  }

  if (sent > 0 || failed > 0) {
    await storage.createAuditLog({
      action: 'bidboard_sync_summary_sent',
      entityType: 'email',
      source: 'automation',
      status: failed > 0 ? 'partial' : 'success',
      details: { 
        templateKey: 'bidboard_sync_summary', 
        recipientCount: params.recipientEmails.length,
        sent, 
        failed,
        stats: {
          projectsScanned: params.projectsScanned,
          stageChanges: params.stageChanges,
          portfolioTransitions: params.portfolioTransitions,
          hubspotUpdates: params.hubspotUpdates,
        }
      },
    });
  }

  return { sent, failed };
}
