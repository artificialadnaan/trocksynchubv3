/**
 * Procore API Extraction Test Script
 * ===================================
 *
 * Verifies which Procore endpoints return downloadable data and logs
 * actual field names for download URLs, filenames, etc.
 *
 * Run with real credentials:
 *   PROCORE_ACCESS_TOKEN=... PROCORE_COMPANY_ID=... PROCORE_PROJECT_ID=... npx tsx scripts/test-procore-extraction.ts
 *
 * Focus: For each endpoint, identify url/download_url/flattened_url/etc.
 */

const BASE_URL = process.env.PROCORE_BASE_URL || 'https://api.procore.com';
const ACCESS_TOKEN = process.env.PROCORE_ACCESS_TOKEN;
const COMPANY_ID = process.env.PROCORE_COMPANY_ID;
const PROJECT_ID = process.env.PROCORE_PROJECT_ID;

const URL_FIELDS = ['url', 'download_url', 'image_url', 'full_url', 'flattened_url', 'pdf_url'];

function findAllPaths(obj: any, prefix = '', depth = 0): string[] {
  if (depth > 4) return [];
  if (obj === null || obj === undefined) return [];
  const paths: string[] = [];
  if (typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (URL_FIELDS.includes(k) && typeof v === 'string' && v.startsWith('http')) {
        paths.push(`${p}=[URL]`);
      } else if (typeof v === 'object' && v !== null) {
        paths.push(...findAllPaths(v, p, depth + 1));
      }
    }
  } else if (Array.isArray(obj) && obj.length > 0) {
    paths.push(...findAllPaths(obj[0], `${prefix}[0]`, depth + 1));
  }
  return paths;
}

function extractUrlFields(obj: any): string[] {
  const urls: string[] = [];
  const scan = (o: any, path: string) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      const p = path ? `${path}.${k}` : k;
      if (URL_FIELDS.includes(k) && typeof v === 'string' && v.startsWith('http')) {
        urls.push(`${p} (${(v as string).slice(0, 50)}...)`);
      } else if (Array.isArray(v) && v.length > 0) {
        scan(v[0], `${p}[0]`);
      } else if (v && typeof v === 'object') {
        scan(v, p);
      }
    }
  };
  scan(obj, '');
  return urls;
}

async function fetchProcore(endpoint: string, params: Record<string, string> = {}): Promise<{ status: number; data: any }> {
  const url = new URL(`${BASE_URL}${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      Accept: 'application/json',
      'Procore-Company-Id': COMPANY_ID!,
    },
  });
  let data: any = null;
  if (res.headers.get('content-type')?.includes('application/json')) {
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  }
  return { status: res.status, data };
}

async function testEndpoint(
  path: string,
  params: Record<string, string> = {}
): Promise<{
  endpoint: string;
  status: number;
  itemCount?: number;
  urlFields: string[];
  sampleKeys: string[];
  error?: string;
}> {
  const allParams = { ...params, company_id: COMPANY_ID! };
  const fullPath = `${path}?${new URLSearchParams(allParams).toString()}`;
  try {
    const { status, data } = await fetchProcore(path, allParams);
    const sample = Array.isArray(data) ? data[0] : data;
    const urlFields = sample ? extractUrlFields(sample) : [];
    const sampleKeys = sample && typeof sample === 'object' ? Object.keys(sample) : [];
    return {
      endpoint: fullPath,
      status,
      itemCount: Array.isArray(data) ? data.length : data ? 1 : 0,
      urlFields,
      sampleKeys: sampleKeys.slice(0, 20),
      ...(status >= 400 ? { error: (data as any)?.message || `HTTP ${status}` } : {}),
    };
  } catch (e: any) {
    return { endpoint: fullPath, status: 0, urlFields: [], sampleKeys: [], error: e.message };
  }
}

const ENDPOINTS: Array<{ path: string; params?: Record<string, string>; label: string }> = [
  { path: `/rest/v1.0/projects/${PROJECT_ID}`, label: 'Project (stage field)' },
  { path: `/rest/v1.0/folders`, params: { project_id: PROJECT_ID! }, label: 'Folders' },
  { path: `/rest/v1.0/projects/${PROJECT_ID}/documents`, params: { per_page: '5' }, label: 'Documents (flat)' },
  { path: `/rest/v1.0/projects/${PROJECT_ID}/drawing_areas`, label: 'Drawing areas' },
  { path: `/rest/v1.0/drawings`, params: { project_id: PROJECT_ID!, per_page: '5' }, label: 'Drawings' },
  { path: `/rest/v1.0/projects/${PROJECT_ID}/drawing_revisions`, params: { per_page: '5' }, label: 'Drawing revisions' },
  { path: `/rest/v1.1/projects/${PROJECT_ID}/submittals`, params: { per_page: '5' }, label: 'Submittals (v1.1)' },
  { path: `/rest/v1.1/projects/${PROJECT_ID}/submittals/attachments_with_markup`, params: { per_page: '5' }, label: 'Submittals attachments' },
  { path: `/rest/v1.0/projects/${PROJECT_ID}/rfis`, params: { per_page: '5' }, label: 'RFIs' },
  { path: `/rest/v1.1/projects/${PROJECT_ID}/bid_packages`, params: { per_page: '5' }, label: 'Bid packages' },
  { path: `/rest/v1.0/projects/${PROJECT_ID}/images`, params: { per_page: '5' }, label: 'Photos/images' },
  { path: `/rest/v1.0/projects/${PROJECT_ID}/image_categories`, label: 'Image categories' },
  { path: `/rest/v1.0/projects/${PROJECT_ID}/budget`, label: 'Budget' },
  { path: `/rest/v1.0/projects/${PROJECT_ID}/budget/line_items`, params: { per_page: '5' }, label: 'Budget line items' },
  { path: `/rest/v1.0/budget_views`, params: { project_id: PROJECT_ID! }, label: 'Budget views' },
];

async function main() {
  if (!ACCESS_TOKEN || !COMPANY_ID || !PROJECT_ID) {
    console.error('Set PROCORE_ACCESS_TOKEN, PROCORE_COMPANY_ID, PROCORE_PROJECT_ID');
    process.exit(1);
  }

  console.log('Procore API Extraction Test — Download URL Field Verification');
  console.log('==============================================================');
  console.log(`Base: ${BASE_URL} | Company: ${COMPANY_ID} | Project: ${PROJECT_ID}\n`);

  for (const { path, params = {}, label } of ENDPOINTS) {
    const p = path.replace(PROJECT_ID!, PROJECT_ID);
    const r = await testEndpoint(p, params);
    const statusStr = r.status === 200 ? '✓ 200' : r.status >= 400 ? `✗ ${r.status}` : `? ${r.status}`;
    console.log(`${statusStr} ${label}`);
    console.log(`   ${r.endpoint}`);
    if (r.error) console.log(`   Error: ${r.error}`);
    if (r.itemCount !== undefined) console.log(`   Items: ${r.itemCount}`);
    if (r.urlFields.length > 0) {
      console.log('   URL fields:');
      r.urlFields.forEach((u) => console.log(`     - ${u}`));
    } else if (r.status === 200 && r.sampleKeys.length > 0) {
      console.log(`   Top-level keys: ${r.sampleKeys.join(', ')}`);
    }
    console.log('');
  }

  console.log('---');
  console.log('Use URL fields above to update server/procore-documents.ts field mappings.');
  console.log('Key checks: file.url vs file_versions[0].url | flattened_url vs pdf_url | image_url vs full_url');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
