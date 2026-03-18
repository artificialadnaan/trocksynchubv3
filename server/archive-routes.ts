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
  budget: { title: 'Budget Report', generator: 'generateBudgetPdf', data: {
    summary: { total_budget: 2500000, approved_changes: 125000, revised_budget: 2625000, pending_changes: 45000 },
    lineItems: [
      { cost_code: '03-300', description: 'Cast-in-Place Concrete', original_budget_amount: 450000, approved_cos: 25000, revised_budget: 475000, committed_costs: 460000, direct_costs: 5000 },
      { cost_code: '05-120', description: 'Structural Steel', original_budget_amount: 680000, approved_cos: 50000, revised_budget: 730000, committed_costs: 715000, direct_costs: 8000 },
      { cost_code: '09-910', description: 'Painting', original_budget_amount: 120000, approved_cos: 0, revised_budget: 120000, committed_costs: 95000, direct_costs: 2000 },
      { cost_code: '23-050', description: 'HVAC', original_budget_amount: 350000, approved_cos: 30000, revised_budget: 380000, committed_costs: 370000, direct_costs: 4000 },
      { cost_code: '26-050', description: 'Electrical', original_budget_amount: 280000, approved_cos: 20000, revised_budget: 300000, committed_costs: 285000, direct_costs: 3000 },
    ],
  } as any},
  dailyLogs: { title: 'Daily Logs Report', generator: 'generateDailyLogsPdf', data: [
    { date: '2025-11-01', weather_conditions: 'Clear, 78F', work_performed: 'Poured slab-on-grade Section A. Installed rebar for Section B.', workers_on_site: 24, visitors: 'Owner rep, architect', equipment: 'Concrete pump, boom truck' },
    { date: '2025-11-02', weather_conditions: 'Partly cloudy, 72F', work_performed: 'Stripped forms Section A. Continued rebar Section B. MEP rough-in 2nd floor.', workers_on_site: 28, visitors: 'None', equipment: 'Crane, forklift' },
    { date: '2025-11-03', weather_conditions: 'Rain - work suspended PM', work_performed: 'Interior framing 1st floor AM only. Site secured at 1pm due to weather.', workers_on_site: 15, visitors: 'Safety inspector', equipment: 'None' },
  ]},
  primeContracts: { title: 'Prime Contracts', generator: 'generatePrimeContractsPdf', data: [
    { id: 1, number: 'PC-001', title: 'General Construction Contract', status: 'approved', vendor: { name: 'T-Rock Construction' }, executed_date: '2025-06-15', value: 2500000, description: 'Lump sum general construction contract' },
  ]},
  subcontracts: { title: 'Subcontracts', generator: 'generateSubcontractsPdf', data: [
    { id: 1, number: 'SC-001', title: 'Concrete Work', status: 'approved', vendor: { name: 'DFW Concrete LLC' }, executed_date: '2025-07-01', value: 450000 },
    { id: 2, number: 'SC-002', title: 'Steel Erection', status: 'approved', vendor: { name: 'Lone Star Steel' }, executed_date: '2025-07-15', value: 680000 },
    { id: 3, number: 'SC-003', title: 'Electrical', status: 'pending', vendor: { name: 'Spark Electric Inc' }, executed_date: '2025-08-01', value: 280000 },
  ]},
  purchaseOrders: { title: 'Purchase Orders', generator: 'generatePurchaseOrdersPdf', data: [
    { id: 1, number: 'PO-001', title: 'Structural Steel Materials', status: 'approved', vendor: { name: 'US Steel Supply' }, value: 185000, created_at: '2025-07-20' },
    { id: 2, number: 'PO-002', title: 'HVAC Equipment', status: 'approved', vendor: { name: 'Carrier HVAC' }, value: 95000, created_at: '2025-08-10' },
  ]},
  changeOrders: { title: 'Change Orders', generator: 'generateChangeOrdersPdf', data: [
    { id: 1, number: 'CO-001', title: 'Additional Structural Support', status: 'approved', amount: 50000, created_at: '2025-09-01', description: 'Added steel bracing per revised structural engineering' },
    { id: 2, number: 'CO-002', title: 'Owner-Requested Finish Upgrade', status: 'approved', amount: 30000, created_at: '2025-09-20', description: 'Upgraded lobby finishes from VCT to porcelain tile' },
    { id: 3, number: 'CO-003', title: 'Unforeseen Site Conditions', status: 'pending', amount: 45000, created_at: '2025-10-15', description: 'Rock excavation required at foundation' },
  ]},
  changeEvents: { title: 'Change Events', generator: 'generateChangeEventsPdf', data: [
    { id: 1, number: 'CE-001', title: 'Structural Redesign', status: 'open', origin: 'Design Error', created_at: '2025-08-28', estimated_amount: 55000 },
    { id: 2, number: 'CE-002', title: 'Owner Scope Addition', status: 'closed', origin: 'Owner Request', created_at: '2025-09-15', estimated_amount: 30000 },
  ]},
  directCosts: { title: 'Direct Costs', generator: 'generateDirectCostsPdf', data: [
    { id: 1, description: 'Temporary power installation', vendor: 'City Electric', amount: 8500, created_at: '2025-07-05', cost_code: '01-500' },
    { id: 2, description: 'Dumpster rental - Month 1', vendor: 'Waste Mgmt', amount: 2400, created_at: '2025-07-15', cost_code: '01-500' },
    { id: 3, description: 'Survey and layout', vendor: 'Precision Survey', amount: 4200, created_at: '2025-07-01', cost_code: '01-400' },
  ]},
  invoicing: { title: 'Invoicing / Requisitions', generator: 'generateInvoicingPdf', data: [
    { id: 1, number: 'INV-001', period: 'July 2025', status: 'paid', amount: 312000, submitted_date: '2025-08-01', paid_date: '2025-08-15' },
    { id: 2, number: 'INV-002', period: 'August 2025', status: 'paid', amount: 445000, submitted_date: '2025-09-01', paid_date: '2025-09-18' },
    { id: 3, number: 'INV-003', period: 'September 2025', status: 'approved', amount: 380000, submitted_date: '2025-10-01' },
  ]},
  directory: { title: 'Project Directory', generator: 'generateDirectoryPdf', data: [
    { name: 'Adnaan Iqbal', email: 'adnaan@trock.com', role: 'Project Manager', company: 'T-Rock Construction', phone: '(972) 555-0100' },
    { name: 'Sarah Johnson', email: 'sarah@trock.com', role: 'Superintendent', company: 'T-Rock Construction', phone: '(972) 555-0101' },
    { name: 'Mike Davis', email: 'mike@dfwconcrete.com', role: 'Foreman', company: 'DFW Concrete LLC', phone: '(214) 555-0200' },
    { name: 'Lisa Chen', email: 'lisa@owner.com', role: 'Owner Representative', company: 'Asset Management Co', phone: '(469) 555-0300' },
  ]},
  estimating: { title: 'Estimating', generator: 'generateEstimatingPdf', data: [
    { id: 1, title: 'Original Estimate', status: 'final', total: 2500000, created_at: '2025-05-15', estimator: 'Tom Engineer' },
    { id: 2, title: 'VE Estimate Rev 1', status: 'final', total: 2350000, created_at: '2025-06-01', estimator: 'Tom Engineer' },
  ]},
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
