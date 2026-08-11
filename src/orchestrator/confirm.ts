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
import type { Orchestration, PipelineDraft } from '../types';
import type { Confirmation } from './types';

/** 创建编排记录（草案态，不落 pipeline）——仅写入 orchestrations 集合 */
export function createOrchestration(goal: string, draft: PipelineDraft): Orchestration {
  const now = new Date().toISOString();
  const orch: Orchestration = {
    id: `orch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    goal,
    status: 'awaiting-confirm',
    createdAt: now,
    updatedAt: now,
    draft,
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
  if (orch.status !== 'awaiting-confirm') {
    throw new Error(`编排记录当前状态不允许确认：${orch.status}`);
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

/**
 * 废弃草案：只删除编排记录，不触碰任何用户工作流。
 * 若已注册 pipeline，由调用方决定是否保留（默认保留，用户可手动清理）。
 */
export function discardDraft(orchId: string): boolean {
  const st = useWorkflowStore.getState();
  const next = st.orchestrations.filter((o) => o.id !== orchId);
  if (next.length === st.orchestrations.length) return false;
  st.setOrchestrations(next);
  return true;
}

/**
 * 更新编排状态（通用内部收口，供 run.ts 推进进度）。
 * 注意：进入 running 只允许由 runOrchestration 调用（H3b），此处不设限制以便复用，
 * 但调用方须遵循「ready → running」的语义。
 */
export function updateOrchestration(
  orchId: string,
  patch: Partial<Pick<Orchestration, 'status' | 'cursor' | 'stageLogs' | 'runIds' | 'pipelineId'>>,
): Orchestration | undefined {
  const st = useWorkflowStore.getState();
  const idx = st.orchestrations.findIndex((o) => o.id === orchId);
  if (idx < 0) return undefined;
  const next: Orchestration = {
    ...st.orchestrations[idx],
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  const list = [...st.orchestrations];
  list[idx] = next;
  st.setOrchestrations(list);
  return next;
}
