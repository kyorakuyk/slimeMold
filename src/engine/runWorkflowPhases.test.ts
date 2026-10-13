import { describe, expect, it, vi } from 'vitest';
import type { FlowEdge, FlowNode } from '../types/graph';
import i18n from '../i18n';
import { prepareExecutionPlan, type WorkflowStoreState } from './runWorkflowPhases';

function node(id: string): FlowNode {
  return {
    id,
    type: 'base',
    position: { x: 0, y: 0 },
    data: {
      typeId: 'test.node',
      label: id.toUpperCase(),
      params: {},
      status: 'idle',
      dirty: false,
      bypass: false,
      mute: false,
    },
  } as unknown as FlowNode;
}

function edge(id: string, source: string, target: string): FlowEdge {
  return {
    id,
    source,
    target,
    sourceHandle: 'out',
    targetHandle: 'in',
    data: { kind: 'data' },
  } as unknown as FlowEdge;
}

describe('prepareExecutionPlan localized cycle diagnostics', () => {
  it('localizes the visible log but preserves the durable RunResult error', async () => {
    const originalLanguage = i18n.language;
    const addLog = vi.fn();
    const setNodeStatus = vi.fn();
    const wf = {
      activeWfId: 'wf-1',
      nodes: [node('a'), node('b')],
      edges: [edge('a-b', 'a', 'b'), edge('b-a', 'b', 'a')],
      workflows: {},
      subgraphs: {},
      addLog,
      setNodeStatus,
    } as unknown as WorkflowStoreState;

    try {
      await i18n.changeLanguage('en-US');
      const outcome = prepareExecutionPlan({
        wf,
        wfId: 'wf-1',
        opts: {},
        getCurrentRunId: () => 12,
      });

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.result).toEqual({
        status: 'aborted',
        runId: 12,
        error: '节点连成了死循环（A、B）',
      });
      expect(addLog).toHaveBeenCalledWith(
        'error',
        'Nodes form a cycle (A, B); remove one of the connections before running',
      );
    } finally {
      await i18n.changeLanguage(originalLanguage || 'zh-CN');
    }
  });
});
