import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearRecentProjects,
  getRecentProjects,
  pushRecentProject,
  removeRecentProject,
} from './projectIO';

describe('recent project history', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('deduplicates the same Windows directory when separators differ', () => {
    pushRecentProject({
      name: 'SMtest',
      path: 'D:\\Agents\\SMtest',
      openedAt: '2026-08-30T02:12:00.000Z',
    });
    pushRecentProject({
      name: 'SMtest',
      path: 'D:/Agents/SMtest',
      openedAt: '2026-08-30T02:13:00.000Z',
    });

    expect(getRecentProjects()).toEqual([
      {
        name: 'SMtest',
        path: 'D:/Agents/SMtest',
        openedAt: '2026-08-30T02:13:00.000Z',
      },
    ]);
  });

  it('removes only the invalid recent project instead of clearing all history', () => {
    pushRecentProject({
      name: 'SMtest',
      path: 'D:/Agents/SMtest',
      openedAt: '2026-08-30T02:12:00.000Z',
    });
    pushRecentProject({
      name: '2048',
      path: 'D:/Agents/2048',
      openedAt: '2026-08-30T02:11:00.000Z',
    });

    removeRecentProject('D:\\Agents\\SMtest');

    expect(getRecentProjects()).toEqual([
      {
        name: '2048',
        path: 'D:/Agents/2048',
        openedAt: '2026-08-30T02:11:00.000Z',
      },
    ]);
  });

  it('clears the complete history only when explicitly requested', () => {
    pushRecentProject({
      name: 'SMtest',
      path: 'D:/Agents/SMtest',
      openedAt: '2026-08-30T02:12:00.000Z',
    });

    clearRecentProjects();

    expect(getRecentProjects()).toEqual([]);
  });
});
