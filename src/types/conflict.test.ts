import { describe, expect, it } from 'vitest';
import './conflict';
import type { CouncilVerdict, FilePatch, MergeResult } from './conflict';

describe('conflict contract owner', () => {
  it('keeps patch merge and council verdict shapes composable', () => {
    const patch: FilePatch = {
      path: 'src/example.ts',
      before: null,
      after: 'export const value = 1;\n',
    };
    const merge: MergeResult = {
      patches: [patch],
      needsArbitration: [],
      sources: ['object'],
    };
    const verdict: CouncilVerdict = {
      verdict: 'accept',
      councillors: [{ name: 'reviewer', reply: 'safe' }],
      consensus: 'unanimous',
      partialFailure: false,
    };

    expect(merge.patches[0]).toEqual(patch);
    expect(merge.needsArbitration).toEqual([]);
    expect(verdict.consensus).toBe('unanimous');
  });
});
