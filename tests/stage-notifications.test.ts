import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockStorage, mockSendEmail, mockGetDealOwnerInfo } = vi.hoisted(() => ({
  mockStorage: {
    getAutomationConfig: vi.fn(),
    checkEmailDedupeKey: vi.fn(),
    createEmailSendLog: vi.fn(),
    createAuditLog: vi.fn(),
    createBidboardAutomationLog: vi.fn(),
    upsertAutomationConfig: vi.fn(),
    getProcoreRoleAssignmentsByProject: vi.fn(),
  },
  mockSendEmail: vi.fn(),
  mockGetDealOwnerInfo: vi.fn(),
}));

vi.mock('../server/storage.ts', () => ({ storage: mockStorage }));
vi.mock('../server/email-service.ts', () => ({ sendEmail: mockSendEmail }));
vi.mock('../server/hubspot.ts', () => ({ getDealOwnerInfo: mockGetDealOwnerInfo }));

import { buildStageNotificationEmail, processStageNotification, setStageNotificationEnabled } from '../server/stage-notifications';

describe('buildStageNotificationEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorage.getAutomationConfig.mockResolvedValue(undefined);
    mockStorage.checkEmailDedupeKey.mockResolvedValue(false);
    mockStorage.createEmailSendLog.mockResolvedValue({});
    mockStorage.createAuditLog.mockResolvedValue({});
    mockStorage.createBidboardAutomationLog.mockResolvedValue({});
    mockStorage.upsertAutomationConfig.mockResolvedValue({});
    mockStorage.getProcoreRoleAssignmentsByProject.mockResolvedValue([]);
    mockGetDealOwnerInfo.mockResolvedValue({
      ownerEmail: 'owner@trockgc.com',
      ownerName: 'Owner',
    });
    mockSendEmail.mockResolvedValue({
      success: true,
      provider: 'outlook',
      to: 'sgibson@trockgc.com',
      cc: ['adnaan.iqbal@gmail.com', 'bbell@trockgc.com', 'jhelms@trockgc.com'],
    });
  });

  it('renders a BidBoard identifier label and details URL', () => {
    const html = buildStageNotificationEmail(
      'The Ridge at Tyler',
      'Estimate Under Review',
      'Estimate Sent to Client',
      'BidBoard ID',
      '562949955724561',
      'https://us02.procore.com/webclients/host/companies/598134325683880/tools/bid-board/project/562949955724561/details',
    );

    expect(html).toContain('BidBoard ID');
    expect(html).toContain('562949955724561');
    expect(html).toContain('/tools/bid-board/project/562949955724561/details');
    expect(html).not.toContain('>Procore ID<');
  });

  it('renders a plain identifier value when no URL is available', () => {
    const html = buildStageNotificationEmail(
      'The Ridge at Tyler',
      'Estimate Under Review',
      'Estimate Sent to Client',
      'BidBoard ID',
      'DFW-1-10326-af',
    );

    expect(html).toContain('BidBoard ID');
    expect(html).toContain('DFW-1-10326-af');
    expect(html).not.toContain('/tools/projecthome');
  });

  it('sends one stage-notification email with primary recipients merged into cc and logs the actual delivery', async () => {
    const result = await processStageNotification({
      stage: 'Estimate Under Review',
      source: 'bidboard',
      projectName: 'Test: 4/17/26 v1',
      oldStage: 'Estimate in Progress',
      bidboardProjectId: '562949955723964',
      hubspotDealId: '321010655946',
    });

    expect(result).toMatchObject({ sent: 2, skipped: false, route: 'bb_internal_review' });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'sgibson@trockgc.com',
        cc: ['jhelms@trockgc.com'],
      })
    );
    expect(mockStorage.createEmailSendLog).toHaveBeenCalledTimes(2);
    expect(mockStorage.createEmailSendLog).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        templateKey: 'stage_notify_bb_internal_review',
        recipientEmail: 'sgibson@trockgc.com',
        metadata: expect.objectContaining({
          provider: 'outlook',
          finalTo: 'sgibson@trockgc.com',
          finalCc: ['adnaan.iqbal@gmail.com', 'bbell@trockgc.com', 'jhelms@trockgc.com'],
          deliveryMode: 'single_message_multi_recipient',
        }),
      })
    );
    expect(mockStorage.createEmailSendLog).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        templateKey: 'stage_notify_bb_internal_review',
        recipientEmail: 'sgibson@trockgc.com, jhelms@trockgc.com',
        dedupeKey:
          'stage_notify:bb_internal_review:562949955723964:Estimate in Progress:Estimate Under Review',
        metadata: expect.objectContaining({
          deliveryCount: 2,
          primaryTo: 'sgibson@trockgc.com',
          primaryCc: ['jhelms@trockgc.com'],
        }),
      })
    );
  });

  it('omits Stephanie from portfolio stage change notifications', async () => {
    const result = await processStageNotification({
      stage: 'Close Out',
      source: 'portfolio',
      projectName: 'Willow Creek',
      oldStage: 'In Production',
      procoreProjectId: '12345',
    });

    expect(result).toMatchObject({ sent: 2, skipped: false, route: 'pf_close_out' });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'jhelms@trockgc.com',
        cc: ['kscheidegger@trockgc.com'],
      })
    );
    expect(mockSendEmail).not.toHaveBeenCalledWith(
      expect.objectContaining({
        cc: expect.arrayContaining(['sbohen@trockgc.com']),
      })
    );
  });

  it('does not send the new Contract closed-won route by default and logs route_disabled_skip', async () => {
    mockStorage.getAutomationConfig.mockResolvedValue(undefined);

    const result = await processStageNotification({
      stage: 'Contract',
      source: 'bidboard',
      projectName: 'Contract Project',
      oldStage: 'Estimate Sent to Client',
      bidboardProjectNumber: 'DFW-1-12326-aa',
      hubspotDealId: 'deal-contract',
    });

    expect(result).toMatchObject({ sent: 0, skipped: true, route: 'bb_closed_won' });
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockStorage.createBidboardAutomationLog).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'DFW-1-12326-aa',
        projectName: 'Contract Project',
        action: 'stage_notify:route_disabled_skip',
        status: 'skipped',
        details: expect.objectContaining({
          route: 'bb_closed_won',
          configKey: 'stage_notify_bb_closed_won_contract',
          stage: 'Contract',
          oldStage: 'Estimate Sent to Client',
          source: 'bidboard',
        }),
      })
    );
  });

  it('sends the new Contract closed-won route when explicitly enabled', async () => {
    mockStorage.getAutomationConfig.mockImplementation(async (key: string) => {
      if (key === 'stage_notify_bb_closed_won_contract') return { key, value: { enabled: true } };
      return undefined;
    });

    const result = await processStageNotification({
      stage: 'Contract',
      source: 'bidboard',
      projectName: 'Contract Project',
      oldStage: 'Estimate Sent to Client',
      bidboardProjectNumber: 'DFW-1-12326-aa',
      hubspotDealId: 'deal-contract',
    });

    expect(result).toMatchObject({ sent: 2, skipped: false, route: 'bb_closed_won' });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockStorage.createEmailSendLog).toHaveBeenCalledWith(
      expect.objectContaining({ templateKey: 'stage_notify_bb_closed_won' })
    );
  });

  it('does not send the new Lost closed-lost route by default and logs route_disabled_skip', async () => {
    mockStorage.getAutomationConfig.mockResolvedValue(undefined);

    const result = await processStageNotification({
      stage: 'Lost',
      source: 'bidboard',
      projectName: 'Lost Project',
      oldStage: 'Estimate Sent to Client',
      bidboardProjectNumber: 'DFW-1-99926-aa',
      hubspotDealId: 'deal-lost',
    });

    expect(result).toMatchObject({ sent: 0, skipped: true, route: 'bb_closed_lost' });
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockStorage.createBidboardAutomationLog).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'DFW-1-99926-aa',
        projectName: 'Lost Project',
        action: 'stage_notify:route_disabled_skip',
        status: 'skipped',
        details: expect.objectContaining({
          route: 'bb_closed_lost',
          configKey: 'stage_notify_bb_closed_lost_lost',
          stage: 'Lost',
        }),
      })
    );
  });

  it('sends the new Lost closed-lost route when explicitly enabled', async () => {
    mockStorage.getAutomationConfig.mockImplementation(async (key: string) => {
      if (key === 'stage_notify_bb_closed_lost_lost') return { key, value: { enabled: true } };
      return undefined;
    });

    const result = await processStageNotification({
      stage: 'Lost',
      source: 'bidboard',
      projectName: 'Lost Project',
      oldStage: 'Estimate Sent to Client',
      bidboardProjectNumber: 'DFW-1-99926-aa',
      hubspotDealId: 'deal-lost',
    });

    expect(result).toMatchObject({ sent: 1, skipped: false, route: 'bb_closed_lost' });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockStorage.createEmailSendLog).toHaveBeenCalledWith(
      expect.objectContaining({ templateKey: 'stage_notify_bb_closed_lost' })
    );
  });

  it('does not route inert Won stage notifications', async () => {
    const result = await processStageNotification({
      stage: 'Won',
      source: 'bidboard',
      projectName: 'Won Project',
      oldStage: 'Contract',
      bidboardProjectNumber: 'DFW-1-77726-aa',
      hubspotDealId: 'deal-won',
    });

    expect(result).toMatchObject({ sent: 0, skipped: true });
    expect(result.route).toBeUndefined();
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockStorage.createBidboardAutomationLog).not.toHaveBeenCalled();
  });

  it.each(['Sent to Production', 'Service - Sent to Production'])('keeps old closed-won route active for %s', async (stage) => {
    const result = await processStageNotification({
      stage,
      source: 'bidboard',
      projectName: 'Legacy Won Project',
      oldStage: 'Estimate Sent to Client',
      bidboardProjectNumber: 'DFW-1-55526-aa',
      hubspotDealId: 'deal-legacy-won',
    });

    expect(result).toMatchObject({ sent: 2, skipped: false, route: 'bb_closed_won' });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it.each(['Production Lost', 'Service - Lost'])('keeps old closed-lost route active for %s', async (stage) => {
    const result = await processStageNotification({
      stage,
      source: 'bidboard',
      projectName: 'Legacy Lost Project',
      oldStage: 'Estimate Sent to Client',
      bidboardProjectNumber: 'DFW-1-55626-aa',
      hubspotDealId: 'deal-legacy-lost',
    });

    expect(result).toMatchObject({ sent: 1, skipped: false, route: 'bb_closed_lost' });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it('keeps legacy toggle keys pointed at the old closed-won route', async () => {
    await expect(setStageNotificationEnabled('bb_closed_won', false)).resolves.toBe(true);

    expect(mockStorage.upsertAutomationConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'stage_notify_bb_closed_won',
        value: { enabled: false },
        description: 'Stage notification: Sent to Production → Closed Won',
      })
    );
  });

  it('allows the new Contract route to be toggled by its explicit config key', async () => {
    await expect(setStageNotificationEnabled('stage_notify_bb_closed_won_contract', true)).resolves.toBe(true);

    expect(mockStorage.upsertAutomationConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'stage_notify_bb_closed_won_contract',
        value: { enabled: true },
        description: 'Stage notification: Contract → Closed Won',
      })
    );
  });
});
