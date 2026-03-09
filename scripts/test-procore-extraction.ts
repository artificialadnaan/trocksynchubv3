/**
 * Procore API Extraction Test Script
 * ===================================
 *
 * Verifies which Procore endpoints return downloadable data.
 * Hit endpoints against a real project and log response shapes.
 *
 * Usage:
 *   PROCORE_ACCESS_TOKEN=... PROCORE_COMPANY_ID=... PROCORE_PROJECT_ID=... npx tsx scripts/test-procore-extraction.ts
 */

const BASE_URL = process.env.PROCORE_BASE_URL || 'https://api.procore.com';
const ACCESS_TOKEN = process.env.PROCORE_ACCESS_TOKEN;
const COMPANY_ID = process.env.PROCORE_COMPANY_ID;
const PROJECT_ID = process.env.PROCORE_PROJECT_ID;

interface EndpointResult {
  endpoint: string;
  status: number;
  itemCount?: number;
  sampleFields?: Record<string, string>;
  error?: string;
}

async function fetchProcore(endpoint: string, params: Record<string, string> = {}): Promise<{ status: number; data: any; headers?: any }> {
  const url = new URL(`${BASE_URL}${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    headers: {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      'Accept': 'application/json',
      'Procore-Company-Id': COMPANY_ID!,
    },
  });

  let data: any = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  }

  return { status: res.status, data, headers: Object.fromEntries(res.headers.entries()) };
}

function sampleFields(obj: any, depth = 0): Record<string, string> {
  if (depth > 2) return {};
  if (obj === null || obj === undefined) return {};
  const out: Record<string, string> = {};
  const o = Array.isArray(obj) ? obj[0] : obj;
  if (!o || typeof o !== 'object') return { value: String(obj).slice(0, 80) };

  for (const [k, v] of Object.entries(o).slice(0, 12)) {
    if (v === null || v === undefined) out[k] = 'null';
    else if (Array.isArray(v)) out[k] = `[${v.length} items]`;
    else if (typeof v === 'object') out[k] = `{${Object.keys(v).slice(0, 3).join(', ')}}`;
    else out[k] = String(v).slice(0, 50);
  }
  return out;
}

async function testEndpoint(endpoint: string, params: Record<string, string> = {}): Promise<EndpointResult> {
  try {
    const { status, data } = await fetchProcore(endpoint, params);
    const arr = Array.isArray(data) ? data : (data && typeof data === 'object' ? [] : []);
    const itemCount = Array.isArray(data) ? data.length : (data && typeof data === 'object' ? 1 : 0);
    const sample = Array.isArray(data) && data[0] ? data[0] : (typeof data === 'object' ? data : null);

    return {
      endpoint,
      status,
      itemCount: Array.isArray(data) ? data.length : undefined,
      sampleFields: sample ? sampleFields(sample) : (data && typeof data === 'object' ? sampleFields(data) : undefined),
      ...(status >= 400 ? { error: typeof data === 'object' && data?.message ? data.message : `HTTP ${status}` } : {}),
    };
  } catch (e: any) {
    return { endpoint, status: 0, error: e.message };
  }
}

const ENDPOINTS: Array<{ path: string; params?: Record<string, string> }> = [
  { path: `/rest/v1.0/projects/${PROJECT_ID}` },
  { path: `/rest/v1.0/projects/${PROJECT_ID}/documents` },
  { path: `/rest/v1.0/projects/${PROJECT_ID}/documents/files` },
  { path: `/rest/v1.0/projects/${PROJECT_ID}/drawing_areas` },
  { path: `/rest/v1.0/drawings`, params: { project_id: PROJECT_ID!, per_page: '5' } },
  { path: `/rest/v1.0/projects/${PROJECT_ID}/submittals`, params: { per_page: '5' } },
  { path: `/rest/v1.0/projects/${PROJECT_ID}/rfis`, params: { per_page: '5' } },
  { path: `/rest/v1.1/projects/${PROJECT_ID}/bid_packages`, params: { per_page: '5' } },
  { path: `/rest/v1.0/projects/${PROJECT_ID}/images`, params: { per_page: '5' } },
  { path: `/rest/v1.0/projects/${PROJECT_ID}/image_categories` },
  { path: `/rest/v1.0/projects/${PROJECT_ID}/budget/views` },
  { path: `/rest/v1.0/projects/${PROJECT_ID}/cost_codes` },
  { path: `/rest/v1.0/projects/${PROJECT_ID}/commitments`, params: { per_page: '5' } },
  { path: `/rest/v1.0/projects/${PROJECT_ID}/change_orders`, params: { per_page: '5' } },
  { path: `/rest/v1.0/projects/${PROJECT_ID}/prime_contracts`, params: { per_page: '5' } },
  { path: `/rest/v1.0/projects/${PROJECT_ID}/meetings`, params: { per_page: '5' } },
  { path: `/rest/v1.0/projects/${PROJECT_ID}/punch_items`, params: { per_page: '5' } },
  { path: `/rest/v1.0/projects/${PROJECT_ID}/daily_logs`, params: { per_page: '5' } },
  { path: `/rest/v1.0/projects/${PROJECT_ID}/inspections`, params: { per_page: '5' } },
];

async function main() {
  if (!ACCESS_TOKEN || !COMPANY_ID || !PROJECT_ID) {
    console.error('Set PROCORE_ACCESS_TOKEN, PROCORE_COMPANY_ID, PROCORE_PROJECT_ID');
    process.exit(1);
  }

  console.log('Procore API Extraction Test');
  console.log('===========================');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Company ID: ${COMPANY_ID}`);
  console.log(`Project ID: ${PROJECT_ID}`);
  console.log('');

  const results: EndpointResult[] = [];
  for (const { path, params = {} } of ENDPOINTS) {
    const p = path.replace(PROJECT_ID!, PROJECT_ID);
    const allParams = { ...params, company_id: COMPANY_ID };
    const fullEndpoint = `${p}?${new URLSearchParams(allParams as Record<string, string>).toString()}`;
    const r = await testEndpoint(p, allParams);
    r.endpoint = fullEndpoint;
    results.push(r);
    const statusStr = r.status === 200 ? '✓ 200' : r.status >= 400 ? `✗ ${r.status}` : `? ${r.status}`;
    const countStr = r.itemCount !== undefined ? ` (${r.itemCount} items)` : '';
    console.log(`${statusStr} ${r.endpoint}${countStr}`);
    if (r.error) console.log(`   Error: ${r.error}`);
    if (r.sampleFields && Object.keys(r.sampleFields).length > 0) {
      for (const [k, v] of Object.entries(r.sampleFields).slice(0, 5)) {
        console.log(`   ${k}: ${v}`);
      }
    }
  }

  console.log('');
  console.log('Summary');
  console.log('-------');
  const ok = results.filter((r) => r.status === 200).length;
  const fail = results.filter((r) => r.status >= 400).length;
  const err = results.filter((r) => r.status === 0).length;
  console.log(`200 OK: ${ok}`);
  console.log(`4xx/5xx: ${fail}`);
  console.log(`Errors: ${err}`);
  console.log('');
  console.log('Endpoints returning 200 — permissions sufficient for archive extraction.');
  console.log('403/404 — may need additional Procore API scopes or project access.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
