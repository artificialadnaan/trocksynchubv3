import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireCrmImmediateAdvance } from '../server/sync/crm-immediate-advance-fire';

describe('fireCrmImmediateAdvance', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.TROCK_CRM_BASE_URL = 'https://example.test';
    process.env.RFP_REQUEST_SYNC_SECRET = 'test-secret-123';
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws when TROCK_CRM_BASE_URL is missing', async () => {
    delete process.env.TROCK_CRM_BASE_URL;
    await expect(
      fireCrmImmediateAdvance({
        sourceDealId: 'deal-1',
        rfpApprovalRequestId: 1,
        bidboardProjectId: 'bb-1',
        procoreCompanyId: null,
      }),
    ).rejects.toThrow(/missing/);
  });

  it('throws when RFP_REQUEST_SYNC_SECRET is missing', async () => {
    delete process.env.RFP_REQUEST_SYNC_SECRET;
    await expect(
      fireCrmImmediateAdvance({
        sourceDealId: 'deal-1',
        rfpApprovalRequestId: 1,
        bidboardProjectId: 'bb-1',
        procoreCompanyId: null,
      }),
    ).rejects.toThrow(/missing/);
  });

  it('signs body with HMAC-SHA256 and POSTs to canonical endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' });
    vi.stubGlobal('fetch', fetchMock);

    await fireCrmImmediateAdvance({
      sourceDealId: 'deal-1',
      rfpApprovalRequestId: 42,
      bidboardProjectId: 'bb-99',
      procoreCompanyId: 'co-1',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.test/api/internal/bid-board-created');
    expect(init.method).toBe('POST');
    expect(init.headers['x-rfp-request-signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(init.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body);
    expect(body).toEqual({
      sourceDealId: 'deal-1',
      rfpApprovalRequestId: 42,
      bidboardProjectId: 'bb-99',
      procoreCompanyId: 'co-1',
    });
  });

  it('throws on non-2xx response with status and body excerpt', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'internal server error',
    }));

    await expect(
      fireCrmImmediateAdvance({
        sourceDealId: 'deal-1',
        rfpApprovalRequestId: 1,
        bidboardProjectId: 'bb-1',
        procoreCompanyId: null,
      }),
    ).rejects.toThrow(/500.*internal server error/);
  });
});
