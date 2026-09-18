import { describe, expect, it } from 'vitest';
import vectors from './command-policy-vectors.json';
import { parseWorkerCommand } from './commandPolicy';

describe('worker command policy', () => {
  it('rejects unscoped git diff content and accepts explicit scoped pathspecs', () => {
    expect(parseWorkerCommand(['git', 'diff', 'HEAD'])).toEqual({
      ok: false,
      error: 'git diff content requires explicit non-protected pathspecs',
    });
    expect(parseWorkerCommand(['git', 'diff', '--name-only', 'HEAD'])).toEqual({
      ok: true,
      intent: { kind: 'git-names-only', revision: 'HEAD' },
    });
    expect(parseWorkerCommand([
      'git',
      'diff',
      'HEAD',
      '--',
      'src/components',
      'src/nodes',
      'docs',
    ])).toEqual({
      ok: true,
      intent: {
        kind: 'git-diff-scoped',
        revision: 'HEAD',
        pathspecs: ['src/components', 'src/nodes', 'docs'],
      },
    });
  });

  it('parses grep option arguments before the pattern boundary', () => {
    expect(parseWorkerCommand(['grep', '-e', '-x', 'src/orchestrator/run.ts'])).toEqual({
      ok: false,
      error: 'grep option arguments must be explicit and safe',
    });
    expect(parseWorkerCommand(['grep', '-n', '--', 'needle', 'src/components/App.tsx'])).toEqual({
      ok: true,
      intent: {
        kind: 'grep-files',
        pattern: 'needle',
        files: ['src/components/App.tsx'],
      },
    });
  });

  it('rejects symlink-following and external-root find modes', () => {
    expect(parseWorkerCommand(['find', '-L', 'src/components', '-name', '*.tsx'])).toEqual({
      ok: false,
      error: 'find traversal mode is not safe',
    });
    expect(parseWorkerCommand(['find', '-files0-from=/outside/list', '-name', '*.tsx'])).toEqual({
      ok: false,
      error: 'find traversal mode is not safe',
    });
    expect(parseWorkerCommand(['find', '-P', 'src/components', '-name', '*.tsx'])).toEqual({
      ok: true,
      intent: {
        kind: 'find',
        roots: ['src/components'],
      },
    });
  });

  it('keeps tsx execution inside scripts and rejects traversal extras', () => {
    expect(parseWorkerCommand(['tsx', 'scripts/../src/components/App.tsx'])).toEqual({
      ok: false,
      error: 'tsx script path is not safe',
    });
    expect(parseWorkerCommand(['tsx', 'scripts/check.ts', '../outside'])).toEqual({
      ok: false,
      error: 'tsx argument is not safe',
    });
    expect(parseWorkerCommand(['tsx', 'scripts/check.ts', '--reporter=dot'])).toEqual({
      ok: true,
      intent: {
        kind: 'tsx-script',
        script: 'scripts/check.ts',
        args: ['--reporter=dot'],
      },
    });
  });

  it('keeps the parity vectors executable', () => {
    for (const vector of vectors) {
      expect(parseWorkerCommand(vector.command).ok, vector.name).toBe(vector.accepted);
    }
  });
});
