import { describe, expect, it } from 'vitest';
import {
  createTypeScriptMvpScaffold,
  decodeFilePatchSet,
  type FilePatchSet,
} from './artifact';

describe('FilePatchSet domain contract', () => {
  it('creates a complete compilable TypeScript project scaffold as a patch candidate', () => {
    const result = createTypeScriptMvpScaffold('First MVP App');
    const paths = result.patchSet.patches.map((patch) => patch.path);

    expect(result.projectSpec).toMatchObject({
      name: 'first-mvp-app',
      runtime: 'node-typescript',
      packageManager: 'npm',
      compileCommand: ['npm', 'run', 'build'],
      testCommand: ['npm', 'run', 'test'],
    });
    expect(result.manifest.files).toEqual([
      { path: 'package.json', role: 'config', required: true },
      { path: 'tsconfig.json', role: 'config', required: true },
      { path: 'README.md', role: 'docs', required: true },
      { path: 'src/index.ts', role: 'source', required: true },
      { path: 'tests/index.test.ts', role: 'test', required: true },
    ]);
    expect(paths).toEqual(result.manifest.files.map((file) => file.path));
    expect(result.patchSet.source).toBe('scaffold');
    expect(result.patchSet.patches.every((patch) => patch.before === null && patch.after.length > 0)).toBe(true);

    const packagePatch = result.patchSet.patches.find((patch) => patch.path === 'package.json');
    expect(JSON.parse(packagePatch?.after ?? '{}')).toMatchObject({
      scripts: { build: 'tsc --noEmit', test: 'vitest run' },
    });
    expect(result.patchSet.patches.find((patch) => patch.path === 'src/index.ts')?.after).toContain('export function');
    expect(result.patchSet.patches.find((patch) => patch.path === 'tests/index.test.ts')?.after).toContain("from '../src/index'");
  });

  it('rejects a preimage hash when the patch declares a new file', () => {
    expect(() => decodeFilePatchSet({
      schemaVersion: 1,
      source: 'worker',
      summary: 'invalid new file hash',
      patches: [{ path: 'src/new.ts', before: null, beforeHash: 'h123', after: 'export {}\n' }],
    })).toThrow(/beforeHash|前置/);
  });

  it('round-trips a valid patch set and rejects unsafe or duplicate paths', () => {
    const { patchSet } = createTypeScriptMvpScaffold('round-trip');
    expect(decodeFilePatchSet(patchSet)).toEqual(patchSet);

    const unsafe = {
      ...patchSet,
      patches: [{ ...patchSet.patches[0], path: '../outside.ts' }],
    };
    expect(() => decodeFilePatchSet(unsafe)).toThrow(/路径|相对|越界/);

    const duplicate: FilePatchSet = {
      ...patchSet,
      patches: [patchSet.patches[0], { ...patchSet.patches[0] }],
    };
    expect(() => decodeFilePatchSet(duplicate)).toThrow(/重复/);
  });

  it('rejects absolute, backslash, metadata, and malformed patch paths', () => {
    const { patchSet } = createTypeScriptMvpScaffold('path-check');
    for (const path of ['/absolute.ts', 'C:/absolute.ts', 'src\\index.ts', 'src/\nindex.ts', '.slimemold/project.json', 'docs/.slimemold/project.json', '']) {
      expect(() => decodeFilePatchSet({
        ...patchSet,
        patches: [{ ...patchSet.patches[0], path }],
      })).toThrow();
    }
  });
});
