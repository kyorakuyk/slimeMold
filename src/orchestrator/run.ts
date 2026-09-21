/**
 * H3 Orchestrator —— 编排执行器（H3b）。
 *
 * 设计约束（docs/H3_ORCHESTRATOR_DESIGN.md §7.2）：
 * - 仅接受 ready / failed（重试）状态；原子迁移 ready → running；
 * - **每个阶段执行前真实绑定工作流**（P0 修复）：
 *   - wfRef.kind === 'existing'：验证目标工作流存在（不存在 → 阶段失败）；
 *   - wfRef.kind === 'new'：创建空白工作流并以 activate:false 注册，真实 wfId 固化到
 *     Orchestration.stageWfIds（恢复/重试复用同一 ID，不重建）；
 *   - **空工作流（无节点）→ 阶段失败，绝不运行空图后标 success**（getWorkflow 为必需依赖）；
 *   - 运行失败 → 阶段 failed。
 * - 按草案拓扑顺序（edges）执行各阶段；每阶段写 StageLog（含真实 runId）；
 * - 首次失败即 failed 并停止后续阶段；
 * - cancel：先 stopWorkflow(wfId) 停止当前阶段，再 cancelOrchestration() 落 cancelled；
 * - **写 success 前复查 cancelled**（P1 修复：cancel 后若 runWorkflow 返回，不得标 success）；
 * - readonly 固化在 Orchestration.readonly（P1 修复：运行路径无需 getRequest）；
 * - 暂不做自动回流 / LLM 动态改图（后续 H3d）；
 * - 依赖注入 runWorkflow/stopWorkflow/ensureStageWorkflow/getWorkflow，便于单测（fake 注入）。
 */

import { useWorkflowStore } from '../store/workflowStore';
import type { DraftStage, Orchestration, StageLog } from '../types/orchestration';
import { cancelOrchestration, getOrchestration, updateOrchestration } from './confirm';
import { canStartLegacyOrchestration } from '../projectControl/executionBoundary';

/** 阶段工作流绑定结果：真实 wfId（运行 runWorkflow 用） */
export type StageWfBind =
  | { ok: true; wfId: string }
  | { ok: false; error: string };

/** runWorkflow 依赖返回：executor 真实运行结果（status 判定成败，runId 精确对应本次运行） */
export interface RunWorkflowResult {
  status: 'success' | 'error' | 'aborted';
  runId: number;
  error?: string;
}

/** 依赖注入：真实 executor / 工作流存储；测试可注入 fake */
export interface OrchestrationDeps {
  runWorkflow: (opts: { wfId: string }) => Promise<RunWorkflowResult>;
  stopWorkflow: (wfId?: string) => void | Promise<void>;
  /**
   * 为某阶段绑定真实工作流：
   * - wfRef.kind='existing'：验证目标工作流存在；
   * - wfRef.kind='new'：创建空白工作流并 activate:false 注册，返回真实 wfId。
   * 实现应优先复用 Orchestration.stageWfIds 已绑定的 wfId（恢复/重试不重建）。
   */
  ensureStageWorkflow: (orchId: string, stage: DraftStage) => StageWfBind;
  /** 按真实 wfId 读取工作流（必需依赖；空图校验依赖它） */
  getWorkflow: (wfId: string) => { nodes?: unknown[]; name?: string } | undefined;
}

export const defaultDeps: OrchestrationDeps = {
  runWorkflow: async (opts) => {
    const { runWorkflow: real } = await import('../engine/executor');
    // executor 现返回 { status, runId }——真实运行结果，禁止反查全局 runHistory（并发串号风险）
    const r = await real({ wfId: opts.wfId });
    return { status: r.status, runId: r.runId, error: r.error };
  },
  stopWorkflow: async (wfId) => {
    const { stopWorkflow: real } = await import('../engine/executor');
    real(wfId);
  },
  ensureStageWorkflow: (orchId, stage) => {
    const orch = useWorkflowStore.getState().orchestrations.find((o) => o.id === orchId);
    // 优先复用已固化的绑定（恢复/重试不重建）
    const bound = orch?.stageWfIds?.[stage.id];
    if (bound) return { ok: true, wfId: bound };
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
    // 固化绑定（P1 修复：恢复/重试复用同一 ID）
    if (orch) {
      updateOrchestration(orchId, { stageWfIds: { ...orch.stageWfIds, [stage.id]: id } });
    }
    return { ok: true, wfId: id };
  },
  getWorkflow: (wfId) => {
    const wf = useWorkflowStore.getState().workflows[wfId];
    if (!wf) return undefined;
    return { nodes: wf.nodes, name: wf.name };
  },
};

/**
 * 提前固化各阶段工作流绑定（H3c：确认/运行前让用户看到真实 wfId 并可打开编辑）。
 * - 对每个阶段调用 ensureStageWorkflow：existing 验证存在 / new 创建空白工作流（activate:false）；
 * - 真实 wfId 固化到 Orchestration.stageWfIds（runOrchestration 复用同一 ID，不重建）；
 * - 仅允许在 awaiting-confirm / ready 状态调用（running 中由运行路径自行绑定）。
 * 返回每阶段绑定结果（{ stageId, bind }），供 UI 展示失败原因。
 */
export function prepareStageWorkflows(
  orchId: string,
  deps: OrchestrationDeps = defaultDeps,
): Array<{ stageId: string; bind: StageWfBind }> {
  const orch = getOrchestration(orchId);
  if (!orch) throw new Error(`编排记录不存在：${orchId}`);
  if (orch.status !== 'awaiting-confirm' && orch.status !== 'ready') {
    throw new Error(
      `编排记录状态 ${orch.status} 不允许提前固化绑定（仅 awaiting-confirm / ready）`,
    );
  }
  const draft = orch.draft;
  if (!draft) return [];
  return draft.stages.map((stage) => ({ stageId: stage.id, bind: deps.ensureStageWorkflow(orchId, stage) }));
}

/** 运行编排：ready → running → 绑定并执行各阶段。返回最终 Orchestration。 */
export async function runOrchestration(
  orchId: string,
  deps: OrchestrationDeps = defaultDeps,
): Promise<Orchestration> {
  const orch = getOrchestration(orchId);
  if (!orch) throw new Error(`编排记录不存在：${orchId}`);
  const legacyDecision = canStartLegacyOrchestration(
    orchId,
    useWorkflowStore.getState().workerRuns,
  );
  if (!legacyDecision.allowed) {
    throw new Error(legacyDecision.reason ?? '该编排已由 Worker Run 接管，不能启动旧 executor');
  }
  // H3c：failed 可重试（failed → running 迁移表合法）；其余状态拒绝启动
  if (orch.status !== 'ready' && orch.status !== 'failed') {
    throw new Error(
      `编排记录状态 ${orch.status} 不允许启动（仅 ready / failed → running）：${orch.status}`,
    );
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

      // P0 修复：真实绑定工作流（existing 验证存在 / new 注册；复用已固化绑定）
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

      // 空图校验（P0 修复：getWorkflow 为必需依赖，空工作流 → 阶段失败）
      const wf = deps.getWorkflow(wfId);
      if (!wf || !wf.nodes || wf.nodes.length === 0) {
        updateStageLog(orchId, stageId, {
          status: 'failed',
          error: `阶段 ${stage.id} 的工作流为空或无节点（${wfId}）：请先配置该阶段工作流`,
          finishedAt: new Date().toISOString(),
        });
        const failed = getOrchestration(orchId)!;
        updateOrchestration(orchId, { status: 'failed', stageLogs: failed.stageLogs });
        return getOrchestration(orchId)!;
      }

      // 写 running 时即带 wfId——cancel 钩子据此停止当前阶段
      updateStageLog(orchId, stageId, { status: 'running', wfId, startedAt: new Date().toISOString() });
      try {
        const result = await deps.runWorkflow({ wfId });
        // P1 修复：cancel 后若 runWorkflow 返回，复查 cancelled——不得标 success
        const after = getOrchestration(orchId);
        if (!after || after.status === 'cancelled') break;
        // 核心判定：仅 executor 返回 status==='success' 才算阶段成功；
        // error/aborted（非法图、节点失败、死循环等）→ 阶段 failed，绝不假成功
        if (result.status !== 'success') {
          updateStageLog(orchId, stageId, {
            status: 'failed',
            wfId,
            runId: result.runId,
            error: result.error ?? `工作流执行未成功（${result.status}）`,
            finishedAt: new Date().toISOString(),
          });
          const failed = getOrchestration(orchId)!;
          updateOrchestration(orchId, { status: 'failed', stageLogs: failed.stageLogs });
          return getOrchestration(orchId)!;
        }
        updateStageLog(orchId, stageId, {
          status: 'success',
          wfId,
          runId: result.runId,
          finishedAt: new Date().toISOString(),
        });
        updateOrchestration(orchId, { cursor: stageId, runIds: [...after.runIds, result.runId] });
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
  // 收口阶段日志（H3c 验收优化）：正在运行的阶段标 cancelled，未运行的后续阶段标 skipped，
  // 避免取消后仍显示「运行中」
  const stageLogs: StageLog[] = orch.stageLogs.map((l) => {
    if (l.status === 'running') {
      return { ...l, status: 'cancelled' as const, finishedAt: new Date().toISOString() };
    }
    if (l.status === 'pending') {
      return { ...l, status: 'skipped' as const };
    }
    return l;
  });
  cancelOrchestration(orchId);
  if (stageLogs.some((l, i) => l.status !== orch.stageLogs[i]?.status)) {
    updateOrchestration(orchId, { stageLogs });
  }
}

/**
 * 所有阶段是否都已绑定到「非空工作流」（H3c 执行按钮前置检查）：
 * - 已固化（stageWfIds 有该阶段）→ 对应工作流 nodes 非空；
 * - 未固化但 existing 引用已有工作流 → 该工作流 nodes 非空；
 * - new 且未固化 → false（须先「固化工作流」再编辑添加节点）。
 * 审计建议：未就绪时 UI 禁用执行按钮，而非运行后才安全失败。
 */
export function stagesReadyToRun(
  orch: Orchestration,
  workflows: Record<string, { nodes?: unknown[]; name?: string }>,
): boolean {
  if (!orch.draft || orch.draft.stages.length === 0) return false;
  return orch.draft.stages.every((stage) => {
    const bound = orch.stageWfIds?.[stage.id];
    if (bound) return (workflows[bound]?.nodes?.length ?? 0) > 0;
    if (stage.wfRef.kind === 'existing') {
      return (workflows[stage.wfRef.wfId]?.nodes?.length ?? 0) > 0;
    }
    return false; // new 未固化
  });
}

/**
 * 阶段当前「有效绑定工作流」（H3c：复用已有工作流后旧固化被清除，但 existing 引用仍明确指向某工作流）。
 * 判定优先级：
 * - 已固化 stageWfIds[stageId]（无论 new/existing 固化后）；
 * - 否则 existing wfRef 直接引用的工作流（无需固化即可打开编辑/查看节点数）；
 * - new 未固化 → undefined（尚无真实 wfId）。
 * 与 stagesReadyToRun 的 existing 分支语义一致。
 */
export function effectiveStageWfId(orch: Orchestration, stageId: string): string | undefined {
  const bound = orch.stageWfIds?.[stageId];
  if (bound) return bound;
  const stage = orch.draft?.stages.find((s) => s.id === stageId);
  if (stage?.wfRef.kind === 'existing') return stage.wfRef.wfId;
  return undefined;
}

/** 写阶段日志（合并到 stageLogs） */
function updateStageLog(orchId: string, stageId: string, patch: Partial<StageLog>): void {
  const orch = getOrchestration(orchId);
  if (!orch) return;
  const stageLogs = orch.stageLogs.map((l) => {
    if (l.stageId !== stageId) return l;
    const merged = { ...l, ...patch };
    // 阶段重新进入 running（failed 重试）时，清除旧的终态字段，避免成功日志残留旧 error/finishedAt
    if (patch.status === 'running') {
      delete (merged as Partial<StageLog>).error;
      delete (merged as Partial<StageLog>).finishedAt;
    }
    return merged;
  });
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
