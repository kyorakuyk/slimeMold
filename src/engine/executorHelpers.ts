// executor 的纯辅助函数（从 executor.ts 物理抽离，行为等价）。
// 这些函数只依赖输入参数与类型，不触碰 store 单例 / IO / 运行态，可独立测试。
// 与调度主流程（runWorkflow）解耦，使 executor.ts 从「上帝模块」进一步瘦身。

import type { CostRecord } from '../types/agent';
import type {
  CapabilityLevel,
  ExecContext,
  FlowEdge,
  NodeDefinition,
  NodeUsageStat,
} from '../types';

/** 按节点定义推导其能力等级（单一真相源：minCapability 优先，否则按 typeId 前缀推断）。 */
export function resolveCapability(def: NodeDefinition): CapabilityLevel {
  if (def.minCapability) return def.minCapability;
  const t = def.typeId;
  if (t.startsWith('coord.') || t === 'flow.council') return 'coordinator';
  if (t === 'tool.writeFile' || t.startsWith('tool.file') || t.startsWith('fs.') || t.startsWith('tool.fs'))
    return 'sandbox_write';
  if (
    t.startsWith('agent.') ||
    t.startsWith('ai.') ||
    t.startsWith('llm') ||
    t.startsWith('http') ||
    t.startsWith('io.') ||
    t.startsWith('tool.') ||
    t.startsWith('worker.') ||
    t.startsWith('architect.') ||
    t === 'dispatch.plan' ||
    t === 'flow.map' ||
    t.startsWith('image.') // 图像节点涉及文件读取/生成，按受限 I/O 处理
  )
    return 'io';
  return 'compute';
}

/**
 * 按能力等级裁剪注入的 ExecContext。
 * 不删除字段（保持类型完整），而是把越权字段替换为「拒绝型」实现：
 * - compute：禁用 llm/storage/addAsset/sandbox（纯计算只读）
 * - io：禁用 sandbox 句柄（不直接碰文件系统）
 * - sandbox_write：保留 sandbox 写副本能力，但剥离 commitAll/commitLanes（落地权只给协调者）
 * - coordinator / system：全权限（含 commit 汇总与系统级调用）
 * 沙箱模式下，非 coordinator 节点的 addAsset 收口为「仅预览、不回写主工作流库」，避免越权落盘。
 */
export function applyCapability(
  ctx: ExecContext,
  def: NodeDefinition,
  opts: { sandbox?: boolean; sandboxMode?: 'copy' | 'gitworktree' },
): void {
  const level = resolveCapability(def);
  const hasSandbox = !!opts.sandbox && !!ctx.sandbox;
  const deny = (what: string) =>
    ctx.logger.error(`节点「${def.typeId}」权限不足（${level} 级），拒绝 ${what}`);

  if (level === 'compute') {
    ctx.llm = async () => {
      deny('调用 LLM');
      throw new Error(`权限不足：${def.typeId} 为 compute 级，不可调用 LLM`);
    };
    ctx.storage = { get: async () => null, set: async () => {} };
    ctx.addAsset = () => {};
    ctx.sandbox = undefined;
    ctx.sandboxLanes = undefined;
    return;
  }

  if (level === 'io') {
    ctx.sandbox = undefined;
    ctx.sandboxLanes = undefined;
    return;
  }

  if (level === 'sandbox_write') {
    ctx.sandboxLanes = undefined; // 无 commit 汇总权
    if (hasSandbox && ctx.sandbox) {
      const inner = ctx.sandbox;
      ctx.sandbox = {
        ...inner,
        async commitAll() {
          deny('commitAll（落地主工作区）');
          throw new Error(`权限不足：${def.typeId} 为 sandbox_write 级，仅协调者可 commit`);
        },
        async commitLanes() {
          deny('commitLanes（落地主工作区）');
          throw new Error(`权限不足：${def.typeId} 为 sandbox_write 级，仅协调者可 commit`);
        },
      };
    }
    // 沙箱模式下收口 addAsset：仅预览、不回写主工作流库（避免越权落盘）
    if (opts.sandbox) {
      const orig = ctx.addAsset;
      ctx.addAsset = (meta) => {
        orig({ ...meta, inWorkspace: false });
      };
    }
    return;
  }

  // coordinator / system：全权限，但沙箱模式下仍收口非主工作区资产标记由节点自身决定，这里不干预
}

/**
 * 判断错误是否为「瞬时错误」：仅这类（网络/超时/限流/网关）值得在节点层重试；
 * 业务错误（参数/解析/逻辑）重试无意义，直接失败。
 */
export function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|timed out|ECONN|ENOTFOUND|ECONNRESET|ETIMEDOUT|429|too many requests|503|502|504|gateway|rate limit|network|socket|aborted/i.test(
    msg,
  );
}

/** 汇集上游输出：edge.targetHandle <- outputs[edge.source][edge.sourceHandle] */
export function collectInputs(
  nodeId: string,
  edges: FlowEdge[],
  outputsMap: Map<string, Record<string, unknown>>,
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const e of edges) {
    if (e.target !== nodeId) continue;
    const upstream = outputsMap.get(e.source);
    if (!upstream) continue;
    const value = upstream[e.sourceHandle ?? ''];
    inputs[e.targetHandle ?? ''] = value;
  }
  return inputs;
}

/** 把单次调用用量累加进节点累计用量统计（幂等合并，模型去重） */
export function accumulateUsage(prev: NodeUsageStat | undefined, rec: CostRecord): NodeUsageStat {
  const base: NodeUsageStat = prev ?? {
    calls: 0,
    failedCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedPromptTokens: 0,
    writtenPromptTokens: 0,
    reasoningTokens: 0,
    replyTokens: 0,
    llmDurationMs: 0,
    models: [],
  };
  const u = rec.usage;
  const prompt = u?.promptTokens ?? 0;
  const completion = u?.completionTokens ?? 0;
  return {
    calls: base.calls + 1,
    failedCalls: base.failedCalls + (rec.ok ? 0 : 1),
    promptTokens: base.promptTokens + prompt,
    completionTokens: base.completionTokens + completion,
    totalTokens: base.totalTokens + (u?.totalTokens ?? prompt + completion),
    cachedPromptTokens: base.cachedPromptTokens + (u?.cachedPromptTokens ?? 0),
    writtenPromptTokens: base.writtenPromptTokens + (u?.writtenPromptTokens ?? 0),
    reasoningTokens: base.reasoningTokens + (u?.reasoningTokens ?? 0),
    replyTokens: base.replyTokens + (u?.replyTokens ?? completion),
    llmDurationMs: base.llmDurationMs + (rec.durationMs ?? 0),
    models:
      rec.model && !base.models.includes(rec.model)
        ? [...base.models, rec.model]
        : base.models,
  };
}
