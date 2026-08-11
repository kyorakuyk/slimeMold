/**
 * run.test.ts — H3 Orchestrator H3b 编排执行器单测（fake runWorkflow 注入）。
 *
 * 覆盖：
 * - 仅接受 ready，非 ready 拒绝；
 * - ready → running → done 全链路，各阶段写 StageLog；
 * - 按拓扑序执行（edges 决定顺序）；
 * - 首次失败 → failed 并停止后续阶段；
 * - cancel：先 stopWorkflow(wfId) 再 cancelled；
 * - readonly 约束：只产出草案不执行。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateDraft } from './draft';
import { createOrchestration, confirmDraft, getOrchestration, updateOrchestration } from './confirm';
import { runOrchestration, cancelOrchestrationRun, type OrchestrationDeps } from './run';
import { useWorkflowStore } from '../store/workflowStore';
import type { OrchestratorRequest } from './types';

const agent = {
  id: 'agent-1',
  name: 'A',
  protocol: 'ollama',
  model: 'llama3',
  baseUrl: 'http://127.0.0.1:11434',
  enabled: true,
} as never;

function deps() {
  return { agents: [agent], defaultAgentId: 'agent-1' };
}

function makeReadyOrch(goal = '目标', constraints?: OrchestratorRequest['constraints']) {
  const draft = generateDraft({ goal, source: 'ui', constraints }, deps());
  const orch = createOrchestration(goal, draft);
  confirmDraft(orch.id, 'approved');
  return orch;
}

function fakeDeps(over: Partial<OrchestrationDeps> = {}): {
  deps: OrchestrationDeps;
  runs: string[];
  stopped: string[];
} {
  const runs: string[] = [];
  const stopped: string[] = [];
  const baseRun = over.runWorkflow;
  const baseStop = over.stopWorkflow;
  const depsImpl: OrchestrationDeps = {
    // runWorkflow 包装：记录 runs，再调覆盖实现（若有）
    runWorkflow: vi.fn(async (opts) => {
      runs.push(opts.wfId);
      if (baseRun) await baseRun(opts);
    }),
    // stopWorkflow 包装：记录 stopped，再调覆盖实现（若有）
    stopWorkflow: vi.fn((wfId) => {
      if (wfId) stopped.push(wfId);
      if (baseStop) baseStop(wfId);
    }),
    // 其余字段（如 getRequest）透传
    ...(over.getRequest ? { getRequest: over.getRequest } : {}),
  };
  return { deps: depsImpl, runs, stopped };
}

beforeEach(() => {
  useWorkflowStore.setState({ orchestrations: [] } as never);
  vi.restoreAllMocks();
});

describe('runOrchestration 编排执行器', () => {
  it('仅接受 ready：非 ready 拒绝', async () => {
    const orch = makeReadyOrch();
    updateOrchestration(orch.id, { status: 'running' }); // 模拟已被占用
    await expect(runOrchestration(orch.id, fakeDeps().deps)).rejects.toThrow(/仅 ready/);
  });

  it('ready → running → done：按拓扑序执行所有阶段并写 StageLog', async () => {
    const orch = makeReadyOrch();
    const { deps: f, runs } = fakeDeps();
    const result = await runOrchestration(orch.id, f);
    expect(result.status).toBe('done');
    // 3 阶段：plan → construction → acceptance
    expect(runs).toHaveLength(3);
    expect(runs[0]).toContain('plan');
    expect(runs[1]).toContain('construction');
    expect(runs[2]).toContain('acceptance');
    // StageLog 全部 success
    expect(result.stageLogs.every((l) => l.status === 'success')).toBe(true);
    expect(result.stageLogs.every((l) => l.startedAt && l.finishedAt)).toBe(true);
  });

  it('首次失败 → failed 并停止后续阶段', async () => {
    const orch = makeReadyOrch();
    const { deps: f, runs } = fakeDeps({
      runWorkflow: vi.fn(async (opts) => {
        if (opts.wfId.includes('construction')) throw new Error('construction 爆炸');
      }),
    });
    const result = await runOrchestration(orch.id, f);
    expect(result.status).toBe('failed');
    expect(result.stageLogs.find((l) => l.stageId === 'plan')?.status).toBe('success');
    expect(result.stageLogs.find((l) => l.stageId === 'construction')?.status).toBe('failed');
    expect(result.stageLogs.find((l) => l.stageId === 'construction')?.error).toContain('construction 爆炸');
    // acceptance 未执行
    expect(result.stageLogs.find((l) => l.stageId === 'acceptance')?.status).toBe('pending');
    expect(runs).toHaveLength(2); // plan + construction（acceptance 未跑）
  });

  it('cancel：先 stopWorkflow(当前阶段 wfId) 再 cancelled', async () => {
    const orch = makeReadyOrch();
    // 模拟运行中：执行 plan 阶段时挂起
    let resolvePlan: () => void = () => {};
    const gate = new Promise<void>((r) => { resolvePlan = r; });
    const { deps: f, runs, stopped } = fakeDeps({
      runWorkflow: vi.fn(async (opts) => {
        runs.push(opts.wfId);
        if (opts.wfId.includes('plan')) {
          await gate; // 挂起，让 cancel 有机会介入
        }
      }),
    });
    const p = runOrchestration(orch.id, f);
    // 等 plan 开始（runs 有 plan）
    await vi.waitFor(() => expect(runs.length).toBeGreaterThan(0));
    // cancel
    cancelOrchestrationRun(orch.id, f);
    resolvePlan();
    await p;
    expect(getOrchestration(orch.id)?.status).toBe('cancelled');
    // stopWorkflow 被调用（plan 阶段 wfId）
    expect(stopped.length).toBeGreaterThan(0);
    expect(stopped[0]).toContain('plan');
  });

  it('readonly 约束：只产出草案不执行', async () => {
    const orch = makeReadyOrch('目标', { readonly: true });
    const { deps: f, runs } = fakeDeps({
      getRequest: () => ({ goal: '目标', source: 'ui', constraints: { readonly: true } }),
    });
    await expect(runOrchestration(orch.id, f)).rejects.toThrow(/只读模式/);
    expect(runs).toHaveLength(0);
    // 状态被置 cancelled
    expect(getOrchestration(orch.id)?.status).toBe('cancelled');
  });
});
