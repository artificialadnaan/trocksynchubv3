import { getProcoreClient, getCompanyId } from './procore';
import { storage } from './storage';

/** Small delay between Procore API calls to stay under 3,600 req/hour (avoid bursting) */
const RATE_LIMIT_DELAY_MS = 150;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DocumentInfo {
  id: string;
  name: string;
  type: 'document' | 'drawing' | 'submittal' | 'rfi' | 'bid_package' | 'photo' | 'budget';
  url?: string;
  downloadUrl?: string;
  size?: number;
  mimeType?: string;
  createdAt?: string;
  updatedAt?: string;
  metadata?: any;
}

interface FolderInfo {
  id: string;
  name: string;
  path: string;
  files: DocumentInfo[];
  subfolders: FolderInfo[];
}

interface ProjectDocuments {
  projectId: string;
  projectName: string;
  folders: FolderInfo[];
  drawings: DocumentInfo[];
  submittals: DocumentInfo[];
  rfis: DocumentInfo[];
  bidPackages: DocumentInfo[];
  photos: DocumentInfo[];
  budget: {
    lineItems: any[];
    summary: any;
  };
  extractedAt: string;
}

export async function extractProjectDocuments(projectId: string): Promise<ProjectDocuments> {
  const client = await getProcoreClient();
  const companyId = await getCompanyId();

  console.log(`[ProcoreDocs] Extracting documents for project ${projectId}`);

  // Get project info
  const projectResponse = await client.get(`/rest/v1.0/projects/${projectId}`, {
    params: { company_id: companyId },
  });
  const projectName = projectResponse.data.name;

  // Extract all document types in parallel
  const [folders, drawings, submittals, rfis, bidPackages, photos, budget] = await Promise.all([
    extractFolders(client, companyId, projectId),
    extractDrawings(client, companyId, projectId),
    extractSubmittals(client, companyId, projectId),
    extractRFIs(client, companyId, projectId),
    extractBidPackages(client, companyId, projectId),
    extractPhotos(client, companyId, projectId),
    extractBudget(client, companyId, projectId),
  ]);

  const result: ProjectDocuments = {
    projectId,
    projectName,
    folders,
    drawings,
    submittals,
    rfis,
    bidPackages,
    photos,
    budget,
    extractedAt: new Date().toISOString(),
  };

  console.log(`[ProcoreDocs] Extracted: ${folders.length} folders, ${drawings.length} drawings, ${submittals.length} submittals, ${rfis.length} RFIs, ${bidPackages.length} bid packages, ${photos.length} photos`);

  return result;
}

async function extractFolders(client: any, companyId: string, projectId: string): Promise<FolderInfo[]> {
  try {
    const response = await client.get(`/rest/v1.0/folders`, {
      params: { project_id: projectId },
    });

    // Procore returns { folders: [...] } or sometimes array directly
    const raw = response.data;
    const folderList = Array.isArray(raw) ? raw : (raw?.folders ?? []);

    const folders: FolderInfo[] = [];
    for (const folder of folderList) {
      const folderInfo = await extractFolderRecursive(client, companyId, projectId, folder, '');
      folders.push(folderInfo);
      await delay(RATE_LIMIT_DELAY_MS);
    }
    return folders;
  } catch (e: any) {
    console.log(`[ProcoreDocs] Could not extract folders: ${e.message}`);
    return [];
  }
}

async function extractFolderRecursive(client: any, companyId: string, projectId: string, folder: any, parentPath: string = ''): Promise<FolderInfo> {
  // Procore root/list returns folder stubs with files: [] even when has_children_files. Fetch full folder when needed.
  const isStub =
    (folder.has_children_files === true || folder.has_children_folders === true) &&
    (folder.files?.length ?? 0) === 0 &&
    (folder.folders?.length ?? 0) === 0;
  if (isStub && folder.id) {
    await delay(RATE_LIMIT_DELAY_MS);
    try {
      const full = await client.get(`/rest/v1.0/folders/${folder.id}`, {
        params: { project_id: projectId },
      });
      folder = full.data;
    } catch (e: any) {
      console.log(`[ProcoreDocs] Could not fetch folder ${folder.id}: ${e.message}`);
    }
  }

  const currentPath = parentPath ? `${parentPath}/${folder.name}` : folder.name;

  const files: DocumentInfo[] = (folder.files || []).map((file: any) => {
    const url = file.url ?? file.file_versions?.[0]?.url;
    return {
    id: String(file.id),
    name: file.name ?? file.filename ?? file.file_name,
    type: 'document' as const,
    url,
    downloadUrl: url,
    size: file.size ?? file.file_versions?.[0]?.file_size,
    mimeType: file.content_type ?? file.mime_type ?? file.file_versions?.[0]?.content_type,
    createdAt: file.created_at,
    updatedAt: file.updated_at,
    metadata: { versionCount: file.file_versions?.length || 0 },
  };
  });

  const subfolders: FolderInfo[] = [];
  if (folder.folders && folder.folders.length > 0) {
    for (const subfolder of folder.folders) {
      await delay(RATE_LIMIT_DELAY_MS);
      try {
        // Fetch full subfolder details (or extractFolderRecursive will fetch if stub)
        const subfolderInfo = await extractFolderRecursive(client, companyId, projectId, subfolder, currentPath);
        subfolders.push(subfolderInfo);
      } catch (e) {
        // Add basic info if can't fetch details
        subfolders.push({
          id: String(subfolder.id),
          name: subfolder.name,
          path: `${currentPath}/${subfolder.name}`,
          files: [],
          subfolders: [],
        });
      }
    }
  }

  return {
    id: String(folder.id),
    name: folder.name,
    path: currentPath,
    files,
    subfolders,
  };
}

async function extractDrawings(client: any, companyId: string, projectId: string): Promise<DocumentInfo[]> {
  try {
    const response = await client.get(`/rest/v1.0/drawings`, {
      params: { project_id: projectId },
    });

    return (response.data || []).map((drawing: any) => {
      const rev = drawing.current_revision;
      const pdfUrl = rev?.flattened_url ?? rev?.pdf_url ?? drawing.pdf_url ?? drawing.image_url;
      const imgUrl = drawing.image_url ?? rev?.image_url;
      const downloadUrl = pdfUrl || imgUrl;
      return {
      id: String(drawing.id),
      name: drawing.name ?? drawing.number ?? drawing.title,
      type: 'drawing' as const,
      url: imgUrl ?? downloadUrl,
      downloadUrl,
      createdAt: drawing.created_at,
      updatedAt: drawing.updated_at,
      metadata: {
        number: drawing.number,
        discipline: drawing.discipline,
        revision: drawing.current_revision,
        setId: drawing.drawing_set_id,
      },
    };
    });
  } catch (e: any) {
    console.log(`[ProcoreDocs] Could not extract drawings: ${e.message}`);
    return [];
  }
}

async function extractSubmittals(client: any, companyId: string, projectId: string): Promise<DocumentInfo[]> {
  try {
    const response = await client.get(`/rest/v1.0/projects/${projectId}/submittals`, {
      params: { company_id: companyId },
    });

    const submittals: DocumentInfo[] = [];
    for (const submittal of response.data || []) {
      // Get submittal attachments
      const attachments = submittal.attachments || [];
      for (const attachment of attachments) {
        const url = attachment.url ?? attachment.download_url;
        submittals.push({
          id: String(attachment.id || submittal.id),
          name: attachment.name ?? attachment.filename ?? `${submittal.title || submittal.number}.pdf`,
          type: 'submittal',
          url,
          downloadUrl: url,
          size: attachment.file_size ?? attachment.size,
          createdAt: submittal.created_at,
          metadata: {
            submittalId: submittal.id,
            submittalNumber: submittal.number,
            submittalTitle: submittal.title,
            status: submittal.status?.name,
            specSection: submittal.specification_section?.number,
          },
        });
      }

      // If no attachments, add placeholder entry
      if (attachments.length === 0) {
        submittals.push({
          id: String(submittal.id),
          name: `${submittal.title || submittal.number || 'Submittal'}`,
          type: 'submittal',
          createdAt: submittal.created_at,
          metadata: {
            submittalId: submittal.id,
            submittalNumber: submittal.number,
            submittalTitle: submittal.title,
            status: submittal.status?.name,
            hasAttachments: false,
          },
        });
      }
    }
    return submittals;
  } catch (e: any) {
    console.log(`[ProcoreDocs] Could not extract submittals: ${e.message}`);
    return [];
  }
}

async function extractRFIs(client: any, companyId: string, projectId: string): Promise<DocumentInfo[]> {
  try {
    const response = await client.get(`/rest/v1.0/projects/${projectId}/rfis`, {
      params: { company_id: companyId },
    });

    const rfis: DocumentInfo[] = [];
    for (const rfi of response.data || []) {
      const attachments = rfi.attachments || [];
      for (const attachment of attachments) {
        const url = attachment.url ?? attachment.download_url;
        rfis.push({
          id: String(attachment.id || rfi.id),
          name: attachment.name ?? attachment.filename ?? `RFI-${rfi.number}.pdf`,
          type: 'rfi',
          url,
          downloadUrl: url,
          size: attachment.file_size ?? attachment.size,
          createdAt: rfi.created_at,
          metadata: {
            rfiId: rfi.id,
            rfiNumber: rfi.number,
            subject: rfi.subject,
            status: rfi.status,
          },
        });
      }

      // If no attachments, add placeholder
      if (attachments.length === 0) {
        rfis.push({
          id: String(rfi.id),
          name: `RFI-${rfi.number}: ${rfi.subject || 'Untitled'}`,
          type: 'rfi',
          createdAt: rfi.created_at,
          metadata: {
            rfiId: rfi.id,
            rfiNumber: rfi.number,
            subject: rfi.subject,
            status: rfi.status,
            hasAttachments: false,
          },
        });
      }
    }
    return rfis;
  } catch (e: any) {
    console.log(`[ProcoreDocs] Could not extract RFIs: ${e.message}`);
    return [];
  }
}

async function extractBidPackages(client: any, companyId: string, projectId: string): Promise<DocumentInfo[]> {
  try {
    // Try the newer endpoint first
    let response;
    try {
      response = await client.get(`/rest/v1.1/projects/${projectId}/bid_packages`, {
        params: { company_id: companyId },
      });
    } catch {
      // Fall back to older endpoint
      response = await client.get(`/rest/v1.0/projects/${projectId}/bids`, {
        params: { company_id: companyId },
      });
    }

    const bidPackages: DocumentInfo[] = [];
    for (const bp of response.data || []) {
      // Get bid package documents
      try {
        const docsResponse = await client.get(`/rest/v1.0/projects/${projectId}/bid_packages/${bp.id}/documents`, {
          params: { company_id: companyId },
        });

        for (const doc of docsResponse.data || []) {
          const url = doc.url ?? doc.download_url;
          bidPackages.push({
            id: String(doc.id),
            name: doc.name ?? doc.filename ?? doc.file_name,
            type: 'bid_package',
            url,
            downloadUrl: url,
            size: doc.file_size ?? doc.size,
            createdAt: bp.created_at,
            metadata: {
              bidPackageId: bp.id,
              bidPackageName: bp.name,
              status: bp.status,
            },
          });
        }
      } catch {
        // Add basic bid package info if can't get documents
        bidPackages.push({
          id: String(bp.id),
          name: bp.name || `Bid Package ${bp.id}`,
          type: 'bid_package',
          createdAt: bp.created_at,
          metadata: {
            bidPackageId: bp.id,
            status: bp.status,
            hasDocuments: false,
          },
        });
      }
    }
    return bidPackages;
  } catch (e: any) {
    console.log(`[ProcoreDocs] Could not extract bid packages: ${e.message}`);
    return [];
  }
}

async function extractPhotos(client: any, companyId: string, projectId: string): Promise<DocumentInfo[]> {
  try {
    const response = await client.get(`/rest/v1.0/projects/${projectId}/images`, {
      params: { company_id: companyId, per_page: 500 },
    });

    return (response.data || []).map((photo: any) => {
      const url = photo.full_url ?? photo.image_url ?? photo.url;
      return {
      id: String(photo.id),
      name: photo.title ?? photo.name ?? photo.filename ?? `Photo_${photo.id}.jpg`,
      type: 'photo' as const,
      url,
      downloadUrl: url,
      createdAt: photo.created_at,
      metadata: {
        categoryId: photo.image_category_id,
        location: photo.location,
        description: photo.description,
      },
    };
    });
  } catch (e: any) {
    console.log(`[ProcoreDocs] Could not extract photos: ${e.message}`);
    return [];
  }
}

async function extractBudget(client: any, companyId: string, projectId: string): Promise<{ lineItems: any[]; summary: any }> {
  try {
    const [lineItemsResponse, summaryResponse] = await Promise.all([
      client.get(`/rest/v1.0/projects/${projectId}/budget/line_items`, {
        params: { company_id: companyId },
      }).catch(() => ({ data: [] })),
      client.get(`/rest/v1.0/projects/${projectId}/budget`, {
        params: { company_id: companyId },
      }).catch(() => ({ data: null })),
    ]);

    return {
      lineItems: lineItemsResponse.data || [],
      summary: summaryResponse.data,
    };
  } catch (e: any) {
    console.log(`[ProcoreDocs] Could not extract budget: ${e.message}`);
    return { lineItems: [], summary: null };
  }
}

export async function downloadProcoreFile(url: string): Promise<Buffer | null> {
  try {
    const client = await getProcoreClient();
    const response = await client.get(url, {
      responseType: 'arraybuffer',
    });
    return Buffer.from(response.data);
  } catch (e: any) {
    console.error(`[ProcoreDocs] Failed to download file from ${url}: ${e.message}`);
    return null;
  }
}

export async function getProjectsList(): Promise<Array<{ id: string; name: string; status: string; stage?: string }>> {
  try {
    const client = await getProcoreClient();
    const companyId = await getCompanyId();

    const response = await client.get(`/rest/v1.0/projects`, {
      params: { company_id: companyId },
    });

    return (response.data || []).map((p: any) => ({
      id: String(p.id),
      name: p.name,
      status: p.active ? 'active' : 'inactive',
      stage: p.stage?.name ?? p.project_stage?.name ?? (typeof p.stage === 'string' ? p.stage : undefined),
    }));
  } catch (e: any) {
    console.error(`[ProcoreDocs] Failed to get projects list: ${e.message}`);
    return [];
  }
}

// Get document counts summary for a project (fast check without downloading)
export async function getProjectDocumentSummary(projectId: string): Promise<{
  folders: number;
  drawings: number;
  submittals: number;
  rfis: number;
  bidPackages: number;
  photos: number;
  hasBudget: boolean;
}> {
  const client = await getProcoreClient();
  const companyId = await getCompanyId();

  const counts = {
    folders: 0,
    drawings: 0,
    submittals: 0,
    rfis: 0,
    bidPackages: 0,
    photos: 0,
    hasBudget: false,
  };

  try {
    const [foldersRes, drawingsRes, submittalsRes, rfisRes, photosRes, budgetRes] = await Promise.all([
      client.get(`/rest/v1.0/folders`, { params: { project_id: projectId } }).catch(() => ({ data: [] })),
      client.get(`/rest/v1.0/drawings`, { params: { project_id: projectId } }).catch(() => ({ data: [] })),
      client.get(`/rest/v1.0/projects/${projectId}/submittals`, { params: { company_id: companyId } }).catch(() => ({ data: [] })),
      client.get(`/rest/v1.0/projects/${projectId}/rfis`, { params: { company_id: companyId } }).catch(() => ({ data: [] })),
      client.get(`/rest/v1.0/projects/${projectId}/images`, { params: { company_id: companyId, per_page: 1 } }).catch(() => ({ data: [], headers: {} })),
      client.get(`/rest/v1.0/projects/${projectId}/budget`, { params: { company_id: companyId } }).catch(() => ({ data: null })),
    ]);

    const rawFolders = foldersRes.data;
    counts.folders = Array.isArray(rawFolders) ? rawFolders.length : (rawFolders?.folders?.length ?? 0);
    counts.drawings = drawingsRes.data?.length || 0;
    counts.submittals = submittalsRes.data?.length || 0;
    counts.rfis = rfisRes.data?.length || 0;
    counts.photos = photosRes.data?.length || 0;
    counts.hasBudget = !!budgetRes.data;
  } catch (e: any) {
    console.log(`[ProcoreDocs] Error getting document summary: ${e.message}`);
  }

  return counts;
}
