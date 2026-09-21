import { describe, expect, it } from 'vitest';
import type { ExecContext } from '../../types/node';
import { builtinDefs } from '../builtin';
import { mvpNodes } from './index';

describe('MVP project nodes', () => {
  it('exposes a deterministic project.scaffold node that returns a complete patch candidate', async () => {
    const scaffold = mvpNodes.find((node) => node.typeId === 'project.scaffold');
    expect(scaffold).toBeDefined();
    expect(scaffold).toMatchObject({ role: 'architect', minCapability: 'compute' });

    const output = await scaffold!.execute(
      { projectName: 'First MVP App' },
      {},
      {} as ExecContext,
    );

    expect(output.projectSpec).toMatchObject({
      name: 'first-mvp-app',
      runtime: 'node-typescript',
    });
    expect(output.manifest).toMatchObject({
      files: expect.arrayContaining([
        { path: 'src/index.ts', role: 'source', required: true },
        { path: 'tests/index.test.ts', role: 'test', required: true },
      ]),
    });
    expect(output.patchSet).toMatchObject({
      source: 'scaffold',
      patches: expect.arrayContaining([
        expect.objectContaining({ path: 'package.json', before: null }),
      ]),
    });
  });

  it('rejects an empty project name rather than silently creating an ambiguous candidate', async () => {
    const scaffold = mvpNodes.find((node) => node.typeId === 'project.scaffold');
    await expect(scaffold!.execute({ projectName: '   ' }, {}, {} as ExecContext)).rejects.toThrow(/项目名称/);
  });

  it('is included in the builtin registry used by the application', () => {
    expect(builtinDefs.some((node) => node.typeId === 'project.scaffold')).toBe(true);
  });
});
