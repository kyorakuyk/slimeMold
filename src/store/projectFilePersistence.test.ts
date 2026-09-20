import { describe, expect, it, vi } from 'vitest';
import type { ProjectFile } from '../types';
import { persistProjectFile } from './projectFilePersistence';

const file = { id: 'project-1' } as ProjectFile;

describe('project file persistence', () => {
  it('flushes pending events against the root returned by ProjectFile save', async () => {
    const saveProjectFile = vi.fn(async () => 'C:/projects/actual-root');
    const flushPendingProjectEvents = vi.fn(async () => {});

    await expect(persistProjectFile(file, 'C:/projects/picked-root', {
      saveProjectFile,
      getPendingProjectEventCount: () => 1,
      flushPendingProjectEvents,
    })).resolves.toBe('C:/projects/actual-root');

    expect(saveProjectFile).toHaveBeenCalledWith(file, 'C:/projects/picked-root');
    expect(flushPendingProjectEvents).toHaveBeenCalledWith('project-1', 'C:/projects/actual-root');
  });

  it('skips event flush when there are no pending events', async () => {
    const saveProjectFile = vi.fn(async () => 'C:/projects/root');
    const flushPendingProjectEvents = vi.fn(async () => {});

    await expect(persistProjectFile(file, undefined, {
      saveProjectFile,
      getPendingProjectEventCount: () => 0,
      flushPendingProjectEvents,
    })).resolves.toBe('C:/projects/root');

    expect(flushPendingProjectEvents).not.toHaveBeenCalled();
  });

  it('propagates save and flush failures without converting them', async () => {
    const saveFailure = new Error('save failed');
    await expect(persistProjectFile(file, undefined, {
      saveProjectFile: async () => { throw saveFailure; },
      getPendingProjectEventCount: () => 1,
      flushPendingProjectEvents: async () => {},
    })).rejects.toBe(saveFailure);

    const flushFailure = new Error('flush failed');
    await expect(persistProjectFile(file, undefined, {
      saveProjectFile: async () => 'C:/projects/root',
      getPendingProjectEventCount: () => 1,
      flushPendingProjectEvents: async () => { throw flushFailure; },
    })).rejects.toBe(flushFailure);
  });
});
