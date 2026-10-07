import { describe, expect, it } from 'vitest';
import {
  normalizeAbsolutePath,
  pathComparisonKey,
  pathComparisonKeyWeb,
  pathsOverlap,
} from './path-utils';

describe('cross-platform path normalization', () => {
  it('keeps Windows drive paths absolute when evaluated by a POSIX host', () => {
    expect(normalizeAbsolutePath('D:/Temp/repo-workers/../repo')).toBe('D:/Temp/repo');
    expect(pathComparisonKey('C:/Repo/Worktree')).toBe('c:/repo/worktree');
    expect(pathComparisonKey('c:/repo/worktree')).toBe('c:/repo/worktree');
  });

  it('compares Windows verbatim drive paths with their ordinary path aliases', () => {
    const separator = String.fromCharCode(92);
    const canonical = `${separator}${separator}?${separator}D:${separator}Temp${separator}repo${separator}worktree`;
    const ordinary = 'D:/Temp/repo/worktree';

    expect(pathComparisonKey(canonical)).toBe(pathComparisonKey(ordinary));
    expect(pathComparisonKeyWeb(canonical)).toBe(pathComparisonKeyWeb(ordinary));
  });

  it('compares Windows verbatim UNC paths with their ordinary path aliases', () => {
    const separator = String.fromCharCode(92);
    const canonical = `${separator}${separator}?${separator}UNC${separator}server${separator}share${separator}repo`;
    const ordinary = '//server/share/repo';

    expect(pathComparisonKey(canonical)).toBe(pathComparisonKey(ordinary));
    expect(pathComparisonKeyWeb(canonical)).toBe(pathComparisonKeyWeb(ordinary));
  });

  it('applies Windows case-insensitive overlap rules independent of host OS', () => {
    expect(pathsOverlap(
      'C:/Repo/Worktree/.slimemold/evidence',
      'c:/repo/worktree',
    )).toBe(true);
    expect(pathsOverlap('D:/repo/.slimemold/evidence', 'D:/repo-workers/task-1')).toBe(false);
  });
});