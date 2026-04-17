import { describe, expect, it } from 'vitest';
import { normalizeOutgoingEmailHtml } from '../server/email-service';

describe('normalizeOutgoingEmailHtml', () => {
  it('adds background-color fallbacks for gradient backgrounds', () => {
    const html = normalizeOutgoingEmailHtml(
      '<div style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);">Card</div>'
    );

    expect(html).toContain('background-color: #1a1a2e;');
    expect(html).toContain('background-image: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);');
  });

  it('replaces red CTA glow with a real border', () => {
    const html = normalizeOutgoingEmailHtml(
      '<a style="background: linear-gradient(135deg, #d11921 0%, #b71c1c 100%); box-shadow: 0 4px 14px rgba(209, 25, 33, 0.4);">Open</a>'
    );

    expect(html).toContain('border: 2px solid #b71c1c;');
    expect(html).not.toContain('box-shadow: 0 4px 14px rgba(209, 25, 33, 0.4);');
  });
});
