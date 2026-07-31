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
  FlowEdge,
  FlowNode,
  LogEntry,
  NodeStatus,
  PortType,
  ProjectFile,
  RoleTemplate,
  RunRecord,
  WorkflowFile,
  WorkflowFileNode,
  WorkflowFileEdge,
  WorkflowNodeData,
} from '../types';
import { arePortsCompatible } from '../types';
import { wouldCreateCycle } from '../engine/topoSort';
import { getNodeDef } from './registryStore';
import { createAgent, builtinRoles } from '../agents/agentManager';

interface WorkflowState {
  workflowName: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  agents: AgentConfig[];
  /** 角色库：工作流级角色模板（含内置预设 + 用户自建） */
  roles: RoleTemplate[];
  selectedNodeId: string | null;
  /** 焦点节点所属工作流 id（拆分视图下，焦点节点可能在非激活工作流中） */
  focusWfId: string;
  /** 示例库次级窗口是否打开（UI 状态，不持久化） */
  examplesOpen: boolean;
  running: boolean;
  failFast: boolean;
  /** LLM 并发上限：同一时刻最多进行的智能体请求数 */
  maxConcurrency: number;
  /** LLM 调用通道：'backend'（经 Tauri Rust 命令，密钥不出前端）/ 'frontend'（WebView 直接请求）。默认 backend。 */
  llmChannel: 'backend' | 'frontend';
  logs: LogEntry[];
  /** 全局变量（可在 {{}} 模板与表达式中引用），随工作流保存 */
  variables: Record<string, unknown>;
  /** 历史运行记录（持久化） */
  runHistory: RunRecord[];

  /* ---- 项目层（多工作流） ---- */
  /** 当前项目名（无项目时为 null，表示游离单工作流） */
  projectName: string | null;
  /** 当前项目文件路径（Tauri 下为磁盘路径，浏览器下为项目名；未保存为 null） */
  projectPath: string | null;
  /** 项目内工作流集合 */
  workflows: Record<string, WorkflowFile>;
  /** 当前激活的工作流 id */
  activeWfId: string;

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

  upsertRole: (role: RoleTemplate) => void;
  removeRole: (id: string) => void;

  setSelected: (id: string | null, wfId?: string) => void;
  setRunning: (running: boolean) => void;
  setFailFast: (v: boolean) => void;
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
  /** 载入整个项目文件，并激活 activeId 对应工作流；path 为磁盘路径（Tauri）或项目名（浏览器） */
  openProject: (file: ProjectFile, path?: string) => void;
  /** 保存当前项目为 .smproj（返回保存路径/名称） */
  saveProject: () => Promise<string>;
  /** 切换当前激活工作流（先写回当前，再加载目标） */
  switchWorkflow: (id: string) => void;
  /** 在项目内新建一个工作流并激活 */
  newWorkflowInProject: () => void;
  /** 重命名当前工作流 */
  renameWorkflow: (name: string) => void;
  /** 删除一个工作流（至少保留一个） */
  removeWorkflow: (id: string) => void;
  /** 将指定工作流的图（节点/连线）写回 workflows 字典，保留其余字段（用于拆分视图分栏编辑） */
  updateWorkflowGraph: (id: string, nodes: FlowNode[], edges: FlowEdge[]) => void;

  /** 打开/关闭示例库次级窗口 */
  setExamplesOpen: (open: boolean) => void;
}

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
  };
}

/** 把当前编辑态序列化为一个 WorkflowFile（用于收纳游离态/写回） */
function serializeCurrent(s: {
  workflowName: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  agents: AgentConfig[];
  roles: RoleTemplate[];
  variables: Record<string, unknown>;
}): WorkflowFile {
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
    })),
    agents: s.agents,
    roles: s.roles,
    variables: s.variables,
  };
}

export const useWorkflowStore = create<WorkflowState>()(
  persist(
    (set, get) => ({
      workflowName: '未命名工作流',
      nodes: [],
      edges: [],
      agents: [createAgent('ollama')],
      roles: builtinRoles.map((r) => ({ ...r })),
      selectedNodeId: null,
      focusWfId: '',
      examplesOpen: false,
      running: false,
      failFast: true,
      maxConcurrency: 3,
      llmChannel: 'backend',
      logs: [],
      variables: {},
      runHistory: [],

      projectName: null,
      projectPath: null,
      workflows: {},
      activeWfId: '',

      onNodesChange: (changes) => {
        set({ nodes: applyNodeChanges(changes, get().nodes) });
        // 删除节点会改变其下游输入：标记下游为脏
        const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id);
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
        const srcDef = getNodeDef(conn.source);
        const tgtDef = getNodeDef(conn.target);
        const srcName = srcDef?.name ?? conn.source;
        const tgtName = tgtDef?.name ?? conn.target;

        if (wouldCreateCycle(conn.source, conn.target, get().edges)) {
          get().addLog(
            'error',
            `「${srcName}」和「${tgtName}」这样连会绕成死循环，换一种接法吧`,
          );
          return;
        }
        // 端口类型校验：source 输出端口类型须与 target 输入端口类型兼容
        const srcPort = srcDef?.outputs.find((o) => o.id === conn.sourceHandle);
        const tgtPort = tgtDef?.inputs.find((i) => i.id === conn.targetHandle);
        const srcType: PortType | undefined = srcPort?.type;
        const tgtType: PortType | undefined = tgtPort?.type;
        if (!arePortsCompatible(srcType, tgtType)) {
          // 在目标节点上找一个兼容的输入端口，给出更友好的引导
          const suggest = tgtDef?.inputs.find((i) =>
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
        set({
          edges: addEdge({ ...conn }, get().edges),
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
        set({ nodes: [], edges: [], selectedNodeId: null, logs: [] }),

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
            data: { ...n.data, status: 'idle' as NodeStatus, error: undefined, outputs: undefined },
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
        set({ agents: get().agents.filter((a) => a.id !== id) }),

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
        const wf: WorkflowFile = {
          version: 1,
          name: '未命名工作流',
          savedAt: new Date().toISOString(),
          nodes: [],
          edges: [],
          agents: [createAgent('ollama')],
          roles: builtinRoles.map((r) => ({ ...r })),
          variables: {},
        };
        set({
          projectName: name,
          projectPath: null,
          workflows: { [id]: wf },
          activeWfId: id,
          workflowName: wf.name,
          nodes: [],
          edges: [],
          agents: wf.agents,
          roles: wf.roles!,
          variables: wf.variables!,
          selectedNodeId: null,
          logs: [],
        });
      },

      openProject: (file, path) => {
        const id = file.activeId ?? Object.keys(file.workflows)[0];
        const wf = file.workflows[id];
        if (!wf) return;
        set({
          projectName: file.name,
          projectPath: path ?? file.name, // 实际磁盘路径由调用方传入
          workflows: file.workflows,
          activeWfId: id,
          workflowName: wf.name,
          nodes: [],
          edges: [],
          agents: wf.agents?.length ? wf.agents : [createAgent('ollama')],
          roles: [
            ...builtinRoles.map((r) => ({ ...r })),
            ...(wf.roles ?? []).filter((r) => !r.builtin),
          ],
          variables: wf.variables ?? {},
          selectedNodeId: null,
          logs: [],
        });
        // 标记项目路径：若调用方传入的是已解析的项目（含 path），由调用处再 set
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
          })),
          agents: s.agents,
          roles: s.roles,
          variables: s.variables,
        };
        const workflows = { ...s.workflows };
        if (s.activeWfId) workflows[s.activeWfId] = current;
        else {
          const id = `wf-${Date.now()}`;
          workflows[id] = current;
        }
        const file: ProjectFile = {
          version: 1,
          kind: 'project',
          name: s.projectName ?? s.workflowName,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          workflows,
          activeId: s.activeWfId || Object.keys(workflows)[0],
          roles: s.roles,
          variables: s.variables,
        };
        const { saveProjectFile } = await import('../io/projectIO');
        const path = await saveProjectFile(file);
        set({ projectPath: path });
        return path;
      },

      switchWorkflow: (id) => {
        const s = get();
        if (id === s.activeWfId) return;
        // 写回当前编辑态（若为游离态则先收纳为临时工作流，避免节点丢失）
        const synced: Record<string, WorkflowFile> = { ...s.workflows };
        const curId = s.activeWfId || `wf-${Date.now()}`;
        synced[curId] = serializeCurrent(s);
        const target = synced[id];
        if (!target) return;
        set({
          workflows: synced,
          activeWfId: id,
          workflowName: target.name,
          nodes: flowNodesFrom(target),
          edges: flowEdgesFrom(target),
          agents: target.agents?.length ? target.agents : s.agents,
          roles: [...builtinRoles.map((r) => ({ ...r })), ...(target.roles ?? []).filter((r) => !r.builtin)],
          variables: target.variables ?? {},
          selectedNodeId: null,
          logs: [],
        });
      },

      newWorkflowInProject: () => {
        const s = get();
        const workflows = { ...s.workflows };
        // 若当前为游离态（无对应工作流）且已有编辑内容，先把现有编辑态收纳为默认工作流
        let baseActive = s.activeWfId;
        if (!baseActive && (s.nodes.length || s.edges.length)) {
          baseActive = `wf-${Date.now()}`;
          workflows[baseActive] = serializeCurrent(s);
        }
        const id = `wf-${Date.now() + 1}`;
        const wf: WorkflowFile = {
          version: 1,
          name: `工作流 ${Object.keys(workflows).length + 1}`,
          savedAt: new Date().toISOString(),
          nodes: [],
          edges: [],
          agents: [createAgent('ollama')],
          roles: builtinRoles.map((r) => ({ ...r })),
          variables: {},
        };
        workflows[id] = wf;
        set({
          workflows,
          activeWfId: id,
          workflowName: wf.name,
          nodes: [],
          edges: [],
          agents: wf.agents,
          roles: wf.roles!,
          variables: wf.variables!,
          selectedNodeId: null,
          logs: [],
        });
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
            roles: [...builtinRoles.map((r) => ({ ...r })), ...(wf.roles ?? []).filter((r) => !r.builtin)],
            variables: wf.variables ?? {},
            selectedNodeId: null,
            logs: [],
          });
        } else {
          set({ workflows: next });
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
    }),
    {
      name: 'slime-mold-workflow',
      partialize: (s) => ({
        workflows: s.workflows,
        activeWfId: s.activeWfId,
        workflowName: s.workflowName,
        nodes: s.nodes,
        edges: s.edges,
        agents: s.agents,
        roles: s.roles,
        failFast: s.failFast,
        maxConcurrency: s.maxConcurrency,
        llmChannel: s.llmChannel,
        variables: s.variables,
        runHistory: s.runHistory,
      }),
    },
  ),
);

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
