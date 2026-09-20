import { describe, expect, it, vi } from 'vitest';
import type { FlowEdge, FlowNode, InterventionRequest, InterventionResult } from '../types';
import type { ExecutionRuntime } from './runtime';
import { createNodeContextAdapter } from './nodeContextAdapter';

function runtime(): ExecutionRuntime {
  return {
    setNodeStatus: vi.fn(),
    addLog: vi.fn(),
    setCostLog: vi.fn(),
    setRunProgress: vi.fn(),
    setRunning: vi.fn(),
    resetUsage: vi.fn(),
    addAsset: vi.fn(),
    setEdges: vi.fn((updater) => updater([])),
  } as unknown as ExecutionRuntime;
}

const node = (id: string, outputs: Record<string, unknown> = {}): FlowNode => ({
  id,
  type: 'base',
  position: { x: 0, y: 0 },
  data: { typeId: 'flow.loopGate', label: id, outputs },
} as unknown as FlowNode);

describe('node context adapter', () => {
  it('builds assets, forwards partial/branches, and writes edge scope', () => {
    const edges = [{ id: 'edge-1', source: 'node-1', sourceHandle: 'out', target: 'next', data: {} }] as unknown as FlowEdge[];
    const rt = runtime();
    const onGate = vi.fn();
    const setStatus = vi.fn();
    const adapter = createNodeContextAdapter({
      nodeId: 'node-1',
      ownerId: null,
      nodeTypeId: 'flow.loopGate',
      nodeLabel: 'Node 1',
      targetWfId: 'wf-1',
      targetRunId: 2,
      myRun: 2,
      incomingNodeIds: ['upstream'],
      edges,
      sandbox: undefined,
      runtime: rt,
      getState: () => ({
        activeWfId: 'wf-1',
        nodes: [node('node-1', { current: 'old' })],
        workflows: { 'wf-1': { nodes: [node('node-1', { current: 'old' })], assets: [{ id: 'wf-asset' }] as never } },
        projectAssets: [{ id: 'project-asset' }] as never,
      }),
      setStatus,
      onGate,
      getCurrentRunId: () => 2,
      scheduleRunCheckpoint: vi.fn(),
      requestIntervention: vi.fn(),
    });

    expect(adapter.assets.map((asset) => asset.id)).toEqual(['project-asset', 'wf-asset']);
    adapter.setPartial('current', 'new');
    expect(setStatus).toHaveBeenCalledWith('node-1', 'running', { outputs: { current: 'new' } });
    adapter.setBranches?.(['pass']);
    expect(onGate).toHaveBeenCalledWith('node-1', ['pass']);
    adapter.writeOutEdgeScope?.('out', ['task-a']);
    expect(edges[0]?.data?.scope).toEqual(['task-a']);
    expect(rt.setEdges).toHaveBeenCalled();
  });

  it('cancels stale intervention requests before invoking host callbacks', async () => {
    const requestIntervention = vi.fn<(
      request: InterventionRequest,
    ) => Promise<InterventionResult>>();
    const scheduleRunCheckpoint = vi.fn();
    const adapter = createNodeContextAdapter({
      nodeId: 'node-1',
      ownerId: 'owner-1',
      nodeTypeId: 'agent.test',
      nodeLabel: 'Node 1',
      targetWfId: 'wf-1',
      targetRunId: 2,
      myRun: 1,
      incomingNodeIds: [],
      edges: [],
      sandbox: undefined,
      runtime: runtime(),
      getState: () => ({ activeWfId: 'wf-1', nodes: [], workflows: {}, projectAssets: [] }),
      setStatus: vi.fn(),
      getCurrentRunId: () => 2,
      scheduleRunCheckpoint,
      requestIntervention,
    });

    await expect(adapter.intervene?.({ message: 'need input' })).resolves.toEqual({
      kind: 'cancelled',
      error: '运行已停止，介入请求被取消',
    });
    expect(requestIntervention).not.toHaveBeenCalled();
    expect(scheduleRunCheckpoint).not.toHaveBeenCalled();
  });
});
