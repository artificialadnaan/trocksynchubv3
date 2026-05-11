import crypto from 'crypto';

interface FireParams {
  sourceDealId: string;
  rfpApprovalRequestId: number;
  bidboardProjectId: string;
  procoreCompanyId: string | null;
}

const CALLBACK_PATH = '/api/internal/bid-board-created';
const REQUEST_TIMEOUT_MS = 5000;

export async function fireCrmImmediateAdvance(params: FireParams): Promise<void> {
  const baseUrl = process.env.TROCK_CRM_BASE_URL;
  const secret = process.env.RFP_REQUEST_SYNC_SECRET;

  if (!baseUrl || !secret) {
    throw new Error('fireCrmImmediateAdvance: missing TROCK_CRM_BASE_URL or RFP_REQUEST_SYNC_SECRET');
  }

  const endpoint = `${baseUrl.replace(/\/$/, '')}${CALLBACK_PATH}`;
  const body = JSON.stringify({
    sourceDealId: params.sourceDealId,
    rfpApprovalRequestId: params.rfpApprovalRequestId,
    bidboardProjectId: params.bidboardProjectId,
    procoreCompanyId: params.procoreCompanyId,
  });

  const signature = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-rfp-request-signature': signature,
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`CRM callback returned ${response.status}: ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
