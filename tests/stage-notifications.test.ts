import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockStorage = {
  getAutomationConfig: vi.fn(),
  checkEmailDedupeKey: vi.fn(),
  createEmailSendLog: vi.fn(),
  createAuditLog: vi.fn(),
  getProcoreRoleAssignmentsByProject: vi.fn(),
};

const mockSendEmail = vi.fn();
const mockGetDealOwnerInfo = vi.fn();

vi.mock('../server/storage.ts', () => ({ storage: mockStorage }));
vi.mock('../server/email-service.ts', () => ({ sendEmail: mockSendEmail }));
vi.mock('../server/hubspot.ts', () => ({ getDealOwnerInfo: mockGetDealOwnerInfo }));

import { buildStageNotificationEmail, processStageNotification } from '../server/stage-notifications';

describe('buildStageNotificationEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorage.getAutomationConfig.mockResolvedValue(undefined);
    mockStorage.checkEmailDedupeKey.mockResolvedValue(false);
    mockStorage.createEmailSendLog.mockResolvedValue({});
    mockStorage.createAuditLog.mockResolvedValue({});
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
          'stage_notify:bb_internal_review:321010655946:Estimate in Progress:Estimate Under Review',
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
});
