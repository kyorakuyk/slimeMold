import { describe, expect, it } from 'vitest';
import { applyMasterTurnCommand } from './masterTurn';
import { startProjectSessionCommand } from './session';

describe('master turn command owner', () => {
  it('records user/master messages and the completed turn as ordered private facts', () => {
    const started = startProjectSessionCommand({
      projectId: 'project-1',
      sessionId: 'session-1',
      issueId: 'issue-1',
      projectName: '项目',
      goal: '目标',
      now: '2026-09-01T00:00:00.000Z',
    });
    const result = applyMasterTurnCommand({
      snapshot: started.snapshot,
      sessionId: 'session-1',
      userMessage: '只做本地版本',
      response: {
        kind: 'question',
        reply: '我先确认范围。',
        questions: [{ id: 'q-scope', prompt: '是否需要云同步？' }],
      },
      now: '2026-09-01T00:01:00.000Z',
      createId: (() => {
        let next = 1;
        return (prefix: string) => `${prefix}-2-${next++}`;
      })(),
    });

    expect(result.events.map((event) => event.eventType)).toEqual([
      'SessionMessageRecorded',
      'SessionMessageRecorded',
      'MasterTurnCompleted',
    ]);
    expect(result.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(result.events[0]).toMatchObject({ actor: 'user', sensitivity: 'private' });
    expect(result.events[1]).toMatchObject({ actor: 'master', sensitivity: 'private' });
    expect(result.events[2]).toMatchObject({
      actor: 'master',
      payload: { sessionId: 'session-1', responseKind: 'question', questionIds: ['q-scope'] },
    });
    expect(result.snapshot.sessions[0].messages).toHaveLength(3);
  });
});
