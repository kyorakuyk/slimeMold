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
  WorkflowNodeData,
} from '../types';
import { wouldCreateCycle } from '../engine/topoSort';
import { getNodeDef } from './registryStore';
import { createAgent } from '../agents/agentManager';

interface WorkflowState {
  workflowName: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  agents: AgentConfig[];
  selectedNodeId: string | null;
  running: boolean;
  failFast: boolean;
  logs: LogEntry[];

  onNodesChange: (changes: NodeChange<FlowNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<FlowEdge>[]) => void;
  onConnect: (conn: Connection) => void;

  addNode: (typeId: string, position: { x: number; y: number }) => void;
  removeNode: (id: string) => void;
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

  setSelected: (id: string | null) => void;
  setRunning: (running: boolean) => void;
  setFailFast: (v: boolean) => void;
  addLog: (level: LogEntry['level'], message: string) => void;
  clearLogs: () => void;

  setWorkflowName: (name: string) => void;
  loadGraph: (
    name: string,
    nodes: FlowNode[],
    edges: FlowEdge[],
    agents: AgentConfig[],
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
      selectedNodeId: null,
      running: false,
      failFast: true,
      logs: [],

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

      setSelected: (id) => set({ selectedNodeId: id }),
      setRunning: (running) => set({ running }),
      setFailFast: (v) => set({ failFast: v }),

      addLog: (level, message) =>
        set({
          logs: [
            ...get().logs.slice(-199),
            { time: new Date().toLocaleTimeString(), level, message },
          ],
        }),
      clearLogs: () => set({ logs: [] }),

      setWorkflowName: (name) => set({ workflowName: name }),

      loadGraph: (name, nodes, edges, agents) =>
        set({
          workflowName: name,
          nodes,
          edges,
          agents: agents.length > 0 ? agents : get().agents,
          selectedNodeId: null,
          logs: [],
        }),

      newWorkflow: () =>
        set({
          workflowName: '未命名工作流',
          nodes: [],
          edges: [],
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
        failFast: s.failFast,
      }),
    },
  ),
);
