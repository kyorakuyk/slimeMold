/**
 * H3 Orchestrator —— 确认门（唯一允许把草案落成 pipeline / 写入编排记录的入口）。
 *
 * 安全红线（docs/H3_ORCHESTRATOR_DESIGN.md §6）：
 * - confirmDraft 是唯一「落盘」入口；approval 必须显式为 'approved'；
 * - **confirmDraft 只把状态置为 ready（确认待执行），绝不进入 running**——
 *   「确认」≠「执行」；running 只能由 H3b runOrchestration() 进入；
 * - discardDraft 只删除编排记录，不触碰任何用户工作流；
 * - 新工作流由调用方以 activate:false 注册（Orchestrator 不会自动运行未确认的工作流）。
 */

import { useWorkflowStore } from '../store/workflowStore';
import type { Orchestration, OrchestrationStatus, PipelineDraft } from '../types';
import { generateDraft, type DraftDeps } from './draft';
import type { Confirmation, OrchestratorRequest } from './types';

/**
 * 状态迁移表：from → 允许的 to 集合。
 * 非法跳转（如 awaiting-confirm → running、running → ready）会被拒绝。
 * running 只能由 ready → running 进入（H3b runOrchestration）。
 */
export const ALLOWED_TRANSITIONS: Record<OrchestrationStatus, ReadonlySet<OrchestrationStatus>> = {
  draft: new Set(['awaiting-confirm', 'cancelled']),
  'awaiting-confirm': new Set(['ready', 'cancelled']),
  ready: new Set(['running', 'cancelled']),
  running: new Set(['paused', 'done', 'failed', 'cancelled']),
  paused: new Set(['running', 'cancelled']),
  done: new Set([]),
  cancelled: new Set([]),
  failed: new Set(['running', 'cancelled']), // failed 可重试回 running
};

/** 判断状态迁移是否合法 */
export function canTransition(from: OrchestrationStatus, to: OrchestrationStatus): boolean {
  return ALLOWED_TRANSITIONS[from].has(to);
}

/** 创建编排记录（草案态，不落 pipeline）——仅写入 orchestrations 集合 */
export function createOrchestration(
  goal: string,
  draft: PipelineDraft,
  opts?: { readonly?: boolean },
): Orchestration {
  const now = new Date().toISOString();
  const orch: Orchestration = {
    id: `orch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    goal,
    status: 'awaiting-confirm',
    createdAt: now,
    updatedAt: now,
    draft,
    // readonly 约束固化到编排记录（P1 修复：运行路径无需 getRequest 也能读到）
    readonly: opts?.readonly,
    stageLogs: draft.stages.map((s) => ({ stageId: s.id, status: 'pending' })),
    runIds: [],
  };
  const st = useWorkflowStore.getState();
  st.setOrchestrations([...st.orchestrations, orch]);
  return orch;
}

/** 读取单条编排记录 */
export function getOrchestration(orchId: string): Orchestration | undefined {
  return useWorkflowStore.getState().orchestrations.find((o) => o.id === orchId);
}

/**
 * 确认草案（唯一落盘门）：
 * - approval 非 'approved' 直接抛错（代码级强制，防止误调）；
 * - 状态 awaiting-confirm → **ready**（确认待执行），**不进入 running**。
 * - 不在此处创建 pipeline / 绑定工作流 / 调 runWorkflow——那些由 H3b runOrchestration()
 *   在真正启动执行时完成（「确认」与「执行」解耦，确认后用户仍可编辑草案绑定）。
 */
export function confirmDraft(orchId: string, approval: Confirmation): Orchestration {
  if (approval !== 'approved') {
    throw new Error('Orchestrator 确认门：必须显式批准草案才能落盘');
  }
  const st = useWorkflowStore.getState();
  const idx = st.orchestrations.findIndex((o) => o.id === orchId);
  if (idx < 0) throw new Error(`编排记录不存在：${orchId}`);
  const orch = st.orchestrations[idx];
  // 状态迁移校验：仅 awaiting-confirm → ready 合法
  if (!canTransition(orch.status, 'ready')) {
    throw new Error(`编排记录当前状态不允许确认（${orch.status} → ready）：${orch.status}`);
  }
  const next: Orchestration = {
    ...orch,
    status: 'ready',
    updatedAt: new Date().toISOString(),
  };
  const list = [...st.orchestrations];
  list[idx] = next;
  st.setOrchestrations(list);
  return next;
}

/** 允许「废弃草案」（直接删除记录）的状态：尚未开始执行的阶段 */
const DISCARDABLE_STATUSES: ReadonlySet<OrchestrationStatus> = new Set([
  'draft',
  'awaiting-confirm',
  'ready',
]);

/**
 * 废弃草案：只删除编排记录，不触碰任何用户工作流。
 * 状态约束（Codex 边界）：
 * - draft / awaiting-confirm / ready：允许直接删除（尚未执行）；
 * - running / paused：**拒绝**——必须先 cancelOrchestration() 停止执行再转 cancelled；
 * - done / failed：**拒绝**——属于历史记录，应归档/清理历史，不作为「废弃草案」处理。
 */
export function discardDraft(orchId: string): boolean {
  const st = useWorkflowStore.getState();
  const orch = st.orchestrations.find((o) => o.id === orchId);
  if (!orch) return false;
  if (!DISCARDABLE_STATUSES.has(orch.status)) {
    throw new Error(
      `编排记录状态 ${orch.status} 不允许直接废弃：running/paused 须先 cancelOrchestration，` +
        `done/failed 应归档历史（见 DISCARDABLE_STATUSES）`,
    );
  }
  const next = st.orchestrations.filter((o) => o.id !== orchId);
  if (next.length === st.orchestrations.length) return false;
  st.setOrchestrations(next);
  return true;
}

/**
 * 删除编排记录（H3c 收口补齐：历史清理入口）。
 * - 允许删除**非运行中**的任意状态记录（draft / awaiting-confirm / ready / failed / done / cancelled）；
 * - running / paused：**拒绝**——必须先 cancelOrchestrationRun 落 cancelled 再删除；
 * - 只删除编排记录（orchestrations），**绝不触碰任何用户工作流**（与 discardDraft 一致）。
 */
export function removeOrchestration(orchId: string): boolean {
  const st = useWorkflowStore.getState();
  const orch = st.orchestrations.find((o) => o.id === orchId);
  if (!orch) return false;
  if (orch.status === 'running' || orch.status === 'paused') {
    throw new Error(`编排记录正在执行（${orch.status}），请先取消再删除`);
  }
  const next = st.orchestrations.filter((o) => o.id !== orchId);
  if (next.length === st.orchestrations.length) return false;
  st.setOrchestrations(next);
  return true;
}

/**
 * 取消编排：running / paused（以及未开始的 awaiting-confirm/ready/draft）→ cancelled。
 * - 若在 running/paused，调用方（H3b runOrchestration 的停止钩子）应先 stopWorkflow 停止
 *   当前阶段，再调本函数落 cancelled 状态——本函数只负责状态收口；
 * - 迁移经 ALLOWED_TRANSITIONS 校验（running → cancelled / paused → cancelled 合法）。
 */
export function cancelOrchestration(orchId: string): Orchestration {
  const st = useWorkflowStore.getState();
  const idx = st.orchestrations.findIndex((o) => o.id === orchId);
  if (idx < 0) throw new Error(`编排记录不存在：${orchId}`);
  const cur = st.orchestrations[idx];
  if (!canTransition(cur.status, 'cancelled')) {
    throw new Error(`编排记录当前状态不能取消（${cur.status} → cancelled）：${cur.status}`);
  }
  const next: Orchestration = {
    ...cur,
    status: 'cancelled',
    updatedAt: new Date().toISOString(),
  };
  const list = [...st.orchestrations];
  list[idx] = next;
  st.setOrchestrations(list);
  return next;
}

/**
 * 更新编排状态（内部收口，供 run.ts 推进进度）。
 * 若 patch 含 status，则按 ALLOWED_TRANSITIONS 强制校验非法跳转：
 *   awaiting-confirm → running 等非法迁移会被拒绝（抛错）。
 */
export function updateOrchestration(
  orchId: string,
  patch: Partial<
    Pick<Orchestration, 'status' | 'cursor' | 'stageLogs' | 'runIds' | 'pipelineId' | 'stageWfIds' | 'draft'>
  >,
): Orchestration | undefined {
  const st = useWorkflowStore.getState();
  const idx = st.orchestrations.findIndex((o) => o.id === orchId);
  if (idx < 0) return undefined;
  const cur = st.orchestrations[idx];
  if (patch.status && !canTransition(cur.status, patch.status)) {
    throw new Error(
      `编排状态非法迁移：${cur.status} → ${patch.status}（拒绝；见 ALLOWED_TRANSITIONS）`,
    );
  }
  const next: Orchestration = {
    ...cur,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  const list = [...st.orchestrations];
  list[idx] = next;
  st.setOrchestrations(list);
  return next;
}

/**
 * 为某阶段绑定/配置工作流（H3c 编辑入口）：
 * - 仅允许在 awaiting-confirm / ready 状态（确认后、执行前仍可调整绑定）；
 * - 修改 draft.stages[stageId].wfRef（new=运行前创建空白工作流 / existing=只读引用已有工作流）；
 * - 不在此处创建/校验工作流——实际绑定由 runOrchestration 的 ensureStageWorkflow 在运行时
 *   完成（或由 prepareStageWorkflows 提前固化）。
 */
export function bindStageWorkflow(
  orchId: string,
  stageId: string,
  wfRef: { kind: 'new' } | { kind: 'existing'; wfId: string },
): Orchestration {
  const st = useWorkflowStore.getState();
  const orch = st.orchestrations.find((o) => o.id === orchId);
  if (!orch) throw new Error(`编排记录不存在：${orchId}`);
  if (orch.status !== 'awaiting-confirm' && orch.status !== 'ready') {
    throw new Error(
      `编排记录状态 ${orch.status} 不允许修改阶段绑定（仅 awaiting-confirm / ready）`,
    );
  }
  if (!orch.draft) throw new Error(`编排记录没有草案：${orchId}`);
  const stage = orch.draft.stages.find((s) => s.id === stageId);
  if (!stage) throw new Error(`阶段不存在：${stageId}`);
  const draft: PipelineDraft = {
    ...orch.draft,
    stages: orch.draft.stages.map((s) => (s.id === stageId ? { ...s, wfRef } : s)),
  };
  // P0 修复（H3c 审计）：重新绑定会使旧的固化绑定失效——执行器优先用 stageWfIds，
  // 若不清除，UI 上选中工作流 B 实际仍可能执行先前固化的工作流 A。
  // 清除该阶段的 stageWfIds，让 prepareStageWorkflows/runOrchestration 按新 wfRef 重新绑定。
  const patch: Partial<Pick<Orchestration, 'draft' | 'stageWfIds'>> = { draft };
  if (orch.stageWfIds && stageId in orch.stageWfIds) {
    const stageWfIds = { ...orch.stageWfIds };
    delete stageWfIds[stageId];
    patch.stageWfIds = stageWfIds;
  }
  return updateOrchestration(orchId, patch)!;
}

/**
 * 生成草案并创建编排记录（H3c UI 入口，供 OrchestratorPanel.onGenerate 调用）。
 * - 纯函数 generateDraft 生成草案（不落盘、不改用户工作流）；
 * - createOrchestration 写入编排记录并把 constraints.readonly 固化到 Orchestration.readonly
 *   （P0 修复：此前 UI 层漏传 readonly，勾选「只读」后仍可执行）。
 */
export function createDraftOrchestration(
  request: OrchestratorRequest,
  deps: DraftDeps,
): Orchestration {
  const draft = generateDraft(request, deps);
  return createOrchestration(request.goal.trim(), draft, {
    readonly: request.constraints?.readonly,
  });
}
