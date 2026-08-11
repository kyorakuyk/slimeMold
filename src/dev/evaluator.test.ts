import { describe, it, expect } from 'vitest';
import type { EvidenceRecord } from './evidence';
import { evaluateDevAcceptance, type AcceptanceRule } from './evaluator';

function ev(partial: Partial<EvidenceRecord> & Pick<EvidenceRecord, 'kind' | 'summary'>): EvidenceRecord {
  return {
    id: 'x',
    orchestrationId: 'o1',
    stageId: 's1',
    status: 'passed',
    capturedBy: 'host',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('H4 DevEvaluator', () => {
  it('test 规则：exitCode=0 通过；非零失败；无证据失败（不得把「没跑」当通过）', () => {
    const rules: AcceptanceRule[] = [
      { id: 'typecheck', kind: 'test', command: 'tsc --noEmit' },
      { id: 'vitest', kind: 'test', command: 'vitest run' },
    ];
    const ok = evaluateDevAcceptance(rules, [
      ev({ kind: 'test', command: 'tsc --noEmit', status: 'passed', exitCode: 0, summary: 'tsc' }),
      ev({ kind: 'test', command: 'vitest run', status: 'passed', exitCode: 0, summary: 'vt' }),
    ], []);
    expect(ok.passed).toBe(true);

    const fail = evaluateDevAcceptance(rules, [
      ev({ kind: 'test', command: 'tsc --noEmit', status: 'failed', exitCode: 2, summary: 'tsc' }),
    ], []);
    expect(fail.passed).toBe(false);
    // typecheck 有证据但退出码非零 → 失败；vitest 无证据 → 也失败（不得把「没跑」当通过）
    expect(fail.failedChecks).toEqual(['typecheck', 'vitest']);

    const none = evaluateDevAcceptance(rules, [], []);
    expect(none.passed).toBe(false);
  });

  it('path-policy 规则：passed 证据通过；touched 保护路径置入 changedProtectedPaths（负向证据）', () => {
    const rules: AcceptanceRule[] = [{ id: 'no-core-touch', kind: 'path-policy' }];
    const ok = evaluateDevAcceptance(rules, [
      ev({ kind: 'path-policy', status: 'passed', summary: '未触碰保护路径' }),
    ], []);
    expect(ok.passed).toBe(true);

    const bad = evaluateDevAcceptance(rules, [
      ev({ kind: 'path-policy', status: 'failed', summary: '触碰保护路径' }),
    ], ['src/orchestrator/run.ts']);
    expect(bad.passed).toBe(false);
    expect(bad.changedProtectedPaths).toContain('src/orchestrator/run.ts');
  });

  it('diff 规则：headRevision ≠ baseRevision 通过；无 diff 证据失败', () => {
    const rules: AcceptanceRule[] = [{ id: 'real-change', kind: 'diff' }];
    const ok = evaluateDevAcceptance(rules, [
      ev({ kind: 'diff', status: 'passed', baseRevision: 'a1', headRevision: 'a2', summary: '有改动' }),
    ], []);
    expect(ok.passed).toBe(true);

    const noChange = evaluateDevAcceptance(rules, [
      ev({ kind: 'diff', status: 'passed', baseRevision: 'a1', headRevision: 'a1', summary: '无改动' }),
    ], []);
    expect(noChange.passed).toBe(false);
  });

  it('uncertainties 只记录，不直接置失败', () => {
    const rules: AcceptanceRule[] = [{ id: 'r1', kind: 'command', command: 'echo ok' }];
    const out = evaluateDevAcceptance(
      rules,
      [ev({ kind: 'command', command: 'echo ok', status: 'passed', exitCode: 0, summary: 'ok' })],
      [],
      ['未能确认新功能是否接入 UI'],
    );
    expect(out.passed).toBe(true);
    expect(out.uncertainties).toEqual(['未能确认新功能是否接入 UI']);
  });
});
