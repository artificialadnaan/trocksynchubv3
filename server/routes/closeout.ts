import type { Express, RequestHandler } from "express";
import { asyncHandler } from "../lib/async-handler";
import { storage } from "../storage";

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
      // Only reveal Google review link after submission if average > 4
      googleReviewLink: survey.submittedAt && survey.ratingAverage && parseFloat(survey.ratingAverage) > 4
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
