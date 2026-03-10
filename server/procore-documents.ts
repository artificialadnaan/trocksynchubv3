import { getProcoreClient, getCompanyId } from './procore';
import { storage } from './storage';

/** Small delay between Procore API calls to stay under 3,600 req/hour (avoid bursting) */
const RATE_LIMIT_DELAY_MS = 150;
const PER_PAGE = 100;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Build full URL string for error logging */
function buildProcoreUrl(path: string, params: Record<string, any>): string {
  const merged = { ...params, per_page: params.per_page ?? PER_PAGE, page: params.page ?? 1 };
  const qs = new URLSearchParams(
    Object.fromEntries(
      Object.entries(merged).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])
    )
  ).toString();
  return `GET ${path}${qs ? '?' + qs : ''}`;
}

/** Paginate through a Procore list endpoint until empty response */
async function paginateAll<T>(
  client: any,
  url: string,
  params: Record<string, any>,
  extractList: (data: any) => T[] = (d) => d ?? []
): Promise<T[]> {
  const all: T[] = [];
  let page = 1;
  for (;;) {
    const res = await client.get(url, {
      params: { ...params, page, per_page: PER_PAGE },
    });
    const items = Array.isArray(res.data) ? res.data : extractList(res.data);
    if (!items?.length) break;
    all.push(...items);
    if (items.length < PER_PAGE) break;
    page++;
    await delay(RATE_LIMIT_DELAY_MS);
  }
  return all;
}

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
  imageCategories: any[];
  budget: { lineItems: any[]; summary: any };
  // Project Management
  emails: DocumentInfo[];
  incidents: DocumentInfo[];
  punchList: DocumentInfo[];
  meetings: DocumentInfo[];
  schedule: DocumentInfo[];
  dailyLogs: { items: any[]; attachments: DocumentInfo[] };
  specifications: DocumentInfo[];
  // Financial (items = attachments + PDF exports; *Data = raw API for JSON export)
  primeContracts: DocumentInfo[];
  primeContractsData: any[];
  commitments: {
    subcontracts: DocumentInfo[];
    purchaseOrders: DocumentInfo[];
  };
  commitmentsData: { subcontracts: any[]; purchaseOrders: any[] };
  changeOrders: DocumentInfo[];
  changeOrdersData: any[];
  changeEvents: DocumentInfo[];
  changeEventsData: any[];
  directCosts: DocumentInfo[];
  directCostsData: any[];
  invoicing: DocumentInfo[];
  invoicingData: any[];
  // Core / Preconstruction
  directory: any[];
  estimating: any[];
  extractedAt: string;
  extractionErrors?: Record<string, string>;
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

  const extractionErrors: Record<string, string> = {};
  const opts = { errors: extractionErrors };

  // Extract all document types in parallel
  const [
    folders,
    drawings,
    submittals,
    rfis,
    bidPackages,
    photosResult,
    budget,
    emails,
    incidents,
    punchList,
    meetings,
    schedule,
    dailyLogs,
    specifications,
    primeResult,
    commitmentsResult,
    changeOrdersResult,
    changeEventsResult,
    directCostsResult,
    invoicingResult,
    directory,
    estimating,
  ] = await Promise.all([
    extractFolders(client, companyId, projectId, opts),
    extractDrawings(client, companyId, projectId, opts),
    extractSubmittals(client, companyId, projectId, opts),
    extractRFIs(client, companyId, projectId, opts),
    extractBidPackages(client, companyId, projectId, opts),
    extractPhotos(client, companyId, projectId, opts),
    extractBudget(client, companyId, projectId, opts),
    extractEmails(client, companyId, projectId, opts),
    extractIncidents(client, companyId, projectId, opts),
    extractPunchList(client, companyId, projectId, opts),
    extractMeetings(client, companyId, projectId, opts),
    extractSchedule(client, companyId, projectId, opts),
    extractDailyLogs(client, companyId, projectId, opts),
    extractSpecifications(client, companyId, projectId, opts),
    extractPrimeContracts(client, companyId, projectId, opts),
    extractCommitments(client, companyId, projectId, opts),
    extractChangeOrders(client, companyId, projectId, opts),
    extractChangeEvents(client, companyId, projectId, opts),
    extractDirectCosts(client, companyId, projectId, opts),
    extractInvoicing(client, companyId, projectId, opts),
    extractDirectory(client, companyId, projectId, opts),
    extractEstimating(client, companyId, projectId, opts),
  ]);

  const photos = photosResult.photos;
  const imageCategories = photosResult.imageCategories;

  const result: ProjectDocuments = {
    projectId,
    projectName,
    folders,
    drawings,
    submittals,
    rfis,
    bidPackages,
    photos,
    imageCategories,
    budget,
    emails,
    incidents,
    punchList,
    meetings,
    schedule,
    dailyLogs,
    specifications,
    primeContracts: primeResult.items,
    primeContractsData: primeResult.rawData,
    commitments: commitmentsResult.commitments,
    commitmentsData: commitmentsResult.data,
    changeOrders: changeOrdersResult.items,
    changeOrdersData: changeOrdersResult.rawData,
    changeEvents: changeEventsResult.items,
    changeEventsData: changeEventsResult.rawData,
    directCosts: directCostsResult.items,
    directCostsData: directCostsResult.rawData,
    invoicing: invoicingResult.items,
    invoicingData: invoicingResult.rawData,
    directory,
    estimating,
    extractedAt: new Date().toISOString(),
    extractionErrors: Object.keys(extractionErrors).length ? extractionErrors : undefined,
  };

  console.log(
    `[ProcoreDocs] Extracted: ${folders.length} folders, ${drawings.length} drawings, ${submittals.length} submittals, ` +
      `${rfis.length} RFIs, ${bidPackages.length} bid packages, ${photos.length} photos, ` +
      `${emails.length} emails, ${incidents.length} incidents, ${punchList.length} punch, ${meetings.length} meetings`
  );

  return result;
}

type ExtractOpts = { errors?: Record<string, string> };

async function extractFolders(client: any, companyId: string, projectId: string, opts?: ExtractOpts): Promise<FolderInfo[]> {
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
    const msg = e?.message ?? String(e);
    console.log(`[ProcoreDocs] Could not extract folders: ${msg}`);
    opts?.errors && (opts.errors['folders'] = msg);
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

async function extractDrawings(client: any, companyId: string, projectId: string, opts?: ExtractOpts): Promise<DocumentInfo[]> {
  const path = `/rest/v1.1/projects/${projectId}/drawing_areas`;
  const params = { company_id: companyId };
  try {
    const areas = await paginateAll<any>(
      client,
      path,
      params,
      (d) => (Array.isArray(d) ? d : d?.drawing_areas ?? [])
    );
    const out: DocumentInfo[] = [];
    for (const area of areas) {
      await delay(RATE_LIMIT_DELAY_MS);
      try {
        const drawings = await paginateAll<any>(
          client,
          `/rest/v1.0/drawings`,
          { drawing_area_id: area.id, project_id: projectId, company_id: companyId },
          (d) => (Array.isArray(d) ? d : d?.drawings ?? [])
        );
        for (const drawing of drawings) {
          const rev = drawing.current_revision;
          const pdfUrl = rev?.flattened_url ?? rev?.pdf_url ?? drawing.pdf_url ?? drawing.image_url;
          const imgUrl = drawing.image_url ?? rev?.image_url;
          const downloadUrl = pdfUrl || imgUrl;
          out.push({
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
              areaId: area.id,
              areaName: area.name,
            },
          });
        }
      } catch (areaErr: any) {
        console.log(`[ProcoreDocs] Could not fetch drawings for area ${area.id}: ${areaErr?.message}`);
      }
    }
    return out;
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    const urlStr = buildProcoreUrl(path, params);
    console.log(`[ProcoreDocs] Could not extract drawings: ${msg}`);
    opts?.errors && (opts.errors['drawings'] = `${msg} (${urlStr})`);
    return [];
  }
}

async function extractSubmittals(client: any, companyId: string, projectId: string, opts?: ExtractOpts): Promise<DocumentInfo[]> {
  try {
    const list = await paginateAll<any>(
      client,
      `/rest/v1.0/projects/${projectId}/submittals`,
      { company_id: companyId }
    );

    const submittals: DocumentInfo[] = [];
    for (const submittal of list) {
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
    const msg = e?.message ?? String(e);
    console.log(`[ProcoreDocs] Could not extract submittals: ${msg}`);
    opts?.errors && (opts.errors['submittals'] = msg);
    return [];
  }
}

async function extractRFIs(client: any, companyId: string, projectId: string, opts?: ExtractOpts): Promise<DocumentInfo[]> {
  try {
    const list = await paginateAll<any>(
      client,
      `/rest/v1.0/projects/${projectId}/rfis`,
      { company_id: companyId }
    );

    const rfis: DocumentInfo[] = [];
    for (const rfi of list) {
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
    const msg = e?.message ?? String(e);
    console.log(`[ProcoreDocs] Could not extract RFIs: ${msg}`);
    opts?.errors && (opts.errors['rfis'] = msg);
    return [];
  }
}

async function extractBidPackages(client: any, companyId: string, projectId: string, opts?: ExtractOpts): Promise<DocumentInfo[]> {
  try {
    let data: any[] = [];
    try {
      data = await paginateAll<any>(client, `/rest/v1.0/bid_packages`, { project_id: projectId, company_id: companyId });
    } catch {
      data = await paginateAll<any>(client, `/rest/v1.0/bids`, { project_id: projectId, company_id: companyId });
    }

    const bidPackages: DocumentInfo[] = [];
    for (const bp of data) {
      try {
        const docsResponse = await client.get(`/rest/v1.0/bid_packages/${bp.id}/documents`, {
          params: { project_id: projectId, company_id: companyId },
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
    const msg = e?.message ?? String(e);
    console.log(`[ProcoreDocs] Could not extract bid packages: ${msg}`);
    opts?.errors && (opts.errors['bidPackages'] = msg);
    return [];
  }
}

async function extractPhotos(client: any, companyId: string, projectId: string, opts?: ExtractOpts): Promise<{ photos: DocumentInfo[]; imageCategories: any[] }> {
  try {
    // Procore Images API: GET /rest/v1.0/images?project_id={projectId}
    const photos = await paginateAll(
      client,
      '/rest/v1.0/images',
      { project_id: projectId, company_id: companyId },
      (d) => (Array.isArray(d) ? d : d?.images ?? [])
    );

    let imageCategories: any[] = [];
    try {
      await delay(RATE_LIMIT_DELAY_MS);
      const catRes = await client.get('/rest/v1.0/image_categories', {
        params: { project_id: projectId, company_id: companyId, per_page: PER_PAGE },
      });
      imageCategories = Array.isArray(catRes.data) ? catRes.data : catRes.data?.image_categories ?? catRes.data ?? [];
    } catch {
      // image_categories optional
    }

    return {
      photos: photos.map((photo: any) => {
        const url = photo.full_url ?? photo.image_url ?? photo.url;
        return {
          id: String(photo.id),
          name: photo.name ?? photo.filename ?? photo.title ?? `Photo_${photo.id}.jpg`,
          type: 'photo' as const,
          url,
          downloadUrl: url,
          createdAt: photo.created_at,
          metadata: {
            categoryId: photo.image_category_id,
            imageCategoryId: photo.image_category_id,
            location: photo.location,
            description: photo.description,
            title: photo.title,
          },
        };
      }),
      imageCategories,
    };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    console.log(`[ProcoreDocs] Could not extract photos: ${msg}`);
    opts?.errors && (opts.errors['photos'] = msg);
    return { photos: [], imageCategories: [] };
  }
}

async function extractBudget(client: any, companyId: string, projectId: string, opts?: ExtractOpts): Promise<{ lineItems: any[]; summary: any }> {
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
    const msg = e?.message ?? String(e);
    console.log(`[ProcoreDocs] Could not extract budget: ${msg}`);
    opts?.errors && (opts.errors['budget'] = msg);
    return { lineItems: [], summary: null };
  }
}

function getAttachmentUrl(a: any): string | undefined {
  return a?.url ?? a?.download_url ?? a?.file?.url ?? a?.prostore_file?.url ?? a?.file_versions?.[0]?.url;
}

function sanitizeFileNameForExport(name: string): string {
  return (name || 'untitled')
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 180) || 'untitled';
}

function mapAttachment(doc: any, att: any, baseMeta: Record<string, any>): DocumentInfo {
  const url = getAttachmentUrl(att);
  return {
    id: String(att.id ?? doc.id),
    name: att.name ?? att.filename ?? att.file_name ?? `attachment_${att.id}.pdf`,
    type: 'document',
    url,
    downloadUrl: url,
    size: att.file_size ?? att.size,
    mimeType: att.content_type ?? att.mime_type,
    createdAt: doc.created_at,
    metadata: { ...baseMeta },
  };
}

async function extractEmails(client: any, companyId: string, projectId: string, opts?: ExtractOpts): Promise<DocumentInfo[]> {
  const path = `/rest/v1.0/project/${projectId}/email_communications`;
  const params = { company_id: companyId };
  try {
    const list = await paginateAll<any>(client, path, params);
    const out: DocumentInfo[] = [];
    for (const e of list) {
      for (const att of e.attachments ?? []) {
        const url = getAttachmentUrl(att);
        if (url) out.push(mapAttachment(e, att, { emailId: e.id, subject: e.subject }));
      }
      if ((e.attachments ?? []).length === 0 && e.id) {
        out.push({
          id: String(e.id),
          name: `${e.subject ?? 'Email'}_${e.id}.json`,
          type: 'document',
          metadata: { emailId: e.id, subject: e.subject, raw: e },
        });
      }
    }
    return out;
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    const urlStr = buildProcoreUrl(path, params);
    console.log(`[ProcoreDocs] Could not extract emails: ${msg}`);
    opts?.errors && (opts.errors['emails'] = `${msg} (${urlStr})`);
    return [];
  }
}

async function extractIncidents(client: any, companyId: string, projectId: string, opts?: ExtractOpts): Promise<DocumentInfo[]> {
  const path = `/rest/v1.0/projects/${projectId}/incidents`;
  const params = { company_id: companyId };
  try {
    const list = await paginateAll<any>(client, path, params);
    const out: DocumentInfo[] = [];
    for (const inc of list) {
      for (const att of inc.attachments ?? []) {
        const url = getAttachmentUrl(att);
        if (url) out.push(mapAttachment(inc, att, { incidentId: inc.id }));
      }
      if ((inc.attachments ?? []).length === 0 && inc.id) {
        out.push({
          id: String(inc.id),
          name: `incident_${inc.id}.json`,
          type: 'document',
          metadata: { incidentId: inc.id, raw: inc },
        });
      }
    }
    return out;
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    const urlStr = buildProcoreUrl(path, params);
    console.log(`[ProcoreDocs] Could not extract incidents: ${msg}`);
    opts?.errors && (opts.errors['incidents'] = `${msg} (${urlStr})`);
    return [];
  }
}

async function extractPunchList(client: any, companyId: string, projectId: string, opts?: ExtractOpts): Promise<DocumentInfo[]> {
  const path = `/rest/v1.0/punch_items`;
  const params = { project_id: projectId, company_id: companyId };
  try {
    const list = await paginateAll<any>(client, path, params);
    const out: DocumentInfo[] = [];
    for (const p of list) {
      for (const att of p.attachments ?? []) {
        const url = getAttachmentUrl(att);
        if (url) out.push(mapAttachment(p, att, { punchItemId: p.id }));
      }
    }
    return out;
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    const urlStr = buildProcoreUrl(path, params);
    console.log(`[ProcoreDocs] Could not extract punch list: ${msg}`);
    opts?.errors && (opts.errors['punchList'] = `${msg} (${urlStr})`);
    return [];
  }
}

async function extractMeetings(client: any, companyId: string, projectId: string, opts?: ExtractOpts): Promise<DocumentInfo[]> {
  const path = `/rest/v1.0/meetings`;
  const params = { project_id: projectId, company_id: companyId };
  try {
    const list = await paginateAll<any>(client, path, params);
    const out: DocumentInfo[] = [];
    for (const m of list) {
      for (const att of m.attachments ?? []) {
        const url = getAttachmentUrl(att);
        if (url) out.push(mapAttachment(m, att, { meetingId: m.id, title: m.title }));
      }
      if ((m.attachments ?? []).length === 0 && m.id) {
        out.push({
          id: String(m.id),
          name: `meeting_${m.id}.json`,
          type: 'document',
          metadata: { meetingId: m.id, title: m.title, raw: m },
        });
      }
    }
    return out;
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    const urlStr = buildProcoreUrl(path, params);
    console.log(`[ProcoreDocs] Could not extract meetings: ${msg}`);
    opts?.errors && (opts.errors['meetings'] = `${msg} (${urlStr})`);
    return [];
  }
}

async function extractSchedule(client: any, companyId: string, projectId: string, opts?: ExtractOpts): Promise<DocumentInfo[]> {
  try {
    await delay(RATE_LIMIT_DELAY_MS);
    const res = await client.get('/rest/v1.0/schedule_integration/download', {
      params: { project_id: projectId },
      responseType: 'arraybuffer',
    }).catch(() => null);
    if (!res?.data) return [];
    const buf = Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data);
    const doc: DocumentInfo & { contentBuffer?: Buffer } = {
      id: 'schedule_1',
      name: 'schedule.mpp',
      type: 'document',
      size: buf.length,
      mimeType: 'application/vnd.ms-project',
      metadata: {},
    };
    (doc as any).contentBuffer = buf;
    return [doc];
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    console.log(`[ProcoreDocs] Could not extract schedule: ${msg}`);
    opts?.errors && (opts.errors['schedule'] = msg);
    return [];
  }
}

const DAILY_LOGS_START = '2020-01-01';
const DAILY_LOGS_END = '2030-12-31';

async function extractDailyLogs(client: any, companyId: string, projectId: string, opts?: ExtractOpts): Promise<{ items: any[]; attachments: DocumentInfo[] }> {
  const path = `/rest/v1.0/projects/${projectId}/daily_logs`;
  const params = { company_id: companyId, start_date: DAILY_LOGS_START, end_date: DAILY_LOGS_END };
  try {
    const list = await paginateAll<any>(client, path, params);
    const attachments: DocumentInfo[] = [];
    for (const d of list) {
      for (const att of d.attachments ?? d.images ?? []) {
        const url = getAttachmentUrl(att);
        if (url) attachments.push(mapAttachment(d, att, { dailyLogId: d.id }));
      }
    }
    return { items: list, attachments };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    const urlStr = buildProcoreUrl(path, params);
    console.log(`[ProcoreDocs] Could not extract daily logs: ${msg}`);
    opts?.errors && (opts.errors['dailyLogs'] = `${msg} (${urlStr})`);
    return { items: [], attachments: [] };
  }
}

async function extractSpecifications(client: any, companyId: string, projectId: string, opts?: ExtractOpts): Promise<DocumentInfo[]> {
  const path = `/rest/v1.0/specification_sections`;
  const params = { project_id: projectId, company_id: companyId };
  try {
    const list = await paginateAll<any>(client, path, params);
    const out: DocumentInfo[] = [];
    for (const s of list) {
      const atts = s.attachments ?? s.uploads ?? s.files ?? [];
      for (const att of atts) {
        const url = getAttachmentUrl(att);
        if (url) out.push(mapAttachment(s, att, { sectionId: s.id, number: s.number }));
      }
    }
    return out;
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    const urlStr = buildProcoreUrl(path, params);
    console.log(`[ProcoreDocs] Could not extract specifications: ${msg}`);
    opts?.errors && (opts.errors['specifications'] = `${msg} (${urlStr})`);
    return [];
  }
}

async function extractPrimeContracts(
  client: any,
  companyId: string,
  projectId: string,
  opts?: ExtractOpts
): Promise<{ items: DocumentInfo[]; rawData: any[] }> {
  const path = `/rest/v1.0/prime_contracts`;
  const params = { project_id: projectId, company_id: companyId };
  try {
    const list = await paginateAll<any>(client, path, params);
    const items: DocumentInfo[] = [];
    for (const c of list) {
      for (const att of c.attachments ?? []) {
        const url = getAttachmentUrl(att);
        if (url) items.push(mapAttachment(c, att, { primeContractId: c.id }));
      }
      const title = c.title ?? c.number ?? String(c.id);
      const pdfPath = `/rest/v1.0/prime_contracts/${c.id}.pdf?project_id=${projectId}&company_id=${companyId}`;
      items.push({
        id: `${c.id}_pdf`,
        name: `${sanitizeFileNameForExport(title)}.pdf`,
        type: 'document',
        downloadUrl: pdfPath,
        mimeType: 'application/pdf',
        metadata: { type: 'pdf_export', contractId: c.id },
      });
    }
    return { items, rawData: list };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    const urlStr = buildProcoreUrl(path, params);
    console.log(`[ProcoreDocs] Could not extract prime contracts: ${msg}`);
    opts?.errors && (opts.errors['primeContracts'] = `${msg} (${urlStr})`);
    return { items: [], rawData: [] };
  }
}

async function extractCommitments(
  client: any,
  companyId: string,
  projectId: string,
  opts?: ExtractOpts
): Promise<{ commitments: { subcontracts: DocumentInfo[]; purchaseOrders: DocumentInfo[] }; data: { subcontracts: any[]; purchaseOrders: any[] } }> {
  const sub: DocumentInfo[] = [];
  const po: DocumentInfo[] = [];
  const subData: any[] = [];
  const poData: any[] = [];
  const woPath = `/rest/v1.0/work_order_contracts`;
  const poPath = `/rest/v1.0/purchase_order_contracts`;
  const baseParams = { project_id: projectId, company_id: companyId };
  try {
    const woList = await paginateAll<any>(client, woPath, baseParams);
    subData.push(...woList);
    for (const c of woList) {
      for (const att of c.attachments ?? []) {
        const url = getAttachmentUrl(att);
        if (url) sub.push(mapAttachment(c, att, { contractId: c.id }));
      }
      const title = c.title ?? c.number ?? String(c.id);
      const pdfPath = `/rest/v1.0/work_order_contracts/${c.id}.pdf?project_id=${projectId}&company_id=${companyId}`;
      sub.push({
        id: `${c.id}_pdf`,
        name: `${sanitizeFileNameForExport(title)}.pdf`,
        type: 'document',
        downloadUrl: pdfPath,
        mimeType: 'application/pdf',
        metadata: { type: 'pdf_export', contractId: c.id },
      });
    }
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    const urlStr = buildProcoreUrl(woPath, baseParams);
    console.log(`[ProcoreDocs] Could not extract subcontracts: ${msg}`);
    opts?.errors && (opts.errors['commitments.subcontracts'] = `${msg} (${urlStr})`);
  }
  try {
    const poList = await paginateAll<any>(client, poPath, baseParams);
    poData.push(...poList);
    for (const c of poList) {
      for (const att of c.attachments ?? []) {
        const url = getAttachmentUrl(att);
        if (url) po.push(mapAttachment(c, att, { contractId: c.id }));
      }
      const title = c.title ?? c.number ?? String(c.id);
      const pdfPath = `/rest/v1.0/purchase_order_contracts/${c.id}.pdf?project_id=${projectId}&company_id=${companyId}`;
      po.push({
        id: `${c.id}_pdf`,
        name: `${sanitizeFileNameForExport(title)}.pdf`,
        type: 'document',
        downloadUrl: pdfPath,
        mimeType: 'application/pdf',
        metadata: { type: 'pdf_export', contractId: c.id },
      });
    }
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    const urlStr = buildProcoreUrl(poPath, baseParams);
    console.log(`[ProcoreDocs] Could not extract purchase orders: ${msg}`);
    opts?.errors && (opts.errors['commitments.purchaseOrders'] = `${msg} (${urlStr})`);
  }
  return { commitments: { subcontracts: sub, purchaseOrders: po }, data: { subcontracts: subData, purchaseOrders: poData } };
}

async function extractChangeOrders(
  client: any,
  companyId: string,
  projectId: string,
  opts?: ExtractOpts
): Promise<{ items: DocumentInfo[]; rawData: any[] }> {
  const path = `/rest/v1.0/change_order_packages`;
  const params = { project_id: projectId, company_id: companyId };
  try {
    const list = await paginateAll<any>(client, path, params);
    const items: DocumentInfo[] = [];
    for (const c of list) {
      for (const att of c.attachments ?? []) {
        const url = getAttachmentUrl(att);
        if (url) items.push(mapAttachment(c, att, { changeOrderId: c.id }));
      }
    }
    return { items, rawData: list };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    const urlStr = buildProcoreUrl(path, params);
    console.log(`[ProcoreDocs] Could not extract change orders: ${msg}`);
    opts?.errors && (opts.errors['changeOrders'] = `${msg} (${urlStr})`);
    return { items: [], rawData: [] };
  }
}

async function extractChangeEvents(
  client: any,
  companyId: string,
  projectId: string,
  opts?: ExtractOpts
): Promise<{ items: DocumentInfo[]; rawData: any[] }> {
  const path = `/rest/v1.0/change_events`;
  const params = { project_id: projectId, company_id: companyId };
  try {
    const list = await paginateAll<any>(client, path, params);
    const items: DocumentInfo[] = [];
    for (const c of list) {
      for (const att of c.attachments ?? []) {
        const url = getAttachmentUrl(att);
        if (url) items.push(mapAttachment(c, att, { changeEventId: c.id }));
      }
    }
    return { items, rawData: list };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    const urlStr = buildProcoreUrl(path, params);
    console.log(`[ProcoreDocs] Could not extract change events: ${msg}`);
    opts?.errors && (opts.errors['changeEvents'] = `${msg} (${urlStr})`);
    return { items: [], rawData: [] };
  }
}

async function extractDirectCosts(
  client: any,
  companyId: string,
  projectId: string,
  opts?: ExtractOpts
): Promise<{ items: DocumentInfo[]; rawData: any[] }> {
  const path = `/rest/v1.0/projects/${projectId}/direct_costs`;
  const params = { company_id: companyId };
  try {
    const list = await paginateAll<any>(client, path, params);
    const items: DocumentInfo[] = [];
    for (const d of list) {
      for (const att of d.attachments ?? []) {
        const url = getAttachmentUrl(att);
        if (url) items.push(mapAttachment(d, att, { directCostId: d.id }));
      }
    }
    return { items, rawData: list };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    const urlStr = buildProcoreUrl(path, params);
    console.log(`[ProcoreDocs] Could not extract direct costs: ${msg}`);
    opts?.errors && (opts.errors['directCosts'] = `${msg} (${urlStr})`);
    return { items: [], rawData: [] };
  }
}

async function extractInvoicing(
  client: any,
  companyId: string,
  projectId: string,
  opts?: ExtractOpts
): Promise<{ items: DocumentInfo[]; rawData: any[] }> {
  const path = `/rest/v1.0/requisitions`;
  const params = { project_id: projectId, company_id: companyId };
  try {
    const list = await paginateAll<any>(client, path, params);
    const items: DocumentInfo[] = [];
    for (const r of list) {
      for (const att of r.attachments ?? []) {
        const url = getAttachmentUrl(att);
        if (url) items.push(mapAttachment(r, att, { requisitionId: r.id }));
      }
    }
    return { items, rawData: list };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    const urlStr = buildProcoreUrl(path, params);
    console.log(`[ProcoreDocs] Could not extract invoicing/requisitions: ${msg}`);
    opts?.errors && (opts.errors['invoicing'] = `${msg} (${urlStr})`);
    return { items: [], rawData: [] };
  }
}

/**
 * Extracts project directory (users assigned to the project).
 * Tries project-specific endpoints first. The /rest/v1.0/users?project_id=...
 * endpoint may return the full company directory (e.g. 496 users) rather than
 * project-assigned users. If a project-scoped endpoint is identified, prefer it.
 * See /api/debug/procore-raw-test for URL variations to verify.
 */
async function extractDirectory(client: any, companyId: string, projectId: string, opts?: ExtractOpts): Promise<any[]> {
  const pathsToTry = [
    { path: `/rest/v1.0/projects/${projectId}/users`, params: { company_id: companyId } },
    { path: `/rest/v1.0/projects/${projectId}/directory`, params: { company_id: companyId } },
    { path: `/rest/v1.0/project_directory`, params: { project_id: projectId, company_id: companyId } },
    { path: `/rest/v1.0/users`, params: { project_id: projectId, company_id: companyId } },
  ];
  for (const { path, params } of pathsToTry) {
    try {
      const list = await paginateAll(client, path, params);
      return list;
    } catch (e: any) {
      const status = e?.response?.status;
      if (status === 404) continue;
      const msg = e?.message ?? String(e);
      const urlStr = buildProcoreUrl(path, params);
      console.log(`[ProcoreDocs] Directory ${path}: ${msg}`);
      opts?.errors && (opts.errors['directory'] = `${msg} (${urlStr})`);
      return [];
    }
  }
  // Fallback: /rest/v1.0/users with project_id — may return full company directory
  try {
    return await paginateAll(client, '/rest/v1.0/users', { project_id: projectId, company_id: companyId });
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    const urlStr = buildProcoreUrl('/rest/v1.0/users', { project_id: projectId, company_id: companyId });
    console.log(`[ProcoreDocs] Could not extract directory: ${msg}`);
    opts?.errors && (opts.errors['directory'] = `${msg} (${urlStr})`);
    return [];
  }
}

async function extractEstimating(client: any, companyId: string, projectId: string, opts?: ExtractOpts): Promise<any[]> {
  try {
    const list = await paginateAll(
      client,
      `/rest/v2.0/companies/${companyId}/estimating/bid_board_projects`,
      {},
      (d) => (Array.isArray(d) ? d : d?.bid_board_projects ?? d ?? [])
    );
    return (list || []).filter((p: any) => String(p.project?.id ?? p.project_id ?? p.bid_board?.project_id) === String(projectId));
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    console.log(`[ProcoreDocs] Could not extract estimating: ${msg}`);
    opts?.errors && (opts.errors['estimating'] = msg);
    return [];
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
  emails: number;
  incidents: number;
  punchList: number;
  meetings: number;
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
    emails: 0,
    incidents: 0,
    punchList: 0,
    meetings: 0,
    dailyLogs: 0,
    specifications: 0,
    primeContracts: 0,
    commitments: 0,
    changeOrders: 0,
    changeEvents: 0,
    directCosts: 0,
    invoicing: 0,
    directory: 0,
    estimating: 0,
  };

  try {
    const results = await Promise.all([
      client.get(`/rest/v1.0/folders`, { params: { project_id: projectId } }).catch(() => ({ data: [] })),
      client.get(`/rest/v1.1/projects/${projectId}/drawing_areas`, { params: { company_id: companyId, per_page: 100 } }).catch(() => ({ data: [] })),
      client.get(`/rest/v1.0/projects/${projectId}/submittals`, { params: { company_id: companyId, per_page: 1 } }).catch(() => ({ data: [] })),
      client.get(`/rest/v1.0/projects/${projectId}/rfis`, { params: { company_id: companyId, per_page: 1 } }).catch(() => ({ data: [] })),
      client.get(`/rest/v1.0/images`, { params: { project_id: projectId, company_id: companyId, per_page: 1 } }).catch(() => ({ data: [] })),
      client.get(`/rest/v1.0/projects/${projectId}/budget`, { params: { company_id: companyId } }).catch(() => ({ data: null })),
      client.get(`/rest/v1.0/project/${projectId}/email_communications`, { params: { company_id: companyId, per_page: 1 } }).catch(() => ({ data: [] })),
      client.get(`/rest/v1.0/projects/${projectId}/incidents`, { params: { company_id: companyId, per_page: 1 } }).catch(() => ({ data: [] })),
      client.get(`/rest/v1.0/punch_items`, { params: { project_id: projectId, company_id: companyId, per_page: 1 } }).catch(() => ({ data: [] })),
      client.get(`/rest/v1.0/meetings`, { params: { project_id: projectId, company_id: companyId, per_page: 1 } }).catch(() => ({ data: [] })),
      client.get(`/rest/v1.0/projects/${projectId}/daily_logs`, { params: { company_id: companyId, per_page: 1, start_date: DAILY_LOGS_START, end_date: DAILY_LOGS_END } }).catch(() => ({ data: [] })),
      client.get(`/rest/v1.0/specification_sections`, { params: { project_id: projectId, company_id: companyId, per_page: 1 } }).catch(() => ({ data: [] })),
      client.get(`/rest/v1.0/prime_contracts`, { params: { project_id: projectId, company_id: companyId, per_page: 1 } }).catch(() => ({ data: [] })),
      client.get(`/rest/v1.0/work_order_contracts`, { params: { project_id: projectId, company_id: companyId, per_page: 1 } }).catch(() => ({ data: [] })),
      client.get(`/rest/v1.0/purchase_order_contracts`, { params: { project_id: projectId, company_id: companyId, per_page: 1 } }).catch(() => ({ data: [] })),
      client.get(`/rest/v1.0/change_order_packages`, { params: { project_id: projectId, company_id: companyId, per_page: 1 } }).catch(() => ({ data: [] })),
      client.get(`/rest/v1.0/change_events`, { params: { project_id: projectId, company_id: companyId, per_page: 1 } }).catch(() => ({ data: [] })),
      client.get(`/rest/v1.0/projects/${projectId}/direct_costs`, { params: { company_id: companyId, per_page: 1 } }).catch(() => ({ data: [] })),
      client.get(`/rest/v1.0/requisitions`, { params: { project_id: projectId, company_id: companyId, per_page: 1 } }).catch(() => ({ data: [] })),
      client.get(`/rest/v1.0/users`, { params: { project_id: projectId, company_id: companyId, per_page: 1 } }).catch(() => ({ data: [] })),
      client.get(`/rest/v2.0/companies/${companyId}/estimating/bid_board_projects`, { params: { per_page: 1 } }).catch(() => ({ data: [] })),
    ]);

    const [
      foldersRes, drawingsRes, submittalsRes, rfisRes, photosRes, budgetRes,
      emailsRes, incidentsRes, punchRes, meetingsRes, dailyRes, specRes,
      primeRes, woRes, poRes, coRes, ceRes, dcRes, invRes, dirRes, estRes,
    ] = results;

    const rawPhotos = photosRes.data;
    const photosList = Array.isArray(rawPhotos) ? rawPhotos : rawPhotos?.images ?? rawPhotos ?? [];

    const rawFolders = foldersRes.data;
    counts.folders = Array.isArray(rawFolders) ? rawFolders.length : (rawFolders?.folders?.length ?? 0);
    const rawDrawingAreas = drawingsRes.data;
    counts.drawings = Array.isArray(rawDrawingAreas) ? rawDrawingAreas.length : (rawDrawingAreas?.drawing_areas?.length ?? rawDrawingAreas?.length ?? 0);
    counts.submittals = (submittalsRes.data?.length ?? 0);
    counts.rfis = (rfisRes.data?.length ?? 0);
    counts.photos = photosList.length;
    counts.hasBudget = !!budgetRes.data;
    counts.emails = emailsRes.data?.length ?? 0;
    counts.incidents = incidentsRes.data?.length ?? 0;
    counts.punchList = punchRes.data?.length ?? 0;
    counts.meetings = meetingsRes.data?.length ?? 0;
    counts.dailyLogs = dailyRes.data?.length ?? 0;
    counts.specifications = specRes.data?.length ?? 0;
    counts.primeContracts = primeRes.data?.length ?? 0;
    counts.commitments = (woRes.data?.length ?? 0) + (poRes.data?.length ?? 0);
    counts.changeOrders = coRes.data?.length ?? 0;
    counts.changeEvents = ceRes.data?.length ?? 0;
    counts.directCosts = dcRes.data?.length ?? 0;
    counts.invoicing = invRes.data?.length ?? 0;
    counts.directory = dirRes.data?.length ?? 0;
    counts.estimating = (estRes.data ?? []).filter((p: any) => String(p.project?.id ?? p.project_id) === String(projectId)).length;
  } catch (e: any) {
    console.log(`[ProcoreDocs] Error getting document summary: ${e.message}`);
  }

  return counts;
}
