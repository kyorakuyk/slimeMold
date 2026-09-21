import { describe, expect, it } from 'vitest';
import type { AssetMeta, RecentProject } from './project';

describe('project metadata contract owner', () => {
  it('keeps asset and recent-project metadata structurally usable', () => {
    const asset: AssetMeta = {
      id: 'asset-1',
      name: 'result.txt',
      path: null,
      kind: 'text',
      content: 'result',
      createdAt: '2026-09-01T00:00:00.000Z',
      inWorkspace: false,
    };
    const recent: RecentProject = {
      path: '/projects/demo',
      name: 'Demo',
      openedAt: asset.createdAt,
    };

    expect(asset.kind).toBe('text');
    expect(recent.path).toContain('demo');
  });
});
