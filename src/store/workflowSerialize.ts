/**
 * workflowSerialize.ts — `workflowStore.ts` 内的「纯序列化 / 转换」子模块。
 *
 * 背景：workflowStore.ts 是执行引擎的「上帝模块」之一（2300+ 行），其中混入了大量
 * 与 store 运行态无关、只做「画布态 ⇄ 磁盘态」结构转换的纯函数（方案 P 内核的
 * toDisk / fromDisk / 拍平 / 还原 / 快照清洗 / ProjectFile 组装）。把它们抽到本文件，
 * 使 workflowStore.ts 聚焦于状态管理与副作用，同时这些纯函数可独立单测、零回归。
 *
 * 本文件不 import `useWorkflowStore` / `useRegistryStore`，也不触碰任何运行态，
 * 仅依赖 `../types` 与 `../engine/pipeline` 的类型，可在 node 测试环境下直接 import。
 */
import type {
  AgentConfig,
  AssetMeta,
  FlowEdge,
  FlowNode,
  NodeGroup,
  NodeStatus,
  ProjectFile,
  RoleTemplate,
  SubgraphDef,
  RunRecord,
  WorkflowFile,
  WorkflowFileEdge,
  WorkflowFileInMemory,
  WorkflowFileNode,
  WorkflowNodeData,
} from '../types';

/** 清洗节点，剔除运行期属性（status/error/durationMs/cached），使快照不携带运行态 */
export function sanitizeNodes(nodes: FlowNode[]): FlowNode[] {
  return nodes.map((n) => ({
    ...n,
    data: {
      ...n.data,
      status: 'idle' as NodeStatus,
      error: undefined,
      durationMs: undefined,
      cached: undefined,
    } as WorkflowNodeData,
  }));
}

/** 把磁盘态 WorkflowFile 的拍平节点还原为画布运行态 FlowNode（方案 P 内核） */
export function flowNodesFrom(wf: WorkflowFile): FlowNode[] {
  return (wf.nodes ?? []).map((n) => ({
    id: n.id,
    type: 'base',
    position: n.position,
    data: {
      typeId: n.typeId,
      label: n.label,
      params: n.params ?? {},
      status: 'idle' as NodeStatus,
      dirty: true,
      bypass: n.bypass ?? false,
      mute: n.mute ?? false,
    },
  }));
}

/** 把 WorkflowFile 的轻量连线还原为画布 FlowEdge（恢复 kind/scope 边语义） */
export function flowEdgesFrom(wf: WorkflowFile): FlowEdge[] {
  return (wf.edges ?? []).map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? undefined,
    targetHandle: e.targetHandle ?? undefined,
    data: { kind: e.kind ?? 'data', scope: e.scope },
  }));
}

/** 画布 FlowNode → 存储轻量节点（落盘拍平用） */
export function storedNodeOf(n: FlowNode): WorkflowFileNode {
  return {
    id: n.id,
    typeId: n.data.typeId,
    label: n.data.label,
    position: { x: n.position.x, y: n.position.y },
    params: n.data.params ?? {},
    bypass: n.data.bypass ?? false,
    mute: n.data.mute ?? false,
  };
}

/** 画布 FlowEdge → 存储轻量连线 */
export function storedEdgeOf(e: FlowEdge): WorkflowFileEdge {
  return {
    id: e.id,
    source: e.source,
    sourceHandle: e.sourceHandle ?? null,
    target: e.target,
    targetHandle: e.targetHandle ?? null,
    kind: e.data?.kind ?? 'data',
    scope: e.data?.scope,
  };
}

/**
 * 磁盘态 WorkflowFile → 内存态 WorkflowFileInMemory（nodes: FlowNode[]）。
 * 用于读取 .slimemold / localStorage / builder / .workflow.json 等所有拍平来源后统一收口。
 */
export function fromDisk(wf: WorkflowFile): WorkflowFileInMemory {
  return {
    ...wf,
    nodes: flowNodesFrom(wf),
    edges: flowEdgesFrom(wf),
  };
}

/** 内存态 WorkflowFileInMemory → 磁盘态 WorkflowFile（拍平，剥离 React Flow 瞬态字段） */
export function toDisk(wf: WorkflowFileInMemory): WorkflowFile {
  return {
    ...wf,
    nodes: (wf.nodes ?? []).map(storedNodeOf),
    edges: (wf.edges ?? []).map(storedEdgeOf),
  };
}

/** 把当前编辑态序列化为一个 WorkflowFile（用于收纳游离态/写回） */
export function serializeCurrent(
  s: {
    workflowName: string;
    nodes: FlowNode[];
    edges: FlowEdge[];
    agents: AgentConfig[];
    roles: RoleTemplate[];
    variables: Record<string, unknown>;
    groups?: NodeGroup[];
    defaultAgentId?: string | null;
  },
  /** 归属声明：保留原工作流的文件身份（项目内 / 游离路径） */
  identity?: { belongsToProject?: string; standalonePath?: string },
  /** 现有工作流的资产库（写回时保留，避免 addAsset/removeAsset 的改动丢失） */
  keepAssets?: AssetMeta[],
  /** 稳定模式：savedAt 用固定占位，避免时间戳使快照逐次刷新（脏检测用） */
  stable = false,
): WorkflowFileInMemory {
  return {
    version: 1,
    name: s.workflowName || '未命名工作流',
    savedAt: stable ? '' : new Date().toISOString(),
    // 方案 P：内存态直接持有运行态 FlowNode，无需再拍平/还原
    nodes: s.nodes.map((n) => ({ ...n, data: { ...n.data, dirty: true } })),
    edges: s.edges,
    agents: s.agents,
    roles: s.roles,
    variables: s.variables,
    groups: s.groups ?? [],
    assets: keepAssets ?? [],
    belongsToProject: identity?.belongsToProject,
    standalonePath: identity?.standalonePath,
  };
}

/** 把当前 store 态组装为完整 ProjectFile（供保存与 dirty 快照比对复用）。
 *
 * @param stable 稳定模式：时间戳/自增 id 用固定占位（createdAt 保持既有值、updatedAt 用
 *   固定常量、projectId 不 fallback 到 Date.now()），使「同一内容」产出「同一字节」，
 *   供 projectSnapshot 脏检测比对。保存落盘时应传 false（保留真实时间戳）。 */
export function buildProjectFile(
  s: {
    workflowName: string;
    nodes: FlowNode[];
    edges: FlowEdge[];
    agents: AgentConfig[];
    roles: RoleTemplate[];
    variables: Record<string, unknown>;
    projectVariables: Record<string, unknown>;
    projectAssets: AssetMeta[];
    groups: NodeGroup[];
    activeWfId: string;
    workflows: Record<string, WorkflowFileInMemory>;
    projectName: string | null;
    projectId: string | null;
    projectCreatedAt: string | null;
    subgraphs: Record<string, SubgraphDef>;
    runHistory: RunRecord[];
    checkpoints?: Record<string, import('../engine/checkpoint').RunCheckpoint>;
    artifacts: import('../engine/pipeline').ProjectArtifacts;
    agentRouteTable: import('../types').AgentRouteTable;
    pipelines: import('../engine/pipeline').PipelineDef[];
    defaultAgentId?: string | null;
  },
  stable = false,
): ProjectFile {
  const current: WorkflowFileInMemory = serializeCurrent(s, undefined, s.workflows[s.activeWfId]?.assets, stable);
  const workflowsInMemory = { ...s.workflows };
  if (s.activeWfId) workflowsInMemory[s.activeWfId] = current;
  else {
    const id = stable ? `wf-${current.name}` : `wf-${Date.now()}`;
    workflowsInMemory[id] = current;
  }
  // 方案 P：落盘前把内存态 FlowNode 拍平回磁盘态 WorkflowFile（剥离瞬态字段）
  const workflows: Record<string, WorkflowFile> = Object.fromEntries(
    Object.entries(workflowsInMemory).map(([k, wf]) => [k, toDisk(wf)]),
  );
  return {
    version: 1,
    kind: 'project',
    id: s.projectId ?? (stable ? `proj-${s.projectName ?? current.name}` : `proj-${Date.now()}`),
    name: s.projectName ?? s.workflowName,
    createdAt: s.projectCreatedAt ?? (stable ? '' : new Date().toISOString()),
    updatedAt: stable ? '' : new Date().toISOString(),
    workflows,
    // 稳定模式排除 activeId：切换激活工作流是视图态，不构成「项目内容变化」，
    // 不应让脏检测误报未保存（activeId 仅在保存落盘时保留真实值）
    activeId: stable ? '' : (s.activeWfId || Object.keys(workflows)[0]),
    roles: s.roles,
    variables: s.projectVariables,
    assets: s.projectAssets,
    subgraphs: s.subgraphs,
    artifacts: s.artifacts,
    // 项目级 agents 独立于任何工作流（2026-08-10）：持久化到 .slimemold/agents.json，
    // 保证切换/重开工作流不丢失。
    agents: s.agents,
    defaultAgentId: s.defaultAgentId ?? null,
    agentRouteTable: s.agentRouteTable,
    pipelines: s.pipelines,
    runs: { history: s.runHistory },
    checkpoints: s.checkpoints ?? {},
  };
}

/** 当前项目态的稳定快照字符串（仅含落盘相关字段，排除运行态/日志等）。
 * 用于脏检测：与上次保存的快照比对即可判断是否偏离。
 * 以 stable 模式序列化（时间戳/自增 id 占位），保证「内容未变 → 快照字节不变」，
 * 避免 updatedAt 每次刷新导致 dirty 恒为 true。 */
export function projectSnapshot(s: Parameters<typeof buildProjectFile>[0]): string {
  return JSON.stringify(buildProjectFile(s, true));
}

/** 脏检测白名单：仅当这些字段变化时才比对快照，避免日志/运行态频繁触发 stringify。
 * 从 workflowStore 抽离为共享常量，供脏检测 subscribe 与测试复用。
 *
 * 语义（Codex 评审后收口）：
 * - 只列「落盘相关」字段（会写入 ProjectFile 的内容）；视图态/运行配置
 *   （activeWfId 切换、llmChannel、failFast、skipFailed、maxConcurrency）不列，
 *   因为它们要么已被 projectSnapshot 稳定化排除（activeId），要么根本不落盘，
 *   变化不应触发 dirty 误报。 */
export const DIRTY_KEYS = [
  'nodes',
  'edges',
  'agents',
  'roles',
  'variables',
  'projectVariables',
  'projectAssets',
  'groups',
  'subgraphs',
  'workflows',
  'artifacts',
  'agentRouteTable',
  'pipelines',
  'projectName',
  'workflowName',
] as const;
