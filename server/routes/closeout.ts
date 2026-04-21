import type { Express, RequestHandler } from "express";
import { asyncHandler } from "../lib/async-handler";
import { storage } from "../storage";
import { DEFAULT_GOOGLE_REVIEW_LINK } from "../closeout-automation";

export function registerCloseoutRoutes(app: Express, requireAuth: RequestHandler) {
  // Get closeout surveys list
  app.get("/api/closeout/surveys", requireAuth, asyncHandler(async (req, res) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const surveys = await storage.getCloseoutSurveys({ limit, offset });
    res.json(surveys);
  }));

  // Trigger closeout survey for a project
  app.post("/api/closeout/survey/:projectId", requireAuth, asyncHandler(async (req, res) => {
    const projectId = req.params.projectId as string;
    const { googleReviewLink } = req.body;
    const { triggerCloseoutSurvey } = await import('../closeout-automation');
    const result = await triggerCloseoutSurvey(projectId, { googleReviewLink });
    res.json(result);
  }));

  // Public survey submission endpoint (no auth required)
  app.get("/api/survey/:token", asyncHandler(async (req, res) => {
    const token = req.params.token as string;
    const survey = await storage.getCloseoutSurveyByToken(token);
    if (!survey) {
      return res.status(404).json({ error: 'Survey not found' });
    }
    res.json({
      projectName: survey.procoreProjectName,
      clientName: survey.clientName,
      submitted: !!survey.submittedAt,
      ratingAverage: survey.ratingAverage ? parseFloat(survey.ratingAverage) : null,
      // Only reveal Google review link after submission if average >= 4
      googleReviewLink: survey.submittedAt && survey.ratingAverage && parseFloat(survey.ratingAverage) >= 4
        ? survey.googleReviewLink
        : null,
    });
  }));

  app.post("/api/survey/:token/submit", asyncHandler(async (req, res) => {
    const token = req.params.token as string;
    const { ratings, feedback, googleReviewClicked } = req.body;

    if (!ratings || typeof ratings !== 'object') {
      return res.status(400).json({ error: 'Ratings object is required' });
    }
    const ratingFields = ['overallExperience', 'communication', 'schedule', 'quality', 'hireAgain', 'referral'];
    for (const field of ratingFields) {
      const val = ratings[field];
      if (!val || val < 1 || val > 5) {
        return res.status(400).json({ error: `Rating for ${field} must be between 1 and 5` });
      }
    }

    const { submitSurveyResponse } = await import('../closeout-automation');
    const result = await submitSurveyResponse(token, {
      ratings,
      feedback,
      googleReviewClicked,
    });
    res.json(result);
  }));

  // Run full closeout workflow
  app.post("/api/closeout/run/:projectId", requireAuth, asyncHandler(async (req, res) => {
    const projectId = req.params.projectId as string;
    const { sendSurvey, archiveToSharePoint, deactivateProject, updateHubSpotStage, googleReviewLink } = req.body;
    const { runProjectCloseout } = await import('../closeout-automation');
    const result = await runProjectCloseout(projectId, {
      sendSurvey,
      archiveToSharePoint,
      deactivateProject,
      updateHubSpotStage,
      googleReviewLink,
    });
    res.json(result);
  }));

  // Send a test survey to a specified email (admin only)
  app.post("/api/closeout/test-survey", requireAuth, asyncHandler(async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const crypto = await import('crypto');
    const { sendEmail, renderTemplate } = await import('../email-service');
    const surveyToken = crypto.randomBytes(32).toString('hex');
    const appUrl = process.env.APP_URL || 'http://localhost:5000';
    const surveyUrl = `${appUrl}/survey/${surveyToken}`;
    const projectName = 'Test Project — DFW Office Renovation';
    const clientName = 'Adnaan';

    await storage.createCloseoutSurvey({
      procoreProjectId: 'test-001',
      procoreProjectName: projectName,
      hubspotDealId: null,
      surveyToken,
      clientEmail: email,
      clientName,
      googleReviewLink: DEFAULT_GOOGLE_REVIEW_LINK,
      sentAt: new Date(),
    });

    const template = await storage.getEmailTemplate('closeout_survey');
    if (!template || !template.enabled) {
      return res.status(500).json({ error: 'closeout_survey email template not found or disabled' });
    }

    const variables: Record<string, string> = {
      clientName,
      projectName,
      surveyUrl,
      googleReviewUrl: DEFAULT_GOOGLE_REVIEW_LINK,
    };
    const subject = renderTemplate(template.subject, variables);
    const htmlBody = renderTemplate(template.bodyHtml, variables);
    const result = await sendEmail({ to: email, subject, htmlBody, fromName: 'T-Rock Construction' });
    res.json({ success: result.success, surveyUrl, error: result.error });
  }));

  // Deactivate project after archive
  app.post("/api/closeout/deactivate/:projectId", requireAuth, asyncHandler(async (req, res) => {
    const projectId = req.params.projectId as string;
    const { archiveId } = req.body;

    if (archiveId) {
      const { deactivateProjectAfterArchive } = await import('../closeout-automation');
      const result = await deactivateProjectAfterArchive(projectId, archiveId);
      res.json(result);
    } else {
      const { deactivateProject } = await import('../procore');
      await deactivateProject(projectId);
      res.json({ success: true });
    }
  }));
}
