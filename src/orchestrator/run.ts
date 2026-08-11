/**
 * H3 Orchestrator —— 编排执行器（H3b 第一刀）。
 *
 * 设计约束（docs/H3_ORCHESTRATOR_DESIGN.md §7.2）：
 * - 仅接受 ready 状态；原子迁移 ready → running；
 * - 按草案拓扑顺序（edges）执行各阶段；
 * - 每阶段写 StageLog；首次失败即 failed 并停止后续阶段；
 * - cancel：先 stopWorkflow(wfId) 停止当前阶段，再 cancelOrchestration() 落 cancelled；
 * - 暂不做自动回流 / LLM 动态改图（后续 H3d）；
 * - 依赖注入 runWorkflow/stopWorkflow，便于单测（fake 注入）。
 */

import type { Orchestration, StageLog } from '../types';
import { cancelOrchestration, getOrchestration, updateOrchestration } from './confirm';
import { generateDraft } from './draft';
import type { OrchestratorRequest } from './types';

/** 依赖注入：runWorkflow 与 stopWorkflow（默认接真实 executor；测试可注入 fake） */
export interface OrchestrationDeps {
  runWorkflow: (opts: { wfId: string }) => Promise<void>;
  stopWorkflow: (wfId?: string) => void | Promise<void>;
  /** 读取请求（用于 readonly 约束——见下） */
  getRequest?: (orchId: string) => OrchestratorRequest | undefined;
}

const defaultDeps: OrchestrationDeps = {
  runWorkflow: async (opts) => {
    const { runWorkflow: real } = await import('../engine/executor');
    await real({ wfId: opts.wfId });
  },
  stopWorkflow: async (wfId) => {
    const { stopWorkflow: real } = await import('../engine/executor');
    real(wfId);
  },
};

/** 运行编排：ready → running → 按拓扑序执行各阶段。返回最终 Orchestration。 */
export async function runOrchestration(
  orchId: string,
  deps: OrchestrationDeps = defaultDeps,
): Promise<Orchestration> {
  const orch = getOrchestration(orchId);
  if (!orch) throw new Error(`编排记录不存在：${orchId}`);
  if (orch.status !== 'ready') {
    throw new Error(`编排记录状态 ${orch.status} 不允许启动（仅 ready → running）：${orch.status}`);
  }

  // readonly 约束：只产出草案不执行（generateDraft 时 constraints.readonly=true）
  const req = deps.getRequest?.(orchId);
  if (req?.constraints?.readonly) {
    updateOrchestration(orchId, { status: 'cancelled' });
    throw new Error('编排为只读模式（constraints.readonly=true），不执行工作流');
  }

  // 原子迁移 ready → running（迁移表校验）
  const running = updateOrchestration(orchId, { status: 'running' });
  if (!running) throw new Error(`编排记录不存在：${orchId}`);

  const draft = orch.draft;
  if (!draft) {
    updateOrchestration(orchId, { status: 'failed', stageLogs: running.stageLogs });
    return getOrchestration(orchId)!;
  }

  // 拓扑序：按 edges 约束执行（MVP 只支持线性 DAG，出现分支/回流先按声明的顺序保守执行）
  const stageOrder = topoOrder(draft.stages.map((s) => s.id), draft.edges);

  try {
    for (const stageId of stageOrder) {
      const cur = getOrchestration(orchId);
      if (!cur || cur.status === 'cancelled') break; // 已被取消
      const stage = draft.stages.find((s) => s.id === stageId);
      if (!stage) continue;
      // 该阶段绑定的工作流 id（H3b 简化：草案阶段尚无 wfId 绑定，用「编排级默认 wf」占位——
      // 真正的 pipeline 绑定在后续迭代接入；此处 MVP 阶段用 stage.id 生成占位 wf 名）
      const wfId = `orch-${orchId}-${stageId}`;
      updateStageLog(orchId, stageId, { status: 'running', startedAt: new Date().toISOString() });
      try {
        await deps.runWorkflow({ wfId });
        const runId = `run-${Date.now()}`;
        updateStageLog(orchId, stageId, {
          status: 'success',
          runId,
          finishedAt: new Date().toISOString(),
        });
        updateOrchestration(orchId, { cursor: stageId });
      } catch (e) {
        // 首次失败：标记该阶段 failed，编排转 failed，停止后续阶段
        updateStageLog(orchId, stageId, {
          status: 'failed',
          error: e instanceof Error ? e.message : String(e),
          finishedAt: new Date().toISOString(),
        });
        const failed = getOrchestration(orchId)!;
        updateOrchestration(orchId, { status: 'failed', stageLogs: failed.stageLogs });
        return getOrchestration(orchId)!;
      }
    }
    // 全部阶段成功 → done
    const done = getOrchestration(orchId)!;
    if (done.status !== 'cancelled') {
      updateOrchestration(orchId, { status: 'done', stageLogs: done.stageLogs });
    }
    return getOrchestration(orchId)!;
  } catch (e) {
    // 编排级异常兜底
    const cur = getOrchestration(orchId);
    if (cur && cur.status !== 'cancelled') {
      updateOrchestration(orchId, { status: 'failed' });
    }
    throw e;
  }
}

/** 取消编排（供 UI/停止钩子调用）：先 stopWorkflow 停止当前阶段，再落 cancelled */
export function cancelOrchestrationRun(orchId: string, deps: OrchestrationDeps = defaultDeps): void {
  const orch = getOrchestration(orchId);
  if (!orch) return;
  // 当前正在执行的阶段工作流（cursor 或最后一个 running 阶段）
  const runningStage = orch.stageLogs.find((l) => l.status === 'running');
  const wfId = runningStage
    ? `orch-${orchId}-${runningStage.stageId}`
    : orch.cursor
      ? `orch-${orchId}-${orch.cursor}`
      : undefined;
  if (wfId) deps.stopWorkflow(wfId);
  cancelOrchestration(orchId);
}

/** 写阶段日志（合并到 stageLogs） */
function updateStageLog(orchId: string, stageId: string, patch: Partial<StageLog>): void {
  const orch = getOrchestration(orchId);
  if (!orch) return;
  const stageLogs = orch.stageLogs.map((l) =>
    l.stageId === stageId ? { ...l, ...patch } : l,
  );
  updateOrchestration(orchId, { stageLogs });
}

/** 拓扑序：按 edges 约束排序（MVP：只保证「所有入边已完成」的节点先执行；成环由草案保证不出现） */
function topoOrder(stageIds: string[], edges: Array<{ from: string; to: string }>): string[] {
  const indeg = new Map(stageIds.map((s) => [s, 0]));
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    const list = adj.get(e.from) ?? [];
    list.push(e.to);
    adj.set(e.from, list);
  }
  const queue = stageIds.filter((s) => (indeg.get(s) ?? 0) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    order.push(cur);
    for (const nxt of adj.get(cur) ?? []) {
      const d = (indeg.get(nxt) ?? 0) - 1;
      indeg.set(nxt, d);
      if (d === 0) queue.push(nxt);
    }
  }
  // 有环/缺失时保守回退为声明的顺序
  if (order.length !== stageIds.length) return stageIds;
  return order;
}

/** 便捷入口：由目标直接「生成草案 → 确认 → 执行」的最小闭环（MVP 端到端） */
export async function orchestrateGoal(
  request: OrchestratorRequest,
  deps: OrchestrationDeps = defaultDeps,
): Promise<Orchestration> {
  const { createOrchestration, confirmDraft } = await import('./confirm');
  const { useWorkflowStore } = await import('../store/workflowStore');
  const agents = useWorkflowStore.getState().agents;
  const draft = generateDraft(request, {
    agents,
    defaultAgentId: useWorkflowStore.getState().defaultAgentId,
  });
  const orch = createOrchestration(request.goal, draft);
  confirmDraft(orch.id, 'approved');
  return runOrchestration(orch.id, deps);
}
