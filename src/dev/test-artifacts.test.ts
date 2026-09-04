import { access, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestArtifactRoot, withTestArtifactRoot } from './test-artifacts';

describe('test artifact roots', () => {
  it('creates generated files under a dedicated root outside the repository cwd', async () => {
    const root = await createTestArtifactRoot('evidence');
    try {
      const normalized = resolve(root).replace(/\\/g, '/');
      expect(normalized).toMatch(/[/\\]slimemold-test-runs[/\\]evidence-/);
      expect(normalized).not.toBe(resolve(process.cwd()));
      await writeFile(join(root, 'marker.txt'), 'ok', 'utf8');
      await expect(access(join(root, 'marker.txt'))).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('cleans the dedicated root when the callback fails', async () => {
    let root = '';
    await expect(
      withTestArtifactRoot('failure', async (createdRoot) => {
        root = createdRoot;
        await writeFile(join(createdRoot, 'partial.txt'), 'partial', 'utf8');
        throw new Error('intentional test failure');
      }),
    ).rejects.toThrow('intentional test failure');

    expect(root).not.toBe('');
    await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a repository-relative artifact root instead of recreating cwd clutter', async () => {
    await expect(createTestArtifactRoot('unsafe', { root: process.cwd() })).rejects.toThrow(/专有目录|仓库|cwd/);
  });
});
