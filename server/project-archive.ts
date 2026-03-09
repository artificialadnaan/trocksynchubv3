/**
 * Project Archive Module
 * ======================
 *
 * Handles archiving completed projects to configurable storage (Google Drive,
 * SharePoint, or local). When a project reaches closeout, documents are
 * extracted from Procore and uploaded to the configured provider.
 *
 * Archive Process:
 * 1. Resolve storage provider (from storage-config)
 * 2. Create project folder structure
 * 3. Enumerate and download Procore documents
 * 4. Upload with retry for transient errors
 * 5. Track progress
 *
 * @module project-archive
 */

import { storage } from './storage';
import {
  extractProjectDocuments,
  downloadProcoreFile,
  getProjectDocumentSummary,
  getProjectsList,
} from './procore-documents';
import { getStorageProvider, getStorageConfig, getAutoArchiveConfig } from './storage-config';
import type { StorageProvider } from './storage-provider';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Archive progress tracking object */
export interface ArchiveProgress {
  projectId: string;
  projectName: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  progress: number;
  currentStep: string;
  totalFiles: number;
  filesUploaded: number;
  errors: string[];
  startedAt: string;
  completedAt?: string;
  storageUrl?: string;
  providerType?: string;
}

interface ArchiveResult {
  success: boolean;
  projectId: string;
  projectName: string;
  storageUrl?: string;
  filesArchived: number;
  errors: string[];
  duration: number;
}

const TRANSIENT_STATUS_CODES = new Set([429, 502, 503]);
const TRANSIENT_ERROR_PATTERNS = ['ECONNRESET', 'ETIMEDOUT', 'timeout', 'ENOTFOUND', 'ECONNRESET'];

function isTransientError(e: any): boolean {
  const msg = String(e?.message || e || '');
  const code = e?.code || e?.response?.status;
  if (TRANSIENT_STATUS_CODES.has(Number(code))) return true;
  return TRANSIENT_ERROR_PATTERNS.some((p) => msg.includes(p));
}

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function uploadDocumentWithRetry(
  provider: StorageProvider,
  folderPath: string,
  fileName: string,
  content: Buffer,
  mimeType: string,
  maxAttempts = 3
): Promise<void> {
  let lastError: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await provider.uploadFile(folderPath, fileName, content, mimeType);
      return;
    } catch (e: any) {
      lastError = e;
      if (attempt < maxAttempts && isTransientError(e)) {
        const delay = 2 * 1000 * attempt; // 2s * attempt
        await sleep(delay);
      } else {
        throw e;
      }
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Archive state
// ---------------------------------------------------------------------------

const archiveProgress: Map<string, ArchiveProgress> = new Map();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function startProjectArchive(
  projectId: string,
  options: {
    includeDrawings?: boolean;
    includeSubmittals?: boolean;
    includeRFIs?: boolean;
    includeBidPackages?: boolean;
    includePhotos?: boolean;
    includeBudget?: boolean;
    includeDocuments?: boolean;
    baseFolderPath?: string;
  } = {}
): Promise<{ archiveId: string }> {
  const archiveId = `archive_${projectId}_${Date.now()}`;

  const cfg = await getStorageConfig();
  const baseFolderPath = options.baseFolderPath ?? cfg.archiveBaseFolderName;

  const opts = {
    includeDrawings: options.includeDrawings ?? true,
    includeSubmittals: options.includeSubmittals ?? true,
    includeRFIs: options.includeRFIs ?? true,
    includeBidPackages: options.includeBidPackages ?? true,
    includePhotos: options.includePhotos ?? true,
    includeBudget: options.includeBudget ?? true,
    includeDocuments: options.includeDocuments ?? true,
    baseFolderPath,
  };

  archiveProgress.set(archiveId, {
    projectId,
    projectName: '',
    status: 'pending',
    progress: 0,
    currentStep: 'Initializing...',
    totalFiles: 0,
    filesUploaded: 0,
    errors: [],
    startedAt: new Date().toISOString(),
  });

  runArchive(archiveId, projectId, opts).catch((e) => {
    const progress = archiveProgress.get(archiveId);
    if (progress) {
      progress.status = 'failed';
      progress.errors.push(e.message);
    }
  });

  return { archiveId };
}

// ---------------------------------------------------------------------------
// Preview (dry-run)
// ---------------------------------------------------------------------------

export interface ArchivePreviewOptions {
  includeDrawings?: boolean;
  includeSubmittals?: boolean;
  includeRFIs?: boolean;
  includeBidPackages?: boolean;
  includePhotos?: boolean;
  includeBudget?: boolean;
  includeDocuments?: boolean;
}

export interface ArchivePreviewResult {
  projectId: string;
  projectName: string;
  folderStructure: string[];
  fileCounts: {
    documents: number;
    drawings: number;
    submittals: number;
    rfis: number;
    bidPackages: number;
    photos: number;
    budget: number;
    total: number;
  };
}

export async function previewArchive(
  projectId: string,
  options: ArchivePreviewOptions = {}
): Promise<ArchivePreviewResult> {
  const opts = {
    includeDrawings: options.includeDrawings ?? true,
    includeSubmittals: options.includeSubmittals ?? true,
    includeRFIs: options.includeRFIs ?? true,
    includeBidPackages: options.includeBidPackages ?? true,
    includePhotos: options.includePhotos ?? true,
    includeBudget: options.includeBudget ?? true,
    includeDocuments: options.includeDocuments ?? true,
  };

  const docs = await extractProjectDocuments(projectId);

  let docCount = 0;
  if (opts.includeDocuments) docCount = countFolderFiles(docs.folders);

  const drawingsCount = opts.includeDrawings ? docs.drawings.filter((d) => d.downloadUrl).length : 0;
  const submittalsCount = opts.includeSubmittals ? docs.submittals.filter((s) => s.downloadUrl).length : 0;
  const rfisCount = opts.includeRFIs ? docs.rfis.filter((r) => r.downloadUrl).length : 0;
  const bidPackagesCount = opts.includeBidPackages ? docs.bidPackages.filter((b) => b.downloadUrl).length : 0;
  const photosCount = opts.includePhotos ? docs.photos.filter((p) => p.downloadUrl).length : 0;
  const budgetCount = opts.includeBudget && docs.budget.summary ? 1 : 0;

  const total = docCount + drawingsCount + submittalsCount + rfisCount + bidPackagesCount + photosCount + budgetCount;

  const projectFolderName = sanitizeFolderName(`${docs.projectName} (${projectId})`);
  const cfg = await getStorageConfig();
  const baseFolderName = cfg.archiveBaseFolderName;
  const basePath = `${baseFolderName}/${projectFolderName}`;

  const folderStructure: string[] = [basePath];
  if (opts.includeDocuments && docs.folders.length > 0) folderStructure.push(`${basePath}/Documents`);
  if (opts.includeDrawings && docs.drawings.length > 0) folderStructure.push(`${basePath}/Drawings`);
  if (opts.includeSubmittals && docs.submittals.length > 0) folderStructure.push(`${basePath}/Submittals`);
  if (opts.includeRFIs && docs.rfis.length > 0) folderStructure.push(`${basePath}/RFIs`);
  if (opts.includeBidPackages && docs.bidPackages.length > 0) folderStructure.push(`${basePath}/Bid Packages`);
  if (opts.includePhotos && docs.photos.length > 0) folderStructure.push(`${basePath}/Photos`);
  if (opts.includeBudget && docs.budget.summary) folderStructure.push(`${basePath}/Budget`);

  return {
    projectId,
    projectName: docs.projectName,
    folderStructure,
    fileCounts: {
      documents: docCount,
      drawings: drawingsCount,
      submittals: submittalsCount,
      rfis: rfisCount,
      bidPackages: bidPackagesCount,
      photos: photosCount,
      budget: budgetCount,
      total,
    },
  };
}

// ---------------------------------------------------------------------------
// Procore stage change handler (webhook)
// ---------------------------------------------------------------------------

export async function handleProjectStageChange(
  projectId: string,
  projectName: string,
  newStage: string
): Promise<{ triggered: boolean; archiveId?: string; reason?: string }> {
  const autoConfig = await getAutoArchiveConfig();
  if (!autoConfig || !autoConfig.enabled) {
    return { triggered: false, reason: 'Auto-archive disabled' };
  }

  const triggerStage = (autoConfig.triggerStage || 'Closeout').trim();
  if (!triggerStage) return { triggered: false, reason: 'No trigger stage configured' };

  if (newStage.toLowerCase() !== triggerStage.toLowerCase()) {
    return { triggered: false, reason: `Stage "${newStage}" does not match trigger "${triggerStage}"` };
  }

  const result = await startProjectArchive(projectId, {
    includeDrawings: autoConfig.includeDrawings,
    includeSubmittals: autoConfig.includeSubmittals,
    includeRFIs: autoConfig.includeRFIs,
    includeBidPackages: autoConfig.includeBidPackages,
    includePhotos: autoConfig.includePhotos,
    includeBudget: autoConfig.includeBudget,
    includeDocuments: autoConfig.includeDocuments,
  });

  return { triggered: true, archiveId: result.archiveId };
}

// ---------------------------------------------------------------------------
// Archive runner
// ---------------------------------------------------------------------------

async function runArchive(
  archiveId: string,
  projectId: string,
  options: {
    includeDrawings: boolean;
    includeSubmittals: boolean;
    includeRFIs: boolean;
    includeBidPackages: boolean;
    includePhotos: boolean;
    includeBudget: boolean;
    includeDocuments: boolean;
    baseFolderPath: string;
  }
): Promise<void> {
  const progress = archiveProgress.get(archiveId)!;
  const startTime = Date.now();

  try {
    progress.status = 'in_progress';
    progress.currentStep = 'Resolving storage provider...';

    const provider = await getStorageProvider();
    progress.providerType = provider.providerType;

    progress.currentStep = 'Checking storage connection...';
    if (!(await provider.isConnected())) {
      throw new Error(
        `${provider.providerType} not connected. Please configure storage in Settings.`
      );
    }

    progress.currentStep = 'Extracting project documents from Procore...';
    progress.progress = 5;

    const docs = await extractProjectDocuments(projectId);
    progress.projectName = docs.projectName;

    let totalFiles = 0;
    if (options.includeDocuments) totalFiles += countFolderFiles(docs.folders);
    if (options.includeDrawings) totalFiles += docs.drawings.filter((d) => d.downloadUrl).length;
    if (options.includeSubmittals) totalFiles += docs.submittals.filter((s) => s.downloadUrl).length;
    if (options.includeRFIs) totalFiles += docs.rfis.filter((r) => r.downloadUrl).length;
    if (options.includeBidPackages) totalFiles += docs.bidPackages.filter((b) => b.downloadUrl).length;
    if (options.includePhotos) totalFiles += docs.photos.filter((p) => p.downloadUrl).length;
    if (options.includeBudget && docs.budget.summary) totalFiles += 1;

    progress.totalFiles = totalFiles;
    progress.progress = 10;

    const projectFolderName = sanitizeFolderName(`${docs.projectName} (${projectId})`);
    const basePath = `${options.baseFolderPath}/${projectFolderName}`;

    progress.currentStep = `Creating folder structure: ${basePath}`;
    const baseFolder = await provider.createFolder(basePath);
    progress.storageUrl = baseFolder.webUrl;
    progress.progress = 15;

    let filesUploaded = 0;
    const errors: string[] = [];

    if (options.includeDocuments && docs.folders.length > 0) {
      progress.currentStep = 'Uploading project documents...';
      await provider.createFolder(`${basePath}/Documents`);

      for (const folder of docs.folders) {
        const result = await uploadFolderRecursive(provider, `${basePath}/Documents`, folder, progress);
        filesUploaded += result.uploaded;
        errors.push(...result.errors);
      }
    }
    progress.progress = 30;

    if (options.includeDrawings && docs.drawings.length > 0) {
      progress.currentStep = 'Uploading drawings...';
      await provider.createFolder(`${basePath}/Drawings`);
      for (const drawing of docs.drawings) {
        if (drawing.downloadUrl) {
          const res = await uploadDocument(provider, `${basePath}/Drawings`, drawing, progress);
          if (res.success) filesUploaded++;
          else errors.push(res.error!);
        }
      }
    }
    progress.progress = 45;

    if (options.includeSubmittals && docs.submittals.length > 0) {
      progress.currentStep = 'Uploading submittals...';
      await provider.createFolder(`${basePath}/Submittals`);
      for (const submittal of docs.submittals) {
        if (submittal.downloadUrl) {
          const res = await uploadDocument(provider, `${basePath}/Submittals`, submittal, progress);
          if (res.success) filesUploaded++;
          else errors.push(res.error!);
        }
      }
    }
    progress.progress = 60;

    if (options.includeRFIs && docs.rfis.length > 0) {
      progress.currentStep = 'Uploading RFIs...';
      await provider.createFolder(`${basePath}/RFIs`);
      for (const rfi of docs.rfis) {
        if (rfi.downloadUrl) {
          const res = await uploadDocument(provider, `${basePath}/RFIs`, rfi, progress);
          if (res.success) filesUploaded++;
          else errors.push(res.error!);
        }
      }
    }
    progress.progress = 75;

    if (options.includeBidPackages && docs.bidPackages.length > 0) {
      progress.currentStep = 'Uploading bid packages...';
      await provider.createFolder(`${basePath}/Bid Packages`);
      for (const bp of docs.bidPackages) {
        if (bp.downloadUrl) {
          const res = await uploadDocument(provider, `${basePath}/Bid Packages`, bp, progress);
          if (res.success) filesUploaded++;
          else errors.push(res.error!);
        }
      }
    }
    progress.progress = 85;

    if (options.includePhotos && docs.photos.length > 0) {
      progress.currentStep = 'Uploading photos...';
      await provider.createFolder(`${basePath}/Photos`);
      for (const photo of docs.photos) {
        if (photo.downloadUrl) {
          const res = await uploadDocument(provider, `${basePath}/Photos`, photo, progress);
          if (res.success) filesUploaded++;
          else errors.push(res.error!);
        }
      }
    }
    progress.progress = 95;

    if (options.includeBudget && docs.budget.summary) {
      progress.currentStep = 'Exporting budget data...';
      await provider.createFolder(`${basePath}/Budget`);
      try {
        const budgetJson = JSON.stringify(docs.budget, null, 2);
        const budgetBuffer = Buffer.from(budgetJson, 'utf-8');
        await uploadDocumentWithRetry(
          provider,
          `${basePath}/Budget`,
          'budget_export.json',
          budgetBuffer,
          'application/json'
        );
        filesUploaded++;
      } catch (e: any) {
        errors.push(`Budget export: ${e.message}`);
      }
    }

    progress.currentStep = 'Creating archive summary...';
    const summary = {
      projectId,
      projectName: docs.projectName,
      archivedAt: new Date().toISOString(),
      extractedAt: docs.extractedAt,
      providerType: provider.providerType,
      statistics: {
        folders: docs.folders.length,
        drawings: docs.drawings.length,
        submittals: docs.submittals.length,
        rfis: docs.rfis.length,
        bidPackages: docs.bidPackages.length,
        photos: docs.photos.length,
        hasBudget: !!docs.budget.summary,
      },
      filesUploaded,
      errors: errors.length,
    };

    const summaryJson = JSON.stringify(summary, null, 2);
    await uploadDocumentWithRetry(
      provider,
      basePath,
      '_archive_summary.json',
      Buffer.from(summaryJson, 'utf-8'),
      'application/json'
    );

    progress.status = 'completed';
    progress.progress = 100;
    progress.filesUploaded = filesUploaded;
    progress.errors = errors;
    progress.completedAt = new Date().toISOString();
    progress.currentStep = 'Archive complete';

    await storage.createAuditLog({
      action: 'project_archived',
      entityType: 'project',
      entityId: projectId,
      source: 'archive',
      status: 'success',
      details: {
        projectName: docs.projectName,
        providerType: provider.providerType,
        filesUploaded,
        errors: errors.length,
        duration: Date.now() - startTime,
        storageUrl: baseFolder.webUrl,
      },
    });

    console.log(
      `[Archive] Project ${docs.projectName} archived to ${provider.providerType}: ${filesUploaded} files, ${errors.length} errors`
    );
  } catch (e: any) {
    progress.status = 'failed';
    progress.errors.push(e.message);
    progress.currentStep = `Failed: ${e.message}`;
    console.error(`[Archive] Failed to archive project ${projectId}: ${e.message}`);
  }
}

async function uploadFolderRecursive(
  provider: StorageProvider,
  basePath: string,
  folder: any,
  progress: ArchiveProgress
): Promise<{ uploaded: number; errors: string[] }> {
  let uploaded = 0;
  const errors: string[] = [];
  const folderPath = `${basePath}/${sanitizeFolderName(folder.name)}`;

  try {
    await provider.createFolder(folderPath);

    for (const file of folder.files || []) {
      if (file.downloadUrl) {
        const result = await uploadDocument(provider, folderPath, file, progress);
        if (result.success) uploaded++;
        else errors.push(result.error!);
      }
    }

    for (const subfolder of folder.subfolders || []) {
      const result = await uploadFolderRecursive(provider, folderPath, subfolder, progress);
      uploaded += result.uploaded;
      errors.push(...result.errors);
    }
  } catch (e: any) {
    errors.push(`Folder ${folder.name}: ${e.message}`);
  }

  return { uploaded, errors };
}

async function uploadDocument(
  provider: StorageProvider,
  folderPath: string,
  doc: any,
  progress: ArchiveProgress
): Promise<{ success: boolean; error?: string }> {
  try {
    progress.currentStep = `Uploading: ${doc.name}`;

    const fileBuffer = await downloadProcoreFile(doc.downloadUrl);
    if (!fileBuffer) {
      return { success: false, error: `${doc.name}: Failed to download from Procore` };
    }

    const fileName = sanitizeFileName(doc.name);
    await uploadDocumentWithRetry(
      provider,
      folderPath,
      fileName,
      fileBuffer,
      doc.mimeType || 'application/octet-stream'
    );

    progress.filesUploaded++;
    return { success: true };
  } catch (e: any) {
    return { success: false, error: `${doc.name}: ${e.message}` };
  }
}

function countFolderFiles(folders: any[]): number {
  let count = 0;
  for (const folder of folders) {
    count += (folder.files || []).filter((f: any) => f.downloadUrl).length;
    count += countFolderFiles(folder.subfolders || []);
  }
  return count;
}

function sanitizeFolderName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 200);
}

function sanitizeFileName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 200);
}

// ---------------------------------------------------------------------------
// Progress & projects
// ---------------------------------------------------------------------------

export function getArchiveProgress(archiveId: string): ArchiveProgress | null {
  return archiveProgress.get(archiveId) || null;
}

export function getAllArchiveProgress(): Array<ArchiveProgress & { archiveId: string }> {
  return Array.from(archiveProgress.entries()).map(([archiveId, p]) => ({ ...p, archiveId }));
}

export async function getArchivableProjects(): Promise<
  Array<{
    id: string;
    name: string;
    status: string;
    stage?: string;
    documentSummary?: {
      folders: number;
      drawings: number;
      submittals: number;
      rfis: number;
      bidPackages: number;
      photos: number;
      hasBudget: boolean;
    };
  }>
> {
  return getProjectsList();
}

export { getProjectDocumentSummary };
