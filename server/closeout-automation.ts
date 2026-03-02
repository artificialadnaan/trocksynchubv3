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
import { deactivateProject, fetchProcoreProjectDetail } from './procore';
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
    
    // Primary: Get deal owner email from HubSpot owners table
    if (mapping?.hubspotDealId) {
      const deal = await storage.getHubspotDealByHubspotId(mapping.hubspotDealId);
      if (deal?.ownerId) {
        const owner = await storage.getHubspotOwnerByHubspotId(deal.ownerId);
        if (owner?.email) {
          recipientEmail = owner.email;
          recipientName = [owner.firstName, owner.lastName].filter(Boolean).join(' ') || 'Team Member';
          console.log(`[closeout] Using HubSpot deal owner: ${recipientName} (${recipientEmail})`);
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

    // Fallback: Use Procore project data if no HubSpot owner found
    if (!recipientEmail) {
      recipientEmail = projectDetail.client_email || projectDetail.owner_email || '';
      recipientName = recipientName || projectDetail.client_name || projectDetail.company?.name || 'Valued Client';
      console.log(`[closeout] Using Procore fallback: ${recipientName} (${recipientEmail})`);
    }

    if (!recipientEmail) {
      return { success: false, error: 'No recipient email found - neither HubSpot deal owner nor Procore client email available' };
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
    rating: number;
    feedback?: string;
    googleReviewClicked?: boolean;
  }
): Promise<{ success: boolean; error?: string }> {
  try {
    const survey = await storage.getCloseoutSurveyByToken(token);
    if (!survey) {
      return { success: false, error: 'Survey not found' };
    }

    if (survey.submittedAt) {
      return { success: false, error: 'Survey has already been submitted' };
    }

    await storage.updateCloseoutSurvey(survey.id, {
      rating: response.rating,
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
        rating: response.rating,
        hasGoogleReview: response.googleReviewClicked,
      },
    });

    console.log(`[closeout] Survey submitted for project ${survey.procoreProjectId} - Rating: ${response.rating}`);
    return { success: true };
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    console.error(`[closeout] Error submitting survey: ${err}`);
    return { success: false, error: err };
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
          includeRfis: true,
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

export async function deactivateProjectAfterArchive(
  projectId: string,
  archiveId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const progress = await getArchiveProgress(archiveId);
    
    if (progress.status !== 'completed') {
      return { 
        success: false, 
        error: `Archive not complete. Current status: ${progress.status}` 
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
