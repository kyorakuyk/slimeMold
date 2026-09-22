import { describe, expect, it } from 'vitest';
import { normalizeAbsolutePath, pathComparisonKey, pathsOverlap } from './path-utils';

describe('cross-platform path normalization', () => {
  it('keeps Windows drive paths absolute when evaluated by a POSIX host', () => {
    expect(normalizeAbsolutePath('D:/Temp/repo-workers/../repo')).toBe('D:/Temp/repo');
    expect(pathComparisonKey('C:/Repo/Worktree')).toBe('c:/repo/worktree');
    expect(pathComparisonKey('c:/repo/worktree')).toBe('c:/repo/worktree');
  });

  it('applies Windows case-insensitive overlap rules independent of host OS', () => {
    expect(pathsOverlap(
      'C:/Repo/Worktree/.slimemold/evidence',
      'c:/repo/worktree',
    )).toBe(true);
    expect(pathsOverlap('D:/repo/.slimemold/evidence', 'D:/repo-workers/task-1')).toBe(false);
  });
});