import { describe, expect, it } from 'vitest';
import {
  createAttemptId,
  createTaskExecutionId,
} from './execution';

describe('execution identity', () => {
  it('creates stable collision-safe ids from run and task identities', () => {
    const taskExecutionId = createTaskExecutionId('run:1', 'task/1');

    expect(taskExecutionId).toBe('task-execution:run%3A1:task%2F1');
    expect(createTaskExecutionId('run:1', 'task/1')).toBe(taskExecutionId);
    expect(createAttemptId(taskExecutionId, 2)).toBe(`${taskExecutionId}:attempt-2`);
  });

  it('rejects empty identities and invalid attempt numbers', () => {
    expect(() => createTaskExecutionId('', 'task-1')).toThrow(/run id/);
    expect(() => createTaskExecutionId('run-1', '  ')).toThrow(/task id/);
    expect(() => createAttemptId('task-execution:run-1:task-1', 0)).toThrow(/attempt/);
    expect(() => createAttemptId('task-execution:run-1:task-1', 1.5)).toThrow(/attempt/);
  });
});
