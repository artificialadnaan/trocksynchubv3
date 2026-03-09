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
