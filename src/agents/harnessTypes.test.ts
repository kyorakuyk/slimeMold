import { describe, expect, it } from 'vitest';
import './harnessTypes';
import type { HarnessEvents } from './harnessTypes';

describe('harness event contract owner', () => {
  it('preserves observable event callback shape', () => {
    const events: HarnessEvents = {
      onThinking: ({ round }) => expect(round).toBe(1),
      onToolCall: ({ name }) => expect(name).toBe('read'),
      onOutput: (text, done) => expect([text, done]).toEqual(['ok', true]),
      onLog: (level, message) => expect([level, message]).toEqual(['info', 'done']),
    };

    events.onThinking?.({ round: 1, model: 'model' });
    events.onToolCall?.({ round: 1, name: 'read', args: {} });
    events.onOutput?.('ok', true);
    events.onLog?.('info', 'done');
  });
});
