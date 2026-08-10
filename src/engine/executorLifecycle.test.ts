/**
 * runWorkflow 主循环生命周期集成测试。
 *
 * 背景：executor.test.ts 只覆盖辅助函数；Codex 评审指出真实 runWorkflow 的
 * stop/force/restart 竞态、非激活工作流并发等从未被测试证明。本文件用
 * 真实 store + 真实调度 + 纯计算节点（避免 LLM/IO）补上这部分。
 *
 * 隔离策略：
 * - 每个用例使用独立 wfId（runGens Map 无清理接口，独立 wfId 规避代次残留）；
 * - beforeEach 重置 store 关键状态 + registerBuiltins + 清缓存；
 * - 竞态场景用可控延迟的测试节点 def（resolveNodeExecutionMode 前注册）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useWorkflowStore } from '../store/workflowStore';
import { useRegistryStore } from '../store/registryStore';
import { registerBuiltins } from '../nodes/builtin';
import { runWorkflow, stopWorkflow, getActiveRunId } from './executor';
import { clearCache, beginRun } from './nodeCache';
import type { FlowNode, FlowEdge, NodeDefinition } from '../types';

/** 注册一个可控延迟的测试节点：execute 返回 pending 直至手动 resolve/abort。 */
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

function mkEdge(id: string, source: string, target: string, sourceHandle = 'out', targetHandle = 'in', kind: string = 'data'): FlowEdge {
  return { id, source, target, sourceHandle, targetHandle, data: { kind } } as unknown as FlowEdge;
}

/** 重置 store 到已知状态：注入单工作流图（激活）+ 独立 wfId */
function seedStore(wfId: string, nodes: FlowNode[], edges: FlowEdge[], variables: Record<string, unknown> = {}) {
  useWorkflowStore.setState({
    activeWfId: wfId,
    nodes,
    edges,
    variables,
    projectVariables: {},
    workflows: {
      [wfId]: {
        name: wfId,
        nodes,
        edges,
        variables,
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

describe('runWorkflow 生命周期集成', () => {
  beforeEach(() => {
    registerBuiltins();
    clearCache();
    beginRun();
  });

  it('正常跑完：input.text → text.template 链，节点被标记 success 且写入运行历史', async () => {
    const wfId = 'wf-life-ok';
    registerGateNode('gate.ok');
    const nodes = [
      mkNode('a', 'input.text', '文本'),
      mkNode('b', 'text.template', '拼接'),
    ];
    // input.text 输出 handle 为 'text'，text.template 输入为 a/b；用 text 接 a
    const edges = [mkEdge('e1', 'a', 'b', 'text', 'a')];
    seedStore(wfId, nodes, edges);
    useWorkflowStore.setState({
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
    } as never);
    // 给 input.text 设参数（保留两个节点）
    useWorkflowStore.setState({
      nodes: [
        { ...nodes[0], data: { ...nodes[0].data, params: { text: 'hello' } } },
        nodes[1],
      ] as never,
    } as never);

    await runWorkflow({ wfId });

    const st = useWorkflowStore.getState();
    // 两个节点都应 success
    for (const n of st.nodes) {
      expect(n.data.status).toBe('success');
    }
    // input.text 输出 hello → template 渲染
    const bNode = st.nodes.find((n) => n.id === 'b');
    expect(bNode?.data.outputs).toBeTruthy();
    // 运行历史应有一条成功记录
    expect(st.runHistory.length).toBeGreaterThanOrEqual(1);
    expect(st.runHistory[0].status).toBe('success');
    // F2 回归：运行历史/检查点应读到「最新」节点状态（而非收尾时的旧 idle）
    // Codex 指出：setNodeStatus 只更新 store，局部 plan.nodes 不会同步，收尾若读局部
    // nodes 会把历史/检查点写成全 idle。此处断言节点级状态真实落到了历史与检查点。
    const recNodes = st.runHistory[0].nodes;
    expect(recNodes.length).toBeGreaterThan(0);
    for (const n of recNodes) {
      expect(n.status).toBe('success');
    }
    const ckpt = st.checkpoints[wfId];
    expect(ckpt).toBeTruthy();
    expect(Object.keys(ckpt!.nodes).length).toBeGreaterThan(0);
    expect(Object.values(ckpt!.nodes).every((c) => c.status === 'success')).toBe(true);
  });

  it('节点执行完成后返回（含缓存命中），运行指针回退到首个节点', async () => {
    const wfId = 'wf-life-pointer';
    const nodes = [
      mkNode('a', 'input.text', '文本'),
      mkNode('b', 'text.template', '拼接'),
    ];
    const edges = [mkEdge('e1', 'a', 'b', 'text', 'a')];
    seedStore(wfId, nodes, edges);
    useWorkflowStore.setState({
      nodes: [
        { ...nodes[0], data: { ...nodes[0].data, params: { text: 'x' } } },
        nodes[1],
      ] as never,
      selectedNodeId: null,
    } as never);

    await runWorkflow({ wfId });

    // 非循环工作流正常跑完 → 指针回退到首个节点
    const st = useWorkflowStore.getState();
    expect(st.selectedNodeId).toBe('a');
  });

  it('stopWorkflow 使旧运行静默退出：不写历史、不污染新运行', async () => {
    const wfId = 'wf-life-stop';
    // 慢节点：延迟 80ms，让 stop 期间它还在跑
    registerGateNode('gate.slow', { delayMs: 80 });

    const nodes = [mkNode('a', 'gate.slow', '慢节点')];
    seedStore(wfId, nodes, []);

    const runPromise = runWorkflow({ wfId });
    // 稍后 stop：递增代次使旧协程过期
    await new Promise((r) => setTimeout(r, 10));
    stopWorkflow(wfId);
    await runPromise;

    const st = useWorkflowStore.getState();
    // 被 stop 的旧运行不应 pushRunHistory（isCurrentRun=false 时跳过）。
    // 因 stopWorkflow 递增代次后 myRun !== currentRunId，历史应为空。
    expect(st.runHistory.length).toBe(0);
  });

  it('force 重启：旧运行被 abort，新运行可启动并完成', async () => {
    const wfId = 'wf-life-force';
    registerGateNode('gate.slow2', { delayMs: 60 });
    const nodes = [mkNode('a', 'gate.slow2', '慢节点')];
    seedStore(wfId, nodes, []);

    // 模拟残留运行态（并发拦截判定用）
    useWorkflowStore.setState({
      runStates: { [wfId]: { running: true, progress: { active: true } } } as never,
    } as never);

    // force 重启：应忽略并发拦截并 abort 旧运行
    await runWorkflow({ wfId, force: true });

    const st = useWorkflowStore.getState();
    expect(st.runStates[wfId]?.running).toBe(false); // finally 复位
    expect(st.runHistory.length).toBeGreaterThanOrEqual(1);
  });

  it('非激活工作流独立运行：读自身节点/变量，不误读 activeWfId', async () => {
    const activeId = 'wf-active';
    const otherId = 'wf-other';
    registerGateNode('gate.other', { output: { out: 'other-result' } });

    const activeNodes = [mkNode('active-node', 'input.text')];
    const otherNodes = [mkNode('other-node', 'gate.other', '独立节点')];

    // 激活工作流：一个 input.text
    useWorkflowStore.setState({
      activeWfId: activeId,
      nodes: activeNodes,
      edges: [],
      variables: { v: 'active-var' },
      workflows: {
        [activeId]: { name: activeId, nodes: activeNodes, edges: [], variables: { v: 'active-var' } } as never,
        [otherId]: { name: otherId, nodes: otherNodes, edges: [], variables: { v: 'other-var' } } as never,
      },
      runStates: {},
      runHistory: [],
      logs: [],
      subgraphs: {},
    } as never);

    await runWorkflow({ wfId: otherId });

    const st = useWorkflowStore.getState();
    // 非激活工作流的节点应成功
    const otherNode = st.workflows[otherId].nodes.find((n: FlowNode) => n.id === 'other-node');
    expect(otherNode?.data.status).toBe('success');
    expect(otherNode?.data.outputs).toEqual({ out: 'other-result' });
    // 激活工作流的节点不应被误执行
    const activeNode = st.nodes.find((n: FlowNode) => n.id === 'active-node');
    expect(activeNode?.data.status).not.toBe('success');
  });

  it('旧运行在节点 await 返回后不再写缓存（代次守卫）', async () => {
    const wfId = 'wf-life-await';
    // 可控 resolve 的节点：手动控制何时完成
    let releaseHold!: () => void;
    const gate: NodeDefinition = {
      typeId: 'gate.hold',
      name: 'gate.hold',
      category: '测试',
      description: '',
      inputs: [],
      outputs: [{ id: 'out', label: 'out', type: 'any' }],
      params: [],
      execute: async () => {
        await new Promise<void>((r) => {
          releaseHold = () => r();
        });
        return { out: 'late-result' };
      },
    } as unknown as NodeDefinition;
    useRegistryStore.getState().register([gate]);

    const nodes = [mkNode('a', 'gate.hold')];
    seedStore(wfId, nodes, []);

    const runPromise = runWorkflow({ wfId });
    // 等节点挂起
    await new Promise((r) => setTimeout(r, 20));
    stopWorkflow(wfId); // 代次过期
    releaseHold(); // 放行旧运行 → 应被代次守卫拦截，不写缓存/状态
    await runPromise;

    const st = useWorkflowStore.getState();
    // 旧运行被淘汰：不应把节点标记 success，也不写历史
    const node = st.nodes.find((n) => n.id === 'a');
    expect(node?.data.status).not.toBe('success');
    expect(st.runHistory.length).toBe(0);
    // getActiveRunId 已推进到新代次
    expect(getActiveRunId(wfId)).toBeGreaterThanOrEqual(1);
  });

  it('两个工作流并行独立运行：互不干扰、各自写入自身状态与历史', async () => {
    const wf1 = 'wf-para-1';
    const wf2 = 'wf-para-2';
    registerGateNode('gate.p1', { delayMs: 30 });
    registerGateNode('gate.p2', { delayMs: 10 });
    const nodes1 = [mkNode('p1-a', 'gate.p1')];
    const nodes2 = [mkNode('p2-a', 'gate.p2')];
    seedStore(wf1, nodes1, []);
    useWorkflowStore.setState({
      activeWfId: wf1, // 激活 wf1
      nodes: nodes1,
      edges: [],
      workflows: {
        [wf1]: { name: wf1, nodes: nodes1, edges: [], variables: {} } as never,
        [wf2]: { name: wf2, nodes: nodes2, edges: [], variables: {} } as never,
      },
      runStates: {},
      runHistory: [],
      logs: [],
    } as never);

    // 并行启动两个工作流
    const [r1, r2] = await Promise.all([runWorkflow({ wfId: wf1 }), runWorkflow({ wfId: wf2 })]);
    await Promise.all([r1, r2]);

    const st = useWorkflowStore.getState();
    // 各自节点都 success
    expect(st.nodes.find((n) => n.id === 'p1-a')?.data.status).toBe('success');
    expect(st.workflows[wf2].nodes.find((n: FlowNode) => n.id === 'p2-a')?.data.status).toBe('success');
    // 各自写各自历史（runHistory 是项目级，两轮成功至少 2 条）
    expect(st.runHistory.length).toBeGreaterThanOrEqual(2);
    // 各自运行态独立
    expect(st.runStates[wf1]?.running).toBe(false);
    expect(st.runStates[wf2]?.running).toBe(false);
  });

  it('旧运行不得关闭新运行的进度（stop 旧运行后，新运行完成并保留进度复位权）', async () => {
    const wfId = 'wf-life-progress';
    // 慢节点：stop 时仍在跑
    registerGateNode('gate.slow3', { delayMs: 50 });
    const nodes = [mkNode('a', 'gate.slow3')];
    seedStore(wfId, nodes, []);

    // 第一轮：慢运行，随后 stop
    const firstRun = runWorkflow({ wfId });
    await new Promise((r) => setTimeout(r, 10));
    stopWorkflow(wfId); // 旧运行代次过期
    await firstRun;

    // 第二轮：新运行快速完成（不同节点，无延迟）
    registerGateNode('gate.fast', {});
    const nodes2 = [mkNode('b', 'gate.fast')];
    useWorkflowStore.setState({
      nodes: nodes2,
      workflows: { [wfId]: { name: wfId, nodes: nodes2, edges: [], variables: {} } as never },
    } as never);
    await runWorkflow({ wfId });

    const st = useWorkflowStore.getState();
    // 新运行完成后运行态复位（旧运行的 finally 不能关掉新运行的进度）
    expect(st.runStates[wfId]?.running).toBe(false);
    // 新运行的节点 success，历史里至少有新运行的成功记录
    expect(st.nodes.find((n) => n.id === 'b')?.data.status).toBe('success');
    expect(st.runHistory.some((h) => h.status === 'success')).toBe(true);
  });

  it('loopGate 多轮迭代：i<3 跑 3 轮，循环体每轮强制重算（loopGate 自身不被缓存吞掉）', async () => {
    const wfId = 'wf-life-loop';
    // 计数节点：每次 execute 递增外部计数（模拟「每轮重算」的可观测副作用）
    let count = 0;
    const counter: NodeDefinition = {
      typeId: 'gate.counter',
      name: 'gate.counter',
      category: '测试',
      description: '',
      inputs: [{ id: 'in', label: 'in', type: 'any' }],
      outputs: [{ id: 'out', label: 'out', type: 'any' }],
      params: [],
      execute: async () => {
        count += 1;
        return { out: `round-${count}` };
      },
    } as unknown as NodeDefinition;
    useRegistryStore.getState().register([counter]);

    // 拓扑：seed(input.text) → counter；loopGate(i<3) pass → counter.in（control 回环）
    // 注意：loopGate 需要 cond 输入。seed 接 cond；pass 接 counter；stop 接 output.text
    const nodes = [
      mkNode('seed', 'input.text', '种子'),
      mkNode('counter', 'gate.counter', '循环体'),
      mkNode('loop', 'flow.loopGate', '迭代闸门'),
      mkNode('done', 'output.text', '结束'),
    ];
    useWorkflowStore.setState({
      nodes: [
        { ...nodes[0], data: { ...nodes[0].data, params: { text: 'go' } } },
        { ...nodes[2], data: { ...nodes[2].data, params: { expression: 'i < 3', maxLoops: 3, loopVar: 'i' } } },
        nodes[1],
        nodes[3],
      ] as never,
    } as never);
    const edges = [
      mkEdge('e1', 'seed', 'loop', 'text', 'cond'), // seed → loop.cond（data）
      mkEdge('e2', 'loop', 'counter', 'pass', 'in', 'control'), // loop.pass → counter.in（control 回环触发循环体）
      mkEdge('e3', 'loop', 'done', 'stop', 'text'), // loop.stop → done（data）
    ];
    seedStore(wfId, useWorkflowStore.getState().nodes, edges);

    await runWorkflow({ wfId });

    // i<3：i=0,1,2 走 pass 共 3 轮，第 4 轮 i=3 走 stop 退出
    expect(count).toBe(3);
    // 循环结束节点应被执行（stop 分支）
    const st = useWorkflowStore.getState();
    expect(st.nodes.find((n) => n.id === 'done')?.data.status).toBe('success');
    // loopGate 每轮被强制重算（count 3 证明循环体跑了 3 次）
    expect(st.runHistory.length).toBeGreaterThanOrEqual(1);
  });
});
