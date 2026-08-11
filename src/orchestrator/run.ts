/**
 * H3 Orchestrator —— 编排执行器（H3b）。
 *
 * 设计约束（docs/H3_ORCHESTRATOR_DESIGN.md §7.2）：
 * - 仅接受 ready 状态；原子迁移 ready → running；
 * - **每个阶段执行前真实绑定工作流**（P0 修复）：
 *   - wfRef.kind === 'existing'：验证目标工作流存在（不存在 → 阶段失败）；
 *   - wfRef.kind === 'new'：创建空白工作流并以 activate:false 注册，真实 wfId 写入 StageLog；
 *   - 工作流不存在 / 为空 / 运行失败 → 阶段失败，不能标 success。
 * - 按草案拓扑顺序（edges）执行各阶段；每阶段写 StageLog；
 * - 首次失败即 failed 并停止后续阶段；
 * - cancel：先 stopWorkflow(wfId) 停止当前阶段，再 cancelOrchestration() 落 cancelled；
 * - **写 success 前复查 cancelled**（P1 修复：cancel 后若 runWorkflow 返回，不得标 success）；
 * - readonly 固化在 Orchestration.readonly（P1 修复：运行路径无需 getRequest）；
 * - 暂不做自动回流 / LLM 动态改图（后续 H3d）；
 * - 依赖注入 runWorkflow/stopWorkflow/ensureStageWorkflow，便于单测（fake 注入）。
 */

import { useWorkflowStore } from '../store/workflowStore';
import type { DraftStage, Orchestration, StageLog } from '../types';
import { cancelOrchestration, getOrchestration, updateOrchestration } from './confirm';

/** 阶段工作流绑定结果：真实 wfId（运行 runWorkflow 用） */
export type StageWfBind =
  | { ok: true; wfId: string }
  | { ok: false; error: string };

/** 依赖注入：真实 executor / 工作流存储；测试可注入 fake */
export interface OrchestrationDeps {
  runWorkflow: (opts: { wfId: string }) => Promise<void>;
  stopWorkflow: (wfId?: string) => void | Promise<void>;
  /**
   * 为某阶段绑定真实工作流：
   * - wfRef.kind='existing'：验证目标工作流存在；
   * - wfRef.kind='new'：创建空白工作流并 activate:false 注册，返回真实 wfId。
   */
  ensureStageWorkflow: (orchId: string, stage: DraftStage) => StageWfBind;
  /** 按真实 wfId 读取工作流（用于「为空→失败」校验，可选） */
  getWorkflow?: (wfId: string) => { nodes?: unknown[]; name?: string } | undefined;
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
  ensureStageWorkflow: (_orchId, stage) => {
    if (stage.wfRef.kind === 'existing') {
      // existing：验证目标工作流存在
      const wf = useWorkflowStore.getState().workflows[stage.wfRef.wfId];
      if (!wf) {
        return { ok: false, error: `阶段 ${stage.id} 引用的工作流不存在：${stage.wfRef.wfId}` };
      }
      return { ok: true, wfId: stage.wfRef.wfId };
    }
    // new：创建空白工作流并 activate:false 注册
    const id = useWorkflowStore.getState().registerWorkflow(
      {
        version: 1,
        name: `编排阶段·${stage.label}`,
        savedAt: new Date().toISOString(),
        nodes: [],
        edges: [],
        agents: [],
        roles: [],
      },
      { activate: false, name: `编排阶段·${stage.label}` },
    );
    return { ok: true, wfId: id };
  },
};

/** 运行编排：ready → running → 绑定并执行各阶段。返回最终 Orchestration。 */
export async function runOrchestration(
  orchId: string,
  deps: OrchestrationDeps = defaultDeps,
): Promise<Orchestration> {
  const orch = getOrchestration(orchId);
  if (!orch) throw new Error(`编排记录不存在：${orchId}`);
  if (orch.status !== 'ready') {
    throw new Error(`编排记录状态 ${orch.status} 不允许启动（仅 ready → running）：${orch.status}`);
  }

  // readonly 约束：固化在 Orchestration.readonly（P1 修复）
  if (orch.readonly) {
    updateOrchestration(orchId, { status: 'cancelled' });
    throw new Error('编排为只读模式（readonly=true），不执行工作流');
  }

  // 原子迁移 ready → running（迁移表校验）
  const running = updateOrchestration(orchId, { status: 'running' });
  if (!running) throw new Error(`编排记录不存在：${orchId}`);

  const draft = orch.draft;
  if (!draft) {
    updateOrchestration(orchId, { status: 'failed', stageLogs: running.stageLogs });
    return getOrchestration(orchId)!;
  }

  // 拓扑序：按 edges 约束执行
  const stageOrder = topoOrder(draft.stages.map((s) => s.id), draft.edges);

  try {
    for (const stageId of stageOrder) {
      const cur = getOrchestration(orchId);
      if (!cur || cur.status === 'cancelled') break; // 已被取消
      const stage = draft.stages.find((s) => s.id === stageId);
      if (!stage) continue;

      // P0 修复：真实绑定工作流（existing 验证存在 / new 注册）
      const bind = deps.ensureStageWorkflow(orchId, stage);
      if (!bind.ok) {
        updateStageLog(orchId, stageId, {
          status: 'failed',
          error: bind.error,
          finishedAt: new Date().toISOString(),
        });
        const failed = getOrchestration(orchId)!;
        updateOrchestration(orchId, { status: 'failed', stageLogs: failed.stageLogs });
        return getOrchestration(orchId)!;
      }
      const wfId = bind.wfId;

      // 为空校验（可选）：工作流没有节点 → 阶段失败
      const wf = deps.getWorkflow?.(wfId);
      if (wf && (!wf.nodes || wf.nodes.length === 0)) {
        updateStageLog(orchId, stageId, {
          status: 'failed',
          error: `阶段 ${stage.id} 的工作流为空（${wfId}）`,
          finishedAt: new Date().toISOString(),
        });
        const failed = getOrchestration(orchId)!;
        updateOrchestration(orchId, { status: 'failed', stageLogs: failed.stageLogs });
        return getOrchestration(orchId)!;
      }

      // 写 running 时即带 wfId——cancel 钩子据此停止当前阶段
      updateStageLog(orchId, stageId, { status: 'running', wfId, startedAt: new Date().toISOString() });
      try {
        await deps.runWorkflow({ wfId });
        // P1 修复：cancel 后若 runWorkflow 返回，复查 cancelled——不得标 success
        const after = getOrchestration(orchId);
        if (!after || after.status === 'cancelled') break;
        const runId = `run-${Date.now()}`;
        updateStageLog(orchId, stageId, {
          status: 'success',
          wfId,
          runId,
          finishedAt: new Date().toISOString(),
        });
        updateOrchestration(orchId, { cursor: stageId });
      } catch (e) {
        // 首次失败：标记该阶段 failed，编排转 failed，停止后续阶段
        updateStageLog(orchId, stageId, {
          status: 'failed',
          wfId,
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
  // 当前正在执行的阶段工作流（running 阶段日志里带 wfId，或 cursor）
  const runningStage = orch.stageLogs.find((l) => l.status === 'running');
  const wfId = runningStage?.wfId ?? orch.cursor;
  if (wfId) void deps.stopWorkflow(wfId);
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
