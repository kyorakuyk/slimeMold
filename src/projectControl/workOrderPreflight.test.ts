import { describe, expect, it } from 'vitest';
import {
  PREFLIGHT_PROMPT,
  isPreflightCurrent,
  parsePreflightResponse,
  workOrderDigest,
} from './workOrderPreflight';

const workOrder = '任务标题：调整路由\n验收标准：覆盖空输入与错误输入';

const blockingGuess = {
  quote: '验收标准：覆盖空输入与错误输入',
  question: '错误输入具体指哪些输入？',
  consequence: '可能影响验收范围',
  severity: 'blocking',
  options: ['格式错误', '字段缺失'],
};

describe('work-order preflight pure rules', () => {
  it('keeps the approved prompt core and computes a deterministic digest', () => {
    expect(PREFLIGHT_PROMPT).toContain('不要写代码，也不要给方案');
    expect(PREFLIGHT_PROMPT).toContain('quote：施工单里引起猜测的原文（逐字复制）');
    expect(PREFLIGHT_PROMPT).toContain('只输出 JSON。');

    const first = workOrderDigest(workOrder);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(workOrderDigest(workOrder)).toBe(first);
    expect(workOrderDigest(`${workOrder}\n追加范围`)).not.toBe(first);
  });

  it('returns unknown for malformed JSON or an unsupported top-level shape', () => {
    expect(parsePreflightResponse('{invalid', workOrder)).toEqual({
      verdict: 'unknown',
      guessPoints: [],
    });
    expect(parsePreflightResponse('{"guesses":[]}', workOrder)).toEqual({
      verdict: 'unknown',
      guessPoints: [],
    });
  });

  it('drops quotes that are not exact work-order substrings', () => {
    const result = parsePreflightResponse(JSON.stringify([
      { ...blockingGuess, quote: '施工单里没有这句话' },
      { ...blockingGuess, severity: 'minor' },
    ]), workOrder);

    expect(result).toEqual({
      verdict: 'clear',
      guessPoints: [{ ...blockingGuess, severity: 'minor' }],
    });
    expect(parsePreflightResponse('[]', workOrder)).toEqual({ verdict: 'clear', guessPoints: [] });
  });

  it('returns ambiguous when at least one valid quote is blocking', () => {
    expect(parsePreflightResponse(JSON.stringify([blockingGuess]), workOrder)).toEqual({
      verdict: 'ambiguous',
      guessPoints: [blockingGuess],
    });
  });

  it('invalidates a record when the work-order digest changes', () => {
    const record = { workOrderDigest: workOrderDigest(workOrder) };
    expect(isPreflightCurrent(record, workOrderDigest(workOrder))).toBe(true);
    expect(isPreflightCurrent(record, workOrderDigest(`${workOrder}\n修订`))).toBe(false);
  });
});
