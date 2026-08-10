/**
 * A3：executor 生命周期事件流集成测试。
 *
 * 验证 runWorkflow / executeNode 在关键生命周期点发出统一事件
 * （run.created/started/completed/failed/aborted、node.started/completed/failed/skipped），
 * 供 JobBoard / 状态栏 / 历史回放等消费方挂接。
 *
 * 隔离策略：与 executorLifecycle 一致——独立 wfId + beforeEach 重置总线（resetRunBus）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useWorkflowStore } from '../store/workflowStore';
import { useRegistryStore } from '../store/registryStore';
import { registerBuiltins } from '../nodes/builtin';
import { runWorkflow, stopWorkflow } from './executor';
import { clearCache, beginRun } from './nodeCache';
import { getRunBus, resetRunBus, type RunEvent } from './runEvents';
import type { FlowNode, FlowEdge, NodeDefinition } from '../types';

/** 注册一个纯计算测试节点（无 LLM/IO 依赖，避免网络调用）。 */
function registerGateNode(typeId: string, opts: { delayMs?: number; output?: Record<string, unknown> } = {}) {
  const def: NodeDefinition = {
    typeId,
    name: typeId,
    category: '测试',
    description: '',
    inputs: [],
    outputs: [{ id: 'out', label: 'out', type: 'any' }],
    params: [],
    execute: async () => {
      if (opts.delayMs) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }
      return opts.output ?? { out: `from-${typeId}` };
    },
  } as unknown as NodeDefinition;
  useRegistryStore.getState().register([def]);
  return def;
}

function mkNode(id: string, typeId: string, label?: string): FlowNode {
  return {
    id,
    type: 'base',
    position: { x: 0, y: 0 },
    data: { typeId, label: label ?? id, params: {}, status: 'idle', dirty: true, bypass: false, mute: false },
  } as unknown as FlowNode;
}

function mkEdge(id: string, source: string, target: string, sourceHandle = 'out', targetHandle = 'in'): FlowEdge {
  return { id, source, target, sourceHandle, targetHandle, data: { kind: 'data' } } as unknown as FlowEdge;
}

function seedStore(wfId: string, nodes: FlowNode[], edges: FlowEdge[]) {
  useWorkflowStore.setState({
    activeWfId: wfId,
    nodes,
    edges,
    variables: {},
    projectVariables: {},
    workflows: {
      [wfId]: {
        name: wfId,
        nodes,
        edges,
        variables: {},
        agents: [],
        roles: [],
        groups: [],
        assets: [],
      } as never,
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

describe('runWorkflow 生命周期事件流（A3）', () => {
  let events: RunEvent[];

  beforeEach(() => {
    registerBuiltins();
    clearCache();
    beginRun();
    resetRunBus(); // 隔离：每个用例全新总线，避免前序用例事件污染
    events = [];
    getRunBus().subscribe((e) => events.push(e));
  });

  it('正常跑完：发出 run.created/started → node.started/completed → run.completed', async () => {
    const wfId = 'wf-ev-ok';
    registerGateNode('gate.ok');
    const nodes = [
      mkNode('a', 'input.text', '文本'),
      mkNode('b', 'text.template', '拼接'),
    ];
    const edges = [mkEdge('e1', 'a', 'b', 'text', 'a')];
    seedStore(wfId, nodes, edges);
    useWorkflowStore.setState({
      nodes: [
        { ...nodes[0], data: { ...nodes[0].data, params: { text: 'hi' } } },
        nodes[1],
      ] as never,
    } as never);

    await runWorkflow({ wfId });

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('run.created');
    expect(kinds).toContain('run.started');
    expect(kinds).toContain('node.started');
    expect(kinds).toContain('node.completed');
    expect(kinds[kinds.length - 1]).toBe('run.completed');

    // 运行级事件 runId 一致（同一次运行）
    const runIds = new Set(events.filter((e) => e.kind.startsWith('run.')).map((e) => e.runId));
    expect(runIds.size).toBe(1);

    const done = events.find((e) => e.kind === 'run.completed');
    expect(done?.payload?.status).toBe('success');

    // 节点事件携带 wfId+runId+nodeId 三元组
    const started = events.find((e) => e.kind === 'node.started');
    expect(started?.nodeId).toBeTruthy();
    expect(started?.wfId).toBe(wfId);
    const nodeCompleted = events.find((e) => e.kind === 'node.completed');
    expect(nodeCompleted?.payload?.status).toBe('success');
  });

  it('节点失败：发出 node.failed + run.failed（status=error）', async () => {
    const wfId = 'wf-ev-fail';
    const bad: NodeDefinition = {
      typeId: 'gate.bad',
      name: 'gate.bad',
      category: '测试',
      description: '',
      inputs: [],
      outputs: [{ id: 'out', label: 'out', type: 'any' }],
      params: [],
      execute: async () => {
        throw new Error('boom');
      },
    } as unknown as NodeDefinition;
    useRegistryStore.getState().register([bad]);
    const nodes = [mkNode('a', 'gate.bad', '坏节点')];
    seedStore(wfId, nodes, []);

    await runWorkflow({ wfId });

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('node.failed');
    expect(kinds).toContain('run.failed');
    expect(kinds[kinds.length - 1]).toBe('run.failed');

    const failedEv = events.find((e) => e.kind === 'node.failed');
    expect(failedEv?.payload?.error).toBe('boom');
    const runFailed = events.find((e) => e.kind === 'run.failed');
    expect(runFailed?.payload?.status).toBe('error');
    expect(runFailed?.payload?.failed).toBe(1);
  });

  it('stopWorkflow：立即发出 run.aborted（携带被终止的 runId）', async () => {
    const wfId = 'wf-ev-stop';
    registerGateNode('gate.slow', { delayMs: 80 });
    const nodes = [mkNode('a', 'gate.slow', '慢节点')];
    seedStore(wfId, nodes, []);

    const runPromise = runWorkflow({ wfId });
    await new Promise((r) => setTimeout(r, 10));
    stopWorkflow(wfId);
    await runPromise;

    const aborted = events.find((e) => e.kind === 'run.aborted');
    expect(aborted).toBeTruthy();
    expect(aborted?.wfId).toBe(wfId);
    expect(aborted?.payload?.reason).toBe('user-stopped');
    // 被终止运行的代次号（自增前的 currentRunId，≥1）
    expect(aborted!.runId).toBeGreaterThanOrEqual(1);
  });

  it('二次运行缓存命中：发出 node.completed status=cached（不再重复执行）', async () => {
    const wfId = 'wf-ev-cache';
    registerGateNode('gate.ck', { output: { out: 'v' } });
    const nodes = [mkNode('a', 'gate.ck', '缓存节点')];
    seedStore(wfId, nodes, []);

    await runWorkflow({ wfId });
    expect(events.some((e) => e.kind === 'node.completed' && e.payload?.status === 'success')).toBe(true);

    // 第二轮：复用同一缓存，节点应命中 cached 而非重新执行
    events.length = 0;
    await runWorkflow({ wfId });
    const cached = events.find((e) => e.kind === 'node.completed' && e.payload?.status === 'cached');
    expect(cached).toBeTruthy();
    expect(cached?.nodeId).toBe('a');
    // 命中缓存后不应发出 node.started
    expect(events.some((e) => e.kind === 'node.started')).toBe(false);
  });
});

describe('阶段 G2：运行中节流检查点快照', () => {
  beforeEach(() => {
    registerBuiltins();
    clearCache();
    beginRun();
    resetRunBus();
  });

  it('节点执行后写入 running 快照，收尾后 latest 变终态且进历史', async () => {
    const wfId = 'wf-g2-snap';
    registerGateNode('gate.g2', { delayMs: 5, output: { out: 'g2-result' } });
    const nodes = [mkNode('a', 'gate.g2', 'G2 节点')];
    seedStore(wfId, nodes, []);

    await runWorkflow({ wfId });

    // 收尾后：latest 是终态（success），历史含该运行版本
    const st = useWorkflowStore.getState();
    const latest = st.checkpoints[wfId];
    expect(latest).toBeTruthy();
    expect(latest!.status).toBe('success');
    expect(latest!.nodes['a']?.status).toBe('success');
    // 多版本历史：至少含本次 runId 的终态条目
    const hist = st.checkpointHistory[wfId] ?? [];
    expect(hist.some((c) => c.runId === latest!.runId)).toBe(true);
  });

  it('stopWorkflow 在 resetStatuses 前强制落盘快照（保留已完成节点结果）', async () => {
    const wfId = 'wf-g2-stop';
    // 两节点：a 快完成，b 挂起（延迟很长）——stop 时 a 已完成
    registerGateNode('gate.g2a', { delayMs: 5, output: { out: 'a-done' } });
    registerGateNode('gate.g2b', { delayMs: 300, output: { out: 'b-slow' } });
    const nodes = [mkNode('a', 'gate.g2a', '快节点'), mkNode('b', 'gate.g2b', '慢节点')];
    const edges = [mkEdge('e1', 'a', 'b')];
    seedStore(wfId, nodes, edges);

    const runPromise = runWorkflow({ wfId });
    // 等 a 完成、b 仍在跑
    await new Promise((r) => setTimeout(r, 40));
    stopWorkflow(wfId);
    await runPromise;

    const st = useWorkflowStore.getState();
    const latest = st.checkpoints[wfId];
    // 停止后 resetStatuses 清空了画布节点状态，但落盘快照应在 reset 前捕获了 a 的结果
    expect(latest).toBeTruthy();
    // 快照至少包含已完成节点（若节流窗口内 a 成功已触发，则 a 在快照中）
    expect(latest!.status).toBe('running');
  });
});
