/**
 * loader.sandbox.test.ts — H2 PoC P0 修复验证（Codex 第三轮）：
 * sandbox: true 时禁止主线程 import(entryCode)（不预执行），类式插件拒绝沙箱。
 *
 * 关键：沙箱路径完全不调用主线程 import()——因此即使 jsdom 无原生动态 import 能力
 * （对 Blob URL 的 import 会失败），加载也能成功，且无任何顶层代码执行。
 */
import { describe, it, expect } from 'vitest';
import { loadPluginFromSource } from './loader';

const FUNC_MANIFEST = JSON.stringify({
  id: 'sandbox-func',
  name: '沙箱函数式插件',
  entry: 'index.js',
  nodes: [
    {
      typeId: 'sandbox.add',
      name: 'Add',
      inputs: [{ id: 'a', label: 'A', type: 'number' }],
      outputs: [{ id: 'out', label: 'Out', type: 'number' }],
      params: [],
    },
  ],
});

const CLASS_MANIFEST = JSON.stringify({
  id: 'sandbox-class',
  name: '沙箱类式插件',
  entry: 'index.js',
  nodes: [
    {
      typeId: 'sandbox.class',
      name: 'Class',
      inputs: [],
      outputs: [{ id: 'out', label: 'Out', type: 'any' }],
      params: [],
      extends: 'ComputeNode',
    },
  ],
});

describe('loader 沙箱模式（P0：不预执行）', () => {
  it('sandbox:true 函数式插件：不抛错、不预执行，返回 defs（execute 为沙箱包装器）', async () => {
    // 若沙箱路径误执行主线程 import(entryCode)，jsdom 下 Blob import 会抛错——此处应成功。
    const entry = `export default { executors: { 'sandbox.add': async (i,p,c) => ({ out: Number(i.a) + 1 }) } };`;
    const { plugin, defs } = await loadPluginFromSource(FUNC_MANIFEST, entry, 'custom', undefined, {
      sandbox: true,
    });
    expect(plugin.manifest.id).toBe('sandbox-func');
    expect(defs).toHaveLength(1);
    expect(defs[0].typeId).toBe('sandbox.add');
    expect(typeof defs[0].execute).toBe('function');
  });

  it('sandbox:true 类式插件（extends）→ 明确拒绝', async () => {
    const entry = `export class ComputeNode { execute(){ return {} } }`;
    await expect(
      loadPluginFromSource(CLASS_MANIFEST, entry, 'custom', undefined, { sandbox: true }),
    ).rejects.toThrow(/类式插件.*暂不支持沙箱模式/);
  });

  it('sandbox:false（默认）保持主线程路径：缺 executor 报错', async () => {
    // 默认路径（非沙箱）会 import entryCode；jsdom 无 Blob import 能力 → 应抛加载错误。
    // 这里验证「默认路径 ≠ 沙箱路径」：沙箱路径能成功，默认路径在无 import 环境会失败。
    const entry = `export default { executors: {} };`;
    await expect(
      loadPluginFromSource(FUNC_MANIFEST, entry, 'custom', undefined, { sandbox: false }),
    ).rejects.toThrow();
  });
});
