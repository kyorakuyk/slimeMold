import { describe, expect, it } from 'vitest';
import {
  assertTaskExecutionLineage,
  createAttemptId,
  createTaskExecutionId,
  parseAttemptId,
  workerIdentitySegment,
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
    expect(() => createTaskExecutionId(' run-1', 'task-1')).toThrow(/canonical|空白/);
    expect(() => createAttemptId('task-execution:run-1:task-1:extra', 1)).toThrow(/canonical|execution/);
    expect(() => createAttemptId('task-execution:run-1:task-1', Number.MAX_SAFE_INTEGER + 1)).toThrow(/attempt/);
  });

  it('parses and validates the complete execution lineage', () => {
    const taskExecutionId = createTaskExecutionId('run-1', 'task-1');
    const attemptId = createAttemptId(taskExecutionId, 2);

    expect(parseAttemptId(attemptId)).toEqual({ taskExecutionId, attempt: 2 });
    expect(assertTaskExecutionLineage({ runId: 'run-1', taskId: 'task-1', taskExecutionId, attemptId, attempt: 2 }))
      .toEqual({ taskExecutionId, attempt: 2 });
    expect(() => assertTaskExecutionLineage({
      runId: 'run-1',
      taskId: 'task-1',
      taskExecutionId,
      attemptId: createAttemptId(taskExecutionId, 1),
      attempt: 2,
    })).toThrow(/lineage|attempt/);
  });

  it('encodes canonical attempt identities with Git-safe characters', () => {
    const taskExecutionId = createTaskExecutionId('run/1', 'task/1');
    const attemptId = createAttemptId(taskExecutionId, 2);
    const identity = workerIdentitySegment(attemptId);

    expect(identity).toMatch(/^w-[0-9a-f]+$/);
    expect(identity).not.toContain('%');
    expect(workerIdentitySegment(attemptId)).toBe(identity);
    expect(workerIdentitySegment(createAttemptId(createTaskExecutionId('run-1', 'task/1'), 2)))
      .not.toBe(identity);
  });

  it('compresses long canonical identities into a bounded worker basename', () => {
    const taskExecutionId = createTaskExecutionId('r'.repeat(180), 'task-1');
    const attemptId = createAttemptId(taskExecutionId, 1);
    const identity = workerIdentitySegment(attemptId);

    expect(identity).toMatch(/^w-[0-9a-f]+$/);
    expect(identity.length).toBeLessThanOrEqual(200);
  });
});
