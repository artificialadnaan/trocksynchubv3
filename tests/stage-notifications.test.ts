import { describe, expect, it } from 'vitest';
import { buildStageNotificationEmail } from '../server/stage-notifications';

describe('buildStageNotificationEmail', () => {
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
});
