import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted: the vi.mock factories below are hoisted above every top-level statement, so plain `const` mocks were
// still in their temporal dead zone when the storage factory ran ("Cannot access 'mockStorage' before initialization").
const { mockClient, mockUpdateHubSpotDeal, mockStorage } = vi.hoisted(() => ({
  mockClient: { get: vi.fn() },
  mockUpdateHubSpotDeal: vi.fn(),
  mockStorage: {
    getSyncMappings: vi.fn(),
    getProcoreProjectByProcoreId: vi.fn(),
    // The per-project sync (syncChangeOrdersToHubSpot) reads these too: the "Update HubSpot deal amount on Change
    // Orders" switch, the mapping, the deal's current amount, and its audit write. Unmocked, they fell through to
    // the REAL storage (no database here), the switch read as off, and the project was never updated.
    getAutomationConfig: vi.fn(),
    getSyncMappingByProcoreProjectId: vi.fn(),
    getHubspotDealByHubspotId: vi.fn(),
    createAuditLog: vi.fn(),
  },
}));

vi.mock('../server/procore.ts', () => ({
  getProcoreClient: vi.fn(async () => mockClient),
  getCompanyId: vi.fn(async () => '598134325683880'),
}));

vi.mock('../server/hubspot.ts', () => ({
  updateHubSpotDeal: mockUpdateHubSpotDeal,
}));

vi.mock('../server/storage.ts', async () => {
  const actual = await vi.importActual('../server/storage.ts');
  return {
    ...actual,
    storage: {
      ...(actual as any).storage,
      ...mockStorage,
    },
  };
});

import { getProjectChangeOrders, syncAllProjectChangeOrders, updateHubSpotDealAmount } from '../server/change-order-sync';

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

  it('polling includes mappings that only have a procoreProjectId', async () => {
    mockStorage.getSyncMappings.mockResolvedValue([
      {
        hubspotDealId: '321711034098',
        portfolioProjectId: null,
        procoreProjectId: '598134326572477',
      },
    ]);
    mockStorage.getProcoreProjectByProcoreId.mockResolvedValue({ active: true });
    mockStorage.getAutomationConfig.mockResolvedValue({ key: 'sync_change_orders', value: { enabled: true } });
    mockStorage.getSyncMappingByProcoreProjectId.mockResolvedValue({
      hubspotDealId: '321711034098',
      procoreProjectId: '598134326572477',
    });
    mockStorage.getHubspotDealByHubspotId.mockResolvedValue({ amount: '28571.43' });
    mockStorage.createAuditLog.mockResolvedValue({ id: 1 });

    mockClient.get.mockImplementation(async (path: string) => {
      if (path === '/rest/v1.0/prime_contracts') {
        return {
          data: [{ grand_total: '28571.43' }],
        };
      }
      if (path === '/rest/v1.0/change_order_packages') {
        return {
          data: [
            {
              id: 1,
              number: '001',
              title: 'Additional Asphalt',
              status: 'approved',
              grand_total: '1500.0',
            },
          ],
        };
      }
      throw new Error(`Unexpected endpoint: ${path}`);
    });
    mockUpdateHubSpotDeal.mockResolvedValue({ success: true, message: 'ok' });

    const result = await syncAllProjectChangeOrders();

    expect(result.projectsChecked).toBe(1);
    expect(result.projectsUpdated).toBe(1);
    expect(mockStorage.getProcoreProjectByProcoreId).toHaveBeenCalledWith('598134326572477');
    expect(mockUpdateHubSpotDeal).toHaveBeenCalledWith('321711034098', {
      amount: '30071.43',
      change_order_approved: '1500',
      change_order_pending: '0',
    });
  });

  it('updates nothing when the "Update HubSpot deal amount on Change Orders" switch is off', async () => {
    mockStorage.getSyncMappings.mockResolvedValue([
      { hubspotDealId: '321711034098', portfolioProjectId: null, procoreProjectId: '598134326572477' },
    ]);
    mockStorage.getProcoreProjectByProcoreId.mockResolvedValue({ active: true });
    mockStorage.getAutomationConfig.mockResolvedValue({ key: 'sync_change_orders', value: { enabled: false } });

    const result = await syncAllProjectChangeOrders();

    expect(result.projectsChecked).toBe(1);
    expect(result.projectsUpdated).toBe(0);
    expect(mockUpdateHubSpotDeal).not.toHaveBeenCalled();
  });
});
