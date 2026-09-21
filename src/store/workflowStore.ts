import {
  type ProjectSaveGuard,
  type WorkflowState,
} from './workflowStoreTypes';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
} from '@xyflow/react';
import type {
  FlowEdge,
  FlowNode,
  NodeGroup,
  Orchestration,
  PipelineDef,
  SubgraphDef,
  WorkflowFile,
  WorkflowFileNode,
  WorkflowFileEdge,
  WorkflowFileInMemory,
} from '../types';
import { arePortsCompatible } from '../types/graph';
import { wouldCreateCycle } from '../engine/topoSort';
import { saveGlobalAgents } from '../agents/globalAgents';
// 与 store 运行态无关的纯序列化/转换函数已抽到 workflowSerialize，保持行为等价
import {
  fromDisk,
  toDisk,
  serializeCurrent,
  buildProjectFile,
  projectSnapshot,
  DIRTY_KEYS,
} from './workflowSerialize';
import { useRegistryStore, getNodeDef } from './registryStore';
import { applyCheckpoint, mergeCheckpointHistory } from '../engine/checkpoint';
import { useViewStore } from './viewStore';
import { inferPorts, packSubgraph, resolvePorts, SUBGRAPH_REF_TYPE } from '../engine/subgraph';
import { createAgent, builtinRoles } from '../agents/agentManager';
import { defaultStandaloneDir, isTauri, showSaveDirDialog } from '../platform/env';
import { saveLastSession, clearLastSession } from '../io/projectIO';
import { STARTER_TEMPLATES } from '../data/starterTemplates';
import { createEmptyProjectControlSnapshot } from '../projectControl/persistence';
import type { ProjectControlSnapshot } from '../projectControl/types';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { WorkerRunRecovery } from '../projectControl/workerRunRuntime';
import type { EvidenceRecord } from '../dev/evidence';
import type { SideEffectRecord } from '../domain/contracts';
import type { WorkerCleanupProposal } from '../projectControl/workerCleanup';
import { EventStreamRepository } from '../domain/eventStore';
import { clearProjectEventBuffer, flushPendingProjectEvents, getPendingProjectEvents } from '../projectControl/eventBuffer';
import {
  clearWorkerRunRuntime,
  installWorkerRunRuntime,
} from '../projectControl/workerRunRuntime';
import { projectWorkerRunsOntoOrchestrations } from '../projectControl/workerRunOrchestrationProjection';
import { restoreMissingWorkerRunsFromEvents } from '../projectControl/workerRunRehydration';
import {
  createProjectControlStoreAdapter,
  normalizeProjectControlSnapshot,
} from './projectControlLifecycle';

// 分组折叠代理端口计算、节点默认参数、组框配色等纯辅助计算已抽到 groupProxy.ts
import { recomputeProxyPorts, defaultParams, GROUP_COLORS } from './groupProxy';
// 节点几何布局（对齐/分布）纯计算已抽到 nodeLayout.ts
import { alignNodes, distributeNodes } from './nodeLayout';
// 运行态复位（清节点状态/去边 running class）纯映射已抽到 nodeRuntime.ts
import { resetNodeRuntime, resetEdgeRuntime } from './nodeRuntime';
import { persistProjectFile } from './projectFilePersistence';
import { createProjectDirtyController, type ProjectDirtyController } from './projectDirtyController';
import { installProjectConfigAutosave } from './projectConfigAutosave';
import { createProjectSaveAsController, type ProjectSaveAsController } from './projectSaveAsController';
import { createProjectSaveQueue } from './projectSaveQueue';
// 图编辑纯逻辑（markDirty BFS / 剪贴板清洗 / 粘贴 id 映射 / 历史栈 / onConnect 决策 / 子图展开）已抽到 workflowGraph.ts（G5 门面化）
import {
  classifyConnection,
  expandSubgraphInstance,
  markDirtyDownstream,
} from './workflowGraph';
import { createProjectCreationActions } from './projectCreationActions';
import { createProjectBootstrapActions } from './projectBootstrapActions';
import { createProjectLifecycleActions } from './projectLifecycleActions';
import { createWorkflowRegistryActions } from './workflowRegistryActions';
import { createWorkflowGraphCommands } from './workflowGraphCommands';
// 持久化落盘段（checkpoint 写 runs/checkpoints.json）已抽到 workflowPersistence.ts（G5 门面化）
import { saveCheckpointToDisk } from './workflowPersistence';
// Pure project lifecycle state builders; store mutation and host lifecycle stay in this facade.
import {
  buildCloseProjectState,
} from './workflowLifecycleState';
import {
  buildRemoveWorkflowState,
  buildRenameWorkflowState,
} from './workflowRegistryState';
import {
  buildRemoveAgentState,
  buildRemoveRoleState,
  buildSetDefaultAgentState,
  buildUpsertAgentState,
  buildUpsertRoleState,
  upsertById,
} from './projectCatalogState';

function assertProjectSaveGuard(state: WorkflowState, guard?: ProjectSaveGuard): void {
  if (!guard) return;
  if (guard.signal?.aborted) {
    const error = new Error('项目保存 operation 已取消');
    error.name = 'AbortError';
    throw error;
  }
  if (state.projectId !== guard.projectId || state.projectPath !== guard.projectPath) {
    const error = new Error('项目已切换，拒绝提交旧保存 operation');
    error.name = 'AbortError';
    throw error;
  }
}

/** 当前项目态的稳定快照（仅含落盘相关字段，排除运行态/日志等）已抽到 workflowSerialize.projectSnapshot */
export const useWorkflowStore = create<WorkflowState>()(
  persist(
    (set, get) => {
      const graphCommands = createWorkflowGraphCommands({
        getState: () => get(),
        setState: (patch) => set(patch),
        addLog: (level, message) => get().addLog(level, message),
      });
      const registryActions = createWorkflowRegistryActions({
        getState: () => get(),
        setState: (patch) => set(patch),
        setDirtySuppressed: (suppressed) => projectDirtyController.setSuppressed(suppressed),
        resolveStandalonePath: async (workspaceDir) => workspaceDir ?? (await defaultStandaloneDir()),
        now: () => Date.now(),
        nowIso: () => new Date().toISOString(),
        createRegisteredWorkflowId: () => `wf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      });
      const projectControlAdapter = createProjectControlStoreAdapter({
        clearPendingProjectEvents: clearProjectEventBuffer,
        clearWorkerRunRuntime,
        installWorkerRunRuntime: (input) => installWorkerRunRuntime(input),
      });
      const projectBootstrapActions = createProjectBootstrapActions({
        getProjectId: () => get().projectId,
        getDefaultAgentId: () => get().defaultAgentId,
        setState: (patch) => set(patch as Partial<WorkflowState>),
        setDirtySuppressed: (suppressed) => projectDirtyController.setSuppressed(suppressed),
        finalizeLoaded: () => projectDirtyController.finalizeLoaded(),
        projectControlAdapter,
      });
      const projectCreationActions = createProjectCreationActions({
        getProjectId: () => get().projectId,
        resetProjectControlLifecycle: projectControlAdapter.resetProjectControlLifecycle,
        getTemplate: (templateId) => {
          const template = templateId ? STARTER_TEMPLATES.find((item) => item.id === templateId) : undefined;
          if (!template) return undefined;
          const graph = template.build();
          return { name: template.name, nodes: graph.nodes, edges: graph.edges };
        },
        createProjectIdentity: () => ({
          workflowId: `wf-${Date.now()}`,
          projectId: `proj-${Date.now()}`,
          createdAt: new Date().toISOString(),
        }),
        resolveSaveRoot: async (name, location) => {
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
          return saveRoot;
        },
        setDirtySuppressed: (suppressed) => projectDirtyController.setSuppressed(suppressed),
        setState: (patch) => set(patch as Partial<WorkflowState>),
        saveProject: () => get().saveProject(),
        saveLastSession,
        clearLastSession,
        addLog: (level, message) => get().addLog(level, message),
      });
      const projectLifecycleActions = createProjectLifecycleActions({
        getProjectId: () => get().projectId,
        resetProjectControlLifecycle: projectControlAdapter.resetProjectControlLifecycle,
        setDirtySuppressed: (suppressed) => projectDirtyController.setSuppressed(suppressed),
        setState: (patch) => set(patch),
        clearLastSession,
        buildCloseState: () => buildCloseProjectState({
          createDefaultAgent: () => createAgent('ollama'),
          cloneBuiltinRoles: () => builtinRoles.map((role) => ({ ...role })),
          createEmptyProjectControl: createEmptyProjectControlSnapshot,
        }),
      });
      return {
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
      orchestrations: [],
      workerRuns: [],
      workerRunRecoveries: [],
      workerRunEvidence: [],
      workerRunSideEffects: [],
      workerCleanupProposals: [],
      projectControl: createEmptyProjectControlSnapshot(),

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

      resetStatuses: (wfId, options) => {
        const target = wfId ?? get().activeWfId;
        set((state) => {
          // 运行态复位纯映射已抽到 nodeRuntime（resetNodeRuntime / resetEdgeRuntime）
          const resetNodes = (nodes: FlowNode[]): FlowNode[] => resetNodeRuntime(nodes, options);
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
        // project catalog state is transformed in projectCatalogState; facade owns set/dirty observation.
        set(buildUpsertAgentState(get().agents, agent));
      },

      removeAgent: (id) =>
        set((s) => buildRemoveAgentState(s, id)),

      setDefaultAgent: (id) => set(buildSetDefaultAgentState(id)),

      setGlobalAgents: (agents) => set({ globalAgents: agents }),

      upsertGlobalAgent: (agent) => {
        // 通用 upsert 纯逻辑已抽到 projectCatalogState.upsertById（G5 门面化）
        const next = upsertById(get().globalAgents, agent);
        set({ globalAgents: next });
        void saveGlobalAgents(next);
      },

      removeGlobalAgent: (id) => {
        const next = get().globalAgents.filter((a) => a.id !== id);
        set({ globalAgents: next });
        if (useViewStore.getState().globalMasterAgentId === id) {
          useViewStore.getState().setGlobalMasterAgent(null);
        }
        void saveGlobalAgents(next);
      },

      upsertRole: (role) => {
        set(buildUpsertRoleState(get().roles, role));
      },

      removeRole: (id) => {
        const result = buildRemoveRoleState(get().roles, id);
        if (result.rejected) {
          get().addLog('error', result.message ?? '内置角色不可删除');
          return;
        }
        set({ roles: result.roles });
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
        projectDirtyController.setSuppressed(true); // 运行收尾写检查点不构成「未保存的项目改动」
        const s = get();
        set({
          checkpoints: { ...s.checkpoints, [cp.wfId]: cp },
          // 阶段 G2：终态/快照同时并入多版本历史（按 runId 去重，保留最近 N 条）
          checkpointHistory: {
            ...s.checkpointHistory,
            [cp.wfId]: mergeCheckpointHistory(s.checkpointHistory[cp.wfId], cp),
          },
        });
        projectDirtyController.setSuppressed(false);
      },
      // F3/F10：运行收尾「即落盘」——内存更新 + 独立写 .slimemold/runs/checkpoints.json，
      // 不依赖用户手动保存，也不标脏（检查点是运行态快照，非项目内容变更）。
      // 返回 Promise 供 executor 收尾 await，避免「runWorkflow 已返回但磁盘尚未写完」的竞态。
      persistCheckpoint: async (cp) => {
        const s = get();
        projectDirtyController.setSuppressed(true);
        const nextCheckpoints = { ...s.checkpoints, [cp.wfId]: cp };
        const nextHistory = {
          ...s.checkpointHistory,
          [cp.wfId]: mergeCheckpointHistory(s.checkpointHistory[cp.wfId], cp),
        };
        set({ checkpoints: nextCheckpoints, checkpointHistory: nextHistory });
        projectDirtyController.setSuppressed(false);
        // 落盘段已抽到 workflowPersistence.saveCheckpointToDisk（G5 门面化）
        await saveCheckpointToDisk(s.projectPath, nextCheckpoints, nextHistory);
      },
      // 阶段 G2：运行中节流快照——只更新 latest（同 runId 覆盖），不进历史（避免中间态污染版本列表），
      // 但会落盘，使崩溃/强制关闭后仍能从最近进度恢复。
      persistCheckpointSnapshot: async (cp) => {
        const s = get();
        projectDirtyController.setSuppressed(true);
        const next = { ...s.checkpoints, [cp.wfId]: cp };
        set({ checkpoints: next });
        projectDirtyController.setSuppressed(false);
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

      /* ---- 撤销 / 重做 / 复制 / 粘贴 / 克隆（graph command owner） ---- */
      ...graphCommands,
      /** 全选仍由 facade 保留，避免把 React Flow selection policy混入 command owner。 */
      selectAll: () => set({ nodes: get().nodes.map((n) => ({ ...n, selected: true })) }),

      /* ---- 项目层方法实现 ---- */

      // 把当前编辑态写回到 workflows[activeWfId]
      // （注意：此方法在 (set,get)=> 闭包内，通过 get() 访问最新状态）
      // 通过下方 newProject/openProject/switchWorkflow/saveProject 间接调用。

      ...projectBootstrapActions,

      ...projectCreationActions,

      saveProject: async (guard) => {
        const initial = get();
        const saveKey = `${initial.projectId ?? 'unsaved'}:${initial.projectPath ?? 'memory'}`;
        return projectSaveQueue.enqueue(saveKey, async () => {
          let s = get();
          assertProjectSaveGuard(s, guard);
          // Never let a startup/recovery save erase a WorkerRun projection that is already
          // durable in the event stream while the in-memory registry is still empty.
          if (isTauri && s.projectId && s.projectPath && s.workerRuns.length === 0) {
            const { createTauriEventStoreAdapter } = await import('../domain/tauriEventStore');
            const repository = new EventStreamRepository(
              createTauriEventStoreAdapter(s.projectPath),
              s.projectPath,
            );
            const parsed = await repository.readStream();
            assertProjectSaveGuard(get(), guard);
            if (parsed.status === 'needs-repair') {
              throw new Error(
                `Worker 事件流需要修复：第 ${parsed.corruption?.line ?? '?'} 行 ${parsed.corruption?.reason ?? ''}`,
              );
            }
            const restored = restoreMissingWorkerRunsFromEvents({
              projectId: s.projectId,
              events: parsed.events,
              taskGraphs: s.projectControl.taskGraphs ?? [],
              existingRuns: s.workerRuns,
            });
            if (restored.issues.length > 0) {
              throw new Error(`Worker Run 投影恢复被阻止：${restored.issues.map((item) => item.message).join('；')}`);
            }
            if (restored.restored) {
              set({
                workerRuns: restored.runs,
                orchestrations: projectWorkerRunsOntoOrchestrations(s.orchestrations, restored.runs),
              });
              s = get();
            }
          }
          assertProjectSaveGuard(s, guard);
          const file = buildProjectFile(s);
          const { saveProjectFile } = await import('../io/projectIO');
          assertProjectSaveGuard(get(), guard);
          // P0：已存盘则直接覆盖原路径，不再弹另存为
          const path = await persistProjectFile(file, s.projectPath ?? undefined, {
            saveProjectFile: async (nextFile, targetPath) => {
              const root = await saveProjectFile(nextFile, targetPath);
              assertProjectSaveGuard(get(), guard);
              return root;
            },
            getPendingProjectEventCount: (projectId) => {
              assertProjectSaveGuard(get(), guard);
              return isTauri ? getPendingProjectEvents(projectId).length : 0;
            },
            flushPendingProjectEvents: async (projectId, projectRoot) => {
              const { createTauriEventStoreAdapter } = await import('../domain/tauriEventStore');
              assertProjectSaveGuard(get(), guard);
              await flushPendingProjectEvents(
                projectId,
                new EventStreamRepository(createTauriEventStoreAdapter(projectRoot), projectRoot),
              );
              assertProjectSaveGuard(get(), guard);
            },
          });
          assertProjectSaveGuard(get(), guard);
          set({
            projectId: file.id,
            projectCreatedAt: file.createdAt,
            projectPath: path,
            // P1：落盘后清除项目级脏标记，并记录稳定快照基准
            projectDirty: false,
          });
          set({ lastSavedSnapshot: projectSnapshot(get()) });
          return path;
        });
      },

      isProjectDirty: () => {
        const s = get();
        if (!s.lastSavedSnapshot) return s.projectDirty; // 从未保存过：以标记为准
        // 与 projectDirtyController/稳定快照基线统一比较（排除时间戳/自增 id 噪声）
        return s.lastSavedSnapshot !== projectSnapshot(s);
      },

      /* ---- workflow registry actions (owner injected above) ---- */
      ...registryActions,

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
        const renamed = buildRenameWorkflowState({
          workflows: s.workflows,
          activeWfId: s.activeWfId,
          name,
        });
        if (renamed) {
          set({ workflows: { ...s.workflows, [s.activeWfId]: renamed } });
        }
      },

      removeWorkflow: (id) => {
        const s = get();
        const result = buildRemoveWorkflowState({
          workflows: s.workflows,
          activeWfId: s.activeWfId,
          id,
        });
        // 未指定工作区时保留原有 AppData 清理策略；用户工作区不动。
        if (result.cleanupWorkflowId !== null) {
          import('@tauri-apps/api/path')
            .then(async (p) => {
              const base = `${await p.appDataDir()}/slime-mold/${result.cleanupWorkflowId}`;
              const fs = await import('@tauri-apps/plugin-fs');
              await fs.remove(base, { recursive: true });
            })
            .catch(() => {});
        }
        if (result.activation) {
          set({ workflows: result.workflows, ...result.activation });
        } else {
          set({ workflows: result.workflows });
        }
      },

      ...projectLifecycleActions,

      saveProjectAs: () => projectSaveAsController.saveProjectAs(),

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
      /** H3：覆盖项目级编排记录集合（Orchestrator 确认/进度更新时调用） */
      setOrchestrations: (orchs: Orchestration[]) => {
        set({ orchestrations: orchs });
      },
      /** Phase 1b：覆盖项目级 Worker Run registry（队列状态可持久化/恢复） */
      setWorkerRuns: (runs: WorkerRunQueueState[]) => {
        set({ workerRuns: runs });
      },
      setWorkerRunRecoveries: (recoveries: WorkerRunRecovery[]) => {
        set({ workerRunRecoveries: recoveries });
      },
      setWorkerRunEvidence: (evidence: EvidenceRecord[]) => {
        set({ workerRunEvidence: evidence });
      },
      setWorkerRunSideEffects: (effects: SideEffectRecord[]) => {
        set({ workerRunSideEffects: effects });
      },
      setWorkerCleanupProposals: (proposals: WorkerCleanupProposal[]) => {
        set({ workerCleanupProposals: proposals });
      },
      setProjectControl: (snapshot: ProjectControlSnapshot) => {
        set({ projectControl: normalizeProjectControlSnapshot(snapshot) });
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
    };
    },
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
        orchestrations: s.orchestrations,
        projectControl: s.projectControl,
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
          projectControl: normalizeProjectControlSnapshot(p.projectControl),
        } as WorkflowState;
      },
    },
  ),
);

// ---------- P1：项目级脏检测（内存态 vs 磁盘态） ----------
// 加载/切换期间临时抑制自动脏检测，避免误标

const projectSaveQueue = createProjectSaveQueue();
const projectSaveAsController: ProjectSaveAsController = createProjectSaveAsController<WorkflowState>({
  isTauri,
  getState: (): WorkflowState => useWorkflowStore.getState(),
  showSaveDirDialog,
  buildProjectFile,
  saveProjectFile: async (file, targetPath) => {
    const { saveProjectFile } = await import('../io/projectIO');
    return saveProjectFile(file, targetPath);
  },
  getPendingProjectEventCount: (projectId) => getPendingProjectEvents(projectId).length,
  flushPendingProjectEvents: async (projectId, projectRoot) => {
    const { createTauriEventStoreAdapter } = await import('../domain/tauriEventStore');
    await flushPendingProjectEvents(
      projectId,
      new EventStreamRepository(createTauriEventStoreAdapter(projectRoot), projectRoot),
    );
  },
  onSaved: (projectRoot, activeWfId) => {
    useWorkflowStore.setState({ projectPath: projectRoot, projectDirty: false });
    useWorkflowStore.setState({ lastSavedSnapshot: projectSnapshot(useWorkflowStore.getState()) });
    saveLastSession({ path: projectRoot, activeId: activeWfId || undefined });
  },
  addLog: (level, message) => useWorkflowStore.getState().addLog(level, message),
});

/** 载入/打开项目后调用：以当前内存态作为"与磁盘一致"的基准，清除脏标记 */


const projectDirtyController: ProjectDirtyController = createProjectDirtyController<WorkflowState>(useWorkflowStore, {
  dirtyKeys: DIRTY_KEYS as readonly (keyof WorkflowState)[],
  snapshot: projectSnapshot,
});

// ---------- 智能体/配置类字段变更自动落盘 ----------
// 用户加/改/删 agent、角色、路由表、默认 agent 时，若有磁盘项目（projectPath），
// 防抖自动 saveProject，避免「改了 agent 忘保存 → 重启自动恢复时 agents.json 没有 → agent 消失」。
// 监听器、debounce 和 timer cleanup 已抽到 projectConfigAutosave.ts。
installProjectConfigAutosave(useWorkflowStore, {
  isSuppressed: () => projectDirtyController.isSuppressed(),
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
