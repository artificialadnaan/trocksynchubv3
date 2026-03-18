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

const DEFAULT_INCLUDE = true;

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
    includeEmails?: boolean;
    includeIncidents?: boolean;
    includePunchList?: boolean;
    includeMeetings?: boolean;
    includeSchedule?: boolean;
    includeDailyLogs?: boolean;
    includeSpecifications?: boolean;
    includePrimeContracts?: boolean;
    includeCommitments?: boolean;
    includeChangeOrders?: boolean;
    includeChangeEvents?: boolean;
    includeDirectCosts?: boolean;
    includeInvoicing?: boolean;
    includeDirectory?: boolean;
    includeEstimating?: boolean;
    includeObservations?: boolean;
    includeActionPlans?: boolean;
    includeWeatherLogs?: boolean;
    includeSafetyViolations?: boolean;
    includeAccidentLogs?: boolean;
    baseFolderPath?: string;
  } = {}
): Promise<{ archiveId: string }> {
  const archiveId = `archive_${projectId}_${Date.now()}`;

  const cfg = await getStorageConfig();
  const baseFolderPath = options.baseFolderPath ?? cfg.archiveBaseFolderName;

  const opts = {
    includeDrawings: options.includeDrawings ?? DEFAULT_INCLUDE,
    includeSubmittals: options.includeSubmittals ?? DEFAULT_INCLUDE,
    includeRFIs: options.includeRFIs ?? DEFAULT_INCLUDE,
    includeBidPackages: options.includeBidPackages ?? DEFAULT_INCLUDE,
    includePhotos: options.includePhotos ?? DEFAULT_INCLUDE,
    includeBudget: options.includeBudget ?? DEFAULT_INCLUDE,
    includeDocuments: options.includeDocuments ?? DEFAULT_INCLUDE,
    includeEmails: options.includeEmails ?? DEFAULT_INCLUDE,
    includeIncidents: options.includeIncidents ?? DEFAULT_INCLUDE,
    includePunchList: options.includePunchList ?? DEFAULT_INCLUDE,
    includeMeetings: options.includeMeetings ?? DEFAULT_INCLUDE,
    includeSchedule: options.includeSchedule ?? DEFAULT_INCLUDE,
    includeDailyLogs: options.includeDailyLogs ?? DEFAULT_INCLUDE,
    includeSpecifications: options.includeSpecifications ?? DEFAULT_INCLUDE,
    includePrimeContracts: options.includePrimeContracts ?? DEFAULT_INCLUDE,
    includeCommitments: options.includeCommitments ?? DEFAULT_INCLUDE,
    includeChangeOrders: options.includeChangeOrders ?? DEFAULT_INCLUDE,
    includeChangeEvents: options.includeChangeEvents ?? DEFAULT_INCLUDE,
    includeDirectCosts: options.includeDirectCosts ?? DEFAULT_INCLUDE,
    includeInvoicing: options.includeInvoicing ?? DEFAULT_INCLUDE,
    includeDirectory: options.includeDirectory ?? DEFAULT_INCLUDE,
    includeEstimating: options.includeEstimating ?? DEFAULT_INCLUDE,
    includeObservations: options.includeObservations ?? DEFAULT_INCLUDE,
    includeActionPlans: options.includeActionPlans ?? DEFAULT_INCLUDE,
    includeWeatherLogs: options.includeWeatherLogs ?? DEFAULT_INCLUDE,
    includeSafetyViolations: options.includeSafetyViolations ?? DEFAULT_INCLUDE,
    includeAccidentLogs: options.includeAccidentLogs ?? DEFAULT_INCLUDE,
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
  includeEmails?: boolean;
  includeIncidents?: boolean;
  includePunchList?: boolean;
  includeMeetings?: boolean;
  includeSchedule?: boolean;
  includeDailyLogs?: boolean;
  includeSpecifications?: boolean;
  includePrimeContracts?: boolean;
  includeCommitments?: boolean;
  includeChangeOrders?: boolean;
  includeChangeEvents?: boolean;
  includeDirectCosts?: boolean;
  includeInvoicing?: boolean;
  includeDirectory?: boolean;
  includeEstimating?: boolean;
  includeObservations?: boolean;
  includeActionPlans?: boolean;
  includeWeatherLogs?: boolean;
  includeSafetyViolations?: boolean;
  includeAccidentLogs?: boolean;
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
    emails: number;
    incidents: number;
    punchList: number;
    meetings: number;
    schedule: number;
    dailyLogs: number;
    specifications: number;
    primeContracts: number;
    commitments: number;
    changeOrders: number;
    changeEvents: number;
    directCosts: number;
    invoicing: number;
    directory: number;
    estimating: number;
    observations: number;
    actionPlans: number;
    weatherLogs: number;
    safetyViolations: number;
    accidentLogs: number;
    total: number;
  };
}

function countDocWithUrl(docs: any[]): number {
  return docs.filter((d) => d.downloadUrl || (d as any).contentBuffer).length;
}

export async function previewArchive(
  projectId: string,
  options: ArchivePreviewOptions = {}
): Promise<ArchivePreviewResult> {
  const opts = {
    includeDrawings: options.includeDrawings ?? DEFAULT_INCLUDE,
    includeSubmittals: options.includeSubmittals ?? DEFAULT_INCLUDE,
    includeRFIs: options.includeRFIs ?? DEFAULT_INCLUDE,
    includeBidPackages: options.includeBidPackages ?? DEFAULT_INCLUDE,
    includePhotos: options.includePhotos ?? DEFAULT_INCLUDE,
    includeBudget: options.includeBudget ?? DEFAULT_INCLUDE,
    includeDocuments: options.includeDocuments ?? DEFAULT_INCLUDE,
    includeEmails: options.includeEmails ?? DEFAULT_INCLUDE,
    includeIncidents: options.includeIncidents ?? DEFAULT_INCLUDE,
    includePunchList: options.includePunchList ?? DEFAULT_INCLUDE,
    includeMeetings: options.includeMeetings ?? DEFAULT_INCLUDE,
    includeSchedule: options.includeSchedule ?? DEFAULT_INCLUDE,
    includeDailyLogs: options.includeDailyLogs ?? DEFAULT_INCLUDE,
    includeSpecifications: options.includeSpecifications ?? DEFAULT_INCLUDE,
    includePrimeContracts: options.includePrimeContracts ?? DEFAULT_INCLUDE,
    includeCommitments: options.includeCommitments ?? DEFAULT_INCLUDE,
    includeChangeOrders: options.includeChangeOrders ?? DEFAULT_INCLUDE,
    includeChangeEvents: options.includeChangeEvents ?? DEFAULT_INCLUDE,
    includeDirectCosts: options.includeDirectCosts ?? DEFAULT_INCLUDE,
    includeInvoicing: options.includeInvoicing ?? DEFAULT_INCLUDE,
    includeDirectory: options.includeDirectory ?? DEFAULT_INCLUDE,
    includeEstimating: options.includeEstimating ?? DEFAULT_INCLUDE,
    includeObservations: options.includeObservations ?? DEFAULT_INCLUDE,
    includeActionPlans: options.includeActionPlans ?? DEFAULT_INCLUDE,
    includeWeatherLogs: options.includeWeatherLogs ?? DEFAULT_INCLUDE,
    includeSafetyViolations: options.includeSafetyViolations ?? DEFAULT_INCLUDE,
    includeAccidentLogs: options.includeAccidentLogs ?? DEFAULT_INCLUDE,
  };

  const docs = await extractProjectDocuments(projectId);

  const docCount = opts.includeDocuments ? countFolderFiles(docs.folders) : 0;
  const drawingsCount = opts.includeDrawings ? countDocWithUrl(docs.drawings) : 0;
  const submittalsCount = opts.includeSubmittals ? countDocWithUrl(docs.submittals) : 0;
  const rfisCount = opts.includeRFIs ? countDocWithUrl(docs.rfis) : 0;
  const bidPackagesCount = opts.includeBidPackages ? countDocWithUrl(docs.bidPackages) : 0;
  const photosCount = opts.includePhotos ? countDocWithUrl(docs.photos) : 0;
  const budgetCount = opts.includeBudget && docs.budget.summary ? 1 : 0;
  const emailsCount = opts.includeEmails ? docs.emails.length : 0;
  const incidentsCount = opts.includeIncidents ? docs.incidents.length : 0;
  const punchListCount = opts.includePunchList ? docs.punchList.length : 0;
  const meetingsCount = opts.includeMeetings ? docs.meetings.length : 0;
  const scheduleCount = opts.includeSchedule ? docs.schedule.length : 0;
  const dailyLogsCount = opts.includeDailyLogs
    ? docs.dailyLogs.attachments.length + (docs.dailyLogs.items.length > 0 ? 1 : 0)
    : 0;
  const specCount = opts.includeSpecifications ? docs.specifications.length : 0;
  const primeCount = opts.includePrimeContracts ? (docs.primeContractsData?.length ?? docs.primeContracts.length) : 0;
  const commitCount = opts.includeCommitments
    ? (docs.commitmentsData?.subcontracts?.length ?? 0) + (docs.commitmentsData?.purchaseOrders?.length ?? 0) ||
      docs.commitments.subcontracts.length + docs.commitments.purchaseOrders.length
    : 0;
  const changeOrdersCount = opts.includeChangeOrders ? (docs.changeOrdersData?.length ?? docs.changeOrders.length) : 0;
  const changeEventsCount = opts.includeChangeEvents ? (docs.changeEventsData?.length ?? docs.changeEvents.length) : 0;
  const directCostsCount = opts.includeDirectCosts ? (docs.directCostsData?.length ?? docs.directCosts.length) : 0;
  const invoicingCount = opts.includeInvoicing ? (docs.invoicingData?.length ?? docs.invoicing.length) : 0;
  const directoryCountForTotal = opts.includeDirectory && docs.directory.length > 0 ? 1 : 0;
  const estimatingCountForTotal = opts.includeEstimating && docs.estimating.length > 0 ? 1 : 0;
  const observationsCount = opts.includeObservations && (docs.observationsData?.length ?? 0) > 0 ? 1 : 0;
  const actionPlansCount = opts.includeActionPlans && (docs.actionPlansData?.length ?? 0) > 0 ? 1 : 0;
  const weatherLogsCount = opts.includeWeatherLogs && (docs.weatherLogsData?.length ?? 0) > 0 ? 1 : 0;
  const safetyViolationsCount = opts.includeSafetyViolations && (docs.safetyViolationsData?.length ?? 0) > 0 ? 1 : 0;
  const accidentLogsCount = opts.includeAccidentLogs && (docs.accidentLogsData?.length ?? 0) > 0 ? 1 : 0;

  const total =
    docCount + drawingsCount + submittalsCount + rfisCount + bidPackagesCount + photosCount +
    budgetCount + emailsCount + incidentsCount + punchListCount + meetingsCount + scheduleCount +
    dailyLogsCount + specCount + primeCount + commitCount + changeOrdersCount + changeEventsCount +
    directCostsCount + invoicingCount + directoryCountForTotal + estimatingCountForTotal +
    observationsCount + actionPlansCount + weatherLogsCount + safetyViolationsCount + accidentLogsCount;

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
  if (opts.includeEmails && docs.emails.length > 0) folderStructure.push(`${basePath}/Emails`);
  if (opts.includeIncidents && docs.incidents.length > 0) folderStructure.push(`${basePath}/Incidents`);
  if (opts.includePunchList && docs.punchList.length > 0) folderStructure.push(`${basePath}/Punch List`);
  if (opts.includeMeetings && docs.meetings.length > 0) folderStructure.push(`${basePath}/Meetings`);
  if (opts.includeSchedule && docs.schedule.length > 0) folderStructure.push(`${basePath}/Schedule`);
  if (opts.includeDailyLogs && (docs.dailyLogs.items.length > 0 || docs.dailyLogs.attachments.length > 0))
    folderStructure.push(`${basePath}/Daily Logs`);
  if (opts.includeSpecifications && docs.specifications.length > 0) folderStructure.push(`${basePath}/Specifications`);
  if (opts.includePrimeContracts && (docs.primeContractsData?.length > 0 || docs.primeContracts.length > 0))
    folderStructure.push(`${basePath}/Prime Contracts`);
  if (opts.includeCommitments && ((docs.commitmentsData?.subcontracts?.length ?? 0) + (docs.commitmentsData?.purchaseOrders?.length ?? 0) > 0 || docs.commitments.subcontracts.length > 0 || docs.commitments.purchaseOrders.length > 0))
    folderStructure.push(`${basePath}/Commitments/Subcontracts`, `${basePath}/Commitments/Purchase Orders`);
  if (opts.includeChangeOrders && (docs.changeOrdersData?.length > 0 || docs.changeOrders.length > 0))
    folderStructure.push(`${basePath}/Change Orders`);
  if (opts.includeChangeEvents && (docs.changeEventsData?.length > 0 || docs.changeEvents.length > 0))
    folderStructure.push(`${basePath}/Change Events`);
  if (opts.includeDirectCosts && (docs.directCostsData?.length > 0 || docs.directCosts.length > 0))
    folderStructure.push(`${basePath}/Direct Costs`);
  if (opts.includeInvoicing && (docs.invoicingData?.length > 0 || docs.invoicing.length > 0))
    folderStructure.push(`${basePath}/Invoicing`);
  if (opts.includeDirectory && docs.directory.length > 0) folderStructure.push(`${basePath}/Directory`);
  if (opts.includeEstimating && docs.estimating.length > 0) folderStructure.push(`${basePath}/Estimating`);
  if (opts.includeObservations && (docs.observationsData?.length ?? 0) > 0) folderStructure.push(`${basePath}/Observations`);
  if (opts.includeActionPlans && (docs.actionPlansData?.length ?? 0) > 0) folderStructure.push(`${basePath}/Action Plans`);
  if (opts.includeWeatherLogs && (docs.weatherLogsData?.length ?? 0) > 0) folderStructure.push(`${basePath}/Weather Logs`);
  if (opts.includeSafetyViolations && (docs.safetyViolationsData?.length ?? 0) > 0) folderStructure.push(`${basePath}/Safety Violations`);
  if (opts.includeAccidentLogs && (docs.accidentLogsData?.length ?? 0) > 0) folderStructure.push(`${basePath}/Accident Logs`);

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
      emails: emailsCount,
      incidents: incidentsCount,
      punchList: punchListCount,
      meetings: meetingsCount,
      schedule: scheduleCount,
      dailyLogs: dailyLogsCount,
      specifications: specCount,
      primeContracts: primeCount,
      commitments: commitCount,
      changeOrders: changeOrdersCount,
      changeEvents: changeEventsCount,
      directCosts: directCostsCount,
      invoicing: invoicingCount,
      directory: opts.includeDirectory ? docs.directory.length : 0,
      estimating: opts.includeEstimating ? docs.estimating.length : 0,
      observations: observationsCount,
      actionPlans: actionPlansCount,
      weatherLogs: weatherLogsCount,
      safetyViolations: safetyViolationsCount,
      accidentLogs: accidentLogsCount,
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

type ArchiveOptions = {
  includeDrawings: boolean;
  includeSubmittals: boolean;
  includeRFIs: boolean;
  includeBidPackages: boolean;
  includePhotos: boolean;
  includeBudget: boolean;
  includeDocuments: boolean;
  includeEmails: boolean;
  includeIncidents: boolean;
  includePunchList: boolean;
  includeMeetings: boolean;
  includeSchedule: boolean;
  includeDailyLogs: boolean;
  includeSpecifications: boolean;
  includePrimeContracts: boolean;
  includeCommitments: boolean;
  includeChangeOrders: boolean;
  includeChangeEvents: boolean;
  includeDirectCosts: boolean;
  includeInvoicing: boolean;
  includeDirectory: boolean;
  includeEstimating: boolean;
  includeObservations?: boolean;
  includeActionPlans?: boolean;
  includeWeatherLogs?: boolean;
  includeSafetyViolations?: boolean;
  includeAccidentLogs?: boolean;
  baseFolderPath: string;
};

async function runArchive(archiveId: string, projectId: string, options: ArchiveOptions): Promise<void> {
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
    if (options.includeDrawings) totalFiles += countDocWithUrl(docs.drawings);
    if (options.includeSubmittals) totalFiles += countDocWithUrl(docs.submittals);
    if (options.includeRFIs) totalFiles += countDocWithUrl(docs.rfis);
    if (options.includeBidPackages) totalFiles += countDocWithUrl(docs.bidPackages);
    if (options.includePhotos) totalFiles += countDocWithUrl(docs.photos);
    if (options.includeBudget && docs.budget.summary) totalFiles += 1;
    if (options.includeEmails) totalFiles += docs.emails.length;
    if (options.includeIncidents) totalFiles += docs.incidents.length;
    if (options.includePunchList) totalFiles += docs.punchList.length;
    if (options.includeMeetings) totalFiles += docs.meetings.length;
    if (options.includeSchedule) totalFiles += docs.schedule.length;
    if (options.includeDailyLogs)
      totalFiles += docs.dailyLogs.attachments.length + (docs.dailyLogs.items.length > 0 ? 1 : 0);
    if (options.includeSpecifications) totalFiles += docs.specifications.length;
    if (options.includePrimeContracts) {
      totalFiles += countDocWithUrl(docs.primeContracts);
      if (docs.primeContractsData?.length) totalFiles += 1;
    }
    if (options.includeCommitments) {
      totalFiles += countDocWithUrl(docs.commitments.subcontracts) + countDocWithUrl(docs.commitments.purchaseOrders);
      if (docs.commitmentsData?.subcontracts?.length) totalFiles += 1;
      if (docs.commitmentsData?.purchaseOrders?.length) totalFiles += 1;
    }
    if (options.includeChangeOrders) {
      totalFiles += countDocWithUrl(docs.changeOrders);
      if (docs.changeOrdersData?.length) totalFiles += 1;
    }
    if (options.includeChangeEvents) {
      totalFiles += countDocWithUrl(docs.changeEvents);
      if (docs.changeEventsData?.length) totalFiles += 1;
    }
    if (options.includeDirectCosts) {
      totalFiles += countDocWithUrl(docs.directCosts);
      if (docs.directCostsData?.length) totalFiles += 1;
    }
    if (options.includeInvoicing) {
      totalFiles += countDocWithUrl(docs.invoicing);
      if (docs.invoicingData?.length) totalFiles += 1;
    }
    if (options.includeDirectory && docs.directory.length > 0) totalFiles += 1;
    if (options.includeEstimating && docs.estimating.length > 0) totalFiles += 1;

    progress.totalFiles = totalFiles;
    progress.progress = 5;

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
        const { generateBudgetPdf } = await import('./archive-pdf-generator');
        const pdfBuffer = await generateBudgetPdf(docs.budget, docs.projectName);
        await uploadDocumentWithRetry(provider, `${basePath}/Budget`, 'budget_report.pdf', pdfBuffer, 'application/pdf');
        filesUploaded++;
      } catch (e: any) {
        console.warn(`[Archive] PDF generation failed for budget, falling back to JSON: ${e.message}`);
        try {
          const budgetJson = JSON.stringify(docs.budget, null, 2);
          await uploadDocumentWithRetry(provider, `${basePath}/Budget`, 'budget_export.json', Buffer.from(budgetJson), 'application/json');
          filesUploaded++;
        } catch (e2: any) {
          errors.push(`Budget export: ${e2.message}`);
        }
      }
    }

    const uploadDocList = async (
      list: any[],
      folder: string,
      stepLabel: string
    ) => {
      if (list.length === 0) return;
      progress.currentStep = stepLabel;
      await provider.createFolder(folder);
      for (const doc of list) {
        if (doc.downloadUrl || (doc as any).contentBuffer) {
          const res = await uploadDocument(provider, folder, doc, progress);
          if (res.success) filesUploaded++;
          else errors.push(res.error!);
        }
      }
    };

    if (options.includeEmails && (docs.emailsData?.length > 0 || docs.emails.length > 0)) {
      progress.currentStep = 'Uploading emails...';
      await provider.createFolder(`${basePath}/Emails`);
      if (docs.emailsData?.length > 0) {
        try {
          const { generateEmailsPdf } = await import('./archive-pdf-generator');
          const pdfBuffer = await generateEmailsPdf(docs.emailsData, docs.projectName);
          await uploadDocumentWithRetry(provider, `${basePath}/Emails`, 'emails_report.pdf', pdfBuffer, 'application/pdf');
          filesUploaded++;
        } catch (e: any) {
          console.warn(`[Archive] PDF generation failed for emails, falling back to JSON: ${e.message}`);
          try {
            const json = JSON.stringify(docs.emailsData, null, 2);
            await uploadDocumentWithRetry(provider, `${basePath}/Emails`, 'emails_data.json', Buffer.from(json), 'application/json');
            filesUploaded++;
          } catch (e2: any) {
            errors.push(`Emails export: ${e2.message}`);
          }
        }
      }
      for (const doc of docs.emails) {
        if (!doc.url && !doc.downloadUrl) continue;
        const res = await uploadDocument(provider, `${basePath}/Emails`, doc, progress);
        if (res.success) filesUploaded++;
        else errors.push(res.error!);
      }
    }

    if (options.includeIncidents && (docs.incidentsData?.length > 0 || docs.incidents.length > 0)) {
      progress.currentStep = 'Uploading incidents...';
      await provider.createFolder(`${basePath}/Incidents`);
      if (docs.incidentsData?.length > 0) {
        try {
          const { generateIncidentsPdf } = await import('./archive-pdf-generator');
          const pdfBuffer = await generateIncidentsPdf(docs.incidentsData, docs.projectName);
          await uploadDocumentWithRetry(provider, `${basePath}/Incidents`, 'incidents_report.pdf', pdfBuffer, 'application/pdf');
          filesUploaded++;
        } catch (e: any) {
          console.warn(`[Archive] PDF generation failed for incidents, falling back to JSON: ${e.message}`);
          try {
            const json = JSON.stringify(docs.incidentsData, null, 2);
            await uploadDocumentWithRetry(provider, `${basePath}/Incidents`, 'incidents_data.json', Buffer.from(json), 'application/json');
            filesUploaded++;
          } catch (e2: any) {
            errors.push(`Incidents export: ${e2.message}`);
          }
        }
      }
      for (const doc of docs.incidents) {
        if (!doc.url && !doc.downloadUrl) continue;
        const res = await uploadDocument(provider, `${basePath}/Incidents`, doc, progress);
        if (res.success) filesUploaded++;
        else errors.push(res.error!);
      }
    }

    if (options.includePunchList && (docs.punchListData?.length > 0 || docs.punchList.length > 0)) {
      progress.currentStep = 'Uploading punch list...';
      await provider.createFolder(`${basePath}/Punch List`);
      if (docs.punchListData?.length > 0) {
        try {
          const { generatePunchListPdf } = await import('./archive-pdf-generator');
          const pdfBuffer = await generatePunchListPdf(docs.punchListData, docs.projectName);
          await uploadDocumentWithRetry(provider, `${basePath}/Punch List`, 'punch_list_report.pdf', pdfBuffer, 'application/pdf');
          filesUploaded++;
        } catch (e: any) {
          console.warn(`[Archive] PDF generation failed for punch list, falling back to JSON: ${e.message}`);
          try {
            const json = JSON.stringify(docs.punchListData, null, 2);
            await uploadDocumentWithRetry(provider, `${basePath}/Punch List`, 'punch_list_data.json', Buffer.from(json), 'application/json');
            filesUploaded++;
          } catch (e2: any) {
            errors.push(`Punch list export: ${e2.message}`);
          }
        }
      }
      for (const doc of docs.punchList) {
        if (!doc.url && !doc.downloadUrl) continue;
        const res = await uploadDocument(provider, `${basePath}/Punch List`, doc, progress);
        if (res.success) filesUploaded++;
        else errors.push(res.error!);
      }
    }

    if (options.includeMeetings && (docs.meetingsData?.length > 0 || docs.meetings.length > 0)) {
      progress.currentStep = 'Uploading meetings...';
      await provider.createFolder(`${basePath}/Meetings`);
      if (docs.meetingsData?.length > 0) {
        try {
          const { generateMeetingsPdf } = await import('./archive-pdf-generator');
          const pdfBuffer = await generateMeetingsPdf(docs.meetingsData, docs.projectName);
          await uploadDocumentWithRetry(provider, `${basePath}/Meetings`, 'meetings_report.pdf', pdfBuffer, 'application/pdf');
          filesUploaded++;
        } catch (e: any) {
          console.warn(`[Archive] PDF generation failed for meetings, falling back to JSON: ${e.message}`);
          try {
            const json = JSON.stringify(docs.meetingsData, null, 2);
            await uploadDocumentWithRetry(provider, `${basePath}/Meetings`, 'meetings_data.json', Buffer.from(json), 'application/json');
            filesUploaded++;
          } catch (e2: any) {
            errors.push(`Meetings export: ${e2.message}`);
          }
        }
      }
      for (const doc of docs.meetings) {
        if (!doc.url && !doc.downloadUrl) continue;
        const res = await uploadDocument(provider, `${basePath}/Meetings`, doc, progress);
        if (res.success) filesUploaded++;
        else errors.push(res.error!);
      }
    }

    if (options.includeSchedule) await uploadDocList(docs.schedule, `${basePath}/Schedule`, 'Uploading schedule...');

    if (options.includeDailyLogs && (docs.dailyLogs.items.length > 0 || docs.dailyLogs.attachments.length > 0)) {
      progress.currentStep = 'Uploading daily logs...';
      await provider.createFolder(`${basePath}/Daily Logs`);
      if (docs.dailyLogs.items.length > 0) {
        try {
          const { generateDailyLogsPdf } = await import('./archive-pdf-generator');
          const pdfBuffer = await generateDailyLogsPdf(docs.dailyLogs.items, docs.projectName);
          await uploadDocumentWithRetry(provider, `${basePath}/Daily Logs`, 'daily_logs_report.pdf', pdfBuffer, 'application/pdf');
          filesUploaded++;
        } catch (e: any) {
          console.warn(`[Archive] PDF generation failed for daily logs, falling back to JSON: ${e.message}`);
          try {
            const json = JSON.stringify(docs.dailyLogs.items, null, 2);
            await uploadDocumentWithRetry(provider, `${basePath}/Daily Logs`, 'daily_logs.json', Buffer.from(json), 'application/json');
            filesUploaded++;
          } catch (e2: any) {
            errors.push(`Daily logs export: ${e2.message}`);
          }
        }
      }
      for (const att of docs.dailyLogs.attachments) {
        if (att.downloadUrl || (att as any).contentBuffer) {
          const res = await uploadDocument(provider, `${basePath}/Daily Logs`, att, progress);
          if (res.success) filesUploaded++;
          else errors.push(res.error!);
        }
      }
    }

    if (options.includeSpecifications && (docs.specificationsData?.length > 0 || docs.specifications.length > 0)) {
      progress.currentStep = 'Uploading specifications...';
      await provider.createFolder(`${basePath}/Specifications`);
      if (docs.specificationsData?.length > 0) {
        try {
          const { generateSpecificationsPdf } = await import('./archive-pdf-generator');
          const pdfBuffer = await generateSpecificationsPdf(docs.specificationsData, docs.projectName);
          await uploadDocumentWithRetry(provider, `${basePath}/Specifications`, 'specifications_report.pdf', pdfBuffer, 'application/pdf');
          filesUploaded++;
        } catch (e: any) {
          console.warn(`[Archive] PDF generation failed for specifications, falling back to JSON: ${e.message}`);
          try {
            const json = JSON.stringify(docs.specificationsData, null, 2);
            await uploadDocumentWithRetry(provider, `${basePath}/Specifications`, 'specifications_data.json', Buffer.from(json), 'application/json');
            filesUploaded++;
          } catch (e2: any) {
            errors.push(`Specifications export: ${e2.message}`);
          }
        }
      }
      for (const doc of docs.specifications) {
        if (!doc.url && !doc.downloadUrl) continue;
        const res = await uploadDocument(provider, `${basePath}/Specifications`, doc, progress);
        if (res.success) filesUploaded++;
        else errors.push(res.error!);
      }
    }
    if (options.includePrimeContracts && (docs.primeContractsData?.length > 0 || docs.primeContracts.length > 0)) {
      progress.currentStep = 'Uploading prime contracts...';
      await provider.createFolder(`${basePath}/Prime Contracts`);
      if (docs.primeContractsData?.length > 0) {
        try {
          const { generatePrimeContractsPdf } = await import('./archive-pdf-generator');
          const pdfBuffer = await generatePrimeContractsPdf(docs.primeContractsData, docs.projectName);
          await uploadDocumentWithRetry(provider, `${basePath}/Prime Contracts`, 'prime_contracts_report.pdf', pdfBuffer, 'application/pdf');
          filesUploaded++;
        } catch (e: any) {
          console.warn(`[Archive] PDF generation failed for prime contracts, falling back to JSON: ${e.message}`);
          try {
            const json = JSON.stringify(docs.primeContractsData, null, 2);
            await uploadDocumentWithRetry(provider, `${basePath}/Prime Contracts`, 'prime_contracts_data.json', Buffer.from(json), 'application/json');
            filesUploaded++;
          } catch (e2: any) {
            errors.push(`Prime contracts JSON: ${e2.message}`);
          }
        }
      }
      for (const doc of docs.primeContracts) {
        if (doc.downloadUrl || (doc as any).contentBuffer) {
          const res = await uploadDocument(provider, `${basePath}/Prime Contracts`, doc, progress);
          if (res.success) filesUploaded++;
          else errors.push(res.error!);
        }
      }
    }

    if (options.includeCommitments) {
      const hasSubs = (docs.commitmentsData?.subcontracts?.length ?? 0) > 0 || docs.commitments.subcontracts.length > 0;
      const hasPOs = (docs.commitmentsData?.purchaseOrders?.length ?? 0) > 0 || docs.commitments.purchaseOrders.length > 0;
      if (hasSubs) {
        await provider.createFolder(`${basePath}/Commitments/Subcontracts`);
        if (docs.commitmentsData?.subcontracts?.length) {
          try {
            const { generateSubcontractsPdf } = await import('./archive-pdf-generator');
            const pdfBuffer = await generateSubcontractsPdf(docs.commitmentsData.subcontracts, docs.projectName);
            await uploadDocumentWithRetry(provider, `${basePath}/Commitments/Subcontracts`, 'subcontracts_report.pdf', pdfBuffer, 'application/pdf');
            filesUploaded++;
          } catch (e: any) {
            console.warn(`[Archive] PDF generation failed for subcontracts, falling back to JSON: ${e.message}`);
            try {
              const json = JSON.stringify(docs.commitmentsData.subcontracts, null, 2);
              await uploadDocumentWithRetry(provider, `${basePath}/Commitments/Subcontracts`, 'subcontracts_data.json', Buffer.from(json), 'application/json');
              filesUploaded++;
            } catch (e2: any) {
              errors.push(`Subcontracts JSON: ${e2.message}`);
            }
          }
        }
        for (const doc of docs.commitments.subcontracts) {
          if (doc.downloadUrl || (doc as any).contentBuffer) {
            const res = await uploadDocument(provider, `${basePath}/Commitments/Subcontracts`, doc, progress);
            if (res.success) filesUploaded++;
            else errors.push(res.error!);
          }
        }
      }
      if (hasPOs) {
        await provider.createFolder(`${basePath}/Commitments/Purchase Orders`);
        if (docs.commitmentsData?.purchaseOrders?.length) {
          try {
            const { generatePurchaseOrdersPdf } = await import('./archive-pdf-generator');
            const pdfBuffer = await generatePurchaseOrdersPdf(docs.commitmentsData.purchaseOrders, docs.projectName);
            await uploadDocumentWithRetry(provider, `${basePath}/Commitments/Purchase Orders`, 'purchase_orders_report.pdf', pdfBuffer, 'application/pdf');
            filesUploaded++;
          } catch (e: any) {
            console.warn(`[Archive] PDF generation failed for purchase orders, falling back to JSON: ${e.message}`);
            try {
              const json = JSON.stringify(docs.commitmentsData.purchaseOrders, null, 2);
              await uploadDocumentWithRetry(provider, `${basePath}/Commitments/Purchase Orders`, 'purchase_orders_data.json', Buffer.from(json), 'application/json');
              filesUploaded++;
            } catch (e2: any) {
              errors.push(`Purchase orders JSON: ${e2.message}`);
            }
          }
        }
        for (const doc of docs.commitments.purchaseOrders) {
          if (doc.downloadUrl || (doc as any).contentBuffer) {
            const res = await uploadDocument(provider, `${basePath}/Commitments/Purchase Orders`, doc, progress);
            if (res.success) filesUploaded++;
            else errors.push(res.error!);
          }
        }
      }
    }

    if (options.includeChangeOrders && (docs.changeOrdersData?.length > 0 || docs.changeOrders.length > 0)) {
      progress.currentStep = 'Uploading change orders...';
      await provider.createFolder(`${basePath}/Change Orders`);
      if (docs.changeOrdersData?.length) {
        try {
          const { generateChangeOrdersPdf } = await import('./archive-pdf-generator');
          const pdfBuffer = await generateChangeOrdersPdf(docs.changeOrdersData, docs.projectName);
          await uploadDocumentWithRetry(provider, `${basePath}/Change Orders`, 'change_orders_report.pdf', pdfBuffer, 'application/pdf');
          filesUploaded++;
        } catch (e: any) {
          console.warn(`[Archive] PDF generation failed for change orders, falling back to JSON: ${e.message}`);
          try {
            const json = JSON.stringify(docs.changeOrdersData, null, 2);
            await uploadDocumentWithRetry(provider, `${basePath}/Change Orders`, 'change_orders_data.json', Buffer.from(json), 'application/json');
            filesUploaded++;
          } catch (e2: any) {
            errors.push(`Change orders JSON: ${e2.message}`);
          }
        }
      }
      for (const doc of docs.changeOrders) {
        if (doc.downloadUrl || (doc as any).contentBuffer) {
          const res = await uploadDocument(provider, `${basePath}/Change Orders`, doc, progress);
          if (res.success) filesUploaded++;
          else errors.push(res.error!);
        }
      }
    }
    if (options.includeChangeEvents && (docs.changeEventsData?.length > 0 || docs.changeEvents.length > 0)) {
      progress.currentStep = 'Uploading change events...';
      await provider.createFolder(`${basePath}/Change Events`);
      if (docs.changeEventsData?.length) {
        try {
          const { generateChangeEventsPdf } = await import('./archive-pdf-generator');
          const pdfBuffer = await generateChangeEventsPdf(docs.changeEventsData, docs.projectName);
          await uploadDocumentWithRetry(provider, `${basePath}/Change Events`, 'change_events_report.pdf', pdfBuffer, 'application/pdf');
          filesUploaded++;
        } catch (e: any) {
          console.warn(`[Archive] PDF generation failed for change events, falling back to JSON: ${e.message}`);
          try {
            const json = JSON.stringify(docs.changeEventsData, null, 2);
            await uploadDocumentWithRetry(provider, `${basePath}/Change Events`, 'change_events_data.json', Buffer.from(json), 'application/json');
            filesUploaded++;
          } catch (e2: any) {
            errors.push(`Change events JSON: ${e2.message}`);
          }
        }
      }
      for (const doc of docs.changeEvents) {
        if (doc.downloadUrl || (doc as any).contentBuffer) {
          const res = await uploadDocument(provider, `${basePath}/Change Events`, doc, progress);
          if (res.success) filesUploaded++;
          else errors.push(res.error!);
        }
      }
    }
    if (options.includeDirectCosts && (docs.directCostsData?.length > 0 || docs.directCosts.length > 0)) {
      progress.currentStep = 'Uploading direct costs...';
      await provider.createFolder(`${basePath}/Direct Costs`);
      if (docs.directCostsData?.length) {
        try {
          const { generateDirectCostsPdf } = await import('./archive-pdf-generator');
          const pdfBuffer = await generateDirectCostsPdf(docs.directCostsData, docs.projectName);
          await uploadDocumentWithRetry(provider, `${basePath}/Direct Costs`, 'direct_costs_report.pdf', pdfBuffer, 'application/pdf');
          filesUploaded++;
        } catch (e: any) {
          console.warn(`[Archive] PDF generation failed for direct costs, falling back to JSON: ${e.message}`);
          try {
            const json = JSON.stringify(docs.directCostsData, null, 2);
            await uploadDocumentWithRetry(provider, `${basePath}/Direct Costs`, 'direct_costs_data.json', Buffer.from(json), 'application/json');
            filesUploaded++;
          } catch (e2: any) {
            errors.push(`Direct costs JSON: ${e2.message}`);
          }
        }
      }
      for (const doc of docs.directCosts) {
        if (doc.downloadUrl || (doc as any).contentBuffer) {
          const res = await uploadDocument(provider, `${basePath}/Direct Costs`, doc, progress);
          if (res.success) filesUploaded++;
          else errors.push(res.error!);
        }
      }
    }
    if (options.includeInvoicing && (docs.invoicingData?.length > 0 || docs.invoicing.length > 0)) {
      progress.currentStep = 'Uploading invoicing...';
      await provider.createFolder(`${basePath}/Invoicing`);
      if (docs.invoicingData?.length) {
        try {
          const { generateInvoicingPdf } = await import('./archive-pdf-generator');
          const pdfBuffer = await generateInvoicingPdf(docs.invoicingData, docs.projectName);
          await uploadDocumentWithRetry(provider, `${basePath}/Invoicing`, 'invoicing_report.pdf', pdfBuffer, 'application/pdf');
          filesUploaded++;
        } catch (e: any) {
          console.warn(`[Archive] PDF generation failed for invoicing, falling back to JSON: ${e.message}`);
          try {
            const json = JSON.stringify(docs.invoicingData, null, 2);
            await uploadDocumentWithRetry(provider, `${basePath}/Invoicing`, 'requisitions_data.json', Buffer.from(json), 'application/json');
            filesUploaded++;
          } catch (e2: any) {
            errors.push(`Invoicing JSON: ${e2.message}`);
          }
        }
      }
      for (const doc of docs.invoicing) {
        if (doc.downloadUrl || (doc as any).contentBuffer) {
          const res = await uploadDocument(provider, `${basePath}/Invoicing`, doc, progress);
          if (res.success) filesUploaded++;
          else errors.push(res.error!);
        }
      }
    }

    if (options.includeDirectory && docs.directory.length > 0) {
      progress.currentStep = 'Exporting directory...';
      await provider.createFolder(`${basePath}/Directory`);
      try {
        const { generateDirectoryPdf } = await import('./archive-pdf-generator');
        const pdfBuffer = await generateDirectoryPdf(docs.directory, docs.projectName);
        await uploadDocumentWithRetry(provider, `${basePath}/Directory`, 'directory_report.pdf', pdfBuffer, 'application/pdf');
        filesUploaded++;
      } catch (e: any) {
        console.warn(`[Archive] PDF generation failed for directory, falling back to JSON: ${e.message}`);
        try {
          const json = JSON.stringify(docs.directory, null, 2);
          await uploadDocumentWithRetry(provider, `${basePath}/Directory`, 'directory.json', Buffer.from(json), 'application/json');
          filesUploaded++;
        } catch (e2: any) {
          errors.push(`Directory export: ${e2.message}`);
        }
      }
    }

    if (options.includeEstimating && docs.estimating.length > 0) {
      progress.currentStep = 'Exporting estimating data...';
      await provider.createFolder(`${basePath}/Estimating`);
      try {
        const { generateEstimatingPdf } = await import('./archive-pdf-generator');
        const pdfBuffer = await generateEstimatingPdf(docs.estimating, docs.projectName);
        await uploadDocumentWithRetry(provider, `${basePath}/Estimating`, 'estimating_report.pdf', pdfBuffer, 'application/pdf');
        filesUploaded++;
      } catch (e: any) {
        console.warn(`[Archive] PDF generation failed for estimating, falling back to JSON: ${e.message}`);
        try {
          const json = JSON.stringify(docs.estimating, null, 2);
          await uploadDocumentWithRetry(provider, `${basePath}/Estimating`, 'estimating.json', Buffer.from(json), 'application/json');
          filesUploaded++;
        } catch (e2: any) {
          errors.push(`Estimating export: ${e2.message}`);
        }
      }
    }

    if (options.includeObservations && (docs.observationsData?.length > 0 || docs.observations?.length > 0)) {
      progress.currentStep = 'Uploading observations...';
      await provider.createFolder(`${basePath}/Observations`);
      if (docs.observationsData?.length > 0) {
        try {
          const { generateObservationsPdf } = await import('./archive-pdf-generator');
          const pdfBuffer = await generateObservationsPdf(docs.observationsData, docs.projectName);
          await uploadDocumentWithRetry(provider, `${basePath}/Observations`, 'observations_report.pdf', pdfBuffer, 'application/pdf');
          filesUploaded++;
        } catch (e: any) {
          console.warn(`[Archive] PDF generation failed for observations, falling back to JSON: ${e.message}`);
          try {
            const json = JSON.stringify(docs.observationsData, null, 2);
            await uploadDocumentWithRetry(provider, `${basePath}/Observations`, 'observations_data.json', Buffer.from(json), 'application/json');
            filesUploaded++;
          } catch (e2: any) {
            errors.push(`Observations export: ${e2.message}`);
          }
        }
      }
      for (const d of docs.observations || []) {
        if (!d.url && !d.downloadUrl) continue;
        const res = await uploadDocument(provider, `${basePath}/Observations`, d, progress);
        if (res.success) filesUploaded++;
        else errors.push(res.error!);
      }
    }

    if (options.includeActionPlans && (docs.actionPlansData?.length > 0 || docs.actionPlans?.length > 0)) {
      progress.currentStep = 'Uploading action plans...';
      await provider.createFolder(`${basePath}/Action Plans`);
      if (docs.actionPlansData?.length > 0) {
        try {
          const { generateActionPlansPdf } = await import('./archive-pdf-generator');
          const pdfBuffer = await generateActionPlansPdf(docs.actionPlansData, docs.projectName);
          await uploadDocumentWithRetry(provider, `${basePath}/Action Plans`, 'action_plans_report.pdf', pdfBuffer, 'application/pdf');
          filesUploaded++;
        } catch (e: any) {
          console.warn(`[Archive] PDF generation failed for action plans, falling back to JSON: ${e.message}`);
          try {
            const json = JSON.stringify(docs.actionPlansData, null, 2);
            await uploadDocumentWithRetry(provider, `${basePath}/Action Plans`, 'action_plans_data.json', Buffer.from(json), 'application/json');
            filesUploaded++;
          } catch (e2: any) {
            errors.push(`Action plans export: ${e2.message}`);
          }
        }
      }
      for (const d of docs.actionPlans || []) {
        if (!d.url && !d.downloadUrl) continue;
        const res = await uploadDocument(provider, `${basePath}/Action Plans`, d, progress);
        if (res.success) filesUploaded++;
        else errors.push(res.error!);
      }
    }

    if (options.includeWeatherLogs && docs.weatherLogsData?.length > 0) {
      progress.currentStep = 'Uploading weather logs...';
      await provider.createFolder(`${basePath}/Weather Logs`);
      try {
        const { generateWeatherLogsPdf } = await import('./archive-pdf-generator');
        const pdfBuffer = await generateWeatherLogsPdf(docs.weatherLogsData, docs.projectName);
        await uploadDocumentWithRetry(provider, `${basePath}/Weather Logs`, 'weather_logs_report.pdf', pdfBuffer, 'application/pdf');
        filesUploaded++;
      } catch (e: any) {
        console.warn(`[Archive] PDF generation failed for weather logs, falling back to JSON: ${e.message}`);
        try {
          const json = JSON.stringify(docs.weatherLogsData, null, 2);
          await uploadDocumentWithRetry(provider, `${basePath}/Weather Logs`, 'weather_logs_data.json', Buffer.from(json), 'application/json');
          filesUploaded++;
        } catch (e2: any) {
          errors.push(`Weather logs export: ${e2.message}`);
        }
      }
    }

    if (options.includeSafetyViolations && docs.safetyViolationsData?.length > 0) {
      progress.currentStep = 'Uploading safety violations...';
      await provider.createFolder(`${basePath}/Safety Violations`);
      try {
        const { generateSafetyViolationsPdf } = await import('./archive-pdf-generator');
        const pdfBuffer = await generateSafetyViolationsPdf(docs.safetyViolationsData, docs.projectName);
        await uploadDocumentWithRetry(provider, `${basePath}/Safety Violations`, 'safety_violations_report.pdf', pdfBuffer, 'application/pdf');
        filesUploaded++;
      } catch (e: any) {
        console.warn(`[Archive] PDF generation failed for safety violations, falling back to JSON: ${e.message}`);
        try {
          const json = JSON.stringify(docs.safetyViolationsData, null, 2);
          await uploadDocumentWithRetry(provider, `${basePath}/Safety Violations`, 'safety_violations_data.json', Buffer.from(json), 'application/json');
          filesUploaded++;
        } catch (e2: any) {
          errors.push(`Safety violations export: ${e2.message}`);
        }
      }
    }

    if (options.includeAccidentLogs && docs.accidentLogsData?.length > 0) {
      progress.currentStep = 'Uploading accident logs...';
      await provider.createFolder(`${basePath}/Accident Logs`);
      try {
        const { generateAccidentLogsPdf } = await import('./archive-pdf-generator');
        const pdfBuffer = await generateAccidentLogsPdf(docs.accidentLogsData, docs.projectName);
        await uploadDocumentWithRetry(provider, `${basePath}/Accident Logs`, 'accident_logs_report.pdf', pdfBuffer, 'application/pdf');
        filesUploaded++;
      } catch (e: any) {
        console.warn(`[Archive] PDF generation failed for accident logs, falling back to JSON: ${e.message}`);
        try {
          const json = JSON.stringify(docs.accidentLogsData, null, 2);
          await uploadDocumentWithRetry(provider, `${basePath}/Accident Logs`, 'accident_logs_data.json', Buffer.from(json), 'application/json');
          filesUploaded++;
        } catch (e2: any) {
          errors.push(`Accident logs export: ${e2.message}`);
        }
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
        emails: docs.emails.length,
        incidents: docs.incidents.length,
        punchList: docs.punchList.length,
        meetings: docs.meetings.length,
        schedule: docs.schedule.length,
        dailyLogs: docs.dailyLogs.attachments.length + docs.dailyLogs.items.length,
        specifications: docs.specifications.length,
        primeContracts: docs.primeContracts.length,
        commitments: docs.commitments.subcontracts.length + docs.commitments.purchaseOrders.length,
        changeOrders: docs.changeOrders.length,
        changeEvents: docs.changeEvents.length,
        directCosts: docs.directCosts.length,
        invoicing: docs.invoicing.length,
        directory: docs.directory.length,
        estimating: docs.estimating.length,
      },
      filesUploaded,
      errors: errors.length,
    };

    try {
      const { generateArchiveCoverSheetPdf } = await import('./archive-pdf-generator');
      const coverBuffer = await generateArchiveCoverSheetPdf(summary, baseFolder.webUrl);
      await uploadDocumentWithRetry(
        provider,
        basePath,
        '00_Archive_Cover_Sheet.pdf',
        coverBuffer,
        'application/pdf'
      );
    } catch (coverErr: any) {
      console.warn(`[Archive] Cover sheet PDF failed, falling back to JSON: ${coverErr.message}`);
      const summaryJson = JSON.stringify(summary, null, 2);
      await uploadDocumentWithRetry(
        provider,
        basePath,
        '_archive_summary.json',
        Buffer.from(summaryJson, 'utf-8'),
        'application/json'
      );
    }

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

    let fileBuffer: Buffer | null = (doc as any).contentBuffer ?? null;
    if (!fileBuffer && doc.downloadUrl) {
      fileBuffer = await downloadProcoreFile(doc.downloadUrl);
    }
    if (!fileBuffer) {
      return { success: false, error: `${doc.name}: No content (missing downloadUrl or contentBuffer)` };
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
