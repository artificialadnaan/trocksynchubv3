/**
 * Project Closeout Automation Module
 * ===================================
 * 
 * This module handles end-of-project workflows including client surveys,
 * document archiving, and project deactivation.
 * 
 * Closeout Workflow:
 * 
 * 1. Trigger Closeout Survey:
 *    - Generate unique survey token
 *    - Create survey record in database
 *    - Send email to client with survey link
 *    - Optionally include executives
 * 
 * 2. Process Survey Response:
 *    - Client submits satisfaction rating
 *    - Optional feedback and Google review
 *    - Store response in database
 *    - Notify team of completion
 * 
 * 3. Archive Project:
 *    - Export all project documents
 *    - Create archive package
 *    - Store in configured location (SharePoint)
 * 
 * 4. Deactivate Project:
 *    - Wait for archive to complete
 *    - Mark project as inactive in Procore
 *    - Update HubSpot deal stage to Closed
 * 
 * Survey Features:
 * - Secure token-based access (no login required)
 * - Star rating (1-5) for satisfaction
 * - Free-form feedback field
 * - Google review redirect link (configurable)
 * 
 * Key Functions:
 * - triggerCloseoutSurvey(): Initiate closeout workflow
 * - generateSurveyToken(): Create secure survey access token
 * - createCloseoutSurvey(): Create survey record in DB
 * - runProjectCloseout(): Full closeout workflow (archive + deactivate)
 * - processSurveySubmission(): Handle client survey response
 * 
 * Database Tables:
 * - closeout_surveys: Survey records and responses
 * - archive_progress: Archive job tracking
 * 
 * @module closeout-automation
 */

import { storage } from './storage';
import { sendEmail, renderTemplate } from './email-service';
import { deactivateProject, fetchProcoreProjectDetail, syncProcoreRoleAssignments } from './procore';
import { startProjectArchive, getArchiveProgress } from './project-archive';
import crypto from 'crypto';

/** Options for triggering closeout survey */
interface CloseoutSurveyOptions {
  includeExecs?: boolean;
  googleReviewLink?: string;
}

export async function generateSurveyToken(): Promise<string> {
  return crypto.randomBytes(32).toString('hex');
}

export async function triggerCloseoutSurvey(
  projectId: string,
  options: CloseoutSurveyOptions = {}
): Promise<{ success: boolean; surveyId?: number; error?: string }> {
  try {
    const existingSurvey = await storage.getCloseoutSurveyByProjectId(projectId);
    if (existingSurvey && !existingSurvey.submittedAt) {
      return { 
        success: false, 
        error: 'A survey has already been sent for this project and is pending response' 
      };
    }

    const projectDetail = await fetchProcoreProjectDetail(projectId);
    if (!projectDetail) {
      return { success: false, error: 'Project not found' };
    }

    const mapping = await storage.getSyncMappingByProcoreProjectId(projectId);
    let recipientEmail = '';
    let recipientName = '';
    
    // Primary: Get deal owner email from HubSpot owners table or user-provided mapping
    if (mapping?.hubspotDealId) {
      const deal = await storage.getHubspotDealByHubspotId(mapping.hubspotDealId);
      if (deal?.ownerId) {
        let owner;
        try {
          owner = await storage.getHubspotOwnerByHubspotId(deal.ownerId);
        } catch (err: any) {
          // hubspot_owners table may not exist yet (run db:push); fall through to owner mapping
          console.warn(`[closeout] hubspot_owners lookup failed for ${deal.ownerId}: ${err?.message?.slice(0, 80)}`);
        }
        if (owner?.email) {
          recipientEmail = owner.email;
          recipientName = [owner.firstName, owner.lastName].filter(Boolean).join(' ') || 'Team Member';
          console.log(`[closeout] Using HubSpot deal owner: ${recipientName} (${recipientEmail})`);
        } else {
          const mappingEntry = await storage.getHubspotOwnerMappingByHubspotId(deal.ownerId);
          if (mappingEntry?.email) {
            recipientEmail = mappingEntry.email;
            recipientName = mappingEntry.name || 'Team Member';
            console.log(`[closeout] Using owner mapping for ${deal.ownerId}: ${recipientName} (${recipientEmail})`);
          }
        }
      }
      // Also get company name for context if available
      if (deal?.associatedCompanyId) {
        const company = await storage.getHubspotCompanyByHubspotId(deal.associatedCompanyId);
        if (company?.name && !recipientName) {
          recipientName = company.name;
        }
      }
    }

    // Fallback: Project Manager from Procore role assignments (Portfolio project)
    if (!recipientEmail) {
      let assignments = await storage.getProcoreRoleAssignmentsByProject(projectId);
      // If no assignments yet (e.g. project not in role sync), sync this project's roles once
      if (assignments.length === 0) {
        try {
          await syncProcoreRoleAssignments([projectId]);
          assignments = await storage.getProcoreRoleAssignmentsByProject(projectId);
        } catch (syncErr) {
          console.warn(`[closeout] Role sync for project ${projectId} failed:`, syncErr);
        }
      }
      const roleLower = (r: string | null | undefined) => (r || '').toLowerCase();
      const isProjectManagerRole = (r: string | null | undefined) => {
        const lower = roleLower(r);
        return lower.includes('project manager') || lower === 'pm' || lower.includes('proj. manager');
      };
      const pmAssignment = assignments.find(a => isProjectManagerRole(a.roleName));
      if (pmAssignment) {
        let pmEmail = pmAssignment.assigneeEmail;
        if (!pmEmail && pmAssignment.assigneeId) {
          const procoreUser = await storage.getProcoreUserByProcoreId(pmAssignment.assigneeId);
          pmEmail = procoreUser?.emailAddress || '';
        }
        if (pmEmail) {
          recipientEmail = pmEmail;
          recipientName = pmAssignment.assigneeName || 'Project Manager';
          console.log(`[closeout] Using Project Manager from Procore: ${recipientName} (${recipientEmail})`);
        }
      }
    }

    // Fallback: Use Procore project data (client/owner) if still no recipient
    if (!recipientEmail) {
      recipientEmail = projectDetail.client_email || projectDetail.owner_email || '';
      recipientName = recipientName || projectDetail.client_name || projectDetail.company?.name || 'Valued Client';
      console.log(`[closeout] Using Procore fallback: ${recipientName} (${recipientEmail})`);
    }

    if (!recipientEmail) {
      const errMsg = 'No recipient email found - neither HubSpot deal owner nor Procore client email available';
      await storage.createEmailSendLog({
        templateKey: 'closeout_survey',
        recipientEmail: '(no recipient)',
        recipientName: null,
        subject: `Closeout survey: ${projectDetail.name || projectId} (no recipient)`,
        dedupeKey: `closeout_survey_no_recipient:${projectId}:${Date.now()}`,
        status: 'failed',
        errorMessage: errMsg,
        metadata: { projectId, projectName: projectDetail.name, reason: 'no_recipient' },
        sentAt: new Date(),
      });
      return { success: false, error: errMsg };
    }

    const template = await storage.getEmailTemplate('closeout_survey');
    if (!template || !template.enabled) {
      return { success: false, error: 'Closeout survey email template is disabled' };
    }

    const surveyToken = await generateSurveyToken();
    const appUrl = process.env.APP_URL || 'http://localhost:5000';
    const surveyUrl = `${appUrl}/survey/${surveyToken}`;
    const googleReviewUrl = options.googleReviewLink || 'https://g.page/r/YOUR_GOOGLE_REVIEW_LINK/review';

    const variables: Record<string, string> = {
      clientName: recipientName,
      projectName: projectDetail.name || projectDetail.display_name || 'Your Project',
      surveyUrl,
      googleReviewUrl,
    };

    const subject = renderTemplate(template.subject, variables);
    const htmlBody = renderTemplate(template.bodyHtml, variables);

    const survey = await storage.createCloseoutSurvey({
      procoreProjectId: projectId,
      procoreProjectName: projectDetail.name || projectDetail.display_name || null,
      hubspotDealId: mapping?.hubspotDealId || null,
      surveyToken,
      clientEmail: recipientEmail,
      clientName: recipientName,
      googleReviewLink: options.googleReviewLink || null,
      sentAt: new Date(),
    });

    const result = await sendEmail({
      to: recipientEmail,
      subject,
      htmlBody,
      fromName: 'T-Rock Construction',
    });

    await storage.createEmailSendLog({
      templateKey: 'closeout_survey',
      recipientEmail,
      recipientName: recipientName || null,
      subject,
      dedupeKey: `closeout_survey:${projectId}:${survey.id}`,
      status: result.success ? 'sent' : 'failed',
      errorMessage: result.error || null,
      metadata: {
        projectId,
        projectName: projectDetail.name || projectDetail.display_name,
        surveyId: survey.id,
      },
      sentAt: new Date(),
    });

    if (!result.success) {
      return { success: false, error: result.error };
    }

    await storage.createAuditLog({
      action: 'closeout_survey_sent',
      entityType: 'project',
      entityId: projectId,
      source: 'automation',
      status: 'success',
      details: { surveyId: survey.id, recipientEmail, recipientName, projectName: projectDetail.name },
    });

    console.log(`[closeout] Survey sent to ${recipientEmail} for project ${projectDetail.name}`);
    return { success: true, surveyId: survey.id };
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    console.error(`[closeout] Error triggering survey: ${err}`);
    return { success: false, error: err };
  }
}

export async function submitSurveyResponse(
  token: string,
  response: {
    ratings: {
      overallExperience: number;
      communication: number;
      schedule: number;
      quality: number;
      hireAgain: number;
      referral: number;
    };
    feedback?: string;
    googleReviewClicked?: boolean;
  }
): Promise<{ success: boolean; showGoogleReview?: boolean; googleReviewLink?: string | null; error?: string }> {
  try {
    const survey = await storage.getCloseoutSurveyByToken(token);
    if (!survey) {
      return { success: false, error: 'Survey not found' };
    }

    if (survey.submittedAt) {
      return { success: false, error: 'Survey has already been submitted' };
    }

    const { ratings } = response;
    // Average only the 4 star-rating questions (not yes/no which are 5 or 1)
    const starRatingValues = [ratings.overallExperience, ratings.communication, ratings.schedule, ratings.quality];
    const average = starRatingValues.reduce((a, b) => a + b, 0) / starRatingValues.length;
    const ratingAverage = average.toFixed(2);

    await storage.updateCloseoutSurvey(survey.id, {
      ratingOverallExperience: ratings.overallExperience,
      ratingCommunication: ratings.communication,
      ratingSchedule: ratings.schedule,
      ratingQuality: ratings.quality,
      ratingHireAgain: ratings.hireAgain,
      ratingReferral: ratings.referral,
      ratingAverage,
      rating: Math.round(average),
      feedback: response.feedback || null,
      googleReviewClicked: response.googleReviewClicked || false,
      submittedAt: new Date(),
    });

    await storage.createAuditLog({
      action: 'closeout_survey_submitted',
      entityType: 'survey',
      entityId: String(survey.id),
      source: 'client',
      status: 'success',
      details: {
        projectId: survey.procoreProjectId,
        ratings,
        ratingAverage,
        hasGoogleReview: response.googleReviewClicked,
      },
    });

    // Send survey results notification to deal owner + Brett
    try {
      await sendSurveyResultsNotification(survey, ratings, ratingAverage, response.feedback || null);
    } catch (notifErr: any) {
      console.error(`[closeout] Survey results notification failed:`, notifErr.message);
    }

    const showGoogleReview = average > 4;
    console.log(`[closeout] Survey submitted for project ${survey.procoreProjectId} - Average: ${ratingAverage}`);
    return {
      success: true,
      showGoogleReview,
      googleReviewLink: showGoogleReview ? survey.googleReviewLink : null,
    };
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    console.error(`[closeout] Error submitting survey: ${err}`);
    return { success: false, error: err };
  }
}

async function sendSurveyResultsNotification(
  survey: { id: number; procoreProjectId: string; procoreProjectName: string | null; hubspotDealId: string | null; clientEmail: string; clientName: string | null },
  ratings: { overallExperience: number; communication: number; schedule: number; quality: number; hireAgain: number; referral: number },
  ratingAverage: string,
  feedback: string | null,
) {
  // Resolve deal owner email
  let ownerEmail: string | null = null;
  let ownerName = '';
  if (survey.hubspotDealId) {
    const deal = await storage.getHubspotDealByHubspotId(survey.hubspotDealId);
    if (deal?.ownerId) {
      let owner;
      try { owner = await storage.getHubspotOwnerByHubspotId(deal.ownerId); } catch {}
      if (owner?.email) {
        ownerEmail = owner.email;
        ownerName = [owner.firstName, owner.lastName].filter(Boolean).join(' ');
      } else {
        const mapping = await storage.getHubspotOwnerMappingByHubspotId(deal.ownerId);
        if (mapping?.email) {
          ownerEmail = mapping.email;
          ownerName = mapping.name || '';
        }
      }
    }
  }

  const avg = parseFloat(ratingAverage);
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const starColor = (val: number) => val >= 4 ? '#16a34a' : val >= 3 ? '#ca8a04' : '#dc2626';
  const stars = (val: number) => '★'.repeat(val) + '☆'.repeat(5 - val);
  const avgColor = avg > 4 ? '#16a34a' : avg >= 3 ? '#ca8a04' : '#dc2626';
  const projectName = survey.procoreProjectName || 'Unknown Project';

  const subject = `Survey Results: ${esc(projectName)} — ${ratingAverage}/5.00`;
  const htmlBody = `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:#f4f4f5;font-family:Arial,sans-serif;">
  <tr><td style="padding:40px 20px;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="margin:0 auto;max-width:600px;">
      <tr>
        <td style="background:#1a1a2e;padding:16px 24px;border-radius:8px 8px 0 0;">
          <img src="https://trockgc.com/wp-content/uploads/2020/12/TRock-CONTRACTING_Icon-dark-1-150x150.png" alt="T-Rock" width="32" height="32" style="vertical-align:middle;margin-right:10px;">
          <span style="font-size:20px;font-weight:700;color:#ffffff;vertical-align:middle;">T-ROCK</span>
          <span style="font-size:20px;font-weight:300;color:#d11921;vertical-align:middle;"> GC</span>
          <span style="font-size:14px;color:#94a3b8;margin-left:12px;vertical-align:middle;">Survey Results</span>
        </td>
      </tr>
      <tr><td style="background:#d11921;height:4px;font-size:0;line-height:0;">&nbsp;</td></tr>
      <tr>
        <td style="background:${avg > 4 ? '#f0fdf4;border-left:1px solid #bbf7d0;border-right:1px solid #bbf7d0' : '#fffbeb;border-left:1px solid #fde68a;border-right:1px solid #fde68a'};padding:12px 24px;color:${avgColor};font-weight:600;font-size:15px;">
          Average Rating: ${ratingAverage} / 5.00 ${avg > 4 ? '— Google Review Prompted' : ''}
        </td>
      </tr>
      <tr>
        <td style="padding:24px;border:1px solid #e2e8f0;border-top:none;background:#ffffff;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-bottom:20px;">
            <tr>
              <td style="color:#64748b;font-size:13px;padding:8px 0;width:50%;">Project</td>
              <td style="font-size:14px;font-weight:600;padding:8px 0;color:#1e293b;">${esc(projectName)}</td>
            </tr>
            <tr>
              <td style="color:#64748b;font-size:13px;padding:8px 0;">Respondent</td>
              <td style="font-size:14px;padding:8px 0;color:#1e293b;">${esc(survey.clientName || 'Unknown')} (${esc(survey.clientEmail)})</td>
            </tr>
          </table>
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="border-top:1px solid #e2e8f0;padding-top:12px;">
            <tr style="border-bottom:1px solid #f1f5f9;">
              <td style="color:#64748b;font-size:13px;padding:10px 0;">Overall Experience</td>
              <td style="font-size:16px;padding:10px 0;color:${starColor(ratings.overallExperience)};letter-spacing:2px;">${stars(ratings.overallExperience)}</td>
              <td style="font-size:14px;font-weight:600;padding:10px 0;color:${starColor(ratings.overallExperience)};text-align:right;">${ratings.overallExperience}/5</td>
            </tr>
            <tr style="border-bottom:1px solid #f1f5f9;">
              <td style="color:#64748b;font-size:13px;padding:10px 0;">Communication</td>
              <td style="font-size:16px;padding:10px 0;color:${starColor(ratings.communication)};letter-spacing:2px;">${stars(ratings.communication)}</td>
              <td style="font-size:14px;font-weight:600;padding:10px 0;color:${starColor(ratings.communication)};text-align:right;">${ratings.communication}/5</td>
            </tr>
            <tr style="border-bottom:1px solid #f1f5f9;">
              <td style="color:#64748b;font-size:13px;padding:10px 0;">Project Schedule</td>
              <td style="font-size:16px;padding:10px 0;color:${starColor(ratings.schedule)};letter-spacing:2px;">${stars(ratings.schedule)}</td>
              <td style="font-size:14px;font-weight:600;padding:10px 0;color:${starColor(ratings.schedule)};text-align:right;">${ratings.schedule}/5</td>
            </tr>
            <tr style="border-bottom:1px solid #f1f5f9;">
              <td style="color:#64748b;font-size:13px;padding:10px 0;">Quality of Work</td>
              <td style="font-size:16px;padding:10px 0;color:${starColor(ratings.quality)};letter-spacing:2px;">${stars(ratings.quality)}</td>
              <td style="font-size:14px;font-weight:600;padding:10px 0;color:${starColor(ratings.quality)};text-align:right;">${ratings.quality}/5</td>
            </tr>
            <tr style="border-bottom:1px solid #f1f5f9;">
              <td style="color:#64748b;font-size:13px;padding:10px 0;">Would Hire Again</td>
              <td colspan="2" style="font-size:14px;font-weight:600;padding:10px 0;color:${ratings.hireAgain >= 5 ? '#16a34a' : '#dc2626'};text-align:right;">${ratings.hireAgain >= 5 ? 'Yes' : 'No'}</td>
            </tr>
            <tr>
              <td style="color:#64748b;font-size:13px;padding:10px 0;">Would Refer T-Rock</td>
              <td colspan="2" style="font-size:14px;font-weight:600;padding:10px 0;color:${ratings.referral >= 5 ? '#16a34a' : '#dc2626'};text-align:right;">${ratings.referral >= 5 ? 'Yes' : 'No'}</td>
            </tr>
          </table>
          ${feedback ? `
          <div style="margin-top:20px;padding:16px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
            <p style="margin:0 0 8px;font-size:13px;color:#64748b;font-weight:600;">Comments</p>
            <p style="margin:0;font-size:14px;color:#1e293b;line-height:1.5;">${esc(feedback)}</p>
          </div>` : ''}
        </td>
      </tr>
      <tr>
        <td style="padding:12px 24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;background:#f8fafc;text-align:center;">
          <span style="font-size:11px;color:#94a3b8;">Sent by T-Rock Sync Hub at ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT</span>
        </td>
      </tr>
    </table>
  </td></tr>
</table>`;

  // Send to deal owner + Brett
  const recipients = new Set<string>();
  if (ownerEmail) recipients.add(ownerEmail);
  recipients.add('bbell@trockgc.com');

  for (const email of recipients) {
    try {
      await sendEmail({ to: email, subject, htmlBody, fromName: 'T-Rock Sync Hub' });
      await storage.createEmailSendLog({
        templateKey: 'survey_results_notification',
        recipientEmail: email,
        subject,
        status: 'sent',
        dedupeKey: `survey_results:${survey.id}:${email}`,
        metadata: { surveyId: survey.id, projectName, ratingAverage },
      });
      console.log(`[closeout] Survey results notification sent to ${email}`);
    } catch (err: any) {
      console.error(`[closeout] Failed to send survey results to ${email}:`, err.message);
    }
  }
}

export async function runProjectCloseout(
  projectId: string,
  options: {
    sendSurvey?: boolean;
    archiveToSharePoint?: boolean;
    deactivateProject?: boolean;
    updateHubSpotStage?: boolean;
    googleReviewLink?: string;
  } = {}
): Promise<{
  success: boolean;
  surveyResult?: { success: boolean; surveyId?: number; error?: string };
  archiveResult?: { archiveId?: string; error?: string };
  deactivationResult?: { success: boolean; error?: string };
  hubspotUpdateResult?: { success: boolean; error?: string };
}> {
  const results: {
    success: boolean;
    surveyResult?: { success: boolean; surveyId?: number; error?: string };
    archiveResult?: { archiveId?: string; error?: string };
    deactivationResult?: { success: boolean; error?: string };
    hubspotUpdateResult?: { success: boolean; error?: string };
  } = { success: true };

  try {
    if (options.sendSurvey !== false) {
      results.surveyResult = await triggerCloseoutSurvey(projectId, {
        googleReviewLink: options.googleReviewLink,
      });
      if (!results.surveyResult.success) {
        console.warn(`[closeout] Survey warning: ${results.surveyResult.error}`);
      }
    }

    if (options.archiveToSharePoint !== false) {
      try {
        const archiveResult = await startProjectArchive(projectId, {
          includeDocuments: true,
          includeDrawings: true,
          includeSubmittals: true,
          includeRFIs: true,
          includePhotos: true,
          includeBudget: true,
        });
        results.archiveResult = { archiveId: archiveResult.archiveId };
      } catch (err: any) {
        results.archiveResult = { error: err.message };
        console.warn(`[closeout] Archive warning: ${err.message}`);
      }
    }

    if (options.updateHubSpotStage !== false) {
      // Check if stage sync automation is enabled (disabled by default)
      const stageSyncConfig = await storage.getAutomationConfig("procore_hubspot_stage_sync");
      const stageSyncEnabled = (stageSyncConfig?.value as any)?.enabled === true;
      
      if (!stageSyncEnabled) {
        console.log('[closeout] Stage sync disabled - skipping HubSpot stage update');
        results.hubspotUpdateResult = { success: false, error: 'Stage sync automation is disabled' };
      } else {
        try {
          const mapping = await storage.getSyncMappingByProcoreProjectId(projectId);
          if (mapping?.hubspotDealId) {
            const { updateHubSpotDealStage } = await import('./hubspot');
            const closeoutStageId = await getHubSpotCloseoutStageId();
            if (closeoutStageId) {
              await updateHubSpotDealStage(mapping.hubspotDealId, closeoutStageId);
              results.hubspotUpdateResult = { success: true };
            } else {
              results.hubspotUpdateResult = { success: false, error: 'Closeout stage not found in HubSpot' };
            }
          } else {
            results.hubspotUpdateResult = { success: false, error: 'No HubSpot deal mapping found' };
          }
        } catch (err: any) {
          results.hubspotUpdateResult = { success: false, error: err.message };
          console.warn(`[closeout] HubSpot update warning: ${err.message}`);
        }
      }
    }

    if (options.deactivateProject !== false) {
      if (options.archiveToSharePoint !== false && results.archiveResult?.archiveId) {
        // Archive is in progress - poll for completion before deactivating
        console.log('[closeout] Archive in progress, polling for completion before deactivation...');
        const archiveId = results.archiveResult.archiveId;
        const maxWaitMs = 60000; // Wait up to 60 seconds
        const pollIntervalMs = 5000;
        const startTime = Date.now();
        let archiveComplete = false;
        
        while (Date.now() - startTime < maxWaitMs) {
          try {
            const progress = getArchiveProgress(archiveId);
            if (!progress) {
              console.warn(`[closeout] Archive ${archiveId} not found in progress tracker`);
              break;
            }
            if (progress.status === 'completed') {
              archiveComplete = true;
              console.log(`[closeout] Archive ${archiveId} completed successfully`);
              break;
            } else if (progress.status === 'failed') {
              console.warn(`[closeout] Archive ${archiveId} failed: ${progress.errors.join(', ')}`);
              break;
            }
            // Still in progress, wait and retry
            console.log(`[closeout] Archive ${archiveId} progress: ${progress.progress}% - ${progress.currentStep}`);
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
          } catch (err: any) {
            console.warn(`[closeout] Error checking archive status: ${err.message}`);
            break;
          }
        }
        
        if (archiveComplete) {
          try {
            await deactivateProject(projectId);
            results.deactivationResult = { success: true };
          } catch (err: any) {
            results.deactivationResult = { success: false, error: err.message };
            results.success = false;
          }
        } else {
          // Archive didn't complete in time - mark deactivation as pending
          results.deactivationResult = { 
            success: false, 
            error: `Deactivation skipped: archive ${archiveId} did not complete within ${maxWaitMs / 1000}s. Manual deactivation required.` 
          };
          console.warn(`[closeout] Deactivation skipped for project ${projectId} - archive still in progress after timeout`);
        }
      } else {
        try {
          await deactivateProject(projectId);
          results.deactivationResult = { success: true };
        } catch (err: any) {
          results.deactivationResult = { success: false, error: err.message };
          results.success = false;
        }
      }
    }

    await storage.createAuditLog({
      action: 'project_closeout',
      entityType: 'project',
      entityId: projectId,
      source: 'automation',
      status: results.success ? 'success' : 'partial',
      details: results,
    });

    return results;
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    console.error(`[closeout] Closeout workflow error: ${err}`);
    results.success = false;
    return results;
  }
}

async function getHubSpotCloseoutStageId(): Promise<string | null> {
  try {
    const pipelines = await storage.getHubspotPipelines();
    for (const pipeline of pipelines) {
      const stages = (pipeline.stages as any[]) || [];
      const closeoutStage = stages.find((s: any) => 
        s.label?.toLowerCase().includes('closeout') || 
        s.stageName?.toLowerCase().includes('closeout') ||
        s.label?.toLowerCase().includes('closed')
      );
      if (closeoutStage) {
        return closeoutStage.stageId;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Check if a Procore stage name indicates closed/closeout (triggers closeout survey) */
export function isProcoreClosedStage(procoreStageName: string | null): boolean {
  if (!procoreStageName) return false;
  const s = procoreStageName.trim().toLowerCase();
  return s === 'close out';
}

/** Check if a HubSpot stage ID corresponds to a closed/closeout stage */
export async function isHubSpotClosedStage(stageId: string): Promise<boolean> {
  try {
    const pipelines = await storage.getHubspotPipelines();
    for (const pipeline of pipelines) {
      const stages = (pipeline.stages as any[]) || [];
      const stage = stages.find((s: any) => String(s.stageId || s.id) === String(stageId));
      if (stage) {
        const label = (stage.label || stage.stageName || '').toLowerCase();
        const isClosed = stage.metadata?.isClosed === 'true';
        return isClosed || label.includes('closeout') || label.includes('closed');
      }
    }
    return false;
  } catch {
    return false;
  }
}

export async function deactivateProjectAfterArchive(
  projectId: string,
  archiveId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const progress = getArchiveProgress(archiveId);
    if (!progress || progress.status !== 'completed') {
      return { 
        success: false, 
        error: `Archive not complete. Current status: ${progress?.status ?? 'unknown'}` 
      };
    }

    await deactivateProject(projectId);
    
    await storage.createAuditLog({
      action: 'project_deactivated_after_archive',
      entityType: 'project',
      entityId: projectId,
      source: 'automation',
      status: 'success',
      details: { archiveId },
    });

    return { success: true };
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    console.error(`[closeout] Deactivation error: ${err}`);
    return { success: false, error: err };
  }
}
