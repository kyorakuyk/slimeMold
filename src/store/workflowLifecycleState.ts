/**
 * workflowLifecycleState.ts — pure project bootstrap and hydration builders.
 *
 * These functions return store patches only. Path selection, persistence, dirty suppression
 * and ProjectControl runtime activation remain owned by workflowStore and its controllers.
 */
import type { AgentConfig, RoleTemplate } from '../types/agent';
import type {
  AssetMeta,
  FlowEdge,
  FlowNode,
  NodeGroup,
  ProjectFile,
  SubgraphDef,
  WorkflowFileInMemory,
} from '../types';
import { flowEdgesFrom, flowNodesFrom, fromDisk } from './workflowSerialize';
import { builtinRoles, createAgent } from '../agents/agentManager';
import { createEmptyProjectControlSnapshot, parseProjectControlSnapshot } from '../projectControl/persistence';
import type { ProjectControlSnapshot } from '../projectControl/types';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { EvidenceRecord } from '../dev/evidence';
import type { SideEffectRecord } from '../domain/contracts';
import type { WorkerRunRecovery } from '../projectControl/workerRunRuntime';
import type { WorkerCleanupProposal } from '../projectControl/workerCleanup';

export interface CloseProjectStatePatch {
  projectName: null;
  projectId: null;
  projectCreatedAt: null;
  projectPath: null;
  projectDirty: false;
  lastSavedSnapshot: null;
  workflows: Record<string, WorkflowFileInMemory>;
  activeWfId: '';
  workflowName: '';
  nodes: FlowNode[];
  edges: FlowEdge[];
  agents: AgentConfig[];
  roles: RoleTemplate[];
  variables: Record<string, unknown>;
  projectVariables: Record<string, unknown>;
  projectAssets: AssetMeta[];
  subgraphs: Record<string, SubgraphDef>;
  groups: NodeGroup[];
  workerRuns: WorkerRunQueueState[];
  workerRunRecoveries: WorkerRunRecovery[];
  workerRunEvidence: EvidenceRecord[];
  workerRunSideEffects: SideEffectRecord[];
  workerCleanupProposals: WorkerCleanupProposal[];
  projectControl: ProjectControlSnapshot;
  selectedNodeId: null;
  logs: never[];
}

export interface CloseProjectStateFactories {
  createDefaultAgent: () => AgentConfig;
  cloneBuiltinRoles: () => RoleTemplate[];
  createEmptyProjectControl: () => ProjectControlSnapshot;
}

export function buildCloseProjectState(
  factories: CloseProjectStateFactories,
): CloseProjectStatePatch {
  return {
    projectName: null,
    projectId: null,
    projectCreatedAt: null,
    projectPath: null,
    projectDirty: false,
    lastSavedSnapshot: null,
    workflows: {},
    activeWfId: '',
    workflowName: '',
    nodes: [],
    edges: [],
    agents: [factories.createDefaultAgent()],
    roles: factories.cloneBuiltinRoles(),
    variables: {},
    projectVariables: {},
    projectAssets: [],
    subgraphs: {},
    groups: [],
    workerRuns: [],
    workerRunRecoveries: [],
    workerRunEvidence: [],
    workerRunSideEffects: [],
    workerCleanupProposals: [],
    projectControl: factories.createEmptyProjectControl(),
    selectedNodeId: null,
    logs: [],
  };
}

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
export interface CreateProjectStateInput {
  name: string;
  projectId: string;
  workflowId: string;
  createdAt: string;
  projectPath: string | null;
  template?: {
    name: string;
    nodes: FlowNode[];
    edges: FlowEdge[];
  };
}

/** createProject 写入项目/工作流状态子集。 */
export interface CreateProjectState {
  projectName: string;
  projectId: string;
  projectCreatedAt: string;
  projectPath: string | null;
  projectDirty: boolean;
  lastSavedSnapshot: null;
  workflows: Record<string, WorkflowFileInMemory>;
  activeWfId: string;
  workflowName: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  agents: import('../types').AgentConfig[];
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
 * 构建「引导式新建项目」的纯状态。
 * 路径选择、store mutation、保存和失败恢复由 workflowStore action 负责。
 */
export function buildCreateProjectState(input: CreateProjectStateInput): CreateProjectState {
  const template = input.template ?? { name: '未命名工作流', nodes: [], edges: [] };
  const baseAgents = [createAgent('ollama')];
  const workflowNodes = template.nodes.map((node) => ({
    ...node,
    data: { ...node.data, dirty: true },
  }));
  const canvasNodes = template.nodes.map((node) => ({
    ...node,
    data: { ...node.data, dirty: true },
  }));
  const workflowRoles = builtinRoles.map((role) => ({ ...role }));
  const workflow: WorkflowFileInMemory = {
    version: 1,
    name: template.name,
    savedAt: input.createdAt,
    nodes: workflowNodes,
    edges: template.edges,
    agents: baseAgents,
    roles: workflowRoles,
    variables: {},
    belongsToProject: input.projectId,
  };

  return {
    projectName: input.name,
    projectId: input.projectId,
    projectCreatedAt: input.createdAt,
    projectPath: input.projectPath,
    projectDirty: !!input.projectPath,
    lastSavedSnapshot: null,
    workflows: { [input.workflowId]: workflow },
    activeWfId: input.workflowId,
    workflowName: workflow.name,
    nodes: canvasNodes,
    edges: template.edges,
    agents: baseAgents,
    roles: builtinRoles.map((role) => ({ ...role })),
    variables: workflow.variables!,
    projectVariables: {},
    projectAssets: [],
    workerRuns: [],
    projectControl: createEmptyProjectControlSnapshot(),
    selectedNodeId: null,
    logs: [],
  };
}


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
