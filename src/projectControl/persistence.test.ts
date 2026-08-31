import { describe, expect, it } from 'vitest';
import type { ProjectControlSnapshot } from './types';
import {
  createEmptyProjectControlSnapshot,
  parseProjectControlSnapshot,
  serializeProjectControlSnapshot,
} from './persistence';

const valid: ProjectControlSnapshot = {
  version: 1,
  activeSessionId: 'session-1',
  sessions: [
    {
      version: 1,
      id: 'session-1',
      projectId: 'project-1',
      status: 'brief-review',
      messages: [],
      openQuestions: [],
      decisionIds: ['decision-1'],
      briefId: 'brief-1',
      createdAt: '2026-08-31T03:00:00.000Z',
      updatedAt: '2026-08-31T03:01:00.000Z',
    },
  ],
  decisions: [],
  briefs: [],
  architectures: [],
  issues: [],
};

describe('ProjectControl persistence', () => {
  it('creates an empty snapshot with no active session', () => {
    expect(createEmptyProjectControlSnapshot()).toEqual({
      version: 1,
      activeSessionId: null,
      sessions: [],
      decisions: [],
      briefs: [],
      architectures: [],
      issues: [],
    });
  });

  it('round-trips a valid snapshot without changing its data', () => {
    const restored = parseProjectControlSnapshot(serializeProjectControlSnapshot(valid));

    expect(restored).toEqual(valid);
    expect(restored).not.toBe(valid);
  });

  it('safely falls back to an empty snapshot for missing or malformed data', () => {
    expect(parseProjectControlSnapshot(undefined)).toEqual(createEmptyProjectControlSnapshot());
    expect(parseProjectControlSnapshot(null)).toEqual(createEmptyProjectControlSnapshot());
    expect(parseProjectControlSnapshot('{"version":1,"sessions":"bad"}')).toEqual(
      createEmptyProjectControlSnapshot(),
    );
    expect(parseProjectControlSnapshot('{not-json')).toEqual(createEmptyProjectControlSnapshot());
  });

  it('drops an active session reference that does not exist', () => {
    const restored = parseProjectControlSnapshot({ ...valid, activeSessionId: 'missing' });

    expect(restored.activeSessionId).toBeNull();
    expect(restored.sessions).toHaveLength(1);
    expect(restored.architectures).toEqual([]);
  });
});
