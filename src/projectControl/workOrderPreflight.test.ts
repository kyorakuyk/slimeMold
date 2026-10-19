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
    expect(PREFLIGHT_PROMPT).toContain('只输出一个 JSON 数组');
    expect(PREFLIGHT_PROMPT).toContain('severity');
    expect(PREFLIGHT_PROMPT).toContain('blocking');
    expect(PREFLIGHT_PROMPT).toContain('minor');
    expect(PREFLIGHT_PROMPT).toContain('options');

    const first = workOrderDigest(workOrder);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(workOrderDigest(workOrder)).toBe(first);
    expect(workOrderDigest(`${workOrder}\n追加范围`)).not.toBe(first);
  });

  it('returns unknown for malformed JSON or an unsupported top-level shape', () => {
    expect(parsePreflightResponse('{invalid', workOrder)).toEqual({
      verdict: 'unknown',
      guessPoints: [],
      droppedCount: 0,
    });
    expect(parsePreflightResponse('{"guesses":[]}', workOrder)).toEqual({
      verdict: 'unknown',
      guessPoints: [],
      droppedCount: 0,
    });
  });

  it('reports unknown with dropped items when no guess point is valid', () => {
    const missingSeverity = [{
      quote: '验收标准：覆盖空输入与错误输入',
      question: '错误输入具体指哪些输入？',
      consequence: '可能影响验收范围',
    }];
    const invalidQuote = [{ ...blockingGuess, quote: '不是施工单原文' }];

    expect(parsePreflightResponse(JSON.stringify(missingSeverity), workOrder)).toEqual({
      verdict: 'unknown',
      guessPoints: [],
      droppedCount: 1,
    });
    expect(parsePreflightResponse(JSON.stringify(invalidQuote), workOrder)).toEqual({
      verdict: 'unknown',
      guessPoints: [],
      droppedCount: 1,
    });
  });

  it('judges valid blocking points and counts invalid entries', () => {
    const result = parsePreflightResponse(JSON.stringify([
      blockingGuess,
      { ...blockingGuess, quote: '不是施工单原文' },
    ]), workOrder);

    expect(result).toEqual({
      verdict: 'ambiguous',
      guessPoints: [blockingGuess],
      droppedCount: 1,
    });
  });

  it('parses one complete json fence but does not repair surrounding prose', () => {
    const fenced = `\`\`\`json\n${JSON.stringify([blockingGuess])}\n\`\`\``;

    expect(parsePreflightResponse(fenced, workOrder)).toEqual({
      verdict: 'ambiguous',
      guessPoints: [blockingGuess],
      droppedCount: 0,
    });
    expect(parsePreflightResponse(`答复：\n${fenced}`, workOrder)).toEqual({
      verdict: 'unknown',
      guessPoints: [],
      droppedCount: 0,
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
      droppedCount: 1,
    });
    expect(parsePreflightResponse('[]', workOrder)).toEqual({
      verdict: 'clear',
      guessPoints: [],
      droppedCount: 0,
    });
  });

  it('returns ambiguous when at least one valid quote is blocking', () => {
    expect(parsePreflightResponse(JSON.stringify([blockingGuess]), workOrder)).toEqual({
      verdict: 'ambiguous',
      guessPoints: [blockingGuess],
      droppedCount: 0,
    });
  });

  it('invalidates a record when the work-order digest changes', () => {
    const record = { workOrderDigest: workOrderDigest(workOrder) };
    expect(isPreflightCurrent(record, workOrderDigest(workOrder))).toBe(true);
    expect(isPreflightCurrent(record, workOrderDigest(`${workOrder}\n修订`))).toBe(false);
  });
});
