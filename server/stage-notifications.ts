/**
 * Stage Notification System
 * =========================
 * Config-driven email notifications for BidBoard and Procore portfolio stage changes.
 * Each notification route can be independently toggled via automation_config.
 */

import { storage } from './storage';
import { sendEmail } from './email-service';
import { getDealOwnerInfo } from './hubspot';

export interface StageNotificationRoute {
  key: string;
  stage: string;
  source: 'bidboard' | 'portfolio';
  label: string;
  staticRecipients: string[];
  includeDealOwner: boolean;
  includeProjectRoles?: string[];
}

export const STAGE_NOTIFICATION_ROUTES: StageNotificationRoute[] = [
  // BidBoard stage notifications
  {
    key: 'bb_internal_review',
    stage: 'Estimate Under Review',
    source: 'bidboard',
    label: 'Estimate Under Review → Internal Review',
    staticRecipients: ['sgibson@trockgc.com', 'jhelms@trockgc.com'],
    includeDealOwner: false,
  },
  {
    key: 'bb_proposal_sent',
    stage: 'Estimate Sent to Client',
    source: 'bidboard',
    label: 'Estimate Sent to Client → Proposal Sent',
    staticRecipients: ['sgibson@trockgc.com', 'jhelms@trockgc.com'],
    includeDealOwner: true,
  },
  {
    key: 'bb_closed_won',
    stage: 'Sent to Production',
    source: 'bidboard',
    label: 'Sent to Production → Closed Won',
    staticRecipients: ['jhelms@trockgc.com'],
    includeDealOwner: true,
  },
  {
    key: 'bb_closed_lost',
    stage: 'Production Lost',
    source: 'bidboard',
    label: 'Production Lost → Closed Lost',
    staticRecipients: [],
    includeDealOwner: true,
  },
  // Portfolio stage notifications
  {
    key: 'pf_buy_out',
    stage: 'Buy Out',
    source: 'portfolio',
    label: 'Buy Out',
    staticRecipients: ['jhelms@trockgc.com'],
    includeDealOwner: false,
  },
  {
    key: 'pf_close_out',
    stage: 'Close Out',
    source: 'portfolio',
    label: 'Close Out',
    staticRecipients: ['jhelms@trockgc.com', 'kscheidegger@trockgc.com', 'sbohen@trockgc.com'],
    includeDealOwner: false,
  },
  {
    key: 'pf_final_invoice',
    stage: 'Close Out - Final Invoice',
    source: 'portfolio',
    label: 'Close Out - Final Invoice',
    staticRecipients: ['jhelms@trockgc.com', 'kscheidegger@trockgc.com', 'sbohen@trockgc.com'],
    includeDealOwner: false,
  },
  {
    key: 'pf_closed',
    stage: 'Closed',
    source: 'portfolio',
    label: 'Closed',
    staticRecipients: ['kscheidegger@trockgc.com', 'sbohen@trockgc.com'],
    includeDealOwner: false,
  },
  {
    key: 'pf_in_production',
    stage: 'In Production',
    source: 'portfolio',
    label: 'In Production',
    staticRecipients: [],
    includeDealOwner: false,
    includeProjectRoles: ['Account Manager', 'Superintendent', 'Project Manager'],
  },
];

function normalizeStage(stage: string): string {
  return stage.trim().toLowerCase().replace(/\s+/g, ' ');
}

function findRoute(stage: string, source: 'bidboard' | 'portfolio'): StageNotificationRoute | undefined {
  const normalized = normalizeStage(stage);
  return STAGE_NOTIFICATION_ROUTES.find(
    r => r.source === source && normalizeStage(r.stage) === normalized
  );
}

export function buildStageNotificationEmail(dealName: string, oldStage: string | null, newStage: string, procoreId: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Stage Notification</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f4f5; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #f4f4f5;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="margin: 0 auto; max-width: 600px;">
          <tr>
            <td style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); padding: 30px 40px; border-radius: 12px 12px 0 0; text-align: center;">
              <img src="https://trockgc.com/wp-content/uploads/2020/12/TRock-CONTRACTING_Icon-dark-1-150x150.png" alt="T-Rock Construction" width="50" style="max-width: 50px; height: auto; display: block; margin: 0 auto 10px auto;">
              <span style="color: #ffffff; font-size: 20px; font-weight: 700; letter-spacing: 1px;">T-ROCK CONSTRUCTION</span>
            </td>
          </tr>
          <tr>
            <td style="background: linear-gradient(90deg, #d11921 0%, #e53935 100%); height: 4px;"></td>
          </tr>
          <tr>
            <td style="background-color: #ffffff; padding: 40px;">
              <div style="text-align: center; margin-bottom: 24px;">
                <div style="display: inline-block; background: linear-gradient(135deg, #10b981 0%, #059669 100%); width: 64px; height: 64px; border-radius: 50%; line-height: 64px;">
                  <span style="font-size: 28px;">&#128203;</span>
                </div>
              </div>
              <h2 style="color: #1a1a2e; margin: 0 0 8px 0; font-size: 22px; text-align: center;">Stage Update: ${newStage}</h2>
              <p style="color: #6b7280; font-size: 14px; text-align: center; margin: 0 0 24px 0;">A project stage has changed</p>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background: #f8fafc; border-radius: 8px; overflow: hidden;">
                <tr>
                  <td style="padding: 14px 20px; border-bottom: 1px solid #e2e8f0; color: #64748b; font-size: 13px; width: 140px;">Project</td>
                  <td style="padding: 14px 20px; border-bottom: 1px solid #e2e8f0; color: #1a1a2e; font-weight: 600; font-size: 14px;">${dealName}</td>
                </tr>
                <tr>
                  <td style="padding: 14px 20px; border-bottom: 1px solid #e2e8f0; color: #64748b; font-size: 13px;">Previous Stage</td>
                  <td style="padding: 14px 20px; border-bottom: 1px solid #e2e8f0; color: #374151; font-size: 14px;">${oldStage || 'Unknown'}</td>
                </tr>
                <tr>
                  <td style="padding: 14px 20px; border-bottom: 1px solid #e2e8f0; color: #64748b; font-size: 13px;">New Stage</td>
                  <td style="padding: 14px 20px; border-bottom: 1px solid #e2e8f0; color: #d11921; font-weight: 700; font-size: 14px;">${newStage}</td>
                </tr>
                <tr>
                  <td style="padding: 14px 20px; color: #64748b; font-size: 13px;">Procore ID</td>
                  <td style="padding: 14px 20px; color: #374151; font-size: 14px;">${procoreId}</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background-color: #1e293b; padding: 30px 40px; border-radius: 0 0 12px 12px; text-align: center;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="text-align: center;">
                    <p style="color: #94a3b8; font-size: 13px; margin: 0 0 10px 0; line-height: 1.5;">
                      T-Rock Construction, LLC<br>
                      3001 Long Prairie Rd. Ste. 200, Flower Mound, TX 75022
                    </p>
                    <p style="color: #64748b; font-size: 12px; margin: 0;">
                      <a href="tel:2145484733" style="color: #d11921; text-decoration: none;">(214) 548-4733</a> &nbsp;|&nbsp;
                      <a href="https://trockgc.com" style="color: #d11921; text-decoration: none;">trockgc.com</a>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function processStageNotification(params: {
  stage: string;
  source: 'bidboard' | 'portfolio';
  projectName: string;
  oldStage: string | null;
  procoreProjectId: string;
  hubspotDealId?: string | null;
}): Promise<{ sent: number; skipped: boolean; route?: string }> {
  const route = findRoute(params.stage, params.source);
  if (!route) {
    return { sent: 0, skipped: true };
  }

  // Check if this notification is enabled
  const configKey = `stage_notify_${route.key}`;
  const config = await storage.getAutomationConfig(configKey);
  if (config && (config.value as any)?.enabled === false) {
    console.log(`[stage-notify] ${route.key} is disabled, skipping`);
    return { sent: 0, skipped: true, route: route.key };
  }

  const recipients = new Set<string>(route.staticRecipients);

  // Add deal owner if required
  if (route.includeDealOwner && params.hubspotDealId) {
    try {
      const ownerInfo = await getDealOwnerInfo(params.hubspotDealId);
      if (ownerInfo.ownerEmail) {
        recipients.add(ownerInfo.ownerEmail);
      }
    } catch (err: any) {
      console.error(`[stage-notify] Failed to get deal owner for ${params.hubspotDealId}:`, err.message);
    }
  }

  // Add role-based recipients if required
  if (route.includeProjectRoles && route.includeProjectRoles.length > 0) {
    try {
      const assignments = await storage.getProcoreRoleAssignmentsByProject(params.procoreProjectId);
      for (const assignment of assignments) {
        const roleMatch = route.includeProjectRoles.some(
          r => r.toLowerCase() === (assignment.roleName || '').toLowerCase()
        );
        if (roleMatch && assignment.assigneeEmail) {
          recipients.add(assignment.assigneeEmail);
        }
      }
    } catch (err: any) {
      console.error(`[stage-notify] Failed to get role assignments for ${params.procoreProjectId}:`, err.message);
    }
  }

  if (recipients.size === 0) {
    console.log(`[stage-notify] No recipients for ${route.key} on project ${params.projectName}`);
    return { sent: 0, skipped: false, route: route.key };
  }

  const htmlBody = buildStageNotificationEmail(
    params.projectName,
    params.oldStage,
    params.stage,
    params.procoreProjectId,
  );

  let sent = 0;
  for (const recipient of recipients) {
    try {
      await sendEmail({
        to: recipient,
        subject: `Stage Update: ${params.projectName} → ${params.stage}`,
        htmlBody,
        fromName: 'T-Rock Sync Hub',
      });
      sent++;
      console.log(`[stage-notify] ${route.key} email sent to ${recipient} for ${params.projectName}`);
    } catch (err: any) {
      console.error(`[stage-notify] Failed to send to ${recipient}:`, err.message);
    }
  }

  await storage.createAuditLog({
    action: 'stage_notification_sent',
    entityType: 'project_stage',
    entityId: params.procoreProjectId,
    source: params.source === 'bidboard' ? 'bidboard_stage_sync' : 'procore',
    status: 'success',
    details: {
      route: route.key,
      stage: params.stage,
      oldStage: params.oldStage,
      projectName: params.projectName,
      recipients: Array.from(recipients),
      sent,
    },
  });

  return { sent, skipped: false, route: route.key };
}

/** Get all notification routes with their enabled/disabled state from automation_config */
export async function getStageNotificationConfigs(): Promise<Array<StageNotificationRoute & { enabled: boolean }>> {
  const results: Array<StageNotificationRoute & { enabled: boolean }> = [];
  for (const route of STAGE_NOTIFICATION_ROUTES) {
    const configKey = `stage_notify_${route.key}`;
    const config = await storage.getAutomationConfig(configKey);
    const enabled = config ? (config.value as any)?.enabled !== false : true; // default enabled
    results.push({ ...route, enabled });
  }
  return results;
}

/** Toggle a specific stage notification on/off */
export async function setStageNotificationEnabled(key: string, enabled: boolean): Promise<boolean> {
  const route = STAGE_NOTIFICATION_ROUTES.find(r => r.key === key);
  if (!route) return false;
  const configKey = `stage_notify_${route.key}`;
  await storage.upsertAutomationConfig({
    key: configKey,
    value: { enabled },
    description: `Stage notification: ${route.label}`,
  });
  return true;
}
