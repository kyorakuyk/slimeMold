import { createNodeDef, type NodeDefinition } from '../../types';

/**
 * 成本审计节点（Auditor / 书记员骨架）：
 * 运行结束时输出本次全流程的 token 用量与耗时汇总（JSON 文本）。
 * 不消费数据流——它通过 ExecContext.costLog 读取引擎累积的成本账本，
 * 因此放在工作流任何位置都会上报全链路成本；多个 Auditor 节点互不影响。
 */
export const nodeAuditor: NodeDefinition = {
  typeId: 'auditor.bookkeeper',
  name: '成本审计',
  category: '审计',
  role: 'verifier',
  whenToUse: '运行结束后汇总全链路 token 用量与耗时，输出成本报告，用于性价比分析与自优化闭环。',
  description:
    '汇总本次运行所有 LLM 调用的 token 用量与耗时，输出成本报告（JSON）。不消费数据流，仅读取引擎成本账本。',
  inputs: [],
  outputs: [
    { id: 'report', label: '成本报告', type: 'text' },
    { id: 'totalTokens', label: '总 Token', type: 'number' },
    { id: 'totalDurationMs', label: '总耗时(ms)', type: 'number' },
  ],
  params: [
    {
      key: 'includeRecords',
      label: '包含逐条明细',
      type: 'select',
      default: 'on',
      options: [
        { value: 'on', label: '包含（完整账本）' },
        { value: 'off', label: '仅汇总（按模型归类）' },
      ],
    },
  ],
  async execute(_inputs, params, ctx) {
    const log = ctx.costLog ?? [];
    const includeRecords = params.includeRecords !== 'off';
    const byModel: Record<string, { promptTokens: number; completionTokens: number; calls: number }> = {};
    let totalPrompt = 0;
    let totalCompletion = 0;
    let totalDuration = 0;
    for (const r of log) {
      totalDuration += r.durationMs;
      if (!r.usage) continue;
      totalPrompt += r.usage.promptTokens ?? 0;
      totalCompletion += r.usage.completionTokens ?? 0;
      const m = (byModel[r.model] ??= { promptTokens: 0, completionTokens: 0, calls: 0 });
      m.promptTokens += r.usage.promptTokens ?? 0;
      m.completionTokens += r.usage.completionTokens ?? 0;
      m.calls += 1;
    }
    const report = {
      summary: {
        totalPromptTokens: totalPrompt,
        totalCompletionTokens: totalCompletion,
        totalTokens: totalPrompt + totalCompletion,
        totalDurationMs: totalDuration,
        llmCalls: log.length,
      },
      byModel: includeRecords ? byModel : undefined,
      records: includeRecords ? log : undefined,
    };
    return {
      report: JSON.stringify(report, null, 2),
      totalTokens: totalPrompt + totalCompletion,
      totalDurationMs: totalDuration,
    };
  },
};

export const auditNodes: NodeDefinition[] = [nodeAuditor].map(createNodeDef);
