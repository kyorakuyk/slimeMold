import { describe, it, expect, beforeEach } from 'vitest';
import {
  cacheKey,
  composeCacheScope,
  getCached,
  setCached,
  strike,
  clearCache,
  beginRun,
  countSkip,
  skippedCount,
  cacheStats,
  cacheSize,
} from './nodeCache';

beforeEach(() => {
  clearCache();
  beginRun();
});

describe('cacheKey', () => {
  it('相同 typeId/params/upstream 产生相同 key', () => {
    const a = cacheKey('llm', { model: 'gpt' }, { x: 1 });
    const b = cacheKey('llm', { model: 'gpt' }, { x: 1 });
    expect(a).toBe(b);
  });

  it('params 顺序不同但内容相同 → key 相同（稳定序列化）', () => {
    const a = cacheKey('n', { a: 1, b: 2 }, {});
    const b = cacheKey('n', { b: 2, a: 1 }, {});
    expect(a).toBe(b);
  });

  it('upstream 变化使 key 改变', () => {
    const a = cacheKey('n', {}, { x: 1 });
    const b = cacheKey('n', {}, { x: 2 });
    expect(a).not.toBe(b);
  });

  it('params 变化使 key 改变', () => {
    const a = cacheKey('n', { t: 0.5 }, {});
    const b = cacheKey('n', { t: 0.7 }, {});
    expect(a).not.toBe(b);
  });

  it('scope 维度隔离：同 typeId/params/upstream 不同 scope 产生不同 key', () => {
    const a = cacheKey('file.read', { p: '/a' }, { x: 1 }, 'wf-A');
    const b = cacheKey('file.read', { p: '/a' }, { x: 1 }, 'wf-B');
    expect(a).not.toBe(b);
  });

  it('scope 缺省与显式空串行为一致（向后兼容）', () => {
    const a = cacheKey('n', {}, {});
    const b = cacheKey('n', {}, {}, '');
    expect(a).toBe(b);
  });

  it('跨 scope 的 set/get 互不串缓存', () => {
    setCached(cacheKey('file.read', {}, {}, 'wf-A'), { path: '/A/out.txt' });
    setCached(cacheKey('file.read', {}, {}, 'wf-B'), { path: '/B/out.txt' });
    expect(getCached(cacheKey('file.read', {}, {}, 'wf-A'))).toEqual({ path: '/A/out.txt' });
    expect(getCached(cacheKey('file.read', {}, {}, 'wf-B'))).toEqual({ path: '/B/out.txt' });
    // 无 scope 的读取不命中任何带 scope 的条目
    expect(getCached(cacheKey('file.read', {}, {}))).toBeNull();
  });
});

describe('composeCacheScope 细粒度隔离（节点实例 + 环境指纹）', () => {
  it('过滤空段，用 : 连接', () => {
    expect(composeCacheScope('wf-A', 'n1', null)).toBe('wf-A:n1');
    expect(composeCacheScope('wf-A', '', 'ws')).toBe('wf-A:ws');
    expect(composeCacheScope('wf-A', 'n1', 'ws')).toBe('wf-A:n1:ws');
    expect(composeCacheScope()).toBe('');
  });

  it('同工作流内不同节点实例：相同 typeId/params/upstream 不再互相串缓存', () => {
    const a = cacheKey('ai.chat', { q: 'hi' }, { input: 'x' }, composeCacheScope('wf-A', 'node-a'));
    const b = cacheKey('ai.chat', { q: 'hi' }, { input: 'x' }, composeCacheScope('wf-A', 'node-b'));
    expect(a).not.toBe(b);
  });

  it('workspace 指纹：环境变化使同节点实例的 key 改变（旧缓存失效）', () => {
    const before = cacheKey('file.read', { p: '/a.txt' }, {}, composeCacheScope('wf-A', 'n1', 'ws-old'));
    const after = cacheKey('file.read', { p: '/a.txt' }, {}, composeCacheScope('wf-A', 'n1', 'ws-new'));
    expect(before).not.toBe(after);
  });

  it('节点实例隔离的 set/get 互不串缓存', () => {
    const k1 = cacheKey('ai.chat', { q: 'hi' }, {}, composeCacheScope('wf-A', 'a'));
    const k2 = cacheKey('ai.chat', { q: 'hi' }, {}, composeCacheScope('wf-A', 'b'));
    setCached(k1, { text: '来自 a' });
    expect(getCached(k2)).toBeNull(); // b 不命中 a 的产物
    expect(getCached(k1)).toEqual({ text: '来自 a' });
  });
});

describe('set/get 缓存读写', () => {
  it('未命中返回 null 并计入 miss', () => {
    expect(getCached('missing')).toBeNull();
    expect(cacheStats().misses).toBe(1);
  });

  it('写入后可命中并返回相同 outputs', () => {
    const key = cacheKey('llm', { m: 'g' }, {});
    setCached(key, { text: 'hi' });
    expect(getCached(key)).toEqual({ text: 'hi' });
    expect(cacheStats().writes).toBe(1);
    expect(cacheStats().hits).toBe(1);
  });

  it('命中时 hits 计数自增', () => {
    const key = cacheKey('n', {}, {});
    setCached(key, { v: 1 });
    getCached(key);
    getCached(key);
    expect(getCached(key)).toEqual({ v: 1 });
    // hits 累计：首次写后 3 次读
    expect(cacheStats().hits).toBe(3);
  });
});

describe('strike 与 clearCache', () => {
  it('strike 仅清除指定 typeId 前缀的条目', () => {
    const k1 = cacheKey('llm', {}, {});
    const k2 = cacheKey('math', {}, {});
    setCached(k1, { a: 1 });
    setCached(k2, { b: 2 });
    strike('llm');
    expect(cacheSize()).toBe(1);
    expect(getCached(k2)).toEqual({ b: 2 });
    expect(getCached(k1)).toBeNull();
  });

  it('clearCache 清空全部', () => {
    setCached(cacheKey('a', {}, {}), {});
    setCached(cacheKey('b', {}, {}), {});
    clearCache();
    expect(cacheSize()).toBe(0);
  });
});

describe('运行统计', () => {
  it('beginRun 重置统计', () => {
    setCached(cacheKey('n', {}, {}), {});
    getCached(cacheKey('n', {}, {}));
    beginRun();
    expect(cacheStats().hits).toBe(0);
    expect(cacheStats().misses).toBe(0);
    expect(cacheStats().writes).toBe(0);
  });

  it('countSkip 累加 skippedCount', () => {
    countSkip();
    countSkip();
    expect(skippedCount()).toBe(2);
    expect(cacheStats().skipped).toBe(2);
  });
});
