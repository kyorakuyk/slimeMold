import { describe, expect, it } from 'vitest';
import { createProjectSaveQueue } from './projectSaveQueue';

describe('project save queue', () => {
  it('serializes saves for one key and does not block a different key', async () => {
    const queue = createProjectSaveQueue();
    const events: string[] = [];
    let release!: () => void;
    const first = queue.enqueue('project-a', async () => {
      events.push('a:first:start');
      await new Promise<void>((resolve) => { release = resolve; });
      events.push('a:first:end');
      return 'first';
    });
    const second = queue.enqueue('project-a', async () => {
      events.push('a:second');
      return 'second';
    });
    const other = queue.enqueue('project-b', async () => {
      events.push('b:first');
      return 'other';
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(['a:first:start', 'b:first']);
    release();
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    await expect(other).resolves.toBe('other');
    expect(events).toEqual(['a:first:start', 'b:first', 'a:first:end', 'a:second']);
  });

  it('continues the queue after a failed save', async () => {
    const queue = createProjectSaveQueue();
    const next = queue.enqueue('project-a', async () => { throw new Error('failed'); });
    const after = queue.enqueue('project-a', async () => 'after');
    await expect(next).rejects.toThrow('failed');
    await expect(after).resolves.toBe('after');
  });
});
