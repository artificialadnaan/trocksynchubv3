import { describe, expect, it } from 'vitest';
import { collectMappedRoleSyncProjectIds, mergeMappedRoleSyncProjects } from '../server/procore';

describe('collectMappedRoleSyncProjectIds', () => {
  it('prefers portfolio ids and ignores legacy bidboard ids stored in procoreProjectId', () => {
    const ids = collectMappedRoleSyncProjectIds([
      {
        portfolioProjectId: '59813432659125',
        procoreProjectId: '562949955724561',
        bidboardProjectId: '562949955724561',
        projectPhase: 'portfolio',
      } as any,
      {
        portfolioProjectId: null,
        procoreProjectId: '598134326568491',
        bidboardProjectId: '562949955723564',
        projectPhase: 'portfolio',
      } as any,
      {
        portfolioProjectId: null,
        procoreProjectId: '562949955700000',
        bidboardProjectId: '562949955700000',
        projectPhase: 'bidboard',
      } as any,
    ]);

    expect(ids).toEqual(['59813432659125', '598134326568491']);
    expect(ids).not.toContain('562949955724561');
    expect(ids).not.toContain('562949955723564');
    expect(ids).not.toContain('562949955700000');
  });

  it('hydrates an uncached mapped portfolio project into the polling set', async () => {
    const existing = new Map([
      ['598134326568560', { procoreId: '598134326568560', name: 'Vitruvian West' }],
    ]);

    const merged = await mergeMappedRoleSyncProjects(
      existing,
      [
        {
          portfolioProjectId: '59813432659125',
          procoreProjectId: '562949955724561',
          bidboardProjectId: '562949955724561',
          projectPhase: 'portfolio',
        } as any,
      ],
      async (projectId) => ({ procoreId: projectId, name: `resolved-${projectId}` }),
    );

    expect(Array.from(merged.keys())).toEqual(['598134326568560', '59813432659125']);
    expect(merged.get('59813432659125')).toEqual({
      procoreId: '59813432659125',
      name: 'resolved-59813432659125',
    });
    expect(merged.has('562949955724561')).toBe(false);
  });
});
