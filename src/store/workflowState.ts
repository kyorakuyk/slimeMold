/**
 * workflowState.ts — workflowStore 状态转换纯逻辑（G5 门面化继续）。
 *
 * 收拢「不触碰 store 单例」的纯状态转换：
 * - upsertById：通用「按 id 更新或追加」列表转换
 * - cleanupRouteTableForAgent：删除 agent 后路由表清理（agentId 命中置空、fallback 剔除、
 *   无引用项整体移除）
 *
 * 设计原则：纯函数，只依赖输入参数 + 类型；workflowStore action 负责 set/get 调度，
 * 本模块只做「给定旧状态 → 新状态」的纯计算，可独立单测。
 */
import type {
  AgentRouteEntry,
  AgentRouteTable,
  FlowEdge,
  FlowNode,
  ProjectFile,
  WorkflowFileInMemory,
} from '../types';
import { flowEdgesFrom, flowNodesFrom, fromDisk, serializeCurrent } from './workflowSerialize';
import { builtinRoles, createAgent } from '../agents/agentManager';
import { createEmptyProjectControlSnapshot, parseProjectControlSnapshot } from '../projectControl/persistence';
import type { ProjectControlSnapshot } from '../projectControl/types';

export function resolveActiveWorkflowWorkspaceDir(input: {
  workflows: Record<string, Pick<WorkflowFileInMemory, 'workspaceDir'>>;
  activeWfId: string;
  workspaceDir?: string | null;
}): string | null {
  const active = input.workflows[input.activeWfId];
  if (active?.workspaceDir !== undefined) return active.workspaceDir;
  return input.workspaceDir ?? null;
}

/** 按 id 更新或追加：列表中存在同 id 项则替换，否则追加。纯函数。 */
export function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const exists = list.some((a) => a.id === item.id);
  return exists ? list.map((a) => (a.id === item.id ? item : a)) : [...list, item];
}

/**
 * 删除 agent 后清理路由表（纯函数）：
 * - agentId 命中该 id → 置空
 * - fallback 含该 id → 从数组中剔除
 * - 无任何引用（agentId 为空且无 fallback）→ 整体移除该类别项
 *
 * @returns 清理后的路由表 + 是否发生变更（供调用方决定是否写回 store）
 */
export function cleanupRouteTableForAgent(
  routeTable: AgentRouteTable,
  agentId: string,
): { table: AgentRouteTable; changed: boolean } {
  const table = { ...routeTable };
  let changed = false;
  for (const key of Object.keys(table)) {
    const item = table[key];
    if (!item) continue;
    const next: AgentRouteEntry = {
      agentId: item.agentId,
      fallback: item.fallback ? [...item.fallback] : [],
    };
    if (next.agentId === agentId) {
      next.agentId = '';
      changed = true;
    }
    if (next.fallback?.includes(agentId)) {
      next.fallback = next.fallback.filter((f) => f !== agentId);
      changed = true;
    }
    // 类别项已无任何引用（agentId 被删或为空，且无 fallback）→ 整体移除，避免留下脏配置
    if (!next.agentId && (next.fallback?.length ?? 0) === 0) {
      delete table[key];
      changed = true;
    } else {
      table[key] = next;
    }
  }
  return { table, changed };
}

/* ---------------- 项目生命周期纯状态构建（G5 门面化 · 生命周期边界） ---------------- */

/** openProject 的纯状态构建结果（返回给 store 的 Partial 状态子集，不含运行态/日志）。 */
export interface OpenProjectState {
  projectName: string;
  projectId: string | null;
  projectCreatedAt: string | null;
  projectPath: string;
  workflows: Record<string, WorkflowFileInMemory>;
  activeWfId: string;
  workflowName: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  agents: import('../types').AgentConfig[];
  defaultAgentId: string | null;
  roles: import('../types').RoleTemplate[];
  variables: Record<string, unknown>;
  projectVariables: Record<string, unknown>;
  projectAssets: import('../types').AssetMeta[];
  subgraphs: Record<string, import('../types').SubgraphDef>;
  groups: import('../types').NodeGroup[];
  runHistory: import('../types').RunRecord[];
  checkpoints: Record<string, import('../engine/checkpoint').RunCheckpoint>;
  checkpointHistory: Record<string, import('../engine/checkpoint').RunCheckpoint[]>;
  artifacts: import('../types').ProjectArtifacts;
  pipelines: import('../types').PipelineDef[];
  orchestrations: import('../types').Orchestration[];
  workerRuns: import('../domain/workerQueue').WorkerRunQueueState[];
  projectControl: ProjectControlSnapshot;
  selectedNodeId: null;
  logs: never[];
}

/**
 * 构建「打开项目」的纯状态（openProject 纯计算段，G5 门面化）。
 * 输入 ProjectFile + 磁盘路径 + 当前 defaultAgentId 兜底，输出新的 store 状态子集。
 * 不触碰 store 单例；set + finalizeLoaded 由调用方执行。
 */
export function buildOpenProjectState(
  file: ProjectFile,
  path: string,
  fallbackDefaultAgentId: string | null,
): OpenProjectState {
  const id = file.activeId ?? Object.keys(file.workflows)[0];
  const wf = file.workflows[id];
  if (!wf) throw new Error('打开项目失败：无可用工作流');
  // 方案 P：磁盘态拍平 workflows 统一收口为内存态 FlowNode
  const workflowsInMemory = Object.fromEntries(
    Object.entries(file.workflows).map(([k, w]) => [k, fromDisk(w)]),
  );
  return {
    projectName: file.name,
    projectId: file.id,
    projectCreatedAt: file.createdAt,
    projectPath: path ?? file.name, // 实际磁盘路径由调用方传入
    workflows: workflowsInMemory,
    activeWfId: id,
    workflowName: wf.name,
    // P1：打开即把活动工作流还原到画布，保证落盘内容完整
    nodes: flowNodesFrom(wf),
    edges: flowEdgesFrom(wf),
    // agents 项目级共享：优先用项目级 file.agents（来自 .slimemold/Agents/agents.json），
    // 不再被某个工作流的 wf.agents 覆盖；旧数据无项目级 agents 时回退工作流级并合并。
    agents:
      file.agents && file.agents.length
        ? file.agents
        : wf.agents?.length
          ? wf.agents
          : [createAgent('ollama')],
    defaultAgentId: (file.defaultAgentId ?? wf.defaultAgentId) ?? fallbackDefaultAgentId,
    roles: [
      ...builtinRoles.map((r) => ({ ...r })),
      ...(wf.roles ?? []).filter((r) => !r.builtin),
    ],
    variables: wf.variables ?? {},
    projectVariables: file.variables ?? {},
    projectAssets: file.assets ?? [],
    subgraphs: file.subgraphs ?? {},
    groups: wf.groups ?? [],
    // P2 成本跟项目：读回运行历史（落盘于 .slimemold/runs/history.json）
    runHistory: file.runs?.history ?? [],
    // 阶段 C 可恢复执行：读回运行检查点（落盘于 .slimemold/runs/checkpoints.json）
    checkpoints: file.checkpoints ?? {},
    // 阶段 G2：读回检查点多版本历史（同文件）
    checkpointHistory: file.checkpointHistory ?? {},
    // 交付物：读回项目级黑板（pipeline.handoff 产出的成果，落盘于 project.json 的 artifacts）
    artifacts: file.artifacts ?? {},
    pipelines: file.pipelines ?? [],
    orchestrations: file.orchestrations ?? [],
    workerRuns: Array.isArray(file.workerRuns) ? file.workerRuns : [],
    projectControl: parseProjectControlSnapshot(file.projectControl),
    selectedNodeId: null,
    logs: [],
  };
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
  groups?: import('../types').NodeGroup[];
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
  groups: import('../types').NodeGroup[];
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

/** newProject 的纯状态构建结果。 */
export interface NewProjectState {
  projectName: string;
  projectId: string;
  projectCreatedAt: string;
  projectPath: null;
  projectDirty: true;
  lastSavedSnapshot: null;
  workflows: Record<string, WorkflowFileInMemory>;
  activeWfId: string;
  workflowName: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  agents: import('../types').AgentConfig[];
  defaultAgentId: string | null;
  roles: import('../types').RoleTemplate[];
  variables: Record<string, unknown>;
  projectVariables: Record<string, unknown>;
  projectAssets: import('../types').AssetMeta[];
  workerRuns: import('../domain/workerQueue').WorkerRunQueueState[];
  projectControl: ProjectControlSnapshot;
  selectedNodeId: null;
  logs: never[];
}

/**
 * 构建「新建项目」的纯状态（newProject 纯计算段，G5 门面化收口）。
 * 生成一个空白工作流 + 项目元信息，返回新的 store 状态子集。
 * 不触碰 store 单例；suppressDirty + set 由调用方执行。
 */
export function buildNewProjectState(name: string): NewProjectState {
  const id = `wf-${Date.now()}`;
  const projId = `proj-${Date.now()}`;
  const now = new Date().toISOString();
  const wf: WorkflowFileInMemory = {
    version: 1,
    name: '未命名工作流',
    savedAt: now,
    nodes: [],
    edges: [],
    agents: [createAgent('ollama')],
    roles: builtinRoles.map((r) => ({ ...r })),
    variables: {},
    belongsToProject: projId,
  };
  return {
    projectName: name,
    projectId: projId,
    projectCreatedAt: now,
    projectPath: null,
    // 新建项目尚未落盘：标记项目级脏，且无落盘快照
    projectDirty: true,
    lastSavedSnapshot: null,
    workflows: { [id]: wf },
    activeWfId: id,
    workflowName: wf.name,
    nodes: [],
    edges: [],
    agents: wf.agents,
    defaultAgentId: wf.defaultAgentId ?? null,
    roles: wf.roles!,
    variables: wf.variables!,
    projectVariables: {},
    projectAssets: [],
    workerRuns: [],
    projectControl: createEmptyProjectControlSnapshot(),
    selectedNodeId: null,
    logs: [],
  };
}
