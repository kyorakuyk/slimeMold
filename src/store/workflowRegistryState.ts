/**
 * workflowRegistryState.ts — project workflow registry transitions.
 *
 * Pure builders for workflow identity, registration, capture, switching and canvas activation.
 * Zustand set/get, persistence, dialogs and ProjectControl lifecycle remain in the facade.
 */
import type { WorkflowFile, WorkflowFileInMemory } from '../types/workflow';
import type { FlowEdge, FlowNode } from '../types';
import { fromDisk, serializeCurrent } from './workflowSerialize';
import { builtinRoles, createAgent } from '../agents/agentManager';

export function resolveActiveWorkflowWorkspaceDir(input: {
  workflows: Record<string, Pick<WorkflowFileInMemory, 'workspaceDir'>>;
  activeWfId: string;
  workspaceDir?: string | null;
}): string | null {
  const active = input.workflows[input.activeWfId];
  if (active?.workspaceDir !== undefined) return active.workspaceDir;
  return input.workspaceDir ?? null;
}
/** switchWorkflow 的状态构建所需的最小「当前状态视图」（避免依赖完整 WorkflowState）。 */
export interface WorkflowSwitchView {
  workflows: Record<string, WorkflowFileInMemory>;
  activeWfId: string | null;
  workflowName: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  agents: import('../types').AgentConfig[];
  roles: import('../types').RoleTemplate[];
  variables: Record<string, unknown>;
  groups?: import('../types/workflow').NodeGroup[];
  defaultAgentId?: string | null;
}

/** switchWorkflow 的纯状态构建结果。 */
export interface SwitchWorkflowState {
  workflows: Record<string, WorkflowFileInMemory>;
  activeWfId: string;
  workflowName: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  agents: import('../types').AgentConfig[];
  roles: import('../types').RoleTemplate[];
  variables: Record<string, unknown>;
  groups: import('../types/workflow').NodeGroup[];
  selectedNodeId: null;
  logs: never[];
}

/**
 * 构建「切换工作流」的纯状态（switchWorkflow 纯计算段，G5 门面化）。
 * - 写回当前编辑态（若为游离态则先收纳为临时工作流）
 * - 加载目标工作流到画布
 * 不触碰 store 单例；suppressDirty + set 由调用方执行。返回 null 表示目标工作流不存在。
 */
export function buildSwitchWorkflowState(
  view: WorkflowSwitchView,
  id: string,
): SwitchWorkflowState | null {
  if (id === view.activeWfId) return null;
  // 写回当前编辑态（若为游离态则先收纳为临时工作流，避免节点丢失）
  const synced: Record<string, WorkflowFileInMemory> = { ...view.workflows };
  const curId = view.activeWfId || `wf-${Date.now()}`;
  const prev = view.workflows[curId];
  synced[curId] = serializeCurrent(
    view,
    {
      belongsToProject: prev?.belongsToProject,
      standalonePath: prev?.standalonePath,
    },
    prev?.assets,
  );
  const target = synced[id];
  if (!target) return null;
  return {
    workflows: synced,
    activeWfId: id,
    workflowName: target.name,
    // 方案 P：workflows 已是运行态 FlowNode，直接复用
    nodes: target.nodes.map((n) => ({ ...n, data: { ...n.data, dirty: true } })),
    edges: target.edges,
    // agents 是「项目级共享」，切换工作流不覆盖；仅当项目尚无任何 agent 时以目标工作流的做初始灌入
    agents: view.agents.length ? view.agents : target.agents?.length ? target.agents : view.agents,
    roles: [...builtinRoles.map((r) => ({ ...r })), ...(target.roles ?? []).filter((r) => !r.builtin)],
    variables: target.variables ?? {},
    groups: target.groups ?? [],
    selectedNodeId: null,
    logs: [],
  };
}

export interface RenameWorkflowStateInput {
  workflows: Record<string, WorkflowFileInMemory>;
  activeWfId: string;
  name: string;
}

export function buildRenameWorkflowState(
  input: RenameWorkflowStateInput,
): WorkflowFileInMemory | null {
  if (!input.activeWfId) return null;
  const workflow = input.workflows[input.activeWfId];
  return workflow ? { ...workflow, name: input.name } : null;
}

export interface RemoveWorkflowStateInput {
  workflows: Record<string, WorkflowFileInMemory>;
  activeWfId: string;
  id: string;
}

export interface WorkflowRemovalActivation {
  activeWfId: string;
  workflowName: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  agents: import('../types').AgentConfig[];
  defaultAgentId?: string | null;
  roles: import('../types').RoleTemplate[];
  variables: Record<string, unknown>;
  selectedNodeId: null;
  logs: never[];
}

export interface RemoveWorkflowState {
  workflows: Record<string, WorkflowFileInMemory>;
  activation?: WorkflowRemovalActivation;
  cleanupWorkflowId: string | null;
}

export function buildRemoveWorkflowState(
  input: RemoveWorkflowStateInput,
): RemoveWorkflowState {
  const next = { ...input.workflows };
  const target = input.workflows[input.id];
  const cleanupWorkflowId = target && !target.workspaceDir ? input.id : null;
  delete next[input.id];

  if (Object.keys(next).length === 0) {
    return {
      workflows: next,
      cleanupWorkflowId,
      activation: {
        activeWfId: '',
        workflowName: '',
        nodes: [],
        edges: [],
        agents: [createAgent('ollama')],
        roles: builtinRoles.map((role) => ({ ...role })),
        variables: {},
        selectedNodeId: null,
        logs: [],
      },
    };
  }

  if (input.id !== input.activeWfId) {
    return { workflows: next, cleanupWorkflowId };
  }

  const newId = Object.keys(next)[0];
  const workflow = next[newId];
  return {
    workflows: next,
    cleanupWorkflowId,
    activation: {
      activeWfId: newId,
      workflowName: workflow.name,
      nodes: workflow.nodes.map((node) => ({ ...node, data: { ...node.data, dirty: true } })),
      edges: workflow.edges,
      agents: workflow.agents?.length ? workflow.agents : [createAgent('ollama')],
      defaultAgentId: workflow.defaultAgentId ?? null,
      roles: [
        ...builtinRoles.map((role) => ({ ...role })),
        ...(workflow.roles ?? []).filter((role) => !role.builtin),
      ],
      variables: workflow.variables ?? {},
      selectedNodeId: null,
      logs: [],
    },
  };
}

export interface RegisteredWorkflowStateInput {
  workflow: WorkflowFile;
  id: string;
  savedAt: string;
  projectId: string | null;
  workflows: Record<string, WorkflowFileInMemory>;
  activeWfId: string;
  activate: boolean;
  name?: string;
}

export interface RegisteredWorkflowActivation {
  activeWfId: string;
  workflowName: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  agents: import('../types').AgentConfig[];
  defaultAgentId: string | null;
  roles: import('../types').RoleTemplate[];
  variables: Record<string, unknown>;
  groups: import('../types/workflow').NodeGroup[];
  selectedNodeId: null;
  logs: never[];
}

export interface RegisteredWorkflowState {
  id: string;
  workflows: Record<string, WorkflowFileInMemory>;
  activation?: RegisteredWorkflowActivation;
}

/**
 * 构建 registerWorkflow 的 normalized registry 与可选 canvas activation state。
 * 不触碰 store；ID生成和 set 由 facade负责。
 */
export function buildRegisteredWorkflowState(input: RegisteredWorkflowStateInput): RegisteredWorkflowState {
  const current = input.workflows[input.activeWfId];
  const merged: WorkflowFileInMemory = {
    ...fromDisk(input.workflow),
    name: input.name ?? input.workflow.name ?? '生成的工作流',
    savedAt: input.savedAt,
    belongsToProject: input.workflow.belongsToProject ?? (input.projectId ? input.projectId : undefined),
    standalonePath:
      input.workflow.standalonePath ?? (input.projectId ? undefined : current?.standalonePath),
    agents: input.workflow.agents?.length
      ? input.workflow.agents
      : (current?.agents ?? [createAgent('ollama')]),
    roles: input.workflow.roles?.length
      ? input.workflow.roles
      : (current?.roles ?? builtinRoles.map((role) => ({ ...role }))),
    variables: input.workflow.variables ?? {},
    assets: input.workflow.assets ?? [],
    groups: input.workflow.groups ?? [],
  };
  const workflows = { ...input.workflows, [input.id]: merged };
  if (!input.activate) return { id: input.id, workflows };
  return {
    id: input.id,
    workflows,
    activation: {
      activeWfId: input.id,
      workflowName: merged.name,
      nodes: merged.nodes.map((node) => ({ ...node, data: { ...node.data, dirty: true } })),
      edges: merged.edges,
      agents: merged.agents,
      defaultAgentId: merged.defaultAgentId ?? null,
      roles: merged.roles!,
      variables: merged.variables!,
      groups: merged.groups!,
      selectedNodeId: null,
      logs: [],
    },
  };
}

/** newWorkflowInProject 的纯输入。 */
export interface NewWorkflowInProjectStateInput {
  workflows: Record<string, WorkflowFileInMemory>;
  activeWfId: string;
  current: {
    workflowName: string;
    nodes: FlowNode[];
    edges: FlowEdge[];
    agents: import('../types').AgentConfig[];
    roles: import('../types').RoleTemplate[];
    variables: Record<string, unknown>;
    groups?: import('../types/workflow').NodeGroup[];
    defaultAgentId?: string | null;
  };
  projectId: string | null;
  standalonePath?: string;
  workflowId: string;
  capturedWorkflowId: string;
  capturedSavedAt: string;
  savedAt: string;
}

export function buildNewWorkflowInProjectState(
  input: NewWorkflowInProjectStateInput,
): RegisteredWorkflowState {
  const workflows = { ...input.workflows };
  if (!input.activeWfId && (input.current.nodes.length || input.current.edges.length)) {
    const capturedId = input.capturedWorkflowId;
    const previous = workflows[capturedId];
    workflows[capturedId] = serializeCurrent(
      input.current,
      {
        belongsToProject: previous?.belongsToProject,
        standalonePath: previous?.standalonePath,
      },
      previous?.assets,
      false,
      input.capturedSavedAt,
    );
  }
  const workflow: WorkflowFileInMemory = {
    version: 1,
    name: `工作流 ${Object.keys(workflows).length + 1}`,
    savedAt: input.savedAt,
    nodes: [],
    edges: [],
    agents: [createAgent('ollama')],
    roles: builtinRoles.map((role) => ({ ...role })),
    variables: {},
    workspaceDir: input.standalonePath ?? null,
    assets: [],
    groups: [],
    belongsToProject: input.projectId ? input.projectId : undefined,
    standalonePath: input.projectId ? undefined : input.standalonePath,
  };
  workflows[input.workflowId] = workflow;
  return {
    id: input.workflowId,
    workflows,
    activation: {
      activeWfId: input.workflowId,
      workflowName: workflow.name,
      nodes: [],
      edges: [],
      agents: workflow.agents,
      defaultAgentId: workflow.defaultAgentId ?? null,
      roles: workflow.roles!,
      variables: workflow.variables!,
      groups: [],
      selectedNodeId: null,
      logs: [],
    },
  };
}
