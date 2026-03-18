/**
 * Archive API Routes
 * ==================
 *
 * REST and webhook endpoints for project archive and storage settings.
 *
 * @module archive-routes
 */

import { Router, type Request, type Response } from 'express';
import {
  getStorageConfig,
  saveStorageConfig,
  testStorageConnection,
  getStorageProvider,
} from './storage-config';
import {
  getArchivableProjects,
  previewArchive,
  getProjectDocumentSummary,
  startProjectArchive,
  getArchiveProgress,
  getAllArchiveProgress,
  handleProjectStageChange,
} from './project-archive';
import type { StorageProviderConfig } from './storage-config';

const router = Router();

function requireAuth(req: any, res: Response, next: () => void) {
  if (req.session?.userId) return next();
  res.status(401).json({ message: 'Unauthorized' });
}

// Redact secrets from config for GET responses
function redactConfig(cfg: StorageProviderConfig): Record<string, any> {
  const out: Record<string, any> = {
    activeProvider: cfg.activeProvider,
    archiveBaseFolderName: cfg.archiveBaseFolderName,
    autoArchive: cfg.autoArchive,
    sharePoint: cfg.sharePoint,
    local: cfg.local,
  };

  if (cfg.googleDrive) {
    const gd = cfg.googleDrive;
    out.googleDrive = {
      clientId: gd.clientId && gd.clientId.length >= 4 ? `****${gd.clientId.slice(-4)}` : undefined,
      clientSecret: gd.clientSecret ? '********' : undefined,
      refreshToken: gd.refreshToken && gd.refreshToken.length >= 4 ? `****${gd.refreshToken.slice(-4)}` : undefined,
      rootFolderId: gd.rootFolderId,
    };
  }

  return out;
}

// ---------------------------------------------------------------------------
// Storage settings
// ---------------------------------------------------------------------------

router.get('/api/settings/storage', requireAuth, async (_req: Request, res: Response) => {
  try {
    const config = await getStorageConfig();
    res.json(redactConfig(config));
  } catch (e: any) {
    res.status(500).json({ message: e.message });
  }
});

router.put('/api/settings/storage', requireAuth, async (req: Request, res: Response) => {
  try {
    const partial = req.body as Partial<StorageProviderConfig>;
    const config = await saveStorageConfig(partial);
    res.json(redactConfig(config));
  } catch (e: any) {
    res.status(500).json({ message: e.message });
  }
});

router.post('/api/settings/storage/test', requireAuth, async (_req: Request, res: Response) => {
  try {
    const result = await testStorageConnection();
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ connected: false, error: (e as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Archive operations
// ---------------------------------------------------------------------------

router.get('/api/archive/projects', requireAuth, async (_req: Request, res: Response) => {
  try {
    const projects = await getArchivableProjects();
    res.json(projects);
  } catch (e: any) {
    res.status(500).json({ message: e.message });
  }
});

function parseOptions(query: Record<string, any>) {
  const opt = (k: string) => parseBool(query[k]);
  return {
    includeDrawings: opt('includeDrawings'),
    includeSubmittals: opt('includeSubmittals'),
    includeRFIs: opt('includeRFIs'),
    includeBidPackages: opt('includeBidPackages'),
    includePhotos: opt('includePhotos'),
    includeBudget: opt('includeBudget'),
    includeDocuments: opt('includeDocuments'),
    includeEmails: opt('includeEmails'),
    includeIncidents: opt('includeIncidents'),
    includePunchList: opt('includePunchList'),
    includeMeetings: opt('includeMeetings'),
    includeSchedule: opt('includeSchedule'),
    includeDailyLogs: opt('includeDailyLogs'),
    includeSpecifications: opt('includeSpecifications'),
    includePrimeContracts: opt('includePrimeContracts'),
    includeCommitments: opt('includeCommitments'),
    includeChangeOrders: opt('includeChangeOrders'),
    includeChangeEvents: opt('includeChangeEvents'),
    includeDirectCosts: opt('includeDirectCosts'),
    includeInvoicing: opt('includeInvoicing'),
    includeDirectory: opt('includeDirectory'),
    includeEstimating: opt('includeEstimating'),
    includeObservations: opt('includeObservations'),
    includeActionPlans: opt('includeActionPlans'),
    includeWeatherLogs: opt('includeWeatherLogs'),
    includeSafetyViolations: opt('includeSafetyViolations'),
    includeAccidentLogs: opt('includeAccidentLogs'),
  };
}

router.get('/api/archive/projects/:projectId/preview', requireAuth, async (req: Request, res: Response) => {
  try {
    const projectId = String(req.params.projectId ?? '');
    const options = parseOptions((req.query as any) || {});
    const preview = await previewArchive(projectId, options);
    res.json(preview);
  } catch (e: any) {
    res.status(500).json({ message: e.message });
  }
});

router.get('/api/archive/projects/:projectId/documents', requireAuth, async (req: Request, res: Response) => {
  try {
    const projectId = String(req.params.projectId ?? '');
    const summary = await getProjectDocumentSummary(projectId);
    res.json(summary);
  } catch (e: any) {
    res.status(500).json({ message: e.message });
  }
});

router.post('/api/archive/start', requireAuth, async (req: Request, res: Response) => {
  try {
    const { projectId, options = {} } = req.body;
    if (!projectId) {
      return res.status(400).json({ message: 'projectId is required' });
    }
    const result = await startProjectArchive(projectId, options);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ message: e.message });
  }
});

router.get('/api/archive/progress/:archiveId', requireAuth, async (req: Request, res: Response) => {
  try {
    const archiveId = String(req.params.archiveId ?? '');
    const progress = getArchiveProgress(archiveId);
    if (!progress) return res.status(404).json({ message: 'Archive not found' });
    res.json(progress);
  } catch (e: any) {
    res.status(500).json({ message: e.message });
  }
});

router.get('/api/archive/progress', requireAuth, async (_req: Request, res: Response) => {
  try {
    const progress = getAllArchiveProgress();
    res.json(progress);
  } catch (e: any) {
    res.status(500).json({ message: e.message });
  }
});

// ---------------------------------------------------------------------------
// Procore webhook: project stage change
// ---------------------------------------------------------------------------

router.post('/api/webhooks/procore/project-stage', async (req: Request, res: Response) => {
  try {
    const body = req.body as { resource_id?: string; metadata?: { stage?: string; project_name?: string; project_id?: string } };
    const projectId = String(body?.resource_id ?? body?.metadata?.project_id ?? '');
    const projectName = body?.metadata?.project_name ?? 'Unknown Project';
    const newStage = body?.metadata?.stage ?? '';

    if (!projectId) {
      return res.status(400).json({ message: 'resource_id or metadata.project_id required' });
    }

    const result = await handleProjectStageChange(projectId, projectName, newStage);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ message: e.message });
  }
});

// ---------------------------------------------------------------------------
// PDF test/download endpoints — generate sample branded PDFs for review
// ---------------------------------------------------------------------------

const SAMPLE_DATA: Record<string, { data: any[]; generator: string; title: string }> = {
  emails: { title: 'Email Communications', generator: 'generateEmailsPdf', data: [
    { subject: 'RFP Response - Exterior Renovation', sender_name: 'John Smith', created_at: '2025-11-15', status: 'sent', attachments: [{},{}] },
    { subject: 'Budget Approval Q4', from: 'sarah@trock.com', created_at: '2025-11-20', status: 'delivered', attachments: [{}] },
    { subject: 'Schedule Update - Phase 2', sender_name: 'Mike Davis', created_at: '2025-12-01', status: 'read', attachments: [] },
  ]},
  incidents: { title: 'Incidents Report', generator: 'generateIncidentsPdf', data: [
    { title: 'Scaffold collapse near Building A', incident_date: '2025-10-05', status: 'closed', severity: 'high', location: 'Building A - 3rd Floor' },
    { title: 'Near miss - unsecured load', incident_date: '2025-11-01', status: 'open', severity: 'medium', location: 'Loading Dock B' },
  ]},
  punchList: { title: 'Punch List', generator: 'generatePunchListPdf', data: [
    { number: 1, name: 'Touch up paint in lobby', location: { node_name: 'Lobby - 1st Floor' }, status: 'open', assignee: { name: 'Mike Painter' }, due_date: '2025-12-20' },
    { number: 2, name: 'Replace cracked tile in restroom', location: { node_name: 'Restroom 2B' }, status: 'in_progress', ball_in_court: { name: 'Joe Tile Co' }, due_date: '2025-12-18' },
    { number: 3, name: 'Adjust HVAC thermostat calibration', location: { node_name: 'Suite 300' }, status: 'closed', assignee: { name: 'HVAC Plus' }, due_date: '2025-12-15' },
  ]},
  meetings: { title: 'Meetings', generator: 'generateMeetingsPdf', data: [
    { title: 'Weekly OAC Meeting #12', meeting_date: '2025-11-05', location: 'Jobsite Trailer', attendees: [{},{},{},{},{}], attachments: [{},{}] },
    { title: 'Safety Stand-down', meeting_date: '2025-11-12', location: 'Main Gate Area', attendees: new Array(10).fill({}), attachments: [] },
  ]},
  specifications: { title: 'Specifications', generator: 'generateSpecificationsPdf', data: [
    { number: '01 10 00', title: 'Summary of Work', division: 'General Requirements', attachments: [{},{}] },
    { number: '03 30 00', title: 'Cast-in-Place Concrete', division: 'Concrete', attachments: [{}] },
    { number: '05 12 00', title: 'Structural Steel Framing', division: 'Metals', attachments: [{},{},{}] },
  ]},
  observations: { title: 'Observations', generator: 'generateObservationsPdf', data: [
    { name: 'Missing guardrail at stairwell', type: { name: 'Safety' }, status: 'open', assignee: { name: 'Site Super' }, due_date: '2025-12-01', priority: 'high' },
    { name: 'Concrete cure time not met', type: { name: 'Quality' }, status: 'closed', assignee: { name: 'QC Manager' }, due_date: '2025-11-20', priority: 'medium' },
  ]},
  actionPlans: { title: 'Action Plans', generator: 'generateActionPlansPdf', data: [
    { title: 'Pre-Pour Checklist - Slab on Grade', status: 'completed', plan_manager: { name: 'Tom Engineer' }, created_at: '2025-09-15', plan_items_count: 12 },
    { title: 'Closeout Documentation Checklist', status: 'draft', plan_manager: { name: 'Lisa PM' }, created_at: '2025-11-20', plan_items_count: 25 },
  ]},
  weatherLogs: { title: 'Weather Logs', generator: 'generateWeatherLogsPdf', data: [
    { log_date: '2025-11-01', weather_conditions: 'Clear skies', temperature_high: '78', temperature_low: '55', wind_conditions: '5 mph NW', precipitation: 'None' },
    { log_date: '2025-11-02', weather_conditions: 'Partly cloudy', temperature_high: '72', temperature_low: '50', wind_conditions: '10 mph S', precipitation: 'None' },
    { log_date: '2025-11-03', weather_conditions: 'Heavy rain - work suspended', temperature_high: '65', temperature_low: '48', wind_conditions: '20 mph SE', precipitation: '2.5 in' },
  ]},
  safetyViolations: { title: 'Safety Violations', generator: 'generateSafetyViolationsPdf', data: [
    { log_date: '2025-10-15', description: 'Worker not wearing hard hat in active construction zone', severity: 'serious', status: 'resolved', person_responsible: 'J. Martinez' },
    { log_date: '2025-11-02', description: 'Improperly stored flammable materials near ignition source', severity: 'willful', status: 'under_investigation', person_responsible: 'Sub XYZ' },
  ]},
  accidentLogs: { title: 'Accident Logs', generator: 'generateAccidentLogsPdf', data: [
    { log_date: '2025-10-08', description: 'Worker twisted ankle stepping off scaffold platform', accident_type: 'Slip/Trip/Fall', number_of_workers: '1', recordable: 'Yes' },
    { log_date: '2025-11-15', description: 'Minor hand cut from handling sheet metal without gloves', accident_type: 'Laceration', number_of_workers: '1', recordable: 'No' },
  ]},
};

// Download a single sample PDF: GET /api/archive/test-pdf/:type
router.get('/api/archive/test-pdf/:type', requireAuth, async (req: Request, res: Response) => {
  try {
    const type = req.params.type;
    const sample = SAMPLE_DATA[type];
    if (!sample) {
      return res.status(400).json({ message: `Unknown type: ${type}. Available: ${Object.keys(SAMPLE_DATA).join(', ')}` });
    }
    const gen = await import('./archive-pdf-generator');
    const fn = (gen as any)[sample.generator];
    if (!fn) return res.status(500).json({ message: `Generator ${sample.generator} not found` });

    const projectName = 'T-Rock Sample Project';
    const buf: Buffer = await fn(sample.data, projectName);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${type}_report.pdf"`);
    res.send(buf);
  } catch (e: any) {
    res.status(500).json({ message: e.message });
  }
});

// Download ALL sample PDFs as ZIP: GET /api/archive/test-pdf-all
router.get('/api/archive/test-pdf-all', requireAuth, async (_req: Request, res: Response) => {
  try {
    const archiver = (await import('archiver')).default;
    const gen = await import('./archive-pdf-generator');
    const projectName = 'T-Rock Sample Project';

    const archive = archiver('zip', { zlib: { level: 5 } });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="archive_pdf_samples.zip"');
    archive.pipe(res);

    for (const [type, sample] of Object.entries(SAMPLE_DATA)) {
      const fn = (gen as any)[sample.generator];
      if (!fn) continue;
      const buf: Buffer = await fn(sample.data, projectName);
      archive.append(buf, { name: `${type}_report.pdf` });
    }

    await archive.finalize();
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ message: e.message });
  }
});

// List available test PDFs: GET /api/archive/test-pdf
router.get('/api/archive/test-pdf', requireAuth, async (_req: Request, res: Response) => {
  const types = Object.entries(SAMPLE_DATA).map(([key, val]) => ({
    type: key,
    title: val.title,
    downloadUrl: `/api/archive/test-pdf/${key}`,
    sampleRows: val.data.length,
  }));
  res.json({
    types,
    downloadAllUrl: '/api/archive/test-pdf-all',
    note: 'Each URL returns a branded PDF with sample data. Use /test-pdf-all for a ZIP of all 10.',
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseBool(val: any): boolean | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    const v = val.toLowerCase();
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
  }
  return undefined;
}

export function registerArchiveRoutes(app: Router): void {
  app.use(router);
}
