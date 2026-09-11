import { describe, expect, it } from 'vitest';
import {
  assertAllowedSandboxLane,
  assertSandboxIdentifier,
  assertSandboxRelativePath,
  encodeSandboxIdentifier,
} from './sandboxPath';

describe('sandbox path boundaries', () => {
  it('allows nested relative paths and normalizes Windows separators', () => {
    expect(assertSandboxRelativePath('deliverables\\report.md')).toBe('deliverables/report.md');
  });

  it.each([
    '../secret',
    '..\\secret',
    '/absolute',
    'C:\\secret',
    '//server/share',
    'a/../b',
    'a:stream',
    'folder/.. /secret',
    'folder/file. ',
    'CON',
    'report?.md',
  ])('rejects path escape %s', (value) => {
    expect(() => assertSandboxRelativePath(value)).toThrow();
  });

  it('requires node and lane ids to be single path components', () => {
    expect(assertSandboxIdentifier('node-1', 'node')).toBe('node-1');
    expect(assertSandboxIdentifier('subgraph::node', 'node')).toBe('subgraph::node');
    expect(encodeSandboxIdentifier('subgraph::node', 'node')).toMatch(/^id-[0-9a-f-]+$/);
    expect(() => assertSandboxIdentifier('node/other', 'node')).toThrow();
  });

  it('only allows host-declared lanes', () => {
    const allowed = new Set(['worker-a', 'worker-b']);
    expect(assertAllowedSandboxLane('worker-a', allowed)).toBe('worker-a');
    expect(() => assertAllowedSandboxLane('worker-c', allowed)).toThrow(/未获宿主授权/);
    expect(() => assertAllowedSandboxLane('../worker-a', allowed)).toThrow();
  });
});
