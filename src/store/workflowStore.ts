import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type NodeChange,
  type EdgeChange,
  type Connection,
} from '@xyflow/react';
import type {
  AgentConfig,
  AssetMeta,
  FlowEdge,
  FlowNode,
  LogEntry,
  NodeGroup,
  NodeStatus,
  ProxyPort,
  VirtualEdge,
  PortType,
  EdgeKind,
  ProjectFile,
  RoleTemplate,
  RunRecord,
  SubgraphDef,
  WorkflowFile,
  WorkflowFileNode,
  WorkflowFileEdge,
  WorkflowNodeData,
} from '../types';
import { arePortsCompatible } from '../types';
import { wouldCreateCycle } from '../engine/topoSort';
import { useRegistryStore, getNodeDef } from './registryStore';
import { useViewStore } from './viewStore';
import { inferPorts, packSubgraph, resolvePorts, SUBGRAPH_REF_TYPE } from '../engine/subgraph';
import { createAgent, builtinRoles } from '../agents/agentManager';
import { defaultStandaloneDir, isTauri, showSaveDirDialog } from '../platform/env';
import { saveLastSession, clearLastSession } from '../io/projectIO';
import { STARTER_TEMPLATES } from '../data/starterTemplates';

/**
 * 根据分组内部节点，按「端口类型」聚合推导折叠态的代理端口（ProxyPort）
 * 与一对多虚拟边（VirtualEdge）。
 * - 内部共需 2×img + 1×txt 输入 -> 仅生成 img、txt 两个聚合输入端口。
 * - 外部多对一：多个父图连线可连到同一个聚合端口。
 * - 内部一对多：聚合端口 -> 所有同类型内部端口（virtualEdges.targets）。
 */
export function recomputeProxyPorts(
  group: NodeGroup,
  sg: SubgraphDef,
  nodes: FlowNode[],
  edges: FlowEdge[],
): NodeGroup {
  const defs = useRegistryStore.getState().defs;
  const memberSet = new Set(group.nodeIds);

  // 聚合：type -> 内部端口列表
  const inByType = new Map<string, Array<{ nodeId: string; portId: string }>>();
  const outByType = new Map<string, Array<{ nodeId: string; portId: string }>>();
  for (const n of nodes) {
    if (!memberSet.has(n.id)) continue;
    const def = defs[n.data.typeId];
    if (!def) continue;
    for (const p of def.inputs ?? []) {
      const list = inByType.get(p.type ?? 'any') ?? [];
      list.push({ nodeId: n.id, portId: p.id });
      inByType.set(p.type ?? 'any', list);
    }
    for (const p of def.outputs ?? []) {
      const list = outByType.get(p.type ?? 'any') ?? [];
      list.push({ nodeId: n.id, portId: p.id });
      outByType.set(p.type ?? 'any', list);
    }
  }

  const proxyPorts: ProxyPort[] = [];
  const virtualEdges: VirtualEdge[] = [];
  let idx = 0;
  for (const [type, targets] of inByType) {
    const id = `${group.id}:in:${type}`;
    proxyPorts.push({ id, kind: 'input', type: type as PortType, label: type, internalTargets: targets });
    virtualEdges.push({ id: `ve_${idx++}`, proxyPortId: id, kind: 'input', targets });
  }
  for (const [type, targets] of outByType) {
    const id = `${group.id}:out:${type}`;
    proxyPorts.push({ id, kind: 'output', type: type as PortType, label: type, internalTargets: targets });
    virtualEdges.push({ id: `ve_${idx++}`, proxyPortId: id, kind: 'output', targets });
  }
  return { ...group, proxyPorts, virtualEdges };
}

interface WorkflowState {
  workflowName: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  agents: AgentConfig[];
  /** 默认智能体 id：节点未指定智能体时引用此默认项 */
  defaultAgentId: string | null;
  /** 角色库：工作流级角色模板（含内置预设 + 用户自建） */
  roles: RoleTemplate[];
  selectedNodeId: string | null;
  /** 焦点节点所属工作流 id（拆分视图下，焦点节点可能在非激活工作流中） */
  focusWfId: string;
  /** 示例库次级窗口是否打开（UI 状态，不持久化） */
  examplesOpen: boolean;
  running: boolean;
  failFast: boolean;
  /** 失败时继续（failFast 的反面策略）：某节点失败后不中断整体运行，下游以空上游输出跳过失败继续执行 */
  skipFailed: boolean;
  /** LLM 并发上限：同一时刻最多进行的智能体请求数 */
  maxConcurrency: number;
  /** LLM 调用通道：'backend'（经 Tauri Rust 命令，密钥不出前端）/ 'frontend'（WebView 直接请求）。默认 backend。 */
  llmChannel: 'backend' | 'frontend';
  logs: LogEntry[];
  /** 当前激活工作流的全局变量（可在 {{}} 模板与表达式中引用），覆盖项目级同名变量 */
  variables: Record<string, unknown>;
  /** 项目级变量（跨工作流共享；被工作流级 variables 覆盖同名项） */
  projectVariables: Record<string, unknown>;
  /** 项目级资产库（跨工作流共享） */
  projectAssets: AssetMeta[];
  /** 历史运行记录（持久化） */
  runHistory: RunRecord[];

  /**
   * 最近一次「自动保存」的时间戳（仅 UI 提示用，不持久化到磁盘，
   * 因为 zustand persist 已在每次变更后同步写入 localStorage）。
   */
  lastAutosave: number | null;

  /* ---- 项目层（多工作流） ---- */
  /** 当前项目名（无项目时为 null，表示游离单工作流） */
  projectName: string | null;
  /** 当前项目 id（对应磁盘 project.json 的 id；游离态为 null） */
  projectId: string | null;
  /** 当前项目创建时间（磁盘唯一真相，保存时不得重写） */
  projectCreatedAt: string | null;
  /** 当前项目文件路径（Tauri 下为磁盘路径，浏览器下为项目名；未保存为 null） */
  projectPath: string | null;
  /** 项目级脏标记：内存态 ≠ 磁盘态（与节点执行引擎的 dirty 无关） */
  projectDirty: boolean;
  /** 最近一次成功落盘的完整项目快照（JSON），用于派生 dirty 比对；null 表示从未保存 */
  lastSavedSnapshot: string | null;
  /** 项目内工作流集合 */
  workflows: Record<string, WorkflowFile>;
  /** 当前激活的工作流 id */
  activeWfId: string;
  /** 项目级子图库（可复用节点组合） */
  subgraphs: Record<string, SubgraphDef>;
  /** 当前工作流的节点组（纯视觉编组） */
  groups: NodeGroup[];

  onNodesChange: (changes: NodeChange<FlowNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<FlowEdge>[]) => void;
  onConnect: (conn: Connection) => void;

  addNode: (typeId: string, position: { x: number; y: number }) => void;
  removeNode: (id: string, wfId?: string) => void;
  deleteSelected: () => void;
  clearGraph: () => void;
  updateNodeParams: (id: string, patch: Record<string, unknown>, wfId?: string) => void;
  setNodeLabel: (id: string, label: string, wfId?: string) => void;
  setNodeStatus: (
    id: string,
    status: NodeStatus,
    patch?: Partial<WorkflowNodeData>,
  ) => void;
  resetStatuses: () => void;
  /** 标记节点及其下游为脏（需重新执行），用于增量执行 */
  markDirty: (id: string) => void;
  /** 清除全部脏标记（全量运行前调用） */
  clearDirty: () => void;

  upsertAgent: (agent: AgentConfig) => void;
  removeAgent: (id: string) => void;
  setDefaultAgent: (id: string | null) => void;

  upsertRole: (role: RoleTemplate) => void;
  removeRole: (id: string) => void;

  setSelected: (id: string | null, wfId?: string) => void;
  setRunning: (running: boolean) => void;
  setFailFast: (v: boolean) => void;
  setSkipFailed: (v: boolean) => void;
  setMaxConcurrency: (v: number) => void;
  setLlmChannel: (v: 'backend' | 'frontend') => void;
  addLog: (level: LogEntry['level'], message: string) => void;
  clearLogs: () => void;

  setVariable: (key: string, value: unknown) => void;
  removeVariable: (key: string) => void;
  pushRunHistory: (rec: RunRecord) => void;
  clearRunHistory: () => void;

  setWorkflowName: (name: string) => void;
  loadGraph: (
    name: string,
    nodes: FlowNode[],
    edges: FlowEdge[],
    agents: AgentConfig[],
    roles?: RoleTemplate[],
  ) => void;
  newWorkflow: () => void;

  /* ---- 项目层方法 ---- */
  /** 新建项目（清空为多工作流容器，含一个空白工作流） */
  newProject: (name: string) => void;
  /** 引导式新建项目：可选从模板起步，可选立即落盘到指定位置 */
  createProject: (opts: { name: string; templateId?: string; location?: string }) => Promise<void>;
  /** 载入整个项目文件，并激活 activeId 对应工作流；path 为磁盘路径（Tauri）或项目名（浏览器） */
  openProject: (file: ProjectFile, path?: string) => void;
  /** 保存当前项目（返回保存的项目根路径/名称） */
  saveProject: () => Promise<string>;
  /** 项目级脏标记：内存态是否不同于最近一次落盘快照 */
  isProjectDirty: () => boolean;
  /** 切换当前激活工作流（先写回当前，再加载目标） */
  switchWorkflow: (id: string) => void;
  /** 在项目内新建一个工作流并激活；workspaceDir 为用户指定的工作区文件夹（null=不创建，产物随工作流销毁） */
  newWorkflowInProject: (workspaceDir?: string | null) => void;
  /** 向当前激活工作流追加一条资产记录（写文件节点产出） */
  addAsset: (meta: AssetMeta) => void;
  /** 删除一条资产元数据 */
  removeAsset: (assetId: string) => void;
  /** 向项目级资产库追加一条资产（跨工作流共享） */
  addProjectAsset: (meta: AssetMeta) => void;
  /** 删除一条项目级资产；若某工作流通过引用依赖它，返回这些工作流名以便 UI 提醒 */
  removeProjectAsset: (assetId: string) => string[];
  /** 设置/覆盖项目级变量 */
  setProjectVariable: (key: string, value: unknown) => void;
  /** 删除项目级变量 */
  removeProjectVariable: (key: string) => void;
  /** 重命名当前工作流 */
  renameWorkflow: (name: string) => void;
  /** 删除一个工作流（至少保留一个） */
  removeWorkflow: (id: string) => void;
  /** 关闭当前项目：清空项目态并回到欢迎页。仅在内存态的项目直接丢弃，已落盘的不删磁盘文件 */
  closeProject: () => void;
  /** 将项目另存为：选择新目录作为项目根并完整落盘，返回新根路径（取消/失败返回 null） */
  saveProjectAs: () => Promise<string | null>;
  /** 将指定工作流的图（节点/连线）写回 workflows 字典，保留其余字段（用于拆分视图分栏编辑） */
  updateWorkflowGraph: (id: string, nodes: FlowNode[], edges: FlowEdge[]) => void;

  /* ---- 子图（方案 A：引用节点 + 执行期扁平化） ---- */
  /** 把选中的一批节点打包成子图，并用一个 subgraph.ref 节点替换它们。返回新子图 id */
  packSelectionAsSubgraph: (nodeIds: string[], name: string) => string | null;
  /** 就地展开一个 subgraph.ref 节点，把子图内容还原成普通节点（解组） */
  unpackSubgraphNode: (refNodeId: string) => void;
  /** 在画布上放置一个引用指定子图的 subgraph.ref 节点（节点库拖放/点击时调用） */
  addSubgraphRefNode: (subgraphId: string, position: { x: number; y: number }) => void;
  /** 用当前画布内容覆盖保存某个子图定义（子图编辑模式保存时调用） */
  saveSubgraphDef: (def: SubgraphDef) => void;
  /** 删除一个子图定义（画布上已有的引用节点会变为缺失态） */
  removeSubgraph: (id: string) => void;
  /** 重命名子图 */
  renameSubgraph: (id: string, name: string) => void;

  /* ---- 节点组（方案 B：纯视觉编组） ---- */
  /** 把一批节点编为一组，返回组 id */
  createGroup: (nodeIds: string[], title?: string) => string | null;
  /** 解散一个组（节点保留） */
  removeGroup: (groupId: string) => void;
  /** 修改组属性（标题/颜色/折叠/成员） */
  updateGroup: (groupId: string, patch: Partial<Omit<NodeGroup, 'id'>>) => void;
  /** 折叠/展开一个组 */
  toggleGroupCollapsed: (groupId: string) => void;
  /** 子图定义更新后，重算所有引用该子图的分组的代理端口/虚拟边，使父图实时同步 */
  syncGroupProxies: (subgraphId: string) => void;
  /** 整体平移一个组内所有节点 */
  moveGroup: (groupId: string, dx: number, dy: number) => void;

  /** 打开/关闭示例库次级窗口 */
  setExamplesOpen: (open: boolean) => void;
}

/** 组框预设配色（创建时轮换取用） */
const GROUP_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6'];

function defaultParams(typeId: string): Record<string, unknown> {
  const def = getNodeDef(typeId);
  const params: Record<string, unknown> = {};
  for (const p of def?.params ?? []) {
    if (p.default !== undefined) params[p.key] = p.default;
  }
  return params;
}

/** 把 WorkflowFile 的轻量节点还原为画布 FlowNode（载入时标记为脏，首次运行必执行） */
function flowNodesFrom(wf: WorkflowFile): FlowNode[] {
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
    },
  }));
}

/** 把 WorkflowFile 的轻量连线还原为画布 FlowEdge */
function flowEdgesFrom(wf: WorkflowFile): FlowEdge[] {
  return (wf.edges ?? []).map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? undefined,
    targetHandle: e.targetHandle ?? undefined,
  }));
}

/** 画布 FlowNode → 存储轻量节点（拆分视图分栏写回用） */
function storedNodeOf(n: FlowNode): WorkflowFileNode {
  return {
    id: n.id,
    typeId: n.data.typeId,
    label: n.data.label,
    position: { x: n.position.x, y: n.position.y },
    params: n.data.params ?? {},
  };
}
/** 画布 FlowEdge → 存储轻量连线 */
function storedEdgeOf(e: FlowEdge): WorkflowFileEdge {
  return {
    id: e.id,
    source: e.source,
    sourceHandle: e.sourceHandle ?? null,
    target: e.target,
    targetHandle: e.targetHandle ?? null,
    kind: e.data?.kind ?? 'data',
  };
}

/** 把当前编辑态序列化为一个 WorkflowFile（用于收纳游离态/写回） */
function serializeCurrent(
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
): WorkflowFile {
  return {
    version: 1,
    name: s.workflowName || '未命名工作流',
    savedAt: new Date().toISOString(),
    nodes: s.nodes.map((n) => ({
      id: n.id,
      typeId: n.data.typeId,
      label: n.data.label,
      position: { x: n.position.x, y: n.position.y },
      params: n.data.params ?? {},
    })),
    edges: s.edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle ?? null,
      target: e.target,
      targetHandle: e.targetHandle ?? null,
      kind: e.data?.kind ?? 'data',
    })),
    agents: s.agents,
    roles: s.roles,
    variables: s.variables,
    groups: s.groups ?? [],
    assets: keepAssets ?? [],
    belongsToProject: identity?.belongsToProject,
    standalonePath: identity?.standalonePath,
  };
}

/** 把当前 store 态组装为完整 ProjectFile（供保存与 dirty 快照比对复用）。 */
function buildProjectFile(s: {
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
  workflows: Record<string, WorkflowFile>;
  projectName: string | null;
  projectId: string | null;
  projectCreatedAt: string | null;
  subgraphs: Record<string, SubgraphDef>;
  runHistory: RunRecord[];
}): ProjectFile {
  const current: WorkflowFile = serializeCurrent(s, undefined, s.workflows[s.activeWfId]?.assets);
  const workflows = { ...s.workflows };
  if (s.activeWfId) workflows[s.activeWfId] = current;
  else {
    const id = `wf-${Date.now()}`;
    workflows[id] = current;
  }
  return {
    version: 1,
    kind: 'project',
    id: s.projectId ?? `proj-${Date.now()}`,
    name: s.projectName ?? s.workflowName,
    createdAt: s.projectCreatedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workflows,
    activeId: s.activeWfId || Object.keys(workflows)[0],
    roles: s.roles,
    variables: s.projectVariables,
    assets: s.projectAssets,
    subgraphs: s.subgraphs,
    runs: { history: s.runHistory },
  };
}

/** 当前项目态的稳定快照（仅含落盘相关字段，排除运行态/日志等） */
function projectSnapshot(s: ReturnType<typeof useWorkflowStore.getState>): string {
  return JSON.stringify(buildProjectFile(s));
}

export const useWorkflowStore = create<WorkflowState>()(
  persist(
    (set, get) => ({
      workflowName: '未命名工作流',
      nodes: [],
      edges: [],
      agents: [createAgent('ollama')],
      defaultAgentId: null,
      roles: builtinRoles.map((r) => ({ ...r })),
      selectedNodeId: null,
      focusWfId: '',
      examplesOpen: false,
      running: false,
      failFast: true,
      skipFailed: false,
      maxConcurrency: 3,
      llmChannel: 'backend',
      logs: [],
      variables: {},
      projectVariables: {},
      projectAssets: [],
      runHistory: [],
      lastAutosave: null,

      projectName: null,
      projectId: null,
      projectCreatedAt: null,
      projectPath: null,
      projectDirty: false,
      lastSavedSnapshot: null,
      workflows: {},
      activeWfId: '',
      subgraphs: {},
      groups: [],

      onNodesChange: (changes) => {
        // grpnode_* 是折叠组的「派生代理节点」，由 WorkflowEditor 计算，不应写回 store.nodes，
        // 否则会被当成真实节点（「分组被判定为节点」），并污染编组/计数等逻辑。
        const realChanges = changes.filter((c) => !String(c.id).startsWith('grpnode_'));
        if (realChanges.length === 0) return;
        set({ nodes: applyNodeChanges(realChanges, get().nodes) });
        // 删除节点会改变其下游输入：标记下游为脏
        const removed = realChanges.filter((c) => c.type === 'remove').map((c) => c.id);
        for (const id of removed) {
          // 找出以该节点为 source 的边对应的 target
          const targets = get().edges
            .filter((e) => e.source === id)
            .map((e) => e.target);
          for (const t of targets) get().markDirty(t);
        }
      },
      onEdgesChange: (changes) =>
        set({ edges: applyEdgeChanges(changes, get().edges) }),

      onConnect: (conn) => {
        if (!conn.source || !conn.target) return;
        // 注意：端口须按「节点实例」解析——普通节点取自类型定义，
        // 子图引用节点（subgraph.ref）的端口是动态的，取自其引用的子图定义。
        const nodesNow = get().nodes;
        const srcNode = nodesNow.find((n) => n.id === conn.source);
        const tgtNode = nodesNow.find((n) => n.id === conn.target);
        const defs = useRegistryStore.getState().defs;
        const sgs = get().subgraphs;
        const srcDef = resolvePorts(srcNode?.data.typeId ?? '', srcNode?.data.params, defs, sgs);
        const tgtDef = resolvePorts(tgtNode?.data.typeId ?? '', tgtNode?.data.params, defs, sgs);
        const srcName = srcNode?.data.label ?? srcDef.name;
        const tgtName = tgtNode?.data.label ?? tgtDef.name;

        if (wouldCreateCycle(conn.source, conn.target, get().edges)) {
          get().addLog(
            'error',
            `「${srcName}」和「${tgtName}」这样连会绕成死循环，换一种接法吧`,
          );
          return;
        }
        // 端口类型校验：source 输出端口类型须与 target 输入端口类型兼容
        const srcPort = srcDef.outputs.find((o) => o.id === conn.sourceHandle);
        const tgtPort = tgtDef.inputs.find((i) => i.id === conn.targetHandle);
        const srcType: PortType | undefined = srcPort?.type;
        const tgtType: PortType | undefined = tgtPort?.type;
        if (!arePortsCompatible(srcType, tgtType)) {
          // 在目标节点上找一个兼容的输入端口，给出更友好的引导
          const suggest = tgtDef.inputs.find((i) =>
            arePortsCompatible(srcType, i.type),
          );
          const srcLabel = srcPort?.label ?? '输出';
          const tgtLabel = tgtPort?.label ?? '输入';
          const hint = suggest
            ? `可以把「${srcName}」的「${srcLabel}」连到「${tgtName}」的「${suggest.label}」端口`
            : `「${srcName}」提供的内容类型，和「${tgtName}」需要的对不上`;
          get().addLog(
            'error',
            `这条线连不上：「${srcName}」的「${srcLabel}」和「${tgtName}」的「${tgtLabel}」内容类型不一样。${hint}`,
          );
          return;
        }
        // 推断连线语义：默认 'data'，若 source 输出端口声明了 flow 则采用该语义
        const kind = (srcPort?.flow as EdgeKind | undefined) ?? 'data';
        set({
          edges: addEdge(
            { ...conn, type: 'kind', data: { kind } },
            get().edges,
          ),
        });
        // 新连线改变了数据依赖：两端节点及其下游需重新执行
        get().markDirty(conn.source);
        get().markDirty(conn.target);
      },

      addNode: (typeId, position) => {
        const def = getNodeDef(typeId);
        if (!def) return;
        const node: FlowNode = {
          id: crypto.randomUUID(),
          type: 'base',
          position,
          data: {
            typeId,
            label: def.name,
            params: defaultParams(typeId),
            status: 'idle',
          },
        };
        set({ nodes: [...get().nodes, node], selectedNodeId: node.id });
      },

      removeNode: (id, wfId) => {
        // 未指定 wfId → 作用于当前激活工作流；否则作用于指定工作流（拆分视图分栏）
        if (wfId && wfId !== get().activeWfId) {
          const wf = get().workflows[wfId];
          if (!wf) return;
          const nodes = (wf.nodes ?? []).filter((n) => n.id !== id);
          const edges = (wf.edges ?? []).filter((e) => e.source !== id && e.target !== id);
          set({
            workflows: { ...get().workflows, [wfId]: { ...wf, nodes, edges } },
            selectedNodeId: get().selectedNodeId === id ? null : get().selectedNodeId,
          });
          return;
        }
        set({
          nodes: get().nodes.filter((n) => n.id !== id),
          edges: get().edges.filter((e) => e.source !== id && e.target !== id),
          selectedNodeId:
            get().selectedNodeId === id ? null : get().selectedNodeId,
        });
      },

      deleteSelected: () => {
        const id = get().selectedNodeId;
        if (!id) return;
        get().removeNode(id, get().focusWfId);
      },

      clearGraph: () =>
        set({ nodes: [], edges: [], groups: [], selectedNodeId: null, logs: [] }),

      updateNodeParams: (id, patch, wfId) => {
        // 未指定 wfId 或作用于激活工作流
        if (!wfId || wfId === get().activeWfId) {
          set({
            nodes: get().nodes.map((n) =>
              n.id === id
                ? { ...n, data: { ...n.data, params: { ...n.data.params, ...patch } } }
                : n,
            ),
          });
          get().markDirty(id);
          return;
        }
        // 作用于拆分视图中的其他工作流
        const wf = get().workflows[wfId];
        if (!wf) return;
        const nodes = (wf.nodes ?? []).map((n) =>
          n.id === id ? { ...n, params: { ...(n.params ?? {}), ...patch } } : n,
        );
        set({ workflows: { ...get().workflows, [wfId]: { ...wf, nodes } } });
      },

      setNodeLabel: (id, label, wfId) => {
        if (!wfId || wfId === get().activeWfId) {
          set({
            nodes: get().nodes.map((n) =>
              n.id === id ? { ...n, data: { ...n.data, label } } : n,
            ),
          });
          return;
        }
        const wf = get().workflows[wfId];
        if (!wf) return;
        const nodes = (wf.nodes ?? []).map((n) => (n.id === id ? { ...n, label } : n));
        set({ workflows: { ...get().workflows, [wfId]: { ...wf, nodes } } });
      },

      setNodeStatus: (id, status, patch) =>
        set((state) => {
          const nodes = state.nodes.map((n) =>
            n.id === id ? { ...n, data: { ...n.data, ...patch, status } } : n,
          );
          // 运行中：让指向该节点的入边显示流动动画；否则清除
          const edges = state.edges.map((e) => {
            if (e.target !== id) return e;
            const isRunning = status === 'running';
            const has = (e.className ?? '').split(' ').includes('sm-edge-running');
            if (isRunning && !has) {
              return { ...e, className: (e.className ? e.className + ' ' : '') + 'sm-edge-running' };
            }
            if (!isRunning && has) {
              return { ...e, className: (e.className ?? '').split(' ').filter((c) => c !== 'sm-edge-running').join(' ') };
            }
            return e;
          });
          return { nodes, edges };
        }),

      resetStatuses: () =>
        set({
          nodes: get().nodes.map((n) => ({
            ...n,
            data: {
              ...n.data,
              status: 'idle' as NodeStatus,
              error: undefined,
              outputs: undefined,
              usage: undefined,
            },
          })),
          edges: get().edges.map((e) => ({
            ...e,
            className: (e.className ?? '').split(' ').filter((c) => c !== 'sm-edge-running').join(' '),
          })),
        }),

      /** 计算从某节点出发、沿边可到达的所有下游节点 id（含自身） */
      markDirty: (startId: string) => {
        const { nodes, edges } = get();
        if (!nodes.some((n) => n.id === startId)) return;
        // BFS 收集下游
        const downstream = new Set<string>([startId]);
        const queue = [startId];
        while (queue.length > 0) {
          const cur = queue.shift()!;
          for (const e of edges) {
            if (e.source === cur && !downstream.has(e.target)) {
              downstream.add(e.target);
              queue.push(e.target);
            }
          }
        }
        set({
          nodes: nodes.map((n) =>
            downstream.has(n.id) ? { ...n, data: { ...n.data, dirty: true } } : n,
          ),
        });
      },

      clearDirty: () =>
        set({
          nodes: get().nodes.map((n) =>
            n.data.dirty ? { ...n, data: { ...n.data, dirty: undefined } } : n,
          ),
        }),

      upsertAgent: (agent) => {
        const exists = get().agents.some((a) => a.id === agent.id);
        set({
          agents: exists
            ? get().agents.map((a) => (a.id === agent.id ? agent : a))
            : [...get().agents, agent],
        });
      },

      removeAgent: (id) =>
        set((s) => ({
          agents: s.agents.filter((a) => a.id !== id),
          defaultAgentId: s.defaultAgentId === id ? null : s.defaultAgentId,
        })),

      setDefaultAgent: (id) => set({ defaultAgentId: id }),

      upsertRole: (role) => {
        const exists = get().roles.some((r) => r.id === role.id);
        set({
          roles: exists
            ? get().roles.map((r) => (r.id === role.id ? role : r))
            : [...get().roles, role],
        });
      },

      removeRole: (id) => {
        const role = get().roles.find((r) => r.id === id);
        if (role?.builtin) {
          get().addLog('error', '内置角色不可删除');
          return;
        }
        set({ roles: get().roles.filter((r) => r.id !== id) });
      },

      setSelected: (id, wfId) => set({ selectedNodeId: id, focusWfId: wfId ?? get().activeWfId }),
      setRunning: (running) => set({ running }),
      setFailFast: (v) => set({ failFast: v }),
      setSkipFailed: (v) => set({ skipFailed: v }),
      setMaxConcurrency: (v) => set({ maxConcurrency: Math.max(1, Math.min(20, Math.floor(v) || 1)) }),
      setLlmChannel: (v) => set({ llmChannel: v }),

      addLog: (level, message) =>
        set({
          logs: [
            ...get().logs.slice(-199),
            { time: new Date().toLocaleTimeString(), level, message },
          ],
        }),
      clearLogs: () => set({ logs: [] }),

      /** 记录一次「自动保存」发生（仅 UI 提示，不写磁盘；persist 已同步落盘） */
      setAutosave: () => set({ lastAutosave: Date.now() }),

      setVariable: (key, value) => {
        if (!key) return;
        set({ variables: { ...get().variables, [key]: value } });
      },
      removeVariable: (key) => {
        const next = { ...get().variables };
        delete next[key];
        set({ variables: next });
      },
      pushRunHistory: (rec) =>
        set({ runHistory: [rec, ...get().runHistory].slice(0, 30) }),
      clearRunHistory: () => set({ runHistory: [] }),

      setWorkflowName: (name) => set({ workflowName: name }),

      loadGraph: (name, nodes, edges, agents, roles) =>
        set({
          workflowName: name,
          // 载入即标记为脏，保证运行时会真正执行而非命中空缓存
          nodes: nodes.map((n) => ({ ...n, data: { ...n.data, dirty: true } })),
          edges,
          agents: agents.length > 0 ? agents : get().agents,
          // 内置角色始终保留；加载文件中的自定义角色（非 builtin）并入
          roles: [
            ...builtinRoles.map((r) => ({ ...r })),
            ...(roles ?? []).filter((r) => !r.builtin),
          ],
          selectedNodeId: null,
          logs: [],
        }),

      newWorkflow: () =>
        set({
          workflowName: '未命名工作流',
          nodes: [],
          edges: [],
          roles: builtinRoles.map((r) => ({ ...r })),
          selectedNodeId: null,
          logs: [],
          // 空画布无需标记，但保持一致性：clearDirty 语义下无任何脏节点
        }),

      setExamplesOpen: (open: boolean) => set({ examplesOpen: open }),

      /* ---- 项目层方法实现 ---- */

      // 把当前编辑态写回到 workflows[activeWfId]
      // （注意：此方法在 (set,get)=> 闭包内，通过 get() 访问最新状态）
      // 通过下方 newProject/openProject/switchWorkflow/saveProject 间接调用。

      newProject: (name) => {
        const id = `wf-${Date.now()}`;
        const projId = `proj-${Date.now()}`;
        const now = new Date().toISOString();
        const wf: WorkflowFile = {
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
        suppressDirty = true;
        set({
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
          selectedNodeId: null,
          logs: [],
        });
        suppressDirty = false;
      },

      createProject: async ({ name, templateId, location }) => {
        const tpl = templateId
          ? STARTER_TEMPLATES.find((t) => t.id === templateId)
          : undefined;
        const graph = tpl?.build();
        const tplNodes = graph?.nodes ?? [];
        const tplEdges = graph?.edges ?? [];
        const id = `wf-${Date.now()}`;
        const projId = `proj-${Date.now()}`;
        const now = new Date().toISOString();
        // 落盘根目录：用户指定优先；未指定则在桌面端落到「文档/SlimeMold/<项目名>」，
        // 保证“新建项目”即自动生成 .slimemold 目录骨架（浏览器无磁盘环境仍按内存草稿处理）
        let saveRoot: string | null = location ?? null;
        if (!saveRoot && isTauri()) {
          try {
            const base = (await defaultStandaloneDir()).replace(/\/未归类$/, '');
            const safe = (name.trim() || '未命名项目').replace(/[\\/:*?"<>|]/g, '_');
            saveRoot = `${base}/${safe}`;
          } catch {
            saveRoot = null;
          }
        }
        const baseAgents = [createAgent('ollama')];
        const wf: WorkflowFile = {
          version: 1,
          name: tpl?.name ?? '未命名工作流',
          savedAt: now,
          nodes: tplNodes,
          edges: tplEdges,
          agents: baseAgents,
          roles: builtinRoles.map((r) => ({ ...r })),
          variables: {},
          belongsToProject: projId,
        };
        suppressDirty = true;
        set({
          projectName: name,
          projectId: projId,
          projectCreatedAt: now,
          projectPath: saveRoot ?? null,
          // 若已指定落盘位置，先按"已保存"对待，待 saveProject 成功后再定 dirty
          projectDirty: !!saveRoot,
          lastSavedSnapshot: null,
          workflows: { [id]: wf },
          activeWfId: id,
          workflowName: wf.name,
          // 模板节点载入即标记脏，保证运行时会真正执行而非命中空缓存
          nodes: tplNodes.map((n) => ({
            ...n,
            data: { ...n.data, dirty: true },
          })),
          edges: tplEdges,
          agents: baseAgents,
          roles: builtinRoles.map((r) => ({ ...r })),
          variables: wf.variables!,
          projectVariables: {},
          projectAssets: [],
          selectedNodeId: null,
          logs: [],
        });
        suppressDirty = false;
        if (saveRoot) {
          try {
            const root = await get().saveProject(saveRoot);
            saveLastSession({ path: root, activeId: id });
          } catch (e) {
            // 落盘失败：保留在内存态（projectPath=null），用户可稍后保存
            set({ projectPath: null, projectDirty: true });
            get().addLog(
              'warn',
              `项目已创建但落盘失败：${e instanceof Error ? e.message : String(e)}`,
            );
          }
        } else {
          clearLastSession();
        }
      },

      openProject: (file, path) => {
        const id = file.activeId ?? Object.keys(file.workflows)[0];
        const wf = file.workflows[id];
        if (!wf) return;
        suppressDirty = true;
        set({
          projectName: file.name,
          projectPath: path ?? file.name, // 实际磁盘路径由调用方传入
          workflows: file.workflows,
          activeWfId: id,
          workflowName: wf.name,
          // P1：打开即把活动工作流还原到画布，保证落盘内容完整
          nodes: flowNodesFrom(wf),
          edges: flowEdgesFrom(wf),
          agents: wf.agents?.length ? wf.agents : [createAgent('ollama')],
          defaultAgentId: wf.defaultAgentId ?? get().defaultAgentId,
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
          selectedNodeId: null,
          logs: [],
        });
        finalizeLoaded();
      },

      saveProject: async () => {
        const s = get();
        // 同步当前工作流
        const current: WorkflowFile = {
          version: 1,
          name: s.workflowName,
          savedAt: new Date().toISOString(),
          nodes: s.nodes.map((n) => ({
            id: n.id,
            typeId: n.data.typeId,
            label: n.data.label,
            position: { x: n.position.x, y: n.position.y },
            params: n.data.params,
          })),
          edges: s.edges.map((e) => ({
            id: e.id,
            source: e.source,
            sourceHandle: e.sourceHandle ?? null,
            target: e.target,
            targetHandle: e.targetHandle ?? null,
            kind: e.data?.kind ?? 'data',
          })),
          agents: s.agents,
          roles: s.roles,
          variables: s.variables,
          groups: s.groups,
        };
        const file = buildProjectFile(s);
        const { saveProjectFile } = await import('../io/projectIO');
        // P0：已存盘则直接覆盖原路径，不再弹另存为
        const path = await saveProjectFile(file, s.projectPath ?? undefined);
        set({
          projectId: file.id,
          projectCreatedAt: file.createdAt,
          projectPath: path,
          // P1：落盘后清除项目级脏标记，并记录本次快照
          projectDirty: false,
          lastSavedSnapshot: JSON.stringify(file),
        });
        return path;
      },

      isProjectDirty: () => {
        const s = get();
        if (!s.lastSavedSnapshot) return s.projectDirty; // 从未保存过：以标记为准
        return s.lastSavedSnapshot !== JSON.stringify(buildProjectFile(s));
      },

      switchWorkflow: (id) => {
        const s = get();
        if (id === s.activeWfId) return;
        // 写回当前编辑态（若为游离态则先收纳为临时工作流，避免节点丢失）
        const synced: Record<string, WorkflowFile> = { ...s.workflows };
        const curId = s.activeWfId || `wf-${Date.now()}`;
        const prev = s.workflows[curId];
        synced[curId] = serializeCurrent(
          s,
          {
            belongsToProject: prev?.belongsToProject,
            standalonePath: prev?.standalonePath,
          },
          prev?.assets,
        );
        const target = synced[id];
        if (!target) return;
        // 切换工作流不新增"内存vs磁盘"差异，抑制本次变更的脏检测
        suppressDirty = true;
        set({
          workflows: synced,
          activeWfId: id,
          workflowName: target.name,
          nodes: flowNodesFrom(target),
          edges: flowEdgesFrom(target),
          agents: target.agents?.length ? target.agents : s.agents,
          roles: [...builtinRoles.map((r) => ({ ...r })), ...(target.roles ?? []).filter((r) => !r.builtin)],
          variables: target.variables ?? {},
          groups: target.groups ?? [],
          selectedNodeId: null,
          logs: [],
        });
        suppressDirty = false;
      },

      /**
       * 新建工作流。两种归属：
       * - 若当前处于项目内（projectId 非空）→ 工作流归属项目（belongsToProject）。
       * - 否则为游离工作流（standalone）：workspaceDir 为存放位置，缺省落默认位置
       *   （文档/SlimeMold/未归类/），并记录 standalonePath。
       */
      newWorkflowInProject: async (workspaceDir?: string | null) => {
        const s = get();
        const workflows = { ...s.workflows };
        const inProject = !!s.projectId;
        // 游离工作流未指定位置时，落到默认位置（文档/SlimeMold/未归类/）
        let standalonePath: string | undefined;
        if (!inProject) {
          standalonePath = workspaceDir ?? (await defaultStandaloneDir());
        }
        // 若当前为游离态（无对应工作流）且已有编辑内容，先把现有编辑态收纳为默认工作流
        let baseActive = s.activeWfId;
        if (!baseActive && (s.nodes.length || s.edges.length)) {
          baseActive = `wf-${Date.now()}`;
          const prev = s.workflows[baseActive];
          workflows[baseActive] = serializeCurrent(
            s,
            {
              belongsToProject: prev?.belongsToProject,
              standalonePath: prev?.standalonePath,
            },
            prev?.assets,
          );
        }
        const id = `wf-${Date.now() + 1}`;
        const index = Object.keys(workflows).length + 1;
        const wf: WorkflowFile = {
          version: 1,
          name: `工作流 ${index}`,
          savedAt: new Date().toISOString(),
          nodes: [],
          edges: [],
          agents: [createAgent('ollama')],
          roles: builtinRoles.map((r) => ({ ...r })),
          variables: {},
          workspaceDir: standalonePath ?? null,
          assets: [],
          groups: [],
          belongsToProject: inProject ? s.projectId! : undefined,
          standalonePath: inProject ? undefined : standalonePath,
        };
        workflows[id] = wf;
        set({
          workflows,
          activeWfId: id,
          workflowName: wf.name,
          nodes: [],
          edges: [],
          agents: wf.agents,
          defaultAgentId: wf.defaultAgentId ?? null,
          roles: wf.roles!,
          variables: wf.variables!,
          groups: [],
          selectedNodeId: null,
          logs: [],
        });
      },

      /** 向当前激活工作流追加一条资产记录（写文件节点产出） */
      addAsset: (meta) => {
        const s = get();
        if (!s.activeWfId) return;
        const wf = s.workflows[s.activeWfId];
        if (!wf) return;
        const assets = [...(wf.assets ?? []), meta];
        set({
          workflows: {
            ...s.workflows,
            [s.activeWfId]: { ...wf, assets },
          },
        });
      },

      /** 删除一条资产（仅元数据；已落盘文件由用户自行管理） */
      removeAsset: (assetId) => {
        const s = get();
        if (!s.activeWfId) return;
        const wf = s.workflows[s.activeWfId];
        if (!wf?.assets) return;
        // 找到待删资产，记录落盘路径以便一并删除磁盘文件
        const target = wf.assets.find((a) => a.id === assetId);
        set({
          workflows: {
            ...s.workflows,
            [s.activeWfId]: {
              ...wf,
              assets: wf.assets.filter((a) => a.id !== assetId),
            },
          },
        });
        // 删除磁盘上的实际文件（path 为 null 表示未真正落盘，仅删记录）
        if (target?.path) {
          (async () => {
            try {
              const fs = await import('@tauri-apps/plugin-fs');
              await fs.remove(target.path as string);
              s.addLog('info', `已删除资产文件：${target.path}`);
            } catch (err) {
              s.addLog('warn', `删除资产文件失败（记录已移除）：${err instanceof Error ? err.message : String(err)}`);
            }
          })();
        }
      },

      addProjectAsset: (meta) => {
        const s = get();
        // 同 id 覆盖，避免重复
        const exists = s.projectAssets.some((a) => a.id === meta.id);
        set({
          projectAssets: exists
            ? s.projectAssets.map((a) => (a.id === meta.id ? meta : a))
            : [...s.projectAssets, meta],
        });
      },

      /**
       * 删除一条项目级资产。返回依赖它的工作流名称列表（其节点 params 中引用了 assetId），
       * 便于 UI 提示"这些工作流仍引用此资产"。
       */
      removeProjectAsset: (assetId) => {
        const s = get();
        const target = s.projectAssets.find((a) => a.id === assetId);
        // 扫描所有工作流节点，找出引用该资产的（{{asset:ID}} 或显式 assetId 字段）
        const refs: string[] = [];
        const idToken = `{{asset:${assetId}}}`;
        for (const id of Object.keys(s.workflows)) {
          const wf = s.workflows[id];
          const hit = (wf.nodes ?? []).some((n) =>
            Object.values(n.params ?? {}).some((v) => {
              const sv = typeof v === 'string' ? v : JSON.stringify(v);
              return sv.includes(idToken) || (typeof v === 'object' && v !== null && (v as any).assetId === assetId);
            }),
          );
          if (hit) refs.push(wf.name);
        }
        set({ projectAssets: s.projectAssets.filter((a) => a.id !== assetId) });
        if (target?.path) {
          (async () => {
            try {
              const fs = await import('@tauri-apps/plugin-fs');
              await fs.remove(target.path as string);
              s.addLog('info', `已删除项目资产文件：${target.path}`);
            } catch (err) {
              s.addLog('warn', `删除项目资产文件失败（记录已移除）：${err instanceof Error ? err.message : String(err)}`);
            }
          })();
        }
        return refs;
      },

      setProjectVariable: (key, value) => {
        const s = get();
        set({ projectVariables: { ...s.projectVariables, [key]: value } });
      },

      removeProjectVariable: (key) => {
        const s = get();
        const next = { ...s.projectVariables };
        delete next[key];
        set({ projectVariables: next });
      },

      renameWorkflow: (name) => {
        const s = get();
        set({ workflowName: name });
        if (s.activeWfId) {
          const wf = s.workflows[s.activeWfId];
          if (wf) {
            set({ workflows: { ...s.workflows, [s.activeWfId]: { ...wf, name } } });
          }
        }
      },

      removeWorkflow: (id) => {
        const s = get();
        const next = { ...s.workflows };
        const target = s.workflows[id];
        // 未指定工作区（workspaceDir=null）时，产物落在 AppData 内部目录，
        // 删除工作流时一并清理，避免残留文件。用户指定工作区的不动。
        if (target && !target.workspaceDir) {
          import('@tauri-apps/api/path')
            .then(async (p) => {
              const base = `${await p.appDataDir()}/slime-mold/${id}`;
              const fs = await import('@tauri-apps/plugin-fs');
              await fs.remove(base, { recursive: true });
            })
            .catch(() => {});
        }
        delete next[id];
        // 删到零工作流：进入「无激活工作流」状态，画布显示欢迎背景
        if (Object.keys(next).length === 0) {
          set({
            workflows: next,
            activeWfId: '',
            workflowName: '',
            nodes: [],
            edges: [],
            agents: [createAgent('ollama')],
            roles: builtinRoles.map((r) => ({ ...r })),
            variables: {},
            selectedNodeId: null,
            logs: [],
          });
          return;
        }
        if (id === s.activeWfId) {
          const newId = Object.keys(next)[0];
          const wf = next[newId];
          set({
            workflows: next,
            activeWfId: newId,
            workflowName: wf.name,
            nodes: flowNodesFrom(wf),
            edges: flowEdgesFrom(wf),
            agents: wf.agents?.length ? wf.agents : [createAgent('ollama')],
            defaultAgentId: wf.defaultAgentId ?? null,
            roles: [...builtinRoles.map((r) => ({ ...r })), ...(wf.roles ?? []).filter((r) => !r.builtin)],
            variables: wf.variables ?? {},
            selectedNodeId: null,
            logs: [],
          });
        } else {
          set({ workflows: next });
        }
      },

      closeProject: () => {
        suppressDirty = true;
        set({
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
          agents: [createAgent('ollama')],
          roles: builtinRoles.map((r) => ({ ...r })),
          variables: {},
          projectVariables: {},
          projectAssets: [],
          subgraphs: {},
          groups: [],
          selectedNodeId: null,
          logs: [],
        });
        suppressDirty = false;
        clearLastSession();
      },

      saveProjectAs: async () => {
        const s = get();
        if (!isTauri()) {
          get().addLog('warn', '「将项目另存为」需要桌面端（Tauri）环境');
          return null;
        }
        const picked = await showSaveDirDialog(s.projectName ?? '未命名项目');
        if (!picked) return null;
        const file = buildProjectFile(s);
        const { saveProjectFile } = await import('../io/projectIO');
        try {
          const root = await saveProjectFile(file, picked);
          set({ projectPath: root, projectDirty: false, lastSavedSnapshot: JSON.stringify(file) });
          saveLastSession({ path: root, activeId: s.activeWfId || undefined });
          return root;
        } catch (e) {
          get().addLog('warn', `项目另存为失败：${e instanceof Error ? e.message : String(e)}`);
          return null;
        }
      },

      updateWorkflowGraph: (id, nodes, edges) => {
        const s = get();
        const wf = s.workflows[id];
        if (!wf) return;
        set({
          workflows: {
            ...s.workflows,
            [id]: {
              ...wf,
              nodes: nodes.map((n) => storedNodeOf(n)),
              edges: edges.map((e) => storedEdgeOf(e)),
            },
          },
        });
      },

      /* ---------- 子图 ---------- */

      packSelectionAsSubgraph: (nodeIds, name) => {
        const s = get();
        const idSet = new Set(nodeIds);
        const selected = s.nodes.filter((n) => idSet.has(n.id));
        if (selected.length === 0) {
          s.addLog('error', '请先选中要打包的节点');
          return null;
        }
        if (selected.some((n) => n.data.typeId === SUBGRAPH_REF_TYPE)) {
          s.addLog('error', '暂不支持把已有的子图节点再次打包，请先展开它');
          return null;
        }

        const defs = useRegistryStore.getState().defs;
        const sg = packSubgraph(name || '未命名子图', selected, s.edges, defs);

        // ref 节点落在选区的几何中心
        const cx = selected.reduce((a, n) => a + n.position.x, 0) / selected.length;
        const cy = selected.reduce((a, n) => a + n.position.y, 0) / selected.length;
        const refId = crypto.randomUUID();
        const refNode: FlowNode = {
          id: refId,
          type: 'base',
          position: { x: cx, y: cy },
          data: {
            typeId: SUBGRAPH_REF_TYPE,
            label: sg.name,
            params: { subgraphId: sg.id },
            status: 'idle',
            dirty: true,
          },
        };

        // 跨边界连线重定向到 ref 节点的对外端口；选区内部连线随节点一起移除
        const inByInner = new Map(sg.inputs.map((p) => [`${p.innerNodeId}|${p.innerHandle}`, p.id]));
        const outByInner = new Map(
          sg.outputs.map((p) => [`${p.innerNodeId}|${p.innerHandle}`, p.id]),
        );
        const edges: FlowEdge[] = [];
        for (const e of s.edges) {
          const srcIn = idSet.has(e.source);
          const dstIn = idSet.has(e.target);
          if (srcIn && dstIn) continue; // 内部连线：已随子图带走
          if (!srcIn && !dstIn) {
            edges.push(e);
            continue;
          }
          if (dstIn) {
            const handle = inByInner.get(`${e.target}|${e.targetHandle ?? ''}`);
            if (!handle) continue;
            edges.push({ ...e, target: refId, targetHandle: handle });
          } else {
            const handle = outByInner.get(`${e.source}|${e.sourceHandle ?? ''}`);
            if (!handle) continue;
            edges.push({ ...e, source: refId, sourceHandle: handle });
          }
        }

        set({
          subgraphs: { ...s.subgraphs, [sg.id]: sg },
          nodes: [...s.nodes.filter((n) => !idSet.has(n.id)), refNode],
          edges,
          // 被打包的节点若在某个组里，把组内成员一并清理
          groups: s.groups
            .map((g) => ({ ...g, nodeIds: g.nodeIds.filter((id) => !idSet.has(id)) }))
            .filter((g) => g.nodeIds.length > 0),
          selectedNodeId: refId,
        });
        s.addLog(
          'info',
          `已打包 ${selected.length} 个节点为子图「${sg.name}」（${sg.inputs.length} 入 / ${sg.outputs.length} 出）`,
        );
        return sg.id;
      },

      unpackSubgraphNode: (refNodeId) => {
        const s = get();
        const ref = s.nodes.find((n) => n.id === refNodeId);
        if (!ref || ref.data.typeId !== SUBGRAPH_REF_TYPE) return;
        const sg = s.subgraphs[String(ref.data.params?.subgraphId ?? '')];
        if (!sg) {
          s.addLog('error', '这个子图的定义已丢失，无法展开');
          return;
        }

        // 内部节点重新分配 id，避免与画布上已有节点（含同一子图的其他实例）冲突
        const idMap = new Map<string, string>();
        for (const n of sg.nodes) idMap.set(n.id, crypto.randomUUID());

        const newNodes: FlowNode[] = sg.nodes.map((n) => ({
          id: idMap.get(n.id)!,
          type: 'base',
          position: { x: ref.position.x + n.position.x * 0.35, y: ref.position.y + n.position.y * 0.35 },
          data: {
            typeId: n.typeId,
            label: n.label,
            params: { ...n.params },
            status: 'idle' as NodeStatus,
            dirty: true,
          },
        }));
        const newEdges: FlowEdge[] = sg.edges.map((e) => ({
          id: crypto.randomUUID(),
          source: idMap.get(e.source)!,
          sourceHandle: e.sourceHandle ?? undefined,
          target: idMap.get(e.target)!,
          targetHandle: e.targetHandle ?? undefined,
          type: 'kind',
          data: { kind: e.kind ?? 'data' },
        }));

        // 原先接在 ref 节点上的外部连线，改接到对应的内部节点端口
        const inPort = new Map(sg.inputs.map((p) => [p.id, p]));
        const outPort = new Map(sg.outputs.map((p) => [p.id, p]));
        for (const e of s.edges) {
          if (e.target === refNodeId) {
            const p = inPort.get(e.targetHandle ?? '');
            if (!p) continue;
            newEdges.push({
              ...e,
              id: crypto.randomUUID(),
              target: idMap.get(p.innerNodeId)!,
              targetHandle: p.innerHandle ?? undefined,
            });
          } else if (e.source === refNodeId) {
            const p = outPort.get(e.sourceHandle ?? '');
            if (!p) continue;
            newEdges.push({
              ...e,
              id: crypto.randomUUID(),
              source: idMap.get(p.innerNodeId)!,
              sourceHandle: p.innerHandle ?? undefined,
            });
          } else {
            newEdges.push(e);
          }
        }

        set({
          nodes: [...s.nodes.filter((n) => n.id !== refNodeId), ...newNodes],
          edges: newEdges,
          selectedNodeId: newNodes[0]?.id ?? null,
        });
        s.addLog('info', `已展开子图「${sg.name}」，还原为 ${newNodes.length} 个节点`);
      },

      addSubgraphRefNode: (subgraphId, position) => {
        const s = get();
        const sg = s.subgraphs[subgraphId];
        if (!sg) return;
        const node: FlowNode = {
          id: crypto.randomUUID(),
          type: 'base',
          position,
          data: {
            typeId: SUBGRAPH_REF_TYPE,
            label: sg.name,
            params: { subgraphId },
            status: 'idle',
            dirty: true,
          },
        };
        set({ nodes: [...s.nodes, node], selectedNodeId: node.id });
      },

      saveSubgraphDef: (def) => {
        const s = get();
        const defs = useRegistryStore.getState().defs;
        // 重新推断「未连接到子图内部的端口」，作为对外端口的补充项
        const inferred = inferPorts(def.nodes, def.edges, defs);
        // 关键：保留 def 中已显式定义的端口（含用户在子图里手动连代理端口得到的），
        // 只补充新出现的、尚未在 def 中登记的未连接端口。
        // 否则在子图里增删节点 / 手动连线后，整体覆盖会把端口清空成「无」。
        const seenIn = new Set(def.inputs.map((p) => `${p.innerNodeId}|${p.innerHandle}`));
        const seenOut = new Set(def.outputs.map((p) => `${p.innerNodeId}|${p.innerHandle}`));
        const inputs = [
          ...def.inputs,
          ...inferred.inputs.filter((p) => !seenIn.has(`${p.innerNodeId}|${p.innerHandle}`)),
        ];
        const outputs = [
          ...def.outputs,
          ...inferred.outputs.filter((p) => !seenOut.has(`${p.innerNodeId}|${p.innerHandle}`)),
        ];
        const next: SubgraphDef = {
          ...def,
          inputs,
          outputs,
          updatedAt: new Date().toISOString(),
        };
        set({ subgraphs: { ...s.subgraphs, [def.id]: next } });
      },

      removeSubgraph: (id) => {
        const s = get();
        const rest = { ...s.subgraphs };
        delete rest[id];
        set({ subgraphs: rest });
      },

      renameSubgraph: (id, name) => {
        const s = get();
        const sg = s.subgraphs[id];
        if (!sg) return;
        set({
          subgraphs: { ...s.subgraphs, [id]: { ...sg, name, updatedAt: new Date().toISOString() } },
          // 画布上未被用户改过名的引用节点跟随更新
          nodes: s.nodes.map((n) =>
            n.data.typeId === SUBGRAPH_REF_TYPE &&
            n.data.params?.subgraphId === id &&
            n.data.label === sg.name
              ? { ...n, data: { ...n.data, label: name } }
              : n,
          ),
        });
      },

      /* ---------- 节点组 ---------- */

      createGroup: (nodeIds, title) => {
        const s = get();
        const valid = nodeIds.filter((id) => s.nodes.some((n) => n.id === id));
        if (valid.length === 0) {
          s.addLog('error', '请先选中要编组的节点');
          return null;
        }
        // 一个节点只属于一个组：先从旧组里摘出去
        const cleaned = s.groups
          .map((g) => ({ ...g, nodeIds: g.nodeIds.filter((id) => !valid.includes(id)) }))
          .filter((g) => g.nodeIds.length > 0);
        const groupId = `grp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const color = GROUP_COLORS[cleaned.length % GROUP_COLORS.length];
        // 分组即子图：自动生成一份子图定义，并把成员节点作为其内容
        const sgId = `sg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const members = s.nodes.filter((n) => valid.includes(n.id));
        const sgNodes: WorkflowFileNode[] = members.map((n) => ({
          id: n.id,
          typeId: n.data.typeId,
          label: n.data.label,
          position: { ...n.position },
          params: { ...n.data.params },
        }));
        const idSet = new Set(valid);
        const sgEdges: WorkflowFileEdge[] = s.edges
          .filter((e) => idSet.has(e.source) && idSet.has(e.target))
          .map((e) => ({
            id: e.id,
            source: e.source,
            sourceHandle: e.sourceHandle ?? null,
            target: e.target,
            targetHandle: e.targetHandle ?? null,
            kind: e.data?.kind ?? 'data',
          }));
        const now = new Date().toISOString();
        const sg: SubgraphDef = {
          id: sgId,
          name: title || `分组 ${cleaned.length + 1}`,
          category: '分组',
          createdAt: now,
          updatedAt: now,
          nodes: sgNodes,
          edges: sgEdges,
          inputs: [],
          outputs: [],
        };
        // 计算成员节点包围盒，折叠态用它占位（避免节点落到画布原点 (0,0) 不可见）
        const memberNodes = s.nodes.filter((n) => valid.includes(n.id));
        let bounds: { x: number; y: number; width: number; height: number } | undefined;
        if (memberNodes.length) {
          const xs = memberNodes.map((n) => n.position.x);
          const ys = memberNodes.map((n) => n.position.y);
          const minX = Math.min(...xs);
          const minY = Math.min(...ys);
          const maxX = Math.max(...xs);
          const maxY = Math.max(...ys);
          bounds = { x: minX, y: minY, width: Math.max(160, maxX - minX + 220), height: Math.max(60, maxY - minY + 120) };
        }
        const group: NodeGroup = {
          id: groupId,
          title: title || `分组 ${cleaned.length + 1}`,
          nodeIds: valid,
          color,
          collapsed: false,
          bounds,
          subgraphId: sgId,
        };
        const withProxy = recomputeProxyPorts({ ...group }, sg, s.nodes, s.edges);
        set({
          subgraphs: { ...s.subgraphs, [sgId]: sg },
          groups: [...cleaned, withProxy],
        });
        s.addLog('info', `已把 ${valid.length} 个节点编为「${group.title}」（子图：${sg.name}）`);
        return group.id;
      },

      removeGroup: (groupId) =>
        set((st) => {
          const g = st.groups.find((x) => x.id === groupId);
          const groups = st.groups.filter((x) => x.id !== groupId);
          const subgraphs = { ...st.subgraphs };
          if (g?.subgraphId && subgraphs[g.subgraphId]) delete subgraphs[g.subgraphId];
          // 如果当前正在该子图里编辑，退出聚焦（viewStore 是独立 store）
          if (g?.subgraphId && useViewStore.getState().focusedSubgraphId === g.subgraphId) {
            useViewStore.getState().setFocusedSubgraph(null);
          }
          return { groups, subgraphs };
        }),

      updateGroup: (groupId, patch) =>
        set({
          groups: get().groups.map((g) => (g.id === groupId ? { ...g, ...patch } : g)),
        }),

      toggleGroupCollapsed: (groupId) =>
        set((st) => ({
          groups: st.groups.map((g) => {
            if (g.id !== groupId) return g;
            const next = { ...g, collapsed: !g.collapsed };
            const sg = st.subgraphs[g.subgraphId ?? ''];
            let out = sg ? recomputeProxyPorts(next, sg, st.nodes, st.edges) : next;
            // 折叠时若缺少包围盒，按成员当前位置补算，避免代理节点落到 (0,0) 消失
            if (out.collapsed && !out.bounds) {
              const ms = st.nodes.filter((n) => out.nodeIds.includes(n.id));
              if (ms.length) {
                const xs = ms.map((n) => n.position.x);
                const ys = ms.map((n) => n.position.y);
                const minX = Math.min(...xs);
                const minY = Math.min(...ys);
                const maxX = Math.max(...xs);
                const maxY = Math.max(...ys);
                out = { ...out, bounds: { x: minX, y: minY, width: Math.max(160, maxX - minX + 220), height: Math.max(60, maxY - minY + 120) } };
              }
            }
            return out;
          }),
        })),

      recomputeGroupProxy: (groupId) =>
        set((st) => {
          const g = st.groups.find((x) => x.id === groupId);
          if (!g || !g.subgraphId) return {};
          const sg = st.subgraphs[g.subgraphId];
          if (!sg) return {};
          return { groups: st.groups.map((x) => (x.id === groupId ? recomputeProxyPorts(x, sg, st.nodes, st.edges) : x)) };
        }),

      /** 子图定义更新后，重算所有引用该子图的分组的代理端口/虚拟边，使父图实时同步 */
      syncGroupProxies: (subgraphId) =>
        set((st) => {
          const sg = st.subgraphs[subgraphId];
          if (!sg) return {};
          return {
            groups: st.groups.map((g) =>
              g.subgraphId === subgraphId ? recomputeProxyPorts(g, sg, st.nodes, st.edges) : g,
            ),
          };
        }),

      moveGroup: (groupId, dx, dy) => {
        const s = get();
        const g = s.groups.find((x) => x.id === groupId);
        if (!g) return;
        const member = new Set(g.nodeIds);
        set({
          nodes: s.nodes.map((n) =>
            member.has(n.id)
              ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }
              : n,
          ),
        });
      },
    }),
    {
      name: 'slime-mold-workflow',
      partialize: (s) => ({
        workflows: s.workflows,
        activeWfId: s.activeWfId,
        projectName: s.projectName,
        projectId: s.projectId,
        projectCreatedAt: s.projectCreatedAt,
        projectPath: s.projectPath,
        projectDirty: s.projectDirty,
        lastSavedSnapshot: s.lastSavedSnapshot,
        workflowName: s.workflowName,
        nodes: s.nodes,
        edges: s.edges,
        agents: s.agents,
        roles: s.roles,
        failFast: s.failFast,
        skipFailed: s.skipFailed,
        maxConcurrency: s.maxConcurrency,
        llmChannel: s.llmChannel,
        variables: s.variables,
        projectVariables: s.projectVariables,
        projectAssets: s.projectAssets,
        runHistory: s.runHistory,
        subgraphs: s.subgraphs,
        groups: s.groups,
      }),
    },
  ),
);

// ---------- P1：项目级脏检测（内存态 vs 磁盘态） ----------
// 加载/切换期间临时抑制自动脏检测，避免误标
let suppressDirty = false;

/** 载入/打开项目后调用：以当前内存态作为"与磁盘一致"的基准，清除脏标记 */
function finalizeLoaded() {
  suppressDirty = false;
  useWorkflowStore.setState({
    projectDirty: false,
    lastSavedSnapshot: projectSnapshot(useWorkflowStore.getState()),
  });
}

// 仅当"落盘相关字段"变化时才比对快照，避免日志/运行态频繁触发 stringify
const DIRTY_KEYS = [
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
  'projectName',
  'activeWfId',
  'workflowName',
  'llmChannel',
  'failFast',
  'skipFailed',
  'maxConcurrency',
] as const;

useWorkflowStore.subscribe((state, prev) => {
  if (suppressDirty) return;
  if (DIRTY_KEYS.every((k) => (state as any)[k] === (prev as any)[k])) return;
  if (!state.lastSavedSnapshot) {
    if (!state.projectDirty) useWorkflowStore.setState({ projectDirty: true });
    return;
  }
  if (state.lastSavedSnapshot !== projectSnapshot(state)) {
    if (!state.projectDirty) useWorkflowStore.setState({ projectDirty: true });
  }
});

// 确保启动/恢复后始终有一个激活的工作流承载当前画布（避免游离态丢节点）
{
  const st = useWorkflowStore.getState();
  const hasWf = Object.keys(st.workflows).length > 0;
  if (!st.activeWfId || !hasWf) {
    const id = `wf-${Date.now()}`;
    useWorkflowStore.setState({
      workflows: hasWf ? st.workflows : { [id]: serializeCurrent(st) },
      activeWfId: st.activeWfId || id,
      workflowName: st.workflowName || '未命名工作流',
    });
  }
}

// 一次性迁移：把持久化中遗留的旧默认模型 qwen2.5:7b 纠正为 qwen2.5:3b
// （仅当 agent 仍是旧默认值，且为 ollama 协议时；不动用户手动选择过的其它模型）
{
  const st = useWorkflowStore.getState();
  const migratedAgents = st.agents.map((a) =>
    a.protocol === 'ollama' && a.model === 'qwen2.5:7b'
      ? { ...a, model: 'qwen2.5:3b' }
      : a,
  );
  const migratedWorkflows: Record<string, WorkflowFile> = {};
  for (const [id, wf] of Object.entries(st.workflows)) {
    const ma = (wf.agents ?? []).map((a) =>
      a.protocol === 'ollama' && a.model === 'qwen2.5:7b'
        ? { ...a, model: 'qwen2.5:3b' }
        : a,
    );
    migratedWorkflows[id] = ma === wf.agents ? wf : { ...wf, agents: ma };
  }
  if (
    migratedAgents !== st.agents ||
    JSON.stringify(migratedWorkflows) !== JSON.stringify(st.workflows)
  ) {
    useWorkflowStore.setState({
      agents: migratedAgents,
      workflows: migratedWorkflows,
    });
  }
}
