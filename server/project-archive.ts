import { storage } from './storage';
import { extractProjectDocuments, downloadProcoreFile, getProjectDocumentSummary, getProjectsList } from './procore-documents';
import { 
  createSharePointFolder, 
  uploadFileToSharePoint, 
  isSharePointConnected,
  getSharePointConfig 
} from './microsoft';

interface ArchiveProgress {
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
  sharePointUrl?: string;
}

interface ArchiveResult {
  success: boolean;
  projectId: string;
  projectName: string;
  sharePointUrl?: string;
  filesArchived: number;
  errors: string[];
  duration: number;
}

const archiveProgress: Map<string, ArchiveProgress> = new Map();

export async function startProjectArchive(projectId: string, options: {
  includeDrawings?: boolean;
  includeSubmittals?: boolean;
  includeRFIs?: boolean;
  includeBidPackages?: boolean;
  includePhotos?: boolean;
  includeBudget?: boolean;
  includeDocuments?: boolean;
  baseFolderPath?: string;
} = {}): Promise<{ archiveId: string }> {
  const archiveId = `archive_${projectId}_${Date.now()}`;

  // Default all options to true
  const opts = {
    includeDrawings: options.includeDrawings ?? true,
    includeSubmittals: options.includeSubmittals ?? true,
    includeRFIs: options.includeRFIs ?? true,
    includeBidPackages: options.includeBidPackages ?? true,
    includePhotos: options.includePhotos ?? true,
    includeBudget: options.includeBudget ?? true,
    includeDocuments: options.includeDocuments ?? true,
    baseFolderPath: options.baseFolderPath || 'T-Rock Projects',
  };

  // Initialize progress
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

  // Start archive process asynchronously
  runArchive(archiveId, projectId, opts).catch((e) => {
    const progress = archiveProgress.get(archiveId);
    if (progress) {
      progress.status = 'failed';
      progress.errors.push(e.message);
    }
  });

  return { archiveId };
}

async function runArchive(archiveId: string, projectId: string, options: {
  includeDrawings: boolean;
  includeSubmittals: boolean;
  includeRFIs: boolean;
  includeBidPackages: boolean;
  includePhotos: boolean;
  includeBudget: boolean;
  includeDocuments: boolean;
  baseFolderPath: string;
}): Promise<void> {
  const progress = archiveProgress.get(archiveId)!;
  const startTime = Date.now();

  try {
    progress.status = 'in_progress';
    progress.currentStep = 'Checking SharePoint connection...';

    // Check SharePoint connection
    if (!await isSharePointConnected()) {
      throw new Error('SharePoint not configured. Please configure SharePoint in Settings first.');
    }

    progress.currentStep = 'Extracting project documents from Procore...';
    progress.progress = 5;

    // Extract documents from Procore
    const docs = await extractProjectDocuments(projectId);
    progress.projectName = docs.projectName;

    // Count total files to upload
    let totalFiles = 0;
    if (options.includeDocuments) {
      totalFiles += countFolderFiles(docs.folders);
    }
    if (options.includeDrawings) totalFiles += docs.drawings.filter(d => d.downloadUrl).length;
    if (options.includeSubmittals) totalFiles += docs.submittals.filter(s => s.downloadUrl).length;
    if (options.includeRFIs) totalFiles += docs.rfis.filter(r => r.downloadUrl).length;
    if (options.includeBidPackages) totalFiles += docs.bidPackages.filter(b => b.downloadUrl).length;
    if (options.includePhotos) totalFiles += docs.photos.filter(p => p.downloadUrl).length;
    if (options.includeBudget && docs.budget.summary) totalFiles += 1;

    progress.totalFiles = totalFiles;
    progress.progress = 10;

    // Create base folder structure in SharePoint
    const projectFolderName = sanitizeFolderName(`${docs.projectName} (${projectId})`);
    const basePath = `${options.baseFolderPath}/${projectFolderName}`;

    progress.currentStep = `Creating folder structure: ${basePath}`;
    const baseFolder = await createSharePointFolder(basePath);

    if (!baseFolder) {
      throw new Error('Failed to create SharePoint folder');
    }

    progress.sharePointUrl = baseFolder.webUrl;
    progress.progress = 15;

    let filesUploaded = 0;
    const errors: string[] = [];

    // Upload documents from folders
    if (options.includeDocuments && docs.folders.length > 0) {
      progress.currentStep = 'Uploading project documents...';
      await createSharePointFolder(`${basePath}/Documents`);

      for (const folder of docs.folders) {
        const result = await uploadFolderRecursive(`${basePath}/Documents`, folder, progress);
        filesUploaded += result.uploaded;
        errors.push(...result.errors);
      }
    }
    progress.progress = 30;

    // Upload drawings
    if (options.includeDrawings && docs.drawings.length > 0) {
      progress.currentStep = 'Uploading drawings...';
      await createSharePointFolder(`${basePath}/Drawings`);

      for (const drawing of docs.drawings) {
        if (drawing.downloadUrl) {
          const result = await uploadDocument(`${basePath}/Drawings`, drawing, progress);
          if (result.success) filesUploaded++;
          else errors.push(result.error!);
        }
      }
    }
    progress.progress = 45;

    // Upload submittals
    if (options.includeSubmittals && docs.submittals.length > 0) {
      progress.currentStep = 'Uploading submittals...';
      await createSharePointFolder(`${basePath}/Submittals`);

      for (const submittal of docs.submittals) {
        if (submittal.downloadUrl) {
          const result = await uploadDocument(`${basePath}/Submittals`, submittal, progress);
          if (result.success) filesUploaded++;
          else errors.push(result.error!);
        }
      }
    }
    progress.progress = 60;

    // Upload RFIs
    if (options.includeRFIs && docs.rfis.length > 0) {
      progress.currentStep = 'Uploading RFIs...';
      await createSharePointFolder(`${basePath}/RFIs`);

      for (const rfi of docs.rfis) {
        if (rfi.downloadUrl) {
          const result = await uploadDocument(`${basePath}/RFIs`, rfi, progress);
          if (result.success) filesUploaded++;
          else errors.push(result.error!);
        }
      }
    }
    progress.progress = 75;

    // Upload bid packages
    if (options.includeBidPackages && docs.bidPackages.length > 0) {
      progress.currentStep = 'Uploading bid packages...';
      await createSharePointFolder(`${basePath}/Bid Packages`);

      for (const bp of docs.bidPackages) {
        if (bp.downloadUrl) {
          const result = await uploadDocument(`${basePath}/Bid Packages`, bp, progress);
          if (result.success) filesUploaded++;
          else errors.push(result.error!);
        }
      }
    }
    progress.progress = 85;

    // Upload photos
    if (options.includePhotos && docs.photos.length > 0) {
      progress.currentStep = 'Uploading photos...';
      await createSharePointFolder(`${basePath}/Photos`);

      for (const photo of docs.photos) {
        if (photo.downloadUrl) {
          const result = await uploadDocument(`${basePath}/Photos`, photo, progress);
          if (result.success) filesUploaded++;
          else errors.push(result.error!);
        }
      }
    }
    progress.progress = 95;

    // Export budget as JSON
    if (options.includeBudget && docs.budget.summary) {
      progress.currentStep = 'Exporting budget data...';
      await createSharePointFolder(`${basePath}/Budget`);

      try {
        const budgetJson = JSON.stringify(docs.budget, null, 2);
        const budgetBuffer = Buffer.from(budgetJson, 'utf-8');
        await uploadFileToSharePoint(`${basePath}/Budget`, 'budget_export.json', budgetBuffer, 'application/json');
        filesUploaded++;
      } catch (e: any) {
        errors.push(`Budget export: ${e.message}`);
      }
    }

    // Create summary file
    progress.currentStep = 'Creating archive summary...';
    const summary = {
      projectId,
      projectName: docs.projectName,
      archivedAt: new Date().toISOString(),
      extractedAt: docs.extractedAt,
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
    await uploadFileToSharePoint(basePath, '_archive_summary.json', Buffer.from(summaryJson, 'utf-8'), 'application/json');

    // Complete
    progress.status = 'completed';
    progress.progress = 100;
    progress.filesUploaded = filesUploaded;
    progress.errors = errors;
    progress.completedAt = new Date().toISOString();
    progress.currentStep = 'Archive complete';

    // Log the archive
    await storage.createAuditLog({
      action: 'project_archived',
      entityType: 'project',
      entityId: projectId,
      source: 'archive',
      status: 'success',
      details: {
        projectName: docs.projectName,
        filesUploaded,
        errors: errors.length,
        duration: Date.now() - startTime,
        sharePointUrl: baseFolder.webUrl,
      },
    });

    console.log(`[Archive] Project ${docs.projectName} archived successfully: ${filesUploaded} files, ${errors.length} errors`);

  } catch (e: any) {
    progress.status = 'failed';
    progress.errors.push(e.message);
    progress.currentStep = `Failed: ${e.message}`;
    console.error(`[Archive] Failed to archive project ${projectId}: ${e.message}`);
  }
}

async function uploadFolderRecursive(basePath: string, folder: any, progress: ArchiveProgress): Promise<{ uploaded: number; errors: string[] }> {
  let uploaded = 0;
  const errors: string[] = [];

  const folderPath = `${basePath}/${sanitizeFolderName(folder.name)}`;

  try {
    await createSharePointFolder(folderPath);

    // Upload files in this folder
    for (const file of folder.files || []) {
      if (file.downloadUrl) {
        const result = await uploadDocument(folderPath, file, progress);
        if (result.success) uploaded++;
        else errors.push(result.error!);
      }
    }

    // Process subfolders
    for (const subfolder of folder.subfolders || []) {
      const result = await uploadFolderRecursive(folderPath, subfolder, progress);
      uploaded += result.uploaded;
      errors.push(...result.errors);
    }
  } catch (e: any) {
    errors.push(`Folder ${folder.name}: ${e.message}`);
  }

  return { uploaded, errors };
}

async function uploadDocument(folderPath: string, doc: any, progress: ArchiveProgress): Promise<{ success: boolean; error?: string }> {
  try {
    progress.currentStep = `Uploading: ${doc.name}`;

    const fileBuffer = await downloadProcoreFile(doc.downloadUrl);
    if (!fileBuffer) {
      return { success: false, error: `${doc.name}: Failed to download from Procore` };
    }

    const fileName = sanitizeFileName(doc.name);
    await uploadFileToSharePoint(folderPath, fileName, fileBuffer, doc.mimeType || 'application/octet-stream');

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

export function getArchiveProgress(archiveId: string): ArchiveProgress | null {
  return archiveProgress.get(archiveId) || null;
}

export async function getArchivableProjects(): Promise<Array<{
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
}>> {
  const projects = await getProjectsList();

  // Optionally get document counts for each project (can be slow for many projects)
  // For now, return basic project list
  return projects;
}

export { getProjectDocumentSummary };
