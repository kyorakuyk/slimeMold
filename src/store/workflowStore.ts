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
  RoleTemplate,
  RunRecord,
  WorkflowNodeData,
} from '../types';
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
  running: boolean;
  failFast: boolean;
  /** LLM 并发上限：同一时刻最多进行的智能体请求数 */
  maxConcurrency: number;
  logs: LogEntry[];
  /** 全局变量（可在 {{}} 模板与表达式中引用），随工作流保存 */
  variables: Record<string, unknown>;
  /** 历史运行记录（持久化） */
  runHistory: RunRecord[];

  onNodesChange: (changes: NodeChange<FlowNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<FlowEdge>[]) => void;
  onConnect: (conn: Connection) => void;

  addNode: (typeId: string, position: { x: number; y: number }) => void;
  removeNode: (id: string) => void;
  deleteSelected: () => void;
  clearGraph: () => void;
  updateNodeParams: (id: string, patch: Record<string, unknown>) => void;
  setNodeLabel: (id: string, label: string) => void;
  setNodeStatus: (
    id: string,
    status: NodeStatus,
    patch?: Partial<WorkflowNodeData>,
  ) => void;
  resetStatuses: () => void;

  upsertAgent: (agent: AgentConfig) => void;
  removeAgent: (id: string) => void;

  upsertRole: (role: RoleTemplate) => void;
  removeRole: (id: string) => void;

  setSelected: (id: string | null) => void;
  setRunning: (running: boolean) => void;
  setFailFast: (v: boolean) => void;
  setMaxConcurrency: (v: number) => void;
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
}

function defaultParams(typeId: string): Record<string, unknown> {
  const def = getNodeDef(typeId);
  const params: Record<string, unknown> = {};
  for (const p of def?.params ?? []) {
    if (p.default !== undefined) params[p.key] = p.default;
  }
  return params;
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
      running: false,
      failFast: true,
      maxConcurrency: 3,
      logs: [],
      variables: {},
      runHistory: [],

      onNodesChange: (changes) =>
        set({ nodes: applyNodeChanges(changes, get().nodes) }),
      onEdgesChange: (changes) =>
        set({ edges: applyEdgeChanges(changes, get().edges) }),

      onConnect: (conn) => {
        if (!conn.source || !conn.target) return;
        if (wouldCreateCycle(conn.source, conn.target, get().edges)) {
          get().addLog('error', '已拦截连线：该连接会形成环路（工作流必须是 DAG）');
          return;
        }
        set({
          edges: addEdge({ ...conn }, get().edges),
        });
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

      removeNode: (id) =>
        set({
          nodes: get().nodes.filter((n) => n.id !== id),
          edges: get().edges.filter((e) => e.source !== id && e.target !== id),
          selectedNodeId:
            get().selectedNodeId === id ? null : get().selectedNodeId,
        }),

      deleteSelected: () => {
        const id = get().selectedNodeId;
        if (!id) return;
        get().removeNode(id);
      },

      clearGraph: () =>
        set({ nodes: [], edges: [], selectedNodeId: null, logs: [] }),

      updateNodeParams: (id, patch) =>
        set({
          nodes: get().nodes.map((n) =>
            n.id === id
              ? { ...n, data: { ...n.data, params: { ...n.data.params, ...patch } } }
              : n,
          ),
        }),

      setNodeLabel: (id, label) =>
        set({
          nodes: get().nodes.map((n) =>
            n.id === id ? { ...n, data: { ...n.data, label } } : n,
          ),
        }),

      setNodeStatus: (id, status, patch) =>
        set({
          nodes: get().nodes.map((n) =>
            n.id === id
              ? { ...n, data: { ...n.data, ...patch, status } }
              : n,
          ),
        }),

      resetStatuses: () =>
        set({
          nodes: get().nodes.map((n) => ({
            ...n,
            data: { ...n.data, status: 'idle' as NodeStatus, error: undefined, outputs: undefined },
          })),
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

      setSelected: (id) => set({ selectedNodeId: id }),
      setRunning: (running) => set({ running }),
      setFailFast: (v) => set({ failFast: v }),
      setMaxConcurrency: (v) => set({ maxConcurrency: Math.max(1, Math.min(20, Math.floor(v) || 1)) }),

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
          nodes,
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
        }),
    }),
    {
      name: 'slime-mold-workflow',
      partialize: (s) => ({
        workflowName: s.workflowName,
        nodes: s.nodes,
        edges: s.edges,
        agents: s.agents,
        roles: s.roles,
        failFast: s.failFast,
        maxConcurrency: s.maxConcurrency,
        variables: s.variables,
        runHistory: s.runHistory,
      }),
    },
  ),
);
