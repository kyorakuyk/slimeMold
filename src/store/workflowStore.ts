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
  AgentRouteTable,
  Artifact,
  AssetMeta,
  CostRecord,
  FlowEdge,
  FlowNode,
  LogEntry,
  NodeGroup,
  NodeStatus,
  PipelineDef,
  ProjectArtifacts,
  ProjectFile,
  RoleTemplate,
  RunRecord,
  SubgraphDef,
  WorkflowFile,
  WorkflowFileNode,
  WorkflowFileEdge,
  WorkflowFileInMemory,
  WorkflowNodeData,
} from '../types';
import { arePortsCompatible } from '../types';
import { wouldCreateCycle } from '../engine/topoSort';
import { saveGlobalAgents } from '../agents/globalAgents';
// 与 store 运行态无关的纯序列化/转换函数已抽到 workflowSerialize，保持行为等价
import {
  sanitizeNodes,
  fromDisk,
  toDisk,
  serializeCurrent,
  buildProjectFile,
  projectSnapshot,
  DIRTY_KEYS,
} from './workflowSerialize';

/** 运行期调度进度（供 Job Board 可视化） */
export interface RunProgressShape {
  active: boolean;
  layer: number;
  totalLayers: number;
  round: number;
  totalRounds: number;
}
/** 单工作流运行态（拆分视图左右栏各自独立一份） */
export interface RunState {
  running: boolean;
  progress: RunProgressShape;
}
import { useRegistryStore, getNodeDef } from './registryStore';
import { applyCheckpoint, mergeCheckpointHistory, type RunCheckpoint } from '../engine/checkpoint';
import { useViewStore } from './viewStore';
import { inferPorts, packSubgraph, resolvePorts, SUBGRAPH_REF_TYPE } from '../engine/subgraph';
import { createAgent, builtinRoles } from '../agents/agentManager';
import { defaultStandaloneDir, isTauri, showSaveDirDialog } from '../platform/env';
import { saveLastSession, clearLastSession } from '../io/projectIO';
import { STARTER_TEMPLATES } from '../data/starterTemplates';

// 分组折叠代理端口计算、节点默认参数、组框配色等纯辅助计算已抽到 groupProxy.ts
import { recomputeProxyPorts, defaultParams, GROUP_COLORS } from './groupProxy';
// 节点几何布局（对齐/分布）纯计算已抽到 nodeLayout.ts
import { alignNodes, distributeNodes } from './nodeLayout';
// 运行态复位（清节点状态/去边 running class）纯映射已抽到 nodeRuntime.ts
import { resetNodeRuntime, resetEdgeRuntime } from './nodeRuntime';
// 图编辑纯逻辑（markDirty BFS / 剪贴板清洗 / 粘贴 id 映射 / 历史栈 / onConnect 决策 / 子图展开）已抽到 workflowGraph.ts（G5 门面化）
import {
  classifyConnection,
  expandSubgraphInstance,
  markDirtyDownstream,
  remapPasted,
  snapshotPush,
  snapshotUndo,
  snapshotRedo,
  type GraphSnapshot,
} from './workflowGraph';
// 持久化落盘段（checkpoint 写 runs/checkpoints.json）已抽到 workflowPersistence.ts（G5 门面化）
import { saveCheckpointToDisk } from './workflowPersistence';
// 状态转换纯逻辑（upsertById / 路由表清理 / 项目装载 / 工作流切换 / 新建项目）已抽到 workflowState.ts（G5 门面化）
import {
  buildNewProjectState,
  buildOpenProjectState,
  buildSwitchWorkflowState,
  cleanupRouteTableForAgent,
  upsertById,
} from './workflowState';

interface WorkflowState {
  workflowName: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  agents: AgentConfig[];
  /** 全局通用智能体（应用级，跨项目共享，落 AppData；不随项目序列化）。
   *  项目打开时与项目级 agents 合并为可用候选池，项目级同名(id)覆盖全局。 */
  globalAgents: AgentConfig[];
  /** 默认智能体 id：节点未指定智能体时引用此默认项 */
  defaultAgentId: string | null;
  /** 角色库：工作流级角色模板（含内置预设 + 用户自建） */
  roles: RoleTemplate[];
  selectedNodeId: string | null;
  /** React Flow 当前实例选中的节点 id 集合（由 onSelectionChange 写入，拆分视图下左右栏各自维护同一份） */
  selectedIds: string[];
  /** 焦点节点所属工作流 id（拆分视图下，焦点节点可能在非激活工作流中） */
  focusWfId: string;
  /** 示例库次级窗口是否打开（UI 状态，不持久化） */
  examplesOpen: boolean;
  running: boolean;
  /** 运行期调度进度（供 Job Board 可视化）：当前 stage 索引、总 stage 数、循环轮次。
   * 该字段为「当前激活工作流(activeWfId)」的运行态视图，拆分视图右栏请改用 runStates[wfId]。 */
  runProgress: RunProgressShape;
  /** 各工作流独立的运行态（拆分视图左右栏可同时运行，互不打扰）。key = wfId */
  runStates: Record<string, RunState>;
  /** 更新运行期调度进度（executor 在每一层开始前上报）。wfId 缺省取 activeWfId；
   * 若该 wfId 即激活工作流，同步回 running/runProgress 兼容旧 UI。 */
  setRunProgress: (p: Partial<RunProgressShape>, wfId?: string) => void;
  /** 运行期成本账本（实时累积 LLM token 用量，供 Companion 浮窗展示，不持久化） */
  costLog: CostRecord[];
  /** 运行结束后保留可读快照，供结束后回顾（setRunning(false) 后不清空，仅下次运行前重置） */
  setCostLog: (log: CostRecord[]) => void;
  /** 清空成本账本（重置统计） */
  resetUsage: () => void;
  /** 诊断用：executor 内部运行代次（current=最新代次，active=当前有效运行代次）；
   * 若 current>active 表示有「旧协程」已过期仍在后台，stop 已生效但协程未退出。 */
  debugRun: { current: number; active: number };
  setDebugRun: (v: { current: number; active: number }) => void;
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
  /** 运行检查点（阶段 C 可恢复执行）：按 wfId 覆盖式存储最近一次运行的节点级结果，随项目持久化 */
  checkpoints: Record<string, RunCheckpoint>;
  /** 检查点多版本历史（阶段 G2）：按 wfId 保留最近 CHECKPOINT_HISTORY_MAX 条运行快照（含终态），供回滚/对比 */
  checkpointHistory: Record<string, RunCheckpoint[]>;

  /**
   * 最近一次「自动保存」的时间戳（仅 UI 提示用，不持久化到磁盘，
   * 因为 zustand persist 已在每次变更后同步写入 localStorage）。
   */
  lastAutosave: number | null;
  /** 记录一次「自动保存」发生（仅 UI 提示，不写磁盘；persist 已同步落盘） */
  setAutosave: () => void;

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
  /** 项目内工作流集合（方案 P：内存态持有运行态 FlowNode，落盘时由 toDisk 拍平） */
  workflows: Record<string, WorkflowFileInMemory>;
  /** 当前激活的工作流 id */
  activeWfId: string;
  /** 项目级子图库（可复用节点组合） */
  subgraphs: Record<string, SubgraphDef>;
  /** 当前工作流的节点组（纯视觉编组） */
  groups: NodeGroup[];
  /** 步骤 14.A：项目级交付物表（跨工作流三方协作的 Artifact 存储），随 .slimemold 持久化 */
  artifacts: ProjectArtifacts;
  /** 步骤 14.7：项目级「模块类别 → 智能体」路由表（Builder 生成施工方工作流时绑定 agent 用），随 .slimemold 持久化 */
  agentRouteTable: AgentRouteTable;
  /** 步骤 14.A：项目级 Pipeline 定义集合（跨工作流三方协作编排的阶段与流向），随 .slimemold 持久化 */
  pipelines: PipelineDef[];
  /** 当前项目/工作区的磁盘目录（用于 git worktree 隔离、相对路径解析等；null=未绑定目录） */
  workspaceDir: string | null;

  onNodesChange: (changes: NodeChange<FlowNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<FlowEdge>[]) => void;
  onConnect: (conn: Connection) => void;
  /** 以函数式更新替换边集合（执行引擎写回 task 连线 scope 时调用） */
  setEdges: (updater: (edges: FlowEdge[]) => FlowEdge[]) => void;

  addNode: (typeId: string, position: { x: number; y: number }) => string | null;
  removeNode: (id: string, wfId?: string) => void;
  deleteSelected: () => void;
  clearGraph: () => void;
  updateNodeParams: (id: string, patch: Record<string, unknown>, wfId?: string) => void;
  setNodeLabel: (id: string, label: string, wfId?: string) => void;
  /** 切换节点的 bypass 开关（跳过执行、同名端口透传） */
  toggleNodeBypass: (id: string, wfId?: string) => void;
  /** 切换节点的 mute 开关（完全屏蔽、不执行） */
  toggleNodeMute: (id: string, wfId?: string) => void;
  alignSelected: (mode: 'left' | 'right' | 'top' | 'bottom' | 'hcenter' | 'vcenter') => void;
  distributeSelected: (axis: 'x' | 'y') => void;
  setNodeStatus: (
    id: string,
    status: NodeStatus,
    patch?: Partial<WorkflowNodeData>,
    wfId?: string,
  ) => void;
  resetStatuses: (wfId?: string) => void;
  /** 标记节点及其下游为脏（需重新执行），用于增量执行 */
  markDirty: (id: string) => void;
  /** 清除全部脏标记（全量运行前调用） */
  clearDirty: () => void;

  upsertAgent: (agent: AgentConfig) => void;
  removeAgent: (id: string) => void;
  setDefaultAgent: (id: string | null) => void;
  /** 载入全局智能体（应用启动/恢复时从 AppData 读取后调用） */
  setGlobalAgents: (agents: AgentConfig[]) => void;
  /** 新增/更新一个全局智能体，并立即落盘 AppData */
  upsertGlobalAgent: (agent: AgentConfig) => void;
  /** 删除一个全局智能体，并立即落盘 AppData */
  removeGlobalAgent: (id: string) => void;

  upsertRole: (role: RoleTemplate) => void;
  removeRole: (id: string) => void;

  setSelected: (id: string | null, wfId?: string) => void;
  /** 写入 React Flow 当前选中节点集合（供对齐/分布使用，避免依赖节点瞬态 selected 字段） */
  setSelectedIds: (ids: string[]) => void;
  setRunning: (running: boolean, wfId?: string) => void;
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
  /** 写入某 wfId 的运行检查点（覆盖式；suppressDirty——运行收尾不构成「未保存的项目改动」） */
  setCheckpoint: (cp: RunCheckpoint) => void;
  /** 写入检查点并独立落盘到 .slimemold/runs/checkpoints.json（运行收尾调用，返回 Promise 便于等待落盘完成） */
  persistCheckpoint: (cp: RunCheckpoint) => Promise<void>;
  /**
   * 运行中节流快照（阶段 G2）：把当前节点中间结果写入检查点并落盘（status='running'）。
   * 供节点完成/阶段结束/接管前/停止时调用——应用崩溃/强制关闭时保留最近进度，跨会话可从中恢复。
   * 与 persistCheckpoint 的区别：收尾写终态（覆盖 latest + 进历史），快照写中间态（同 runId 覆盖 latest）。
   */
  persistCheckpointSnapshot: (cp: RunCheckpoint) => Promise<void>;
  /** 清除某 wfId 的检查点（缺省取当前激活工作流） */
  clearCheckpoint: (wfId?: string) => void;
  /** 从检查点恢复画布节点状态（success 复用输出 / error 保留 + 标脏），使「断点续跑」跨会话可用 */
  restoreCheckpoint: (wfId?: string) => boolean;

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
  /**
   * 步骤 14.F：把一份「现成」WorkflowFile（如 Builder 节点生成的施工/物业工作流）
   * 直接注册进项目工作流集合并激活。与 newWorkflowInProject（建空白）互补——
   * Builder 只需拼 JSON，不必操作画布。
   */
  registerWorkflow: (wf: WorkflowFile, opts?: { activate?: boolean; name?: string }) => string;
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

  /** 步骤 14.A：写入一份跨工作流交付物（Artifact）到项目级存储，走 store 方法以触发脏标记与持久化 */
  setArtifact: (stage: string, kind: string, artifact: Artifact) => void;
  /** 步骤 14.7：覆盖项目级「类别 → agent」路由表（Builder 生成施工方工作流时绑定 agent 用） */
  setAgentRouteTable: (table: AgentRouteTable) => void;
  /** 步骤 14.A：覆盖整个 Pipeline 定义集合（随项目持久化） */
  setPipelines: (defs: PipelineDef[]) => void;
  /** 步骤 14.A：声明或更新单条 Pipeline 定义（随项目持久化，触发脏标记） */
  upsertPipeline: (def: PipelineDef) => void;

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

  /* ---- 撤销 / 重做（图结构历史栈） ---- */
  /** 历史栈上限（超出丢弃最旧记录） */
  maxHistory: number;
  /** 历史快照栈：past=已发生可撤销，future=已撤销可重做 */
  past: GraphSnapshot[];
  future: GraphSnapshot[];
  /** 在图结构变更「之前」调用，压入当前快照 */
  pushHistory: () => void;
  /** 撤销最近一次图变更 */
  undo: () => void;
  /** 重做最近一次被撤销的变更 */
  redo: () => void;
  /** 清空历史栈（如打开/新建项目后） */
  clearHistory: () => void;

  /* ---- 复制 / 粘贴 / 克隆 / 全选 ---- */
  /** 剪贴板：复制的图片段（仅含选中节点及其内部连线），不持久化 */
  clipboard: GraphSnapshot | null;
  /** 复制当前选中节点（含内部连线）到剪贴板 */
  copySelection: () => void;
  /** 粘贴剪贴板内容到画布（新 id + 偏移），可撤销 */
  pasteClipboard: () => void;
  /** 克隆选中（复制后立即粘贴，Ctrl+D） */
  duplicateSelection: () => void;
  /** 全选所有节点（Ctrl+A） */
  selectAll: () => void;
}

/** 当前项目态的稳定快照（仅含落盘相关字段，排除运行态/日志等）已抽到 workflowSerialize.projectSnapshot */
export const useWorkflowStore = create<WorkflowState>()(
  persist(
    (set, get) => ({
      workflowName: '未命名工作流',
      nodes: [],
      edges: [],
      agents: [createAgent('ollama')],
      globalAgents: [],
      defaultAgentId: null,
      workspaceDir: null,
      roles: builtinRoles.map((r) => ({ ...r })),
      selectedNodeId: null,
      selectedIds: [],
      focusWfId: '',
      examplesOpen: false,
      maxHistory: 100,
      past: [],
      future: [],
      clipboard: null,
      running: false,
      runProgress: { active: false, layer: 0, totalLayers: 0, round: 0, totalRounds: 0 },
      runStates: {},
      costLog: [],
      debugRun: { current: 0, active: 0 },
      failFast: true,
      skipFailed: false,
      maxConcurrency: 3,
      llmChannel: 'backend',
      logs: [],
      variables: {},
      projectVariables: {},
      projectAssets: [],
      runHistory: [],
      checkpoints: {},
      checkpointHistory: {},
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
      artifacts: {},
      agentRouteTable: {},
      pipelines: [],

      onNodesChange: (changes) => {
        // grpnode_* 是折叠组的「派生代理节点」，由 WorkflowEditor 计算，不应写回 store.nodes，
        // 否则会被当成真实节点（「分组被判定为节点」），并污染编组/计数等逻辑。
        const realChanges = changes.filter((c) => c.type === 'add' || !String(c.id).startsWith('grpnode_'));
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
      onEdgesChange: (changes) => {
        // 空 changes 不写回，避免无谓的 store 刷新（受控模式下 React Flow 会频繁回传空变化）
        if (changes.length === 0) return;
        set({ edges: applyEdgeChanges(changes, get().edges) });
      },

      setEdges: (updater) => set({ edges: updater(get().edges) }),

      onConnect: (conn) => {
        if (!conn.source || !conn.target) return;
        // 决策段（端口解析/成环/类型校验/kind 推断）已抽到 workflowGraph.classifyConnection（G5 门面化）
        const decision = classifyConnection(
          conn,
          get().nodes,
          get().edges,
          useRegistryStore.getState().defs,
          get().subgraphs,
          {
            resolvePorts,
            wouldCreateCycle,
            arePortsCompatible,
          },
        );
        if (!decision.ok) {
          get().addLog('error', decision.message);
          return;
        }
        get().pushHistory();
        set({
          edges: addEdge(
            { ...conn, type: 'kind', data: { kind: decision.kind } },
            get().edges,
          ),
        });
        // 新连线改变了数据依赖：两端节点及其下游需重新执行
        get().markDirty(conn.source);
        get().markDirty(conn.target);
      },

      addNode: (typeId, position) => {
        const def = getNodeDef(typeId);
        if (!def) return null;
        get().pushHistory();
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
        return node.id;
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
        get().pushHistory();
        const wfId = get().focusWfId;
        // 拆分视图：作用于指定工作流（分栏内选中）
        if (wfId && wfId !== get().activeWfId) {
          const wf = get().workflows[wfId];
          if (!wf) return;
          const delNodes = new Set((wf.nodes ?? []).filter((n) => n.selected).map((n) => n.id));
          const selNode = get().selectedNodeId;
          if (selNode) delNodes.add(selNode);
          if (delNodes.size === 0) return;
          const nodes = (wf.nodes ?? []).filter((n) => !delNodes.has(n.id));
          const edges = (wf.edges ?? []).filter(
            (e) => !delNodes.has(e.source) && !delNodes.has(e.target) && !e.selected,
          );
          set({
            workflows: { ...get().workflows, [wfId]: { ...wf, nodes, edges } },
            selectedNodeId: delNodes.has(get().selectedNodeId ?? '') ? null : get().selectedNodeId,
          });
          return;
        }
        // 主工作流：删除所有被 React Flow 选中的节点与连线，以及 selectedNodeId 指向节点
        const delNodes = new Set(
          get().nodes.filter((n) => n.selected).map((n) => n.id),
        );
        const selNode = get().selectedNodeId;
        if (selNode) delNodes.add(selNode);
        if (delNodes.size === 0 && !get().edges.some((e) => e.selected)) return;
        set({
          nodes: get().nodes.filter((n) => !delNodes.has(n.id)),
          edges: get().edges.filter(
            (e) => !delNodes.has(e.source) && !delNodes.has(e.target) && !e.selected,
          ),
          selectedNodeId: delNodes.has(get().selectedNodeId ?? '') ? null : get().selectedNodeId,
        });
      },

      clearGraph: () => {
        get().pushHistory();
        set({ nodes: [], edges: [], groups: [], selectedNodeId: null, logs: [] });
      },

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
          n.id === id ? { ...n, data: { ...n.data, params: { ...n.data.params, ...patch } } } : n,
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
        // 方案 P：非激活工作流节点已是运行态 FlowNode，统一改 data.label
        const wf = get().workflows[wfId];
        if (!wf) return;
        const nodes = wf.nodes.map((n) =>
          n.id === id ? { ...n, data: { ...n.data, label } } : n,
        );
        set({ workflows: { ...get().workflows, [wfId]: { ...wf, nodes } } });
      },

      toggleNodeBypass: (id, wfId) => {
        const flip = (n: FlowNode) =>
          n.id === id ? { ...n, data: { ...n.data, bypass: !n.data.bypass, mute: false } } : n;
        if (!wfId || wfId === get().activeWfId) {
          set({ nodes: get().nodes.map(flip) });
          return;
        }
        // 方案 P：非激活工作流节点已是运行态 FlowNode，统一改 data.bypass/mute
        const wf = get().workflows[wfId];
        if (!wf) return;
        set({ workflows: { ...get().workflows, [wfId]: { ...wf, nodes: wf.nodes.map(flip) } } });
      },

      toggleNodeMute: (id, wfId) => {
        const flip = (n: FlowNode) =>
          n.id === id ? { ...n, data: { ...n.data, mute: !n.data.mute, bypass: false } } : n;
        if (!wfId || wfId === get().activeWfId) {
          set({ nodes: get().nodes.map(flip) });
          return;
        }
        // 方案 P：非激活工作流节点已是运行态 FlowNode，统一改 data.mute/bypass
        const wf = get().workflows[wfId];
        if (!wf) return;
        set({ workflows: { ...get().workflows, [wfId]: { ...wf, nodes: wf.nodes.map(flip) } } });
      },

      /** 对齐 / 分布：对当前选中的多个节点生效（少于 2 个不操作），支持拆分视图 */
      alignSelected: (mode) => {
        // 方案 P：统一以运行态 FlowNode 处理（active 与非 active 同构）
        // 纯几何计算已抽到 nodeLayout.alignNodes（传入选中集合，避免依赖 store 单例）
        const apply = (nodes: FlowNode[]): FlowNode[] => alignNodes(nodes, get().selectedIds, mode);
        const wfId = get().focusWfId;
        if (wfId && wfId !== get().activeWfId) {
          const wf = get().workflows[wfId];
          if (!wf) return;
          get().pushHistory();
          set({ workflows: { ...get().workflows, [wfId]: { ...wf, nodes: apply(wf.nodes) } } });
          return;
        }
        get().pushHistory();
        set({ nodes: apply(get().nodes) });
      },

      distributeSelected: (axis) => {
        // 方案 P：统一以运行态 FlowNode 处理（active 与非 active 同构）
        // 纯几何计算已抽到 nodeLayout.distributeNodes（传入选中集合，避免依赖 store 单例）
        const apply = (nodes: FlowNode[]): FlowNode[] => distributeNodes(nodes, get().selectedIds, axis);
        const wfId = get().focusWfId;
        if (wfId && wfId !== get().activeWfId) {
          const wf = get().workflows[wfId];
          if (!wf) return;
          get().pushHistory();
          set({ workflows: { ...get().workflows, [wfId]: { ...wf, nodes: apply(wf.nodes) } } });
          return;
        }
        get().pushHistory();
        set({ nodes: apply(get().nodes) });
      },

      setNodeStatus: (id, status, patch, wfId) => {
        const target = wfId ?? get().activeWfId;
        set((state) => {
          const apply = (nodes: FlowNode[], edges: FlowEdge[]): { nodes: FlowNode[]; edges: FlowEdge[] } => {
            const nodes2 = nodes.map((n) =>
              n.id === id ? { ...n, data: { ...n.data, ...patch, status } } : n,
            );
            const edges2 = edges.map((e) => {
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
            return { nodes: nodes2, edges: edges2 };
          };
          // 非激活工作流：直接改 workflows[target]
          if (target !== state.activeWfId) {
            const wf = state.workflows[target];
            if (!wf) return {};
            const res = apply(wf.nodes, wf.edges ?? []);
            return { workflows: { ...state.workflows, [target]: { ...wf, nodes: res.nodes, edges: res.edges } } };
          }
          // 激活工作流：同步 s.nodes/s.edges
          const res = apply(state.nodes, state.edges);
          return { nodes: res.nodes, edges: res.edges };
        });
      },

      resetStatuses: (wfId) => {
        const target = wfId ?? get().activeWfId;
        set((state) => {
          // 运行态复位纯映射已抽到 nodeRuntime（resetNodeRuntime / resetEdgeRuntime）
          const resetNodes = (nodes: FlowNode[]): FlowNode[] => resetNodeRuntime(nodes);
          const resetEdges = (edges: FlowEdge[]): FlowEdge[] => resetEdgeRuntime(edges);
          // 注意：此处只清节点执行状态，不碰 running 标志位。
          // running 由 executor 的 setRunning 统一管理（启动置 true、停止/收尾置 false）。
          // 此前把 running 一并复位导致 runWorkflow 里 setRunning(true) 被紧接着的
          // resetStatuses 打回 false，顶栏停止按钮永不出现（运行正常但无法停止）。
          const prev = state.runStates[target];
          const patch: Partial<WorkflowState> = {
            runStates: {
              ...state.runStates,
              [target]: {
                running: prev?.running ?? false,
                progress: { active: false, layer: 0, totalLayers: 0, round: 0, totalRounds: 0 },
              },
            },
          };
          if (target === state.activeWfId) {
            patch.runProgress = { active: false, layer: 0, totalLayers: 0, round: 0, totalRounds: 0 };
            patch.costLog = [];
            patch.nodes = resetNodes(state.nodes);
            patch.edges = resetEdges(state.edges);
          } else {
            const wf = state.workflows[target];
            if (!wf) return patch;
            patch.workflows = { ...state.workflows, [target]: { ...wf, nodes: resetNodes(wf.nodes), edges: resetEdges(wf.edges ?? []) } };
          }
          return patch;
        });
      },

      /** 计算从某节点出发、沿边可到达的所有下游节点 id（含自身） */
      markDirty: (startId: string) => {
        const { nodes, edges } = get();
        if (!nodes.some((n) => n.id === startId)) return;
        // BFS 收集下游（纯计算已抽到 workflowGraph.markDirtyDownstream）
        const downstream = markDirtyDownstream(nodes, edges, startId);
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
        // 通用 upsert 纯逻辑已抽到 workflowState.upsertById（G5 门面化）
        set({ agents: upsertById(get().agents, agent) });
      },

      removeAgent: (id) =>
        set((s) => {
          // 路由表清理纯逻辑已抽到 workflowState.cleanupRouteTableForAgent（G5 门面化）
          const { table, changed } = cleanupRouteTableForAgent(s.agentRouteTable, id);
          return {
            agents: s.agents.filter((a) => a.id !== id),
            defaultAgentId: s.defaultAgentId === id ? null : s.defaultAgentId,
            ...(changed ? { agentRouteTable: table } : {}),
          };
        }),

      setDefaultAgent: (id) => set({ defaultAgentId: id }),

      setGlobalAgents: (agents) => set({ globalAgents: agents }),

      upsertGlobalAgent: (agent) => {
        // 通用 upsert 纯逻辑已抽到 workflowState.upsertById（G5 门面化）
        const next = upsertById(get().globalAgents, agent);
        set({ globalAgents: next });
        void saveGlobalAgents(next);
      },

      removeGlobalAgent: (id) => {
        const next = get().globalAgents.filter((a) => a.id !== id);
        set({ globalAgents: next });
        void saveGlobalAgents(next);
      },

      upsertRole: (role) => {
        // 通用 upsert 纯逻辑已抽到 workflowState.upsertById（G5 门面化）
        set({ roles: upsertById(get().roles, role) });
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
      setSelectedIds: (ids) => set({ selectedIds: ids }),
      setRunning: (running, wfId) => {
        const id = wfId ?? get().activeWfId;
        set((s) => {
          const runStates = {
            ...s.runStates,
            [id]: { running, progress: s.runStates[id]?.progress ?? { active: false, layer: 0, totalLayers: 0, round: 0, totalRounds: 0 } },
          };
          // 激活工作流同步回兼容字段
          const patch: Partial<WorkflowState> = { runStates };
          if (id === s.activeWfId) patch.running = running;
          return patch;
        });
      },
      setRunProgress: (p, wfId) => {
        const id = wfId ?? get().activeWfId;
        set((s) => {
          const prev = s.runStates[id]?.progress ?? { active: false, layer: 0, totalLayers: 0, round: 0, totalRounds: 0 };
          const progress = { ...prev, ...p };
          const runStates = { ...s.runStates, [id]: { running: s.runStates[id]?.running ?? false, progress } };
          const patch: Partial<WorkflowState> = { runStates };
          if (id === s.activeWfId) patch.runProgress = progress;
          return patch;
        });
      },
      setCostLog: (log) => set({ costLog: log }),
      resetUsage: () => set({ costLog: [] }),
      setDebugRun: (v) => set({ debugRun: v }),
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

      // 阶段 C 可恢复执行：检查点
      setCheckpoint: (cp) => {
        suppressDirty = true; // 运行收尾写检查点不构成「未保存的项目改动」
        const s = get();
        set({
          checkpoints: { ...s.checkpoints, [cp.wfId]: cp },
          // 阶段 G2：终态/快照同时并入多版本历史（按 runId 去重，保留最近 N 条）
          checkpointHistory: {
            ...s.checkpointHistory,
            [cp.wfId]: mergeCheckpointHistory(s.checkpointHistory[cp.wfId], cp),
          },
        });
        suppressDirty = false;
      },
      // F3/F10：运行收尾「即落盘」——内存更新 + 独立写 .slimemold/runs/checkpoints.json，
      // 不依赖用户手动保存，也不标脏（检查点是运行态快照，非项目内容变更）。
      // 返回 Promise 供 executor 收尾 await，避免「runWorkflow 已返回但磁盘尚未写完」的竞态。
      persistCheckpoint: async (cp) => {
        const s = get();
        suppressDirty = true;
        const nextCheckpoints = { ...s.checkpoints, [cp.wfId]: cp };
        const nextHistory = {
          ...s.checkpointHistory,
          [cp.wfId]: mergeCheckpointHistory(s.checkpointHistory[cp.wfId], cp),
        };
        set({ checkpoints: nextCheckpoints, checkpointHistory: nextHistory });
        suppressDirty = false;
        // 落盘段已抽到 workflowPersistence.saveCheckpointToDisk（G5 门面化）
        await saveCheckpointToDisk(s.projectPath, nextCheckpoints, nextHistory);
      },
      // 阶段 G2：运行中节流快照——只更新 latest（同 runId 覆盖），不进历史（避免中间态污染版本列表），
      // 但会落盘，使崩溃/强制关闭后仍能从最近进度恢复。
      persistCheckpointSnapshot: async (cp) => {
        const s = get();
        suppressDirty = true;
        const next = { ...s.checkpoints, [cp.wfId]: cp };
        set({ checkpoints: next });
        suppressDirty = false;
        // 落盘段已抽到 workflowPersistence.saveCheckpointToDisk（G5 门面化）
        await saveCheckpointToDisk(s.projectPath, next, s.checkpointHistory);
      },
      clearCheckpoint: (wfId) => {
        const id = wfId ?? get().activeWfId;
        if (!id) return;
        const next = { ...get().checkpoints };
        delete next[id];
        const nextHistory = { ...get().checkpointHistory };
        delete nextHistory[id];
        set({ checkpoints: next, checkpointHistory: nextHistory });
      },
      restoreCheckpoint: (wfId) => {
        const id = wfId ?? get().activeWfId;
        if (!id) return false;
        const s = get();
        const cp = s.checkpoints[id];
        if (!cp) return false;
        const nodes = id === s.activeWfId ? s.nodes : (s.workflows[id]?.nodes ?? []);
        const restored = applyCheckpoint(cp, nodes);
        if (id === s.activeWfId) {
          set({ nodes: restored });
        } else {
          set({ workflows: { ...s.workflows, [id]: { ...s.workflows[id]!, nodes: restored } } });
        }
        return true;
      },

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

      /* ---- 撤销 / 重做（图结构历史栈） ---- */
      pushHistory: () => {
        const { nodes, edges, past, maxHistory } = get();
        // 历史栈纯逻辑已抽到 workflowGraph.snapshotPush
        const { past: nextPast, future: nextFuture } = snapshotPush(past, nodes, edges, maxHistory, sanitizeNodes);
        set({ past: nextPast, future: nextFuture });
      },
      undo: () => {
        const { past, future, nodes, edges } = get();
        // 撤销纯逻辑已抽到 workflowGraph.snapshotUndo
        const result = snapshotUndo(past, future, nodes, edges, sanitizeNodes);
        if (!result) return;
        set({ nodes: result.nodes, edges: result.edges, past: result.past, future: result.future });
      },
      redo: () => {
        const { past, future, nodes, edges } = get();
        // 重做纯逻辑已抽到 workflowGraph.snapshotRedo
        const result = snapshotRedo(past, future, nodes, edges, sanitizeNodes);
        if (!result) return;
        set({ nodes: result.nodes, edges: result.edges, past: result.past, future: result.future });
      },
      clearHistory: () => set({ past: [], future: [] }),

      /* ---- 复制 / 粘贴 / 克隆 / 全选 ---- */
      copySelection: () => {
        const { nodes, edges } = get();
        const selIds = new Set(nodes.filter((n) => n.selected).map((n) => n.id));
        if (selIds.size === 0) return;
        // 运行态字段清洗纯映射已抽到 workflowGraph.sanitizeForClipboard
        const selNodes = nodes.filter((n) => selIds.has(n.id)).map((n) => ({ ...n, data: { ...n.data, status: 'idle' as NodeStatus, error: undefined, durationMs: undefined, cached: undefined } }));
        const selEdges = edges.filter((e) => selIds.has(e.source) && selIds.has(e.target));
        set({ clipboard: { nodes: selNodes, edges: [...selEdges] } });
        get().addLog('info', `已复制 ${selIds.size} 个节点到剪贴板`);
      },
      pasteClipboard: () => {
        const clip = get().clipboard;
        if (!clip || clip.nodes.length === 0) return;
        get().pushHistory();
        // id 映射 + 位置偏移纯计算已抽到 workflowGraph.remapPasted
        const { nodes: newNodes, edges: newEdges, firstId } = remapPasted(clip, 40);
        // 取消其它节点的选中，仅选中粘贴进来的节点
        const deselected = get().nodes.map((n) => (n.selected ? { ...n, selected: false } : n));
        set({
          nodes: [...deselected, ...newNodes],
          edges: [...get().edges, ...newEdges],
          selectedNodeId: firstId,
        });
      },
      duplicateSelection: () => {
        get().copySelection();
        get().pasteClipboard();
      },
      selectAll: () => set({ nodes: get().nodes.map((n) => ({ ...n, selected: true })) }),

      /* ---- 项目层方法实现 ---- */

      // 把当前编辑态写回到 workflows[activeWfId]
      // （注意：此方法在 (set,get)=> 闭包内，通过 get() 访问最新状态）
      // 通过下方 newProject/openProject/switchWorkflow/saveProject 间接调用。

      newProject: (name) => {
        // 状态构建纯逻辑已抽到 workflowState.buildNewProjectState（G5 门面化收口）
        suppressDirty = true;
        set(buildNewProjectState(name));
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
        if (!saveRoot && isTauri) {
          try {
            const base = (await defaultStandaloneDir()).replace(/\/未归类$/, '');
            const safe = (name.trim() || '未命名项目').replace(/[\\/:*?"<>|]/g, '_');
            saveRoot = `${base}/${safe}`;
          } catch {
            saveRoot = null;
          }
        }
        const baseAgents = [createAgent('ollama')];
        const wf: WorkflowFileInMemory = {
          version: 1,
          name: tpl?.name ?? '未命名工作流',
          savedAt: now,
          // 方案 P：模板节点已是运行态 FlowNode，直接持有（createProject 走内存态）
          nodes: tplNodes.map((n) => ({ ...n, data: { ...n.data, dirty: true } })),
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
            const root = await get().saveProject();
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
        // 状态构建纯逻辑已抽到 workflowState.buildOpenProjectState（G5 门面化）
        let state;
        try {
          state = buildOpenProjectState(file, path ?? file.name, get().defaultAgentId);
        } catch {
          return; // 无可用工作流，保持现状
        }
        suppressDirty = true;
        set(state);
        finalizeLoaded();
        // 工作区信任：Tauri 下项目根目录 fs:scope 动态注入已统一收口在 openProjectByPath
        // （先授权后读盘），此处不再重复 fire-and-forget，避免与扫描 custom_nodes 竞态。
      },

      saveProject: async () => {
        const s = get();
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
        // 与 finalizeLoaded/subscribe 统一用稳定快照比对（排除时间戳/自增 id 噪声）
        return s.lastSavedSnapshot !== projectSnapshot(s);
      },

      switchWorkflow: (id) => {
        const s = get();
        if (id === s.activeWfId) return;
        // 状态构建纯逻辑已抽到 workflowState.buildSwitchWorkflowState（G5 门面化）
        const state = buildSwitchWorkflowState(s, id);
        if (!state) return;
        // 切换工作流不新增"内存vs磁盘"差异，抑制本次变更的脏检测
        suppressDirty = true;
        set(state);
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
        const wf: WorkflowFileInMemory = {
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

      /**
       * 步骤 14.F：把现成 WorkflowFile 注册进项目。复用 newWorkflowInProject 的同款激活逻辑，
       * 但内容来自 wf（非空白）。id 自动生成；若 wf 已带 belongsToProject 则保留，否则归属当前项目。
       */
      registerWorkflow: (wf, opts) => {
        const s = get();
        const workflows = { ...s.workflows };
        const id = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const inProject = !!s.projectId;
        // 入参 wf 为磁盘态拍平 WorkflowFile（builder/导入来源），统一收口为内存态
        const merged: WorkflowFileInMemory = {
          ...fromDisk(wf),
          name: opts?.name ?? wf.name ?? '生成的工作流',
          savedAt: new Date().toISOString(),
          belongsToProject: wf.belongsToProject ?? (inProject ? s.projectId! : undefined),
          standalonePath: wf.standalonePath ?? (inProject ? undefined : s.workflows[s.activeWfId]?.standalonePath),
          agents: wf.agents && wf.agents.length ? wf.agents : (s.workflows[s.activeWfId]?.agents ?? [createAgent('ollama')]),
          roles: wf.roles && wf.roles.length ? wf.roles : (s.workflows[s.activeWfId]?.roles ?? builtinRoles.map((r) => ({ ...r }))),
          variables: wf.variables ?? {},
          assets: wf.assets ?? [],
          groups: wf.groups ?? [],
        };
        workflows[id] = merged;
        if (opts?.activate === false) {
          // 仅注册、不切换当前画布（避免打断正在跑的承建方工作流）
          set({ workflows });
          return id;
        }
        set({
          workflows,
          activeWfId: id,
          workflowName: merged.name,
          // 方案 P：merged 已是运行态 FlowNode
          nodes: merged.nodes.map((n) => ({ ...n, data: { ...n.data, dirty: true } })),
          edges: merged.edges,
          agents: merged.agents,
          defaultAgentId: merged.defaultAgentId ?? null,
          roles: merged.roles!,
          variables: merged.variables!,
          groups: merged.groups!,
          selectedNodeId: null,
          logs: [],
        });
        return id;
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
            Object.values(n.data.params ?? {}).some((v) => {
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
            // 方案 P：wf.nodes 已是运行态 FlowNode
            nodes: wf.nodes.map((n) => ({ ...n, data: { ...n.data, dirty: true } })),
            edges: wf.edges,
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
        if (!isTauri) {
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
              // 方案 P：直接持有运行态 FlowNode（拆分视图分栏写回）
              nodes,
              edges,
            },
          },
        });
      },

      /* ---------- 步骤 14.A：跨工作流交付物（Artifact） ---------- */

      setArtifact: (stage, kind, artifact) => {
        const s = get();
        const stageMap = s.artifacts[stage] ?? {};
        set({
          artifacts: {
            ...s.artifacts,
            [stage]: { ...stageMap, [kind]: artifact },
          },
        });
      },

      setAgentRouteTable: (table) => {
        set({ agentRouteTable: table });
      },

      /* ---------- 步骤 14.A：Pipeline 编排定义（随项目持久化） ---------- */

      /** 覆盖整个 pipeline 定义集合（Builder / Orchestrator 全量写入时调用） */
      setPipelines: (defs: PipelineDef[]) => {
        set({ pipelines: defs });
      },
      /** 声明或更新单条 pipeline（definePipeline 走此路径，确保存于项目态并触发脏标记/持久化） */
      upsertPipeline: (def: PipelineDef) => {
        const s = get();
        const exists = s.pipelines.some((p) => p.id === def.id);
        set({
          pipelines: exists
            ? s.pipelines.map((p) => (p.id === def.id ? def : p))
            : [...s.pipelines, def],
        });
      },

      /* ---------- 子图 ---------- */

      packSelectionAsSubgraph: (nodeIds, name) => {
        const s = get();
        get().pushHistory();
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
        get().pushHistory();
        const ref = s.nodes.find((n) => n.id === refNodeId);
        if (!ref || ref.data.typeId !== SUBGRAPH_REF_TYPE) return;
        const sg = s.subgraphs[String(ref.data.params?.subgraphId ?? '')];
        if (!sg) {
          s.addLog('error', '这个子图的定义已丢失，无法展开');
          return;
        }

        // 内部节点 id 重映射 + 节点/边重建 + 外部连线重接（纯计算已抽到 workflowGraph.expandSubgraphInstance）
        const { nodes: newNodes, edges: newEdges } = expandSubgraphInstance(
          sg,
          ref.position,
          s.edges,
          refNodeId,
        );
        set({
          nodes: [...s.nodes.filter((n) => n.id !== refNodeId), ...newNodes],
          edges: newEdges,
          selectedNodeId: newNodes[0]?.id ?? null,
        });
        s.addLog('info', `已展开子图「${sg.name}」，还原为 ${newNodes.length} 个节点`);
      },

      addSubgraphRefNode: (subgraphId, position) => {
        const s = get();
        get().pushHistory();
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
        get().pushHistory();
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
            scope: e.data?.scope,
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
          get().pushHistory();
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

      recomputeGroupProxy: (groupId: string) =>
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
        // 方案 P：workflows 在内存态是 FlowNode[]，落盘前拍平剥离 React Flow 瞬态字段
        workflows: Object.fromEntries(
          Object.entries(s.workflows).map(([k, wf]) => [k, toDisk(wf)]),
        ),
        activeWfId: s.activeWfId,
        projectName: s.projectName,
        projectId: s.projectId,
        projectCreatedAt: s.projectCreatedAt,
        projectPath: s.projectPath,
        projectDirty: s.projectDirty,
        lastSavedSnapshot: s.lastSavedSnapshot,
        workflowName: s.workflowName,
        nodes: s.nodes.map((n) => ({ ...n, data: { ...n.data, dirty: true } })),
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
        checkpoints: s.checkpoints,
        checkpointHistory: s.checkpointHistory,
        subgraphs: s.subgraphs,
        groups: s.groups,
        artifacts: s.artifacts,
        agentRouteTable: s.agentRouteTable,
        pipelines: s.pipelines,
      }),
      // 恢复持久化状态时，把拍平的 workflows 重新收口为内存态 FlowNode
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<WorkflowState>;
        const restoredWorkflows = p.workflows
          ? Object.fromEntries(
              Object.entries(p.workflows).map(([k, wf]) =>
                [k, fromDisk(wf as unknown as WorkflowFile)],
              ),
            )
          : current.workflows;
        return {
          ...current,
          ...p,
          workflows: restoredWorkflows,
        } as WorkflowState;
      },
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
// DIRTY_KEYS 已抽到 workflowSerialize（共享常量）
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

// ---------- 智能体/配置类字段变更自动落盘 ----------
// 用户加/改/删 agent、角色、路由表、默认 agent 时，若有磁盘项目（projectPath），
// 防抖自动 saveProject，避免「改了 agent 忘保存 → 重启自动恢复时 agents.json 没有 → agent 消失」。
// 只监听配置型字段，不监听 nodes/edges/运行态，避免频繁全量保存。
let configSaveTimer: ReturnType<typeof setTimeout> | null = null;
const CONFIG_AUTO_SAVE_KEYS = ['agents', 'roles', 'defaultAgentId', 'agentRouteTable'] as const;
useWorkflowStore.subscribe((state, prev) => {
  if (suppressDirty) return;
  const changed = CONFIG_AUTO_SAVE_KEYS.some((k) => (state as any)[k] !== (prev as any)[k]);
  if (!changed) return;
  // 无磁盘项目无从落盘（靠 localStorage + 用户「另存为」），不自动保存
  if (!state.projectPath) return;
  if (configSaveTimer) clearTimeout(configSaveTimer);
  configSaveTimer = setTimeout(() => {
    configSaveTimer = null;
    // 取最新 state，避免闭包拿到过期引用；失败静默，不阻塞 UI
    void useWorkflowStore.getState().saveProject().catch(() => {});
  }, 1000);
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
  const migratedWorkflows: Record<string, WorkflowFileInMemory> = {};
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
