import type { Connection, EdgeChange, NodeChange } from '@xyflow/react';
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
  Orchestration,
  PipelineDef,
  ProjectArtifacts,
  ProjectFile,
  RoleTemplate,
  RunRecord,
  SubgraphDef,
  WorkflowFile,
  WorkflowFileInMemory,
  WorkflowNodeData,
} from '../types';
import type { RunCheckpoint } from '../engine/checkpoint';
import type { ProjectControlSnapshot } from '../projectControl/types';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { WorkerRunRecovery } from '../projectControl/workerRunRuntime';
import type { EvidenceRecord } from '../dev/evidence';
import type { SideEffectRecord } from '../domain/contracts';
import type { WorkerCleanupProposal } from '../projectControl/workerCleanup';
import type { GraphSnapshot } from './workflowGraph';

/** Runtime progress shared by Job Board and executor wiring. */
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

export interface ProjectSaveGuard {
  projectId: string;
  projectPath: string;
  signal?: AbortSignal;
}
export interface WorkflowState {
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
  /** H3 Orchestrator：项目级编排记录（草案/进度/阶段日志），随 .slimemold 持久化 */
  orchestrations: Orchestration[];
  /** Phase 1b：项目级 Worker Run registry（队列状态随项目持久化） */
  workerRuns: WorkerRunQueueState[];
  /** 从持久队列派生的恢复提示（运行态，不写入 ProjectFile） */
  workerRunRecoveries: WorkerRunRecovery[];
  /** 从宿主 EvidenceStore 派生的证据详情（运行态，不写入 ProjectFile） */
  workerRunEvidence: EvidenceRecord[];
  /** 从项目 side-effect journal 派生的 receipt 状态（运行态，不写入 ProjectFile） */
  workerRunSideEffects: SideEffectRecord[];
  /** 从宿主 acceptance/signature 派生的清理提案（运行态，不写入 ProjectFile） */
  workerCleanupProposals: WorkerCleanupProposal[];
  /** 项目控制面快照：主控会话、Decision 和 Project Brief */
  projectControl: ProjectControlSnapshot;
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
  resetStatuses: (wfId?: string, options?: { preserveOutputs?: boolean }) => void;
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
  /** 写入某 wfId 的运行检查点（覆盖式；dirty suppression——运行收尾不构成「未保存的项目改动」） */
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
  openProject: (file: ProjectFile, path?: string) => boolean;
  /** 保存当前项目（返回保存的项目根路径/名称） */
  saveProject: (guard?: ProjectSaveGuard) => Promise<string>;
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
  /** H3：覆盖项目级编排记录集合（Orchestrator 确认/进度更新时调用） */
  setOrchestrations: (orchs: Orchestration[]) => void;
  /** Phase 1b：覆盖项目级 Worker Run registry（队列状态可持久化/恢复） */
  setWorkerRuns: (runs: WorkerRunQueueState[]) => void;
  /** 更新当前 runtime 的 Worker recovery 提示（不写入 ProjectFile） */
  setWorkerRunRecoveries: (recoveries: WorkerRunRecovery[]) => void;
  /** 更新当前 runtime 的 Worker Evidence 详情（不写入 ProjectFile） */
  setWorkerRunEvidence: (evidence: EvidenceRecord[]) => void;
  setWorkerRunSideEffects: (effects: SideEffectRecord[]) => void;
  setWorkerCleanupProposals: (proposals: WorkerCleanupProposal[]) => void;
  /** 覆盖项目控制面快照（主控会话/Decision/Brief 更新时调用） */
  setProjectControl: (snapshot: ProjectControlSnapshot) => void;
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

