import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNodeDevService } from './capabilities';
import { applyFilePatchSet } from './patch-set';
import { pathComparisonKey } from './path-utils';
import { createTypeScriptMvpScaffold } from '../domain/model/artifact';
import { withTestArtifactRoot } from './test-artifacts';

const fixturePolicy = {
  allowedPaths: ['src', 'tests', 'package.json', 'tsconfig.json', 'README.md'],
  protectedPaths: [],
  requireApprovalFor: [],
  autoTest: true,
  autoCommit: false,
  autoPush: false,
};

describe('applyFilePatchSet real filesystem integration', () => {
  it('materializes the scaffold inside a tracked disposable worktree and reads every file back', async () => {
    await withTestArtifactRoot('patch-apply-real-fs', async (root) => {
      const worktreePath = join(root, 'worktree');
      await mkdir(worktreePath, { recursive: true });
      const worktreeKey = pathComparisonKey(resolve(worktreePath));
      const service = createNodeDevService(fixturePolicy, {}, {
        isTracked: (cwd) => pathComparisonKey(cwd) === worktreeKey,
      });
      const scaffold = createTypeScriptMvpScaffold('real-fs-mvp');

      const result = await applyFilePatchSet(scaffold.patchSet, service, { cwd: worktreePath });

      expect(result.appliedPaths).toEqual(scaffold.manifest.files.map((file) => file.path));
      for (const patch of scaffold.patchSet.patches) {
        await expect(readFile(join(worktreePath, patch.path), 'utf8')).resolves.toBe(patch.after);
      }
    });
  });
});
