import type { FlowEdge, FlowNode } from '../types/graph';
import type { NodeDefinition } from '../types/node';
import type { NodeGroup, SubgraphDef, WorkflowFileEdge, WorkflowFileNode } from '../types/workflow';
import { recomputeProxyPorts, GROUP_COLORS } from './groupProxy';

export interface WorkflowGroupCommandState {
  nodes: FlowNode[];
  edges: FlowEdge[];
  groups: NodeGroup[];
  subgraphs: Record<string, SubgraphDef>;
}

export type WorkflowGroupStatePatch =
  | Partial<WorkflowGroupCommandState>
  | ((state: WorkflowGroupCommandState) => Partial<WorkflowGroupCommandState>);

export interface WorkflowGroupCommandDependencies {
  getState: () => WorkflowGroupCommandState;
  setState: (patch: WorkflowGroupStatePatch) => void;
  pushHistory: () => void;
  addLog: (level: 'info' | 'error', message: string) => void;
  getFocusedSubgraphId: () => string | null;
  clearFocusedSubgraph: () => void;
  getNodeDefinitions: () => Record<string, NodeDefinition>;
}

/** Owns node-group and proxy-port mutations for the workflow facade. */
export function createWorkflowGroupCommands(deps: WorkflowGroupCommandDependencies) {
  return {
    createGroup: (nodeIds: string[], title?: string): string | null => {
      const state = deps.getState();
      deps.pushHistory();
      const valid = nodeIds.filter((id) => state.nodes.some((node) => node.id === id));
      if (valid.length === 0) {
        deps.addLog('error', '请先选中要编组的节点');
        return null;
      }
      const cleaned = state.groups
        .map((group) => ({ ...group, nodeIds: group.nodeIds.filter((id) => !valid.includes(id)) }))
        .filter((group) => group.nodeIds.length > 0);
      const groupId = `grp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const color = GROUP_COLORS[cleaned.length % GROUP_COLORS.length];
      const subgraphId = `sg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const members = state.nodes.filter((node) => valid.includes(node.id));
      const subgraphNodes: WorkflowFileNode[] = members.map((node) => ({
        id: node.id,
        typeId: node.data.typeId,
        label: node.data.label,
        position: { ...node.position },
        params: { ...node.data.params },
      }));
      const idSet = new Set(valid);
      const subgraphEdges: WorkflowFileEdge[] = state.edges
        .filter((edge) => idSet.has(edge.source) && idSet.has(edge.target))
        .map((edge) => ({
          id: edge.id,
          source: edge.source,
          sourceHandle: edge.sourceHandle ?? null,
          target: edge.target,
          targetHandle: edge.targetHandle ?? null,
          kind: edge.data?.kind ?? 'data',
          scope: edge.data?.scope,
        }));
      const now = new Date().toISOString();
      const subgraph: SubgraphDef = {
        id: subgraphId,
        name: title || `分组 ${cleaned.length + 1}`,
        category: '分组',
        createdAt: now,
        updatedAt: now,
        nodes: subgraphNodes,
        edges: subgraphEdges,
        inputs: [],
        outputs: [],
      };

      const memberNodes = state.nodes.filter((node) => valid.includes(node.id));
      let bounds: { x: number; y: number; width: number; height: number } | undefined;
      if (memberNodes.length) {
        const xs = memberNodes.map((node) => node.position.x);
        const ys = memberNodes.map((node) => node.position.y);
        const minX = Math.min(...xs);
        const minY = Math.min(...ys);
        const maxX = Math.max(...xs);
        const maxY = Math.max(...ys);
        bounds = {
          x: minX,
          y: minY,
          width: Math.max(160, maxX - minX + 220),
          height: Math.max(60, maxY - minY + 120),
        };
      }
      const group: NodeGroup = {
        id: groupId,
        title: title || `分组 ${cleaned.length + 1}`,
        nodeIds: valid,
        color,
        collapsed: false,
        bounds,
        subgraphId,
      };
      const withProxy = recomputeProxyPorts({ ...group }, subgraph, state.nodes, state.edges, deps.getNodeDefinitions());
      deps.setState({
        subgraphs: { ...state.subgraphs, [subgraphId]: subgraph },
        groups: [...cleaned, withProxy],
      });
      deps.addLog('info', `已把 ${valid.length} 个节点编为「${group.title}」（子图：${subgraph.name}）`);
      return group.id;
    },

    removeGroup: (groupId: string): void => {
      deps.pushHistory();
      deps.setState((state) => {
        const group = state.groups.find((item) => item.id === groupId);
        const groups = state.groups.filter((item) => item.id !== groupId);
        const subgraphs = { ...state.subgraphs };
        if (group?.subgraphId && subgraphs[group.subgraphId]) delete subgraphs[group.subgraphId];
        if (group?.subgraphId && deps.getFocusedSubgraphId() === group.subgraphId) {
          deps.clearFocusedSubgraph();
        }
        return { groups, subgraphs };
      });
    },

    updateGroup: (groupId: string, patch: Partial<Omit<NodeGroup, 'id'>>): void => {
      deps.setState({
        groups: deps.getState().groups.map((group) => (
          group.id === groupId ? { ...group, ...patch } : group
        )),
      });
    },

    toggleGroupCollapsed: (groupId: string): void => {
      deps.setState((state) => ({
        groups: state.groups.map((group) => {
          if (group.id !== groupId) return group;
          const next = { ...group, collapsed: !group.collapsed };
          const subgraph = state.subgraphs[group.subgraphId ?? ''];
          let output = subgraph
            ? recomputeProxyPorts(next, subgraph, state.nodes, state.edges, deps.getNodeDefinitions())
            : next;
          if (output.collapsed && !output.bounds) {
            const members = state.nodes.filter((node) => output.nodeIds.includes(node.id));
            if (members.length) {
              const xs = members.map((node) => node.position.x);
              const ys = members.map((node) => node.position.y);
              const minX = Math.min(...xs);
              const minY = Math.min(...ys);
              const maxX = Math.max(...xs);
              const maxY = Math.max(...ys);
              output = {
                ...output,
                bounds: {
                  x: minX,
                  y: minY,
                  width: Math.max(160, maxX - minX + 220),
                  height: Math.max(60, maxY - minY + 120),
                },
              };
            }
          }
          return output;
        }),
      }));
    },

    recomputeGroupProxy: (groupId: string): void => {
      deps.setState((state) => {
        const group = state.groups.find((item) => item.id === groupId);
        if (!group?.subgraphId) return {};
        const subgraph = state.subgraphs[group.subgraphId];
        if (!subgraph) return {};
        return {
          groups: state.groups.map((item) => (
            item.id === groupId
              ? recomputeProxyPorts(item, subgraph, state.nodes, state.edges, deps.getNodeDefinitions())
              : item
          )),
        };
      });
    },

    syncGroupProxies: (subgraphId: string): void => {
      deps.setState((state) => {
        const subgraph = state.subgraphs[subgraphId];
        if (!subgraph) return {};
        return {
          groups: state.groups.map((group) => (
            group.subgraphId === subgraphId
              ? recomputeProxyPorts(group, subgraph, state.nodes, state.edges, deps.getNodeDefinitions())
              : group
          )),
        };
      });
    },

    moveGroup: (groupId: string, dx: number, dy: number): void => {
      const state = deps.getState();
      const group = state.groups.find((item) => item.id === groupId);
      if (!group) return;
      const memberIds = new Set(group.nodeIds);
      deps.setState({
        nodes: state.nodes.map((node) => (
          memberIds.has(node.id)
            ? { ...node, position: { x: node.position.x + dx, y: node.position.y + dy } }
            : node
        )),
      });
    },
  };
}
