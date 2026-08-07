/**
 * 阶段 D：实时接管 executor 集成测试。
 *
 * 验证 ctx.intervene 注入链路：节点调用 intervene 挂起 → node.intervene 事件发出 →
 * resolveIntervention 放行 → 节点以用户结果完成 → 运行成功。
 * 以及：stopWorkflow 后待接管请求被取消（挂起不泄漏）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useWorkflowStore } from '../store/workflowStore';
import { useRegistryStore } from '../store/registryStore';
import { registerBuiltins } from '../nodes/builtin';
import { runWorkflow, stopWorkflow } from './executor';
import { clearCache, beginRun } from './nodeCache';
import { getRunBus, resetRunBus, type RunEvent } from './runEvents';
import { resetInterventions, resolveIntervention, getPendingInterventions } from './intervention';
import type { FlowNode, FlowEdge, NodeDefinition, ExecContext } from '../types';

type GateExec = (
  inputs: Record<string, unknown>,
  params: Record<string, unknown>,
  ctx: ExecContext,
) => Promise<Record<string, unknown>>;

function mkNode(id: string, typeId: string, label?: string): FlowNode {
  return {
    id,
    type: 'base',
    position: { x: 0, y: 0 },
    data: { typeId, label: label ?? id, params: {}, status: 'idle', dirty: true, bypass: false, mute: false },
  } as unknown as FlowNode;
}

function seedStore(wfId: string, nodes: FlowNode[], edges: FlowEdge[] = []) {
  useWorkflowStore.setState({
    activeWfId: wfId,
    nodes,
    edges,
    variables: {},
    projectVariables: {},
    workflows: {
      [wfId]: { name: wfId, nodes, edges, variables: {}, agents: [], roles: [], groups: [], assets: [] } as never,
    },
    runStates: {},
    runHistory: [],
    logs: [],
    subgraphs: {},
    failFast: true,
    skipFailed: false,
    maxConcurrency: 3,
  } as never);
}

describe('实时接管 executor 集成', () => {
  let events: RunEvent[];

  beforeEach(() => {
    registerBuiltins();
    clearCache();
    beginRun();
    resetRunBus();
    resetInterventions();
    events = [];
    getRunBus().subscribe((e) => events.push(e));
  });

  it('节点请求接管 → 提交结果 → 节点以用户结果完成', async () => {
    const wfId = 'wf-intv-ok';
    const gate: NodeDefinition = {
      typeId: 'gate.intervene',
      name: 'gate.intervene',
      category: '测试',
      description: '',
      inputs: [],
      outputs: [{ id: 'out', label: 'out', type: 'any' }],
      params: [],
      execute: (async (_i: Record<string, unknown>, _p: Record<string, unknown>, ctx: ExecContext) => {
        const r = await ctx.intervene!({ message: '请提供结果' });
        return { out: r.kind === 'resolved' ? r.result : 'cancelled' };
      }) as GateExec,
    } as unknown as NodeDefinition;
    useRegistryStore.getState().register([gate]);

    seedStore(wfId, [mkNode('a', 'gate.intervene', '接管节点')]);

    const runPromise = runWorkflow({ wfId });
    // 等 node.intervene 事件发出
    await new Promise((r) => setTimeout(r, 20));
    const req = getPendingInterventions()[0];
    expect(req?.nodeId).toBe('a');
    expect(req?.message).toBe('请提供结果');

    // 用户提交结果（复合键：wfId/runId/nodeId）
    resolveIntervention(req!.wfId, req!.runId, 'a', 'user-answer');
    await runPromise;

    const st = useWorkflowStore.getState();
    expect(st.nodes.find((n) => n.id === 'a')?.data.status).toBe('success');
    expect(st.nodes.find((n) => n.id === 'a')?.data.outputs).toEqual({ out: 'user-answer' });
    // 运行成功完成
    expect(events.some((e) => e.kind === 'run.completed')).toBe(true);
  });

  it('stopWorkflow 取消待接管请求：节点以 cancelled 继续，运行不挂死', async () => {
    const wfId = 'wf-intv-stop';
    let saw: string | null = null;
    const gate: NodeDefinition = {
      typeId: 'gate.intervene2',
      name: 'gate.intervene2',
      category: '测试',
      description: '',
      inputs: [],
      outputs: [{ id: 'out', label: 'out', type: 'any' }],
      params: [],
      execute: (async (_i: Record<string, unknown>, _p: Record<string, unknown>, ctx: ExecContext) => {
        const r = await ctx.intervene!({ message: 'x' });
        saw = r.kind;
        return { out: r.kind };
      }) as GateExec,
    } as unknown as NodeDefinition;
    useRegistryStore.getState().register([gate]);

    seedStore(wfId, [mkNode('a', 'gate.intervene2')]);
    const runPromise = runWorkflow({ wfId });
    await new Promise((r) => setTimeout(r, 20));
    expect(getPendingInterventions().length).toBe(1);

    stopWorkflow(wfId);
    await runPromise;

    // 待接管请求已被取消，节点返回 cancelled（不挂死）
    expect(saw).toBe('cancelled');
    expect(getPendingInterventions().length).toBe(0);
    expect(events.some((e) => e.kind === 'run.aborted')).toBe(true);
  });
});
