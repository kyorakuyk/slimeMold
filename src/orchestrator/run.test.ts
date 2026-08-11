/**
 * run.test.ts — H3 Orchestrator H3b 编排执行器单测（fake runWorkflow / ensureStageWorkflow / getWorkflow 注入）。
 *
 * 覆盖：
 * - 仅接受 ready，非 ready 拒绝；
 * - ready → running → done 全链路，各阶段写 StageLog（含真实 wfId + runId）；
 * - 按拓扑序执行（edges 决定顺序）；
 * - 首次失败 → failed 并停止后续阶段；
 * - existing 工作流不存在 → 阶段失败（P0）；
 * - **工作流为空（new 阶段空图）→ 阶段失败，不运行空图标 success（P0）**；
 * - 绑定固化 stageWfIds：恢复/重试复用同一 ID（P1）；
 * - cancel：先 stopWorkflow(wfId) 再 cancelled；cancel 后 runWorkflow 返回不标 success（P1）；
 * - readonly 约束：固化在 Orchestration.readonly，不执行。
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
  const orch = createOrchestration(goal, draft, { readonly: constraints?.readonly });
  confirmDraft(orch.id, 'approved');
  return orch;
}

function fakeDeps(over: Partial<OrchestrationDeps> = {}): {
  deps: OrchestrationDeps;
  runs: string[];
  stopped: string[];
  bound: string[];
} {
  const runs: string[] = [];
  const stopped: string[] = [];
  const bound: string[] = [];
  const baseRun = over.runWorkflow;
  const baseStop = over.stopWorkflow;
  const baseEnsure = over.ensureStageWorkflow;
  const baseGetWf = over.getWorkflow;
  const depsImpl: OrchestrationDeps = {
    // runWorkflow 包装：记录 runs，返回 success + 递增 runId，再调覆盖实现（若有）
    runWorkflow: vi.fn(async (opts) => {
      runs.push(opts.wfId);
      const runId = 1000 + runs.length;
      if (baseRun) {
        return await baseRun(opts);
      }
      return { status: 'success' as const, runId };
    }),
    // stopWorkflow 包装：记录 stopped，再调覆盖实现（若有）
    stopWorkflow: vi.fn((wfId) => {
      if (wfId) stopped.push(wfId);
      if (baseStop) baseStop(wfId);
    }),
    // ensureStageWorkflow：默认返回真实 wfId（记录 bound）；可覆盖
    ensureStageWorkflow: vi.fn(
      (orchId: string, stage: Parameters<OrchestrationDeps['ensureStageWorkflow']>[1]) => {
        bound.push(stage.id);
        if (baseEnsure) return baseEnsure(orchId, stage);
        return { ok: true as const, wfId: `wf-${orchId}-${stage.id}` };
      },
    ),
    // getWorkflow：必需依赖；默认返回非空节点（可覆盖）
    getWorkflow: vi.fn((wfId: string) => {
      if (baseGetWf) return baseGetWf(wfId);
      return { nodes: [{ id: 'n1' }], name: wfId };
    }),
  };
  return { deps: depsImpl, runs, stopped, bound };
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

  it('ready → running → done：按拓扑序执行所有阶段并写 StageLog（真实 wfId + runId）', async () => {
    const orch = makeReadyOrch();
    const { deps: f, runs } = fakeDeps();
    const result = await runOrchestration(orch.id, f);
    expect(result.status).toBe('done');
    expect(runs).toHaveLength(3);
    expect(runs[0]).toContain('plan');
    expect(runs[1]).toContain('construction');
    expect(runs[2]).toContain('acceptance');
    expect(result.stageLogs.every((l) => l.status === 'success')).toBe(true);
    expect(result.stageLogs.every((l) => l.wfId && l.startedAt && l.finishedAt)).toBe(true);
    // 真实 runId（executor 返回，非时间戳伪造）
    expect(result.stageLogs.every((l) => typeof l.runId === 'number')).toBe(true);
    // runIds 已收集（executor 真实 runId）
    expect(result.runIds.length).toBe(3);
  });

  it('首次失败 → failed 并停止后续阶段', async () => {
    const orch = makeReadyOrch();
    const { deps: f, runs } = fakeDeps({
      runWorkflow: vi.fn(async (opts) => {
        if (opts.wfId.includes('construction')) throw new Error('construction 爆炸');
        return { status: 'success' as const, runId: 1 };
      }),
    });
    const result = await runOrchestration(orch.id, f);
    expect(result.status).toBe('failed');
    expect(result.stageLogs.find((l) => l.stageId === 'plan')?.status).toBe('success');
    expect(result.stageLogs.find((l) => l.stageId === 'construction')?.status).toBe('failed');
    expect(result.stageLogs.find((l) => l.stageId === 'construction')?.error).toContain('construction 爆炸');
    expect(result.stageLogs.find((l) => l.stageId === 'acceptance')?.status).toBe('pending');
    expect(runs).toHaveLength(2);
  });

  it('existing 工作流不存在 → 阶段失败，不标 success（P0）', async () => {
    const orch = makeReadyOrch();
    const { deps: f, runs } = fakeDeps({
      ensureStageWorkflow: (orchId, stage) =>
        stage.id === 'construction'
          ? { ok: false, error: '阶段 construction 引用的工作流不存在：ghost' }
          : { ok: true, wfId: `wf-${orchId}-${stage.id}` },
    });
    const result = await runOrchestration(orch.id, f);
    expect(result.status).toBe('failed');
    expect(result.stageLogs.find((l) => l.stageId === 'construction')?.status).toBe('failed');
    expect(result.stageLogs.find((l) => l.stageId === 'construction')?.error).toContain('不存在');
    expect(runs).toHaveLength(1); // 仅 plan
  });

  it('工作流为空（new 空图）→ 阶段失败，不运行空图标 success（P0）', async () => {
    const orch = makeReadyOrch();
    const { deps: f, runs } = fakeDeps({
      getWorkflow: (wfId) =>
        wfId.includes('construction')
          ? { nodes: [], name: 'x' }
          : { nodes: [{ id: 'n1' }], name: 'x' },
    });
    const result = await runOrchestration(orch.id, f);
    expect(result.status).toBe('failed');
    expect(result.stageLogs.find((l) => l.stageId === 'construction')?.status).toBe('failed');
    expect(result.stageLogs.find((l) => l.stageId === 'construction')?.error).toContain('为空或无节点');
    // construction 未跑 runWorkflow（空图即失败）
    expect(runs).toHaveLength(1);
  });

  it('绑定固化 stageWfIds：恢复/重试复用同一 ID，不重建（P1）', async () => {
    const orch = makeReadyOrch();
    const { deps: f } = fakeDeps({
      ensureStageWorkflow: (orchId, stage) => {
        // 模拟已固化绑定的场景：stageWfIds 里已有 plan → 复用
        const st = useWorkflowStore.getState().orchestrations.find((o) => o.id === orchId);
        const existing = st?.stageWfIds?.[stage.id];
        if (existing) return { ok: true, wfId: existing };
        const wfId = `fixed-wf-${stage.id}`;
        useWorkflowStore.getState().setOrchestrations(
          useWorkflowStore.getState().orchestrations.map((o) =>
            o.id === orchId ? { ...o, stageWfIds: { ...o.stageWfIds, [stage.id]: wfId } } : o,
          ),
        );
        return { ok: true, wfId };
      },
    });
    const result = await runOrchestration(orch.id, f);
    expect(result.status).toBe('done');
    // stageWfIds 已固化三个阶段的 wfId
    expect(Object.keys(result.stageWfIds ?? {})).toEqual(['plan', 'construction', 'acceptance']);
    // 与 StageLog 的 wfId 一致
    expect(result.stageLogs.every((l) => l.wfId === result.stageWfIds![l.stageId])).toBe(true);
  });

  it('cancel：先 stopWorkflow(当前阶段 wfId) 再 cancelled；cancel 后 runWorkflow 返回不标 success（P1）', async () => {
    const orch = makeReadyOrch();
    let resolvePlan: () => void = () => {};
    const gate = new Promise<void>((r) => { resolvePlan = r; });
    const { deps: f, runs, stopped } = fakeDeps({
      runWorkflow: vi.fn(async (opts) => {
        if (opts.wfId.includes('plan')) {
          await gate; // 挂起，让 cancel 有机会介入
        }
        return { status: 'success' as const, runId: 42 };
      }),
    });
    const p = runOrchestration(orch.id, f);
    await vi.waitFor(() => expect(runs.length).toBeGreaterThan(0));
    cancelOrchestrationRun(orch.id, f);
    resolvePlan();
    await p;
    const final = getOrchestration(orch.id)!;
    expect(final.status).toBe('cancelled');
    expect(stopped.length).toBeGreaterThan(0);
    expect(stopped[0]).toContain('plan');
    // plan 阶段不得被写成 success（cancel 后复查 cancelled）
    expect(final.stageLogs.find((l) => l.stageId === 'plan')?.status).not.toBe('success');
  });

  it('readonly 约束：固化在 Orchestration.readonly，不执行', async () => {
    const orch = makeReadyOrch('目标', { readonly: true });
    expect(orch.readonly).toBe(true);
    const { deps: f, runs } = fakeDeps();
    await expect(runOrchestration(orch.id, f)).rejects.toThrow(/只读模式/);
    expect(runs).toHaveLength(0);
    expect(getOrchestration(orch.id)?.status).toBe('cancelled');
  });

  it('executor 返回 error → 阶段 failed，不假成功（P0 核心）', async () => {
    const orch = makeReadyOrch();
    const { deps: f, runs } = fakeDeps({
      runWorkflow: vi.fn(async (opts) => {
        if (opts.wfId.includes('construction')) {
          return { status: 'error' as const, runId: 7, error: '节点执行失败：网络超时' };
        }
        return { status: 'success' as const, runId: 1 };
      }),
    });
    const result = await runOrchestration(orch.id, f);
    expect(result.status).toBe('failed');
    expect(result.stageLogs.find((l) => l.stageId === 'plan')?.status).toBe('success');
    expect(result.stageLogs.find((l) => l.stageId === 'construction')?.status).toBe('failed');
    expect(result.stageLogs.find((l) => l.stageId === 'construction')?.error).toContain('节点执行失败');
    expect(result.stageLogs.find((l) => l.stageId === 'acceptance')?.status).toBe('pending');
    expect(runs).toHaveLength(2); // acceptance 未跑
  });

  it('executor 返回 aborted → 阶段 failed（空图/非法图/被停止均经此判定）', async () => {
    const orch = makeReadyOrch();
    const { deps: f } = fakeDeps({
      runWorkflow: vi.fn(async (opts) => {
        if (opts.wfId.includes('construction')) {
          return { status: 'aborted' as const, runId: 8, error: '工作流无可用执行计划' };
        }
        return { status: 'success' as const, runId: 1 };
      }),
    });
    const result = await runOrchestration(orch.id, f);
    expect(result.status).toBe('failed');
    expect(result.stageLogs.find((l) => l.stageId === 'construction')?.status).toBe('failed');
    expect(result.stageLogs.find((l) => l.stageId === 'construction')?.error).toContain('无可用执行计划');
  });
});
