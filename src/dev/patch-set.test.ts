import { describe, expect, it, vi } from 'vitest';
import { applyUnifiedPatch, type DevCapabilityService, type DevContext } from './capabilities';
import { applyFilePatchSet } from './patch-set';
import {
  FILE_PATCH_SET_SCHEMA_VERSION,
  createTypeScriptMvpScaffold,
  type FilePatchSet,
} from '../domain/model/artifact';

function fingerprint(content: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) hash = ((hash << 5) + hash + content.charCodeAt(i)) >>> 0;
  return `h${hash.toString(36)}`;
}

function fakeHost(initial: Record<string, string> = {}): {
  files: Map<string, string>;
  service: Pick<DevCapabilityService, 'codeRead' | 'codePatch'>;
  patchCalls: ReturnType<typeof vi.fn>;
} {
  const files = new Map(Object.entries(initial));
  const patchCalls = vi.fn();
  const service: Pick<DevCapabilityService, 'codeRead' | 'codePatch'> = {
    codeRead: async (path: string) => {
      const content = files.get(path);
      if (content === undefined) {
        const error = Object.assign(new Error(`not found: ${path}`), { code: 'ENOENT' });
        throw error;
      }
      return { content, lineCount: content.split('\n').length };
    },
    codePatch: async (path: string, unifiedDiff: string) => {
      patchCalls(path, unifiedDiff);
      const current = files.get(path) ?? '';
      const applied = applyUnifiedPatch(current, unifiedDiff);
      if (!applied.ok) return { ok: false, error: applied.error };
      files.set(path, applied.result ?? '');
      return { ok: true, contentHash: fingerprint(applied.result ?? '') };
    },
  };
  return { files, service, patchCalls };
}

const ctx: DevContext = { cwd: '/worker' };

function patchSet(patches: FilePatchSet['patches']): FilePatchSet {
  return {
    schemaVersion: FILE_PATCH_SET_SCHEMA_VERSION,
    source: 'worker',
    summary: 'apply test patch set',
    patches,
  };
}

describe('applyFilePatchSet', () => {
  it('preflights all files, applies the set in the worktree, and verifies read-back', async () => {
    const host = fakeHost({ 'src/index.ts': 'export const value = 1;\n' });
    const result = await applyFilePatchSet(
      patchSet([
        {
          path: 'src/index.ts',
          before: 'export const value = 1;\n',
          after: 'export const value = 2;\n',
        },
        {
          path: 'tests/index.test.ts',
          before: null,
          after: "import { value } from '../src/index';\n\nconsole.log(value);\n",
        },
      ]),
      host.service,
      ctx,
    );

    expect(result.appliedPaths).toEqual(['src/index.ts', 'tests/index.test.ts']);
    expect(result.contentHashes).toEqual({
      'src/index.ts': fingerprint('export const value = 2;\n'),
      'tests/index.test.ts': fingerprint("import { value } from '../src/index';\n\nconsole.log(value);\n"),
    });
    expect(host.files.get('src/index.ts')).toBe('export const value = 2;\n');
    expect(host.files.get('tests/index.test.ts')).toContain("from '../src/index'");
    expect(host.patchCalls).toHaveBeenCalledTimes(2);
  });

  it('materializes the complete project.scaffold candidate as five real host files', async () => {
    const host = fakeHost();
    const scaffold = createTypeScriptMvpScaffold('materialized-mvp');

    const result = await applyFilePatchSet(scaffold.patchSet, host.service, ctx);

    expect(result.appliedPaths).toEqual(scaffold.manifest.files.map((file) => file.path));
    for (const patch of scaffold.patchSet.patches) {
      expect(host.files.get(patch.path)).toBe(patch.after);
    }
  });

  it('does not write any file when a later preimage has drifted', async () => {
    const host = fakeHost({
      'src/index.ts': 'export const value = 1;\n',
      'src/other.ts': 'changed outside candidate;\n',
    });
    const candidate = patchSet([
      {
        path: 'src/index.ts',
        before: 'export const value = 1;\n',
        after: 'export const value = 2;\n',
      },
      {
        path: 'src/other.ts',
        before: 'original;\n',
        after: 'updated;\n',
      },
    ]);

    await expect(applyFilePatchSet(candidate, host.service, ctx)).rejects.toThrow(/preimage|前置|漂移/);
    expect(host.patchCalls).not.toHaveBeenCalled();
    expect(host.files.get('src/index.ts')).toBe('export const value = 1;\n');
    expect(host.files.get('src/other.ts')).toBe('changed outside candidate;\n');
  });

  it('rejects a mismatched preimage hash before the first write', async () => {
    const host = fakeHost({ 'src/index.ts': 'export const value = 1;\n' });
    const candidate = patchSet([
      {
        path: 'src/index.ts',
        before: 'export const value = 1;\n',
        beforeHash: 'wrong-hash',
        after: 'export const value = 2;\n',
      },
    ]);

    await expect(applyFilePatchSet(candidate, host.service, ctx)).rejects.toThrow(/hash|指纹/);
    expect(host.patchCalls).not.toHaveBeenCalled();
  });

  it('fails closed when the host rejects one patch and never returns a success result', async () => {
    const host = fakeHost({ 'src/index.ts': 'export const value = 1;\n' });
    const service = {
      ...host.service,
      codePatch: async () => ({ ok: false, error: 'host rejected patch' }),
    } satisfies Pick<DevCapabilityService, 'codeRead' | 'codePatch'>;

    await expect(
      applyFilePatchSet(
        patchSet([{ path: 'src/index.ts', before: 'export const value = 1;\n', after: 'export const value = 2;\n' }]),
        service,
        ctx,
      ),
    ).rejects.toThrow(/host rejected|补丁/);
  });
});
