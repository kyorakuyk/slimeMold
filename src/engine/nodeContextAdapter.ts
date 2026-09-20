import type {
  AssetMeta,
  ExecContext,
  FlowEdge,
  FlowNode,
  InterventionRequest,
  InterventionResult,
  NodeStatus,
  SandboxHandle,
  WorkflowNodeData,
} from '../types';
import type { ExecutionRuntime } from './runtime';

type ContextAdapterState = {
  activeWfId: string;
  nodes: FlowNode[];
  workflows: Record<string, { nodes?: FlowNode[]; assets?: AssetMeta[] }>;
  projectAssets: AssetMeta[];
};

type NodeStatusSetter = (
  id: string,
  status: NodeStatus,
  patch?: Partial<WorkflowNodeData>,
) => void;

export interface NodeContextAdapterOptions {
  nodeId: string;
  ownerId: string | null;
  nodeTypeId: string;
  nodeLabel: string;
  targetWfId: string;
  targetRunId: number;
  myRun: number;
  incomingNodeIds: readonly string[];
  edges: FlowEdge[];
  sandbox: SandboxHandle | undefined;
  runtime: ExecutionRuntime;
  getState: () => ContextAdapterState;
  setStatus: NodeStatusSetter;
  onGate?: (id: string, handles: string[]) => void;
  onBranches?: (handles: string[]) => void;
  getCurrentRunId: (wfId: string) => number;
  scheduleRunCheckpoint: (wfId: string, runId: number, startedWall: number) => void;
  requestIntervention: (request: InterventionRequest & {
    wfId: string;
    runId: number;
    nodeId: string;
    label: string;
    typeId: string;
  }) => Promise<InterventionResult>;
}

export type NodeContextAdapter = Pick<
  ExecContext,
  | 'setPartial'
  | 'setBranches'
  | 'assets'
  | 'addAsset'
  | 'sandboxLanes'
  | 'writeOutEdgeScope'
  | 'intervene'
>;

export function createNodeContextAdapter(options: NodeContextAdapterOptions): NodeContextAdapter {
  const state = options.getState();
  const workflowAssets = options.targetWfId === state.activeWfId
    ? state.workflows[state.activeWfId]?.assets ?? []
    : state.workflows[options.targetWfId]?.assets ?? [];
  const assetsById = new Map<string, AssetMeta>();
  for (const asset of state.projectAssets) assetsById.set(asset.id, asset);
  for (const asset of workflowAssets) assetsById.set(asset.id, asset);

  return {
    setPartial: (key, value) => {
      const target = options.ownerId ?? options.nodeId;
      const current = options.getState();
      const targetNodes = options.targetWfId === current.activeWfId
        ? current.nodes
        : (current.workflows[options.targetWfId]?.nodes ?? []);
      const currentOutputs = targetNodes.find((node) => node.id === target)?.data.outputs ?? {};
      options.setStatus(options.nodeId, 'running', {
        outputs: { ...currentOutputs, [key]: value },
      });
    },
    setBranches: (handles) => {
      options.onBranches?.(handles);
      if (options.nodeTypeId === 'flow.loopGate') options.onGate?.(options.nodeId, handles);
    },
    assets: [...assetsById.values()],
    addAsset: (meta) => options.runtime.addAsset(meta),
    sandboxLanes: options.sandbox ? [...options.incomingNodeIds] : undefined,
    writeOutEdgeScope: (handle, scope) => {
      for (const edge of options.edges) {
        if (edge.source === options.nodeId && (edge.sourceHandle ?? null) === (handle ?? null)) {
          edge.data = { ...edge.data, kind: edge.data?.kind ?? 'task', scope };
        }
      }
      options.runtime.setEdges((edges) =>
        edges.map((edge) =>
          edge.source === options.nodeId && (edge.sourceHandle ?? null) === (handle ?? null)
            ? { ...edge, data: { ...edge.data, kind: edge.data?.kind ?? 'task', scope } }
            : edge,
        ),
      );
    },
    intervene: async (request) => {
      if (options.myRun !== options.getCurrentRunId(options.targetWfId)) {
        return { kind: 'cancelled', error: '运行已停止，介入请求被取消' };
      }
      options.scheduleRunCheckpoint(options.targetWfId, options.targetRunId, Date.now());
      return options.requestIntervention({
        wfId: options.targetWfId,
        runId: options.targetRunId,
        nodeId: options.ownerId ?? options.nodeId,
        label: options.nodeLabel,
        typeId: options.nodeTypeId,
        ...request,
      });
    },
  };
}
