import type { CostRecord } from '../types/agent';
import type { RunRecord } from '../types/execution';
import type { FlowNode } from '../types/graph';

export interface FinalizerCostSummary {
  byModel: Record<string, { promptTokens: number; completionTokens: number; calls: number }>;
  totalPrompt: number;
  totalCompletion: number;
  totalDuration: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  replyTokens: number;
  hasCost: boolean;
}

export function summarizeFinalizerCosts(costLog: CostRecord[]): FinalizerCostSummary {
  // Aggregate by model for run history and cost analysis.
  const byModel: FinalizerCostSummary['byModel'] = {};
  let totalPrompt = 0;
  let totalCompletion = 0;
  let totalDuration = 0;
  let cacheHitTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  let replyTokens = 0;
  for (const record of costLog) {
    totalDuration += record.durationMs;
    if (!record.usage) continue;
    const prompt = record.usage.promptTokens ?? 0;
    const completion = record.usage.completionTokens ?? 0;
    totalPrompt += prompt;
    totalCompletion += completion;
    cacheHitTokens += record.usage.cachedPromptTokens ?? 0;
    cacheWriteTokens += record.usage.writtenPromptTokens ?? 0;
    reasoningTokens += record.usage.reasoningTokens ?? 0;
    replyTokens += record.usage.replyTokens ?? completion;
    const model = (byModel[record.model] ??= { promptTokens: 0, completionTokens: 0, calls: 0 });
    model.promptTokens += prompt;
    model.completionTokens += completion;
    model.calls += 1;
  }
  return {
    byModel,
    totalPrompt,
    totalCompletion,
    totalDuration,
    cacheHitTokens,
    cacheMissTokens: Math.max(0, totalPrompt - cacheHitTokens - cacheWriteTokens),
    cacheWriteTokens,
    reasoningTokens,
    replyTokens,
    hasCost: costLog.length > 0,
  };
}

export interface BuildFinalizerRunRecordInput {
  workflowName: string;
  startedWall: number;
  startAt: number;
  status: RunRecord['status'];
  nodes: FlowNode[];
  nodesNow: FlowNode[];
  costByNode: Map<string, CostRecord[]>;
  costLog: CostRecord[];
  costSummary: FinalizerCostSummary;
}

export function buildFinalizerRunRecord({
  workflowName,
  startedWall,
  startAt,
  status,
  nodes,
  nodesNow,
  costByNode,
  costLog,
  costSummary,
}: BuildFinalizerRunRecordInput): RunRecord {
  return {
    id: `run_${Date.now()}`,
    name: workflowName,
    startedAt: new Date(startedWall).toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - startAt),
    status,
    nodeCount: nodes.length,
    nodes: nodesNow.map((node) => ({
      id: node.id,
      label: node.data.label,
      typeId: node.data.typeId,
      status: node.data.status ?? 'idle',
      outputs: node.data.outputs ?? null,
      error: node.data.error ?? null,
      startedAt: node.data.startedAt ?? null,
      durationMs: node.data.durationMs ?? null,
      cost: costByNode.get(node.id) ?? null,
    })),
    cost: costSummary.hasCost
      ? {
          totalPromptTokens: costSummary.totalPrompt,
          totalCompletionTokens: costSummary.totalCompletion,
          totalTokens: costSummary.totalPrompt + costSummary.totalCompletion,
          totalDurationMs: costSummary.totalDuration,
          cache: {
            hitTokens: costSummary.cacheHitTokens,
            missTokens: costSummary.cacheMissTokens,
            writeTokens: costSummary.cacheWriteTokens,
          },
          output: {
            reasoningTokens: costSummary.reasoningTokens,
            replyTokens: costSummary.replyTokens,
          },
          byModel: costSummary.byModel,
          records: costLog,
        }
      : null,
  };
}
