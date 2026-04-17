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
      cc: ['adnaan.iqbal@gmail.com', 'bbell@trockgc.com'],
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

  it('logs one row per actual stage-notification delivery with provider and final recipients', async () => {
    mockSendEmail
      .mockResolvedValueOnce({
        success: true,
        provider: 'outlook',
        to: 'sgibson@trockgc.com',
        cc: ['adnaan.iqbal@gmail.com', 'bbell@trockgc.com'],
      })
      .mockResolvedValueOnce({
        success: true,
        provider: 'gmail',
        to: 'jhelms@trockgc.com',
        cc: ['adnaan.iqbal@gmail.com', 'bbell@trockgc.com'],
      });

    const result = await processStageNotification({
      stage: 'Estimate Under Review',
      source: 'bidboard',
      projectName: 'Test: 4/17/26 v1',
      oldStage: 'Estimate in Progress',
      bidboardProjectId: '562949955723964',
      hubspotDealId: '321010655946',
    });

    expect(result).toMatchObject({ sent: 2, skipped: false, route: 'bb_internal_review' });
    expect(mockStorage.createEmailSendLog).toHaveBeenCalledTimes(3);
    expect(mockStorage.createEmailSendLog).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        templateKey: 'stage_notify_bb_internal_review',
        recipientEmail: 'sgibson@trockgc.com',
        metadata: expect.objectContaining({
          provider: 'outlook',
          finalTo: 'sgibson@trockgc.com',
          finalCc: ['adnaan.iqbal@gmail.com', 'bbell@trockgc.com'],
        }),
      })
    );
    expect(mockStorage.createEmailSendLog).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        templateKey: 'stage_notify_bb_internal_review',
        recipientEmail: 'jhelms@trockgc.com',
        metadata: expect.objectContaining({
          provider: 'gmail',
          finalTo: 'jhelms@trockgc.com',
          finalCc: ['adnaan.iqbal@gmail.com', 'bbell@trockgc.com'],
        }),
      })
    );
    expect(mockStorage.createEmailSendLog).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        templateKey: 'stage_notify_bb_internal_review',
        recipientEmail: 'sgibson@trockgc.com, jhelms@trockgc.com',
        dedupeKey:
          'stage_notify:bb_internal_review:321010655946:Estimate in Progress:Estimate Under Review',
        metadata: expect.objectContaining({
          deliveryCount: 2,
        }),
      })
    );
  });
});
