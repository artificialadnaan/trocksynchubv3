import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockClient = {
  get: vi.fn(),
};

const mockUpdateHubSpotDeal = vi.fn();

vi.mock('../server/procore.ts', () => ({
  getProcoreClient: vi.fn(async () => mockClient),
  getCompanyId: vi.fn(async () => '598134325683880'),
}));

vi.mock('../server/hubspot.ts', () => ({
  updateHubSpotDeal: mockUpdateHubSpotDeal,
}));

import { getProjectChangeOrders, updateHubSpotDealAmount } from '../server/change-order-sync';

describe('getProjectChangeOrders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads change order packages from the top-level endpoint before falling back to the project-scoped path', async () => {
    mockClient.get.mockImplementation(async (path: string, options: any) => {
      if (path === '/rest/v1.0/change_order_packages') {
        expect(options).toMatchObject({
          params: {
            project_id: '598134326572477',
            company_id: '598134325683880',
          },
        });
        return {
          data: [
            {
              id: 1,
              number: '001',
              title: 'Additional Asphalt',
              status: 'approved',
              grand_total: '1500.0',
              created_at: '2026-04-21T16:31:20Z',
              updated_at: '2026-04-21T16:33:36Z',
            },
            {
              id: 2,
              number: '002',
              title: 'Pending Striping',
              status: 'pending',
              grand_total: '250.0',
              created_at: '2026-04-21T16:40:00Z',
              updated_at: '2026-04-21T16:42:00Z',
            },
          ],
        };
      }

      throw new Error(`Unexpected endpoint: ${path}`);
    });

    const changeOrders = await getProjectChangeOrders('598134326572477');

    expect(changeOrders).toEqual([
      expect.objectContaining({
        id: '1',
        number: '001',
        title: 'Additional Asphalt',
        status: 'approved',
        approvedAmount: 1500,
        pendingAmount: 0,
      }),
      expect.objectContaining({
        id: '2',
        number: '002',
        title: 'Pending Striping',
        status: 'pending',
        approvedAmount: 0,
        pendingAmount: 250,
      }),
    ]);
    expect(mockClient.get).toHaveBeenCalledTimes(1);
    expect(mockClient.get).toHaveBeenCalledWith('/rest/v1.0/change_order_packages', {
      params: {
        project_id: '598134326572477',
        company_id: '598134325683880',
      },
    });
  });

  it('returns a failure when the HubSpot update helper reports success false', async () => {
    mockUpdateHubSpotDeal.mockResolvedValue({
      success: false,
      message: 'HubSpot not connected',
    });

    const result = await updateHubSpotDealAmount('321711034098', 30071.43, 1500, 0);

    expect(result).toEqual({
      success: false,
      error: 'HubSpot not connected',
    });
    expect(mockUpdateHubSpotDeal).toHaveBeenCalledWith('321711034098', {
      amount: '30071.43',
      change_order_approved: '1500',
      change_order_pending: '0',
    });
  });
});
