import type { FlowEdge, FlowNode } from '../types/graph';
import type { NodeGroup, SubgraphDef } from '../types';
import { useRegistryStore } from './registryStore';
import { inferPorts, packSubgraph, SUBGRAPH_REF_TYPE } from '../engine/subgraph';
import { expandSubgraphInstance } from './workflowGraph';

export interface WorkflowSubgraphCommandState {
  nodes: FlowNode[];
  edges: FlowEdge[];
  subgraphs: Record<string, SubgraphDef>;
  groups: NodeGroup[];
  selectedNodeId: string | null;
}

export interface WorkflowSubgraphCommandDependencies {
  getState: () => WorkflowSubgraphCommandState;
  setState: (patch: Partial<WorkflowSubgraphCommandState>) => void;
  pushHistory: () => void;
  addLog: (level: 'info' | 'error', message: string) => void;
}

/** Owns subgraph definition and reference-node mutations for the workflow facade. */
export function createWorkflowSubgraphCommands(
  deps: WorkflowSubgraphCommandDependencies,
) {
  return {
    packSelectionAsSubgraph: (nodeIds: string[], name: string): string | null => {
      const state = deps.getState();
      deps.pushHistory();
      const idSet = new Set(nodeIds);
      const selected = state.nodes.filter((node) => idSet.has(node.id));
      if (selected.length === 0) {
        deps.addLog('error', '请先选中要打包的节点');
        return null;
      }
      if (selected.some((node) => node.data.typeId === SUBGRAPH_REF_TYPE)) {
        deps.addLog('error', '暂不支持把已有的子图节点再次打包，请先展开它');
        return null;
      }

      const defs = useRegistryStore.getState().defs;
      const subgraph = packSubgraph(name || '未命名子图', selected, state.edges, defs);
      const cx = selected.reduce((total, node) => total + node.position.x, 0) / selected.length;
      const cy = selected.reduce((total, node) => total + node.position.y, 0) / selected.length;
      const refId = crypto.randomUUID();
      const refNode: FlowNode = {
        id: refId,
        type: 'base',
        position: { x: cx, y: cy },
        data: {
          typeId: SUBGRAPH_REF_TYPE,
          label: subgraph.name,
          params: { subgraphId: subgraph.id },
          status: 'idle',
          dirty: true,
        },
      };

      const inputByInner = new Map(
        subgraph.inputs.map((port) => [`${port.innerNodeId}|${port.innerHandle}`, port.id]),
      );
      const outputByInner = new Map(
        subgraph.outputs.map((port) => [`${port.innerNodeId}|${port.innerHandle}`, port.id]),
      );
      const edges: FlowEdge[] = [];
      for (const edge of state.edges) {
        const sourceInside = idSet.has(edge.source);
        const targetInside = idSet.has(edge.target);
        if (sourceInside && targetInside) continue;
        if (!sourceInside && !targetInside) {
          edges.push(edge);
          continue;
        }
        if (targetInside) {
          const handle = inputByInner.get(`${edge.target}|${edge.targetHandle ?? ''}`);
          if (handle) edges.push({ ...edge, target: refId, targetHandle: handle });
        } else {
          const handle = outputByInner.get(`${edge.source}|${edge.sourceHandle ?? ''}`);
          if (handle) edges.push({ ...edge, source: refId, sourceHandle: handle });
        }
      }

      deps.setState({
        subgraphs: { ...state.subgraphs, [subgraph.id]: subgraph },
        nodes: [...state.nodes.filter((node) => !idSet.has(node.id)), refNode],
        edges,
        groups: state.groups
          .map((group) => ({ ...group, nodeIds: group.nodeIds.filter((id) => !idSet.has(id)) }))
          .filter((group) => group.nodeIds.length > 0),
        selectedNodeId: refId,
      });
      deps.addLog(
        'info',
        `已打包 ${selected.length} 个节点为子图「${subgraph.name}」（${subgraph.inputs.length} 入 / ${subgraph.outputs.length} 出）`,
      );
      return subgraph.id;
    },

    unpackSubgraphNode: (refNodeId: string): void => {
      const state = deps.getState();
      deps.pushHistory();
      const ref = state.nodes.find((node) => node.id === refNodeId);
      if (!ref || ref.data.typeId !== SUBGRAPH_REF_TYPE) return;
      const subgraph = state.subgraphs[String(ref.data.params?.subgraphId ?? '')];
      if (!subgraph) {
        deps.addLog('error', '这个子图的定义已丢失，无法展开');
        return;
      }
      const { nodes, edges } = expandSubgraphInstance(
        subgraph,
        ref.position,
        state.edges,
        refNodeId,
      );
      deps.setState({
        nodes: [...state.nodes.filter((node) => node.id !== refNodeId), ...nodes],
        edges,
        selectedNodeId: nodes[0]?.id ?? null,
      });
      deps.addLog('info', `已展开子图「${subgraph.name}」，还原为 ${nodes.length} 个节点`);
    },

    addSubgraphRefNode: (subgraphId: string, position: { x: number; y: number }): void => {
      const state = deps.getState();
      deps.pushHistory();
      const subgraph = state.subgraphs[subgraphId];
      if (!subgraph) return;
      const node: FlowNode = {
        id: crypto.randomUUID(),
        type: 'base',
        position,
        data: {
          typeId: SUBGRAPH_REF_TYPE,
          label: subgraph.name,
          params: { subgraphId },
          status: 'idle',
          dirty: true,
        },
      };
      deps.setState({ nodes: [...state.nodes, node], selectedNodeId: node.id });
    },

    saveSubgraphDef: (definition: SubgraphDef): void => {
      const state = deps.getState();
      const defs = useRegistryStore.getState().defs;
      const inferred = inferPorts(definition.nodes, definition.edges, defs);
      const seenInputs = new Set(definition.inputs.map((port) => `${port.innerNodeId}|${port.innerHandle}`));
      const seenOutputs = new Set(definition.outputs.map((port) => `${port.innerNodeId}|${port.innerHandle}`));
      const next: SubgraphDef = {
        ...definition,
        inputs: [
          ...definition.inputs,
          ...inferred.inputs.filter((port) => !seenInputs.has(`${port.innerNodeId}|${port.innerHandle}`)),
        ],
        outputs: [
          ...definition.outputs,
          ...inferred.outputs.filter((port) => !seenOutputs.has(`${port.innerNodeId}|${port.innerHandle}`)),
        ],
        updatedAt: new Date().toISOString(),
      };
      deps.setState({ subgraphs: { ...state.subgraphs, [definition.id]: next } });
    },

    removeSubgraph: (id: string): void => {
      const state = deps.getState();
      const rest = { ...state.subgraphs };
      delete rest[id];
      deps.setState({ subgraphs: rest });
    },

    renameSubgraph: (id: string, name: string): void => {
      const state = deps.getState();
      const subgraph = state.subgraphs[id];
      if (!subgraph) return;
      deps.setState({
        subgraphs: { ...state.subgraphs, [id]: { ...subgraph, name, updatedAt: new Date().toISOString() } },
        nodes: state.nodes.map((node) =>
          node.data.typeId === SUBGRAPH_REF_TYPE
          && node.data.params?.subgraphId === id
          && node.data.label === subgraph.name
            ? { ...node, data: { ...node.data, label: name } }
            : node,
        ),
      });
    },
  };
}
