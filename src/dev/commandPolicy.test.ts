import { describe, expect, it } from 'vitest';
import vectors from './command-policy-vectors.json';
import { buildSafeGitDiffArgs, parseWorkerCommand } from './commandPolicy';

describe('worker command policy', () => {
  it('rejects unscoped git diff content and accepts explicit scoped pathspecs', () => {
    expect(parseWorkerCommand(['git', 'diff', 'HEAD'])).toEqual({
      ok: false,
      error: 'git diff content requires explicit non-protected pathspecs',
    });
    expect(parseWorkerCommand(['git', 'diff', '--name-only', 'HEAD'])).toEqual({
      ok: false,
      error: 'git diff content requires explicit non-protected pathspecs',
    });
    expect(parseWorkerCommand(['git', 'diff', '--name-only', 'HEAD', '--'])).toEqual({
      ok: true,
      intent: { kind: 'git-names-only', revision: 'HEAD', pathspecs: [] },
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
    expect(parseWorkerCommand(['grep', '-e', '', 'src/components/App.tsx'])).toEqual({
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
    expect(parseWorkerCommand(['grep', 'needle', '--file=/outside'])).toEqual({
      ok: false,
      error: 'grep file operands are not safe',
    });
  });

  it('rejects symlink-following, actions, and external-root find modes', () => {
    expect(parseWorkerCommand(['find', '-L', 'src/components', '-name', '*.tsx'])).toEqual({
      ok: false,
      error: 'find traversal mode is not safe',
    });
    expect(parseWorkerCommand(['find', '-H', 'src/components', '-name', '*.tsx'])).toEqual({
      ok: false,
      error: 'find traversal mode is not safe',
    });
    expect(parseWorkerCommand(['find', '-follow', 'src/components', '-name', '*.tsx'])).toEqual({
      ok: false,
      error: 'find traversal mode is not safe',
    });
    expect(parseWorkerCommand(['find', '-files0-from=/outside/list', '-name', '*.tsx'])).toEqual({
      ok: false,
      error: 'find traversal mode is not safe',
    });
    expect(parseWorkerCommand(['find', '-P', 'src/components', '-exec', 'cat', '{}', ';'])).toEqual({
      ok: false,
      error: 'find traversal mode is not safe',
    });
    expect(parseWorkerCommand(['find', 'src/components', 'src/orchestrator', '-name', '*.tsx'])).toEqual({
      ok: false,
      error: 'find roots are not safe',
    });
    expect(parseWorkerCommand(['find', '-P', 'src/components', '-name', '*.tsx'])).toEqual({
      ok: true,
      intent: {
        kind: 'find',
        roots: ['src/components'],
        predicates: ['-name', '*.tsx'],
      },
    });
    const excessiveUnary = ['find', 'src/components', ...Array.from({ length: 129 }, () => '!'), '-name', '*.tsx'];
    expect(parseWorkerCommand(excessiveUnary)).toEqual({
      ok: false,
      error: 'find traversal mode is not safe',
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
    expect(parseWorkerCommand(['tsx', 'scripts/check.ts', '--tsconfig=/outside/tsconfig.json'])).toEqual({
      ok: false,
      error: 'tsx argument is not safe',
    });
    expect(parseWorkerCommand(['tsx', 'scripts/check.ts', '/outside/config.json'])).toEqual({
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

  it('builds config-independent Git diff argv', () => {
    const parsed = parseWorkerCommand(['git', 'diff', 'HEAD', '--', 'src/components']);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.intent.kind === 'git-diff-scoped') {
      expect(buildSafeGitDiffArgs(parsed.intent)).toEqual([
        'git', '--no-pager', 'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', 'src/components',
      ]);
    }
  });

  it('rejects malformed and oversized runtime command arrays', () => {
    const sparse = [] as unknown[];
    sparse[0] = 'cat';
    sparse[2] = 'src/components/App.tsx';
    expect(parseWorkerCommand(sparse as string[]).ok).toBe(false);
    expect(parseWorkerCommand(['cat', null] as unknown as string[]).ok).toBe(false);
    const inheritedGetter = new Array(2) as unknown[];
    let inheritedGetterRead = false;
    inheritedGetter[0] = 'cat';
    Object.setPrototypeOf(inheritedGetter, {
      get 1() {
        inheritedGetterRead = true;
        return 'src/components/App.tsx';
      },
    });
    expect(parseWorkerCommand(inheritedGetter as string[]).ok).toBe(false);
    expect(inheritedGetterRead).toBe(false);
    const ownAccessor = ['cat', 'src/components/App.tsx'] as unknown[];
    Object.defineProperty(ownAccessor, '1', { configurable: true, get: () => 'NUL' });
    expect(parseWorkerCommand(ownAccessor as string[]).ok).toBe(false);
    const revoked = Proxy.revocable(['cat', 'src/components/App.tsx'], {});
    revoked.revoke();
    expect(() => parseWorkerCommand(revoked.proxy as string[])).not.toThrow();
    expect(parseWorkerCommand(revoked.proxy as string[]).ok).toBe(false);
    const throwingLength = new Proxy(['cat', 'src/components/App.tsx'], {
      get(target, property, receiver) {
        if (property === 'length') throw new Error('length trap');
        return Reflect.get(target, property, receiver);
      },
    });
    expect(parseWorkerCommand(throwingLength as string[]).ok).toBe(false);
    const fractionalLength = new Proxy(['cat', 'src/components/App.tsx'], {
      get(target, property, receiver) {
        if (property === 'length') return 1.5;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(parseWorkerCommand(fractionalLength as string[]).ok).toBe(false);
    let shrinkingReads = 0;
    const shrinkingLength = new Proxy(['cat', 'src/components/App.tsx'], {
      get(target, property, receiver) {
        if (property === 'length') return shrinkingReads++ === 0 ? 2 : 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(parseWorkerCommand(shrinkingLength as string[]).ok).toBe(false);
    let growingReads = 0;
    const growingLength = new Proxy(['cat'], {
      get(target, property, receiver) {
        if (property === 'length') return growingReads++ === 0 ? 1 : 2;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(parseWorkerCommand(growingLength as string[]).ok).toBe(false);
    const shadowedMethods = ['cat', 'src/components/App.tsx'] as string[];
    Object.defineProperty(shadowedMethods, 'slice', { configurable: true, value: null });
    expect(parseWorkerCommand(shadowedMethods)).toEqual({
      ok: true,
      intent: { kind: 'read-files', command: 'cat', files: ['src/components/App.tsx'] },
    });
    expect(parseWorkerCommand(['grep', String.fromCharCode(0xD800), 'src/components/App.tsx']).ok).toBe(false);
    expect(parseWorkerCommand(['cat', 'x'.repeat(4096)]).ok).toBe(true);
    expect(parseWorkerCommand(['cat', 'x'.repeat(4097)]).ok).toBe(false);
    const totalAtLimit = ['cat', ...Array.from({ length: 7 }, () => 'x'.repeat(4096)), 'x'.repeat(4093)];
    const totalOverLimit = ['cat', ...Array.from({ length: 7 }, () => 'x'.repeat(4096)), 'x'.repeat(4094)];
    expect(parseWorkerCommand(totalAtLimit).ok).toBe(true);
    expect(parseWorkerCommand(totalOverLimit).ok).toBe(false);
  });

  it('keeps the parity vectors executable', () => {
    for (const vector of vectors) {
      const result = parseWorkerCommand(vector.command);
      expect(result.ok, vector.name).toBe(vector.accepted);
      if (vector.accepted) {
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.intent.kind, vector.name).toBe(vector.intentKind);
      }
    }
  });
});
