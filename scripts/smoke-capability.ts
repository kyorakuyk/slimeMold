/**
 * 步骤 11 阶段 D：能力分级（capability model）纯函数 smoke 测试。
 * 用 `tsx scripts/smoke-capability.ts` 运行（项目无测试框架，此为最小回归护栏）。
 *
 * 验证三件事：
 *  1) resolveCapability 的默认前缀推断是否正确（含自定义节点兜底为 compute）。
 *  2) createNodeDef 兜底（category/role）与 minCapability 透传。
 *  3) applyCapability 的裁剪是否真的拦截越权：
 *     - compute 节点：llm 抛错、sandbox 收口为 undefined、storage 为 no-op。
 *     - sandbox_write 节点：sandbox 句柄存在但 commitAll 抛错（落地权只给协调者）。
 *     - coordinator 节点：commitAll 可用、sandbox 保留。
 */
import { resolveCapability, applyCapability } from '../src/engine/executor';
import { createNodeDef } from '../src/types';
import type { ExecContext, NodeDefinition, NodeRole } from '../src/types';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✔ ${name}`);
  } else {
    failed++;
    console.error(`  ✘ ${name}`);
  }
}

/** 构造最小 ExecContext（applyCapability 只改写 llm/storage/sandbox/addAsset，其余仅占位）。 */
function makeCtx(): ExecContext {
  const base = {
    logger: { info() {}, warn() {}, error() {}, debug() {} } as any,
    llm: async () => 'ok',
    reportCost() {},
    costLog: [] as any[],
    setPartial() {},
    storage: {
      get: async () => 'v',
      set: async () => {},
    },
    signal: new AbortController().signal,
    vars: {} as Record<string, unknown>,
    assets: [] as any[],
    addAsset() {},
  };
  return base as unknown as ExecContext;
}

console.log('[1] resolveCapability 默认推断');
check('coord.resolver → coordinator', resolveCapability({ typeId: 'coord.resolver' } as NodeDefinition) === 'coordinator');
check('flow.council → coordinator', resolveCapability({ typeId: 'flow.council' } as NodeDefinition) === 'coordinator');
check('tool.writeFile → sandbox_write', resolveCapability({ typeId: 'tool.writeFile' } as NodeDefinition) === 'sandbox_write');
check('fs.copy → sandbox_write', resolveCapability({ typeId: 'fs.copy' } as NodeDefinition) === 'sandbox_write');
check('agent.chat → io', resolveCapability({ typeId: 'agent.chat' } as NodeDefinition) === 'io');
check('tool.http → io', resolveCapability({ typeId: 'tool.http' } as NodeDefinition) === 'io');
check('worker.scaffolder → io', resolveCapability({ typeId: 'worker.scaffolder' } as NodeDefinition) === 'io');
check('architect.design → io', resolveCapability({ typeId: 'architect.design' } as NodeDefinition) === 'io');
check('dispatch.plan → io', resolveCapability({ typeId: 'dispatch.plan' } as NodeDefinition) === 'io');
check('image.load → io', resolveCapability({ typeId: 'image.load' } as NodeDefinition) === 'io');
check('verify.assert → compute', resolveCapability({ typeId: 'verify.assert' } as NodeDefinition) === 'compute');
check('flow.if → compute', resolveCapability({ typeId: 'flow.if' } as NodeDefinition) === 'compute');
check('自定义 my.sum → compute（兜底）', resolveCapability({ typeId: 'my.sum' } as NodeDefinition) === 'compute');
check('显式声明优先于推断', resolveCapability({ typeId: 'tool.http', minCapability: 'compute' } as NodeDefinition) === 'compute');

console.log('[2] createNodeDef 兜底与透传');
const custom = createNodeDef({
  typeId: 'my.sum',
  name: '求和',
  inputs: [{ id: 'a', label: 'A', type: 'number' }],
  outputs: [{ id: 'out', label: '和', type: 'number' }],
  execute: async () => ({ out: 0 }),
});
check('category 默认「自定义」', custom.category === '自定义');
check('role 推断为 worker', custom.role === ('worker' as NodeRole));
const coord = createNodeDef({
  typeId: 'coord.resolver',
  name: '协调者',
  category: '协调',
  minCapability: 'coordinator',
  inputs: [],
  outputs: [],
  execute: async () => ({}),
});
check('minCapability 透传', coord.minCapability === 'coordinator');
check('role 推断为 orchestrator', coord.role === ('orchestrator' as NodeRole));

console.log('[3] applyCapability 裁剪越权');
// 带 mock sandbox 的 ctx（模拟 executor 在 runWorkflow 里注入的真实句柄）
function makeCtxWithSandbox(): ExecContext {
  const ctx = makeCtx();
  (ctx as any).sandbox = {
    nodeId: 'n1',
    baseDir: '/tmp/.sandbox/n1',
    inBrowser: false,
    writeFile: async () => '/tmp/.sandbox/n1/x.txt',
    readFrom: async () => null,
    list: async () => [],
    async commitAll() {
      return ['x.txt'];
    },
    async commitLanes() {
      return ['x.txt'];
    },
  };
  return ctx;
}
// compute 级：自定义 my.sum
{
  const ctx = makeCtxWithSandbox();
  const def = { typeId: 'my.sum', minCapability: 'compute' as const } as NodeDefinition;
  applyCapability(ctx, def, { sandbox: true });
  check('compute: llm 被拒绝（抛错）', await ctx.llm('x', []).then(() => false).catch((e) => /权限不足|capability/.test(String(e))));
  check('compute: sandbox 收口为 undefined', ctx.sandbox === undefined);
  let storageNoop = false;
  try {
    await ctx.storage.set('k', 'v');
    storageNoop = true;
  } catch {
    storageNoop = false;
  }
  check('compute: storage 为 no-op（不抛错、不实际写入）', storageNoop);
}
// sandbox_write 级：普通写文件 Worker
{
  const ctx = makeCtxWithSandbox();
  const def = { typeId: 'tool.writeFile', minCapability: 'sandbox_write' as const } as NodeDefinition;
  applyCapability(ctx, def, { sandbox: true });
  check('sandbox_write: sandbox 句柄保留', !!ctx.sandbox);
  check(
    'sandbox_write: commitAll 被拒绝（无落地权）',
    ctx.sandbox ? await ctx.sandbox.commitAll().then(() => false).catch((e) => /权限不足|capability/.test(String(e))) : false,
  );
}
// coordinator 级：协调者
{
  const ctx = makeCtxWithSandbox();
  const def = { typeId: 'coord.resolver', minCapability: 'coordinator' as const } as NodeDefinition;
  applyCapability(ctx, def, { sandbox: true });
  check('coordinator: sandbox 句柄保留', !!ctx.sandbox);
  check('coordinator: commitAll 可用（有落地权）', ctx.sandbox ? (await ctx.sandbox.commitAll()).length === 1 : false);
  check('coordinator: llm 可用（未裁剪）', typeof ctx.llm === 'function');
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
