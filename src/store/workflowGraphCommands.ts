/**
 * workflowGraphCommands.ts — store-bound graph history/clipboard commands.
 *
 * The module owns command orchestration but not Zustand, React Flow or persistence.
 * Pure graph transforms remain in workflowGraph.ts; the facade supplies state ports.
 */
import type { FlowEdge, FlowNode } from '../types';
import type { LogEntry } from '../types/execution';
import {
  remapPasted,
  sanitizeForClipboard,
  snapshotPush,
  snapshotRedo,
  snapshotUndo,
  type GraphSnapshot,
} from './workflowGraph';

export interface GraphCommandState {
  nodes: FlowNode[];
  edges: FlowEdge[];
  past: GraphSnapshot[];
  future: GraphSnapshot[];
  maxHistory: number;
  clipboard: GraphSnapshot | null;
  selectedNodeId: string | null;
}

export interface GraphCommandDeps {
  getState: () => GraphCommandState;
  setState: (patch: Partial<GraphCommandState>) => void;
  addLog: (level: LogEntry['level'], message: string) => void;
}

export interface WorkflowGraphCommands {
  pushHistory: () => void;
  undo: () => void;
  redo: () => void;
  clearHistory: () => void;
  copySelection: () => void;
  pasteClipboard: () => void;
  duplicateSelection: () => void;
}

/**
 * Creates the graph command facade used by workflowStore.
 * The public action names remain on the Zustand facade; this module receives only narrow ports.
 */
export function createWorkflowGraphCommands(deps: GraphCommandDeps): WorkflowGraphCommands {
  const pushHistory = (): void => {
    const { nodes, edges, past, maxHistory } = deps.getState();
    const next = snapshotPush(past, nodes, edges, maxHistory, sanitizeForClipboard);
    deps.setState(next);
  };

  const undo = (): void => {
    const { past, future, nodes, edges } = deps.getState();
    const result = snapshotUndo(past, future, nodes, edges, sanitizeForClipboard);
    if (!result) return;
    deps.setState(result);
  };

  const redo = (): void => {
    const { past, future, nodes, edges } = deps.getState();
    const result = snapshotRedo(past, future, nodes, edges, sanitizeForClipboard);
    if (!result) return;
    deps.setState(result);
  };

  const clearHistory = (): void => deps.setState({ past: [], future: [] });

  const copySelection = (): void => {
    const { nodes, edges } = deps.getState();
    const selectedIds = new Set(nodes.filter((node) => node.selected).map((node) => node.id));
    if (selectedIds.size === 0) return;
    const selectedNodes = sanitizeForClipboard(nodes.filter((node) => selectedIds.has(node.id)));
    const selectedEdges = edges.filter(
      (edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target),
    );
    deps.setState({ clipboard: { nodes: selectedNodes, edges: [...selectedEdges] } });
    deps.addLog('info', `已复制 ${selectedIds.size} 个节点到剪贴板`);
  };

  const pasteClipboard = (): void => {
    const clip = deps.getState().clipboard;
    if (!clip || clip.nodes.length === 0) return;
    pushHistory();
    const { nodes: newNodes, edges: newEdges, firstId } = remapPasted(clip, 40);
    const current = deps.getState();
    const deselected = current.nodes.map((node) =>
      node.selected ? { ...node, selected: false } : node,
    );
    deps.setState({
      nodes: [...deselected, ...newNodes],
      edges: [...current.edges, ...newEdges],
      selectedNodeId: firstId,
    });
  };

  const duplicateSelection = (): void => {
    copySelection();
    pasteClipboard();
  };

  return {
    pushHistory,
    undo,
    redo,
    clearHistory,
    copySelection,
    pasteClipboard,
    duplicateSelection,
  };
}
