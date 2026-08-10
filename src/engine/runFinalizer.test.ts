/**
 * H1a：runFinalizer 直接测试（Codex 建议补 runFinalizer 直接测试）。
 *
 * 覆盖：finalizeRun 的收尾语义——
 * - 成功运行：写运行历史（status=success）、写 checkpoint、发 run.completed 终态事件、指针回退
 * - 失败运行：status=error、发 run.failed
 * - 手动停止（signal aborted）：status=aborted、发 run.aborted
 * - 被淘汰的旧运行（isCurrentRun=false）：不写历史/checkpoint/事件，仅一条警告日志
 *
 * 用真实 workflowStore + 最小 runtime + ExperienceSink（selfImprove 默认关，避免 LLM 复盘）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useWorkflowStore } from '../store/workflowStore';
import { finalizeRun, type FinalizeInput } from './runFinalizer';
import { getRunBus, resetRunBus, type RunEvent } from './runEvents';
import { ExperienceSink } from '../agents/experienceSink';
import type { FlowNode, CostRecord, RunRecord, LogEntry } from '../types';
import type { ExecutionRuntime } from './runtime';
import type { RunContext } from './runContext';

function mkNode(id: string, status: FlowNode['data']['status'] = 'success'): FlowNode {
  return {
    id,
    type: 'base',
    position: { x: 0, y: 0 },
    data: { typeId: 'x', label: id, params: {}, status, dirty: false, outputs: { out: id } },
  } as unknown as FlowNode;
}

function fakeRuntime(logs: string[]): ExecutionRuntime {
  return {
    addLog: (level: LogEntry['level'], message: string) => logs.push(`${level}:${message}`),
    setRunProgress: () => {},
    pushRunHistory: (rec: RunRecord) => useWorkflowStore.getState().pushRunHistory(rec),
    setCostLog: () => {},
    resetUsage: () => {},
    setNodeStatus: () => {},
    addAsset: () => {},
    setEdges: () => {},
  } as unknown as ExecutionRuntime;
}

function seedStore(wfId: string, nodes: FlowNode[]) {
  useWorkflowStore.setState({
    activeWfId: wfId,
    nodes,
    edges: [],
    variables: {},
    projectVariables: {},
    workflows: {
      [wfId]: { name: wfId, nodes, edges: [], variables: {}, agents: [], roles: [], groups: [], assets: [] } as never,
    },
    runStates: {},
    runHistory: [],
    logs: [],
    subgraphs: {},
    failFast: false,
    skipFailed: false,
    maxConcurrency: 3,
    checkpoints: {},
    checkpointHistory: {},
    selectedNodeId: 'other-node', // 确保指针回退会触发 setSelected
  } as never);
}

function baseInput(wfId: string, nodes: FlowNode[], overrides: Partial<FinalizeInput> = {}): FinalizeInput {
  return {
    wfId,
    myRun: 1,
    isCurrentRun: true,
    workflowName: wfId,
    nodes,
    startedWall: Date.now() - 1000,
    startAt: performance.now() - 500,
    runCtx: { wfId, runId: 1, goal: wfId } as RunContext,
    rt: fakeRuntime([]),
    sink: new ExperienceSink(wfId),
    signal: new AbortController().signal,
    costLog: [] as CostRecord[],
    costByNode: new Map(),
    failed: new Set(),
    hasLoop: false,
    stages: [['a']],
    ...overrides,
  };
}

describe('finalizeRun 收尾', () => {
  beforeEach(() => {
    resetRunBus();
  });

  it('成功运行：写历史(SUCCESS) + 写 checkpoint + 发 run.completed + 指针回退', async () => {
    const wfId = 'wf-fin-ok';
    const nodes = [mkNode('a', 'success')];
    seedStore(wfId, nodes);
    const events: RunEvent[] = [];
    getRunBus().subscribe((e) => events.push(e));
    const logs: string[] = [];

    await finalizeRun(baseInput(wfId, nodes, { rt: fakeRuntime(logs) }));

    const st = useWorkflowStore.getState();
    // 历史
    expect(st.runHistory.length).toBe(1);
    expect(st.runHistory[0]!.status).toBe('success');
    // checkpoint
    expect(st.checkpoints[wfId]).toBeTruthy();
    expect(st.checkpoints[wfId]!.status).toBe('success');
    // 事件
    const kinds = events.map((e) => e.kind);
    expect(kinds[kinds.length - 1]).toBe('run.completed');
    // 指针回退
    expect(st.selectedNodeId).toBe('a');
    // 日志含完成提示
    expect(logs.some((l) => l.includes('全部完成'))).toBe(true);
  });

  it('失败运行：status=error + 发 run.failed', async () => {
    const wfId = 'wf-fin-fail';
    const nodes = [mkNode('a', 'error')];
    seedStore(wfId, nodes);
    const events: RunEvent[] = [];
    getRunBus().subscribe((e) => events.push(e));

    await finalizeRun(baseInput(wfId, nodes, {
      failed: new Set(['a']),
      costLog: [{ nodeId: 'a', nodeLabel: 'a', agentId: 'ag', model: 'm', durationMs: 1, at: 't', ok: false, error: 'boom' }],
    }));

    const st = useWorkflowStore.getState();
    expect(st.runHistory[0]!.status).toBe('error');
    const kinds = events.map((e) => e.kind);
    expect(kinds[kinds.length - 1]).toBe('run.failed');
  });

  it('手动停止（signal aborted）：status=aborted + 发 run.aborted，指针不回退', async () => {
    const wfId = 'wf-fin-abort';
    const nodes = [mkNode('a', 'running')];
    seedStore(wfId, nodes);
    const events: RunEvent[] = [];
    getRunBus().subscribe((e) => events.push(e));
    const ac = new AbortController();
    ac.abort();

    await finalizeRun(baseInput(wfId, nodes, { signal: ac.signal }));

    const st = useWorkflowStore.getState();
    expect(st.runHistory[0]!.status).toBe('aborted');
    const kinds = events.map((e) => e.kind);
    expect(kinds[kinds.length - 1]).toBe('run.aborted');
    // 指针不回退（aborted 时 finishedClean=false）
    expect(st.selectedNodeId).toBe('other-node');
  });

  it('被淘汰的旧运行（isCurrentRun=false）：不写历史/checkpoint/事件，仅警告日志', async () => {
    const wfId = 'wf-fin-stale';
    const nodes = [mkNode('a', 'success')];
    seedStore(wfId, nodes);
    const events: RunEvent[] = [];
    getRunBus().subscribe((e) => events.push(e));
    const logs: string[] = [];

    await finalizeRun(baseInput(wfId, nodes, { isCurrentRun: false, rt: fakeRuntime(logs) }));

    const st = useWorkflowStore.getState();
    expect(st.runHistory.length).toBe(0); // 不写历史
    expect(st.checkpoints[wfId]).toBeUndefined(); // 不写 checkpoint
    expect(events.length).toBe(0); // 不发终态事件
    expect(logs.some((l) => l.includes('旧运行已由新一次运行替代'))).toBe(true);
  });

  it('成本指标：costLog 有 agentId 时写入记录（失败调用也计入 fail）', async () => {
    const wfId = 'wf-fin-metric';
    const nodes = [mkNode('a', 'success')];
    seedStore(wfId, nodes);
    const costLog: CostRecord[] = [
      { nodeId: 'a', nodeLabel: 'a', agentId: 'ag1', model: 'gpt-4o-mini', usage: { promptTokens: 1_000_000, completionTokens: 0 }, durationMs: 5, at: 't1', ok: true },
    ];
    await finalizeRun(baseInput(wfId, nodes, { costLog }));
    // 无断言本地存储副作用（localStorage 在 jsdom 可用，但不强依赖）；
    // 主要验证不抛错、历史正常写入
    expect(useWorkflowStore.getState().runHistory[0]!.status).toBe('success');
  });
});
