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
import {
  bindStageWorkflow,
  createDraftOrchestration,
  createOrchestration,
  confirmDraft,
  getOrchestration,
  updateOrchestration,
} from './confirm';
import {
  runOrchestration,
  cancelOrchestrationRun,
  effectiveStageWfId,
  prepareStageWorkflows,
  stagesReadyToRun,
  type OrchestrationDeps,
} from './run';
import { useWorkflowStore } from '../store/workflowStore';
import type { Orchestration } from '../types';
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
    // ensureStageWorkflow：默认返回真实 wfId（记录 bound）；可覆盖。
    // 同时模拟 defaultDeps 的「固化绑定」行为——把 wfId 写入 stageWfIds（prepareStageWorkflows 断言依赖）
    ensureStageWorkflow: vi.fn(
      (orchId: string, stage: Parameters<OrchestrationDeps['ensureStageWorkflow']>[1]) => {
        bound.push(stage.id);
        if (baseEnsure) return baseEnsure(orchId, stage);
        const wfId = `wf-${orchId}-${stage.id}`;
        const st = useWorkflowStore.getState();
        const o = st.orchestrations.find((x) => x.id === orchId);
        if (o) {
          st.setOrchestrations(
            st.orchestrations.map((x) =>
              x.id === orchId ? { ...x, stageWfIds: { ...x.stageWfIds, [stage.id]: wfId } } : x,
            ),
          );
        }
        return { ok: true as const, wfId };
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

  /* ---------- H3c：阶段工作流绑定/配置入口 ---------- */

  it('bindStageWorkflow：awaiting-confirm 可改 wfRef，确认后 ready 仍可调整，running 拒绝', async () => {
    // 未确认的编排（awaiting-confirm）
    const orch = createOrchestration('x', generateDraft({ goal: 'x', source: 'ui' }, deps()));
    // awaiting-confirm 状态（确认前）绑定 existing
    bindStageWorkflow(orch.id, 'construction', { kind: 'existing', wfId: 'wf-existing-1' });
    let cur = getOrchestration(orch.id)!;
    expect(cur.draft!.stages.find((s) => s.id === 'construction')?.wfRef).toEqual({
      kind: 'existing',
      wfId: 'wf-existing-1',
    });
    // ready 状态（确认后执行前）仍可调整回 new
    confirmDraft(orch.id, 'approved');
    bindStageWorkflow(orch.id, 'construction', { kind: 'new' });
    cur = getOrchestration(orch.id)!;
    expect(cur.status).toBe('ready');
    expect(cur.draft!.stages.find((s) => s.id === 'construction')?.wfRef).toEqual({ kind: 'new' });
    // running 状态拒绝修改
    updateOrchestration(orch.id, { status: 'running' });
    expect(() => bindStageWorkflow(orch.id, 'construction', { kind: 'existing', wfId: 'x' })).toThrow(
      /不允许修改阶段绑定/,
    );
  });

  it('prepareStageWorkflows：提前固化每阶段 wfId 到 stageWfIds（runOrchestration 复用不重建）', async () => {
    const orch = makeReadyOrch();
    const { deps: f, bound } = fakeDeps();
    const binds = prepareStageWorkflows(orch.id, f);
    expect(binds).toHaveLength(3);
    expect(binds.every((b) => b.bind.ok)).toBe(true);
    expect(bound).toEqual(['plan', 'construction', 'acceptance']);
    // 固化写入 stageWfIds，与 ensureStageWorkflow 返回的 wfId 一致
    const cur = getOrchestration(orch.id)!;
    expect(Object.keys(cur.stageWfIds ?? {})).toEqual(['plan', 'construction', 'acceptance']);
    // 运行复用已固化绑定：ensureStageWorkflow 不再重建（fake 里 stageWfIds 优先返回）
    const result = await runOrchestration(orch.id, f);
    expect(result.status).toBe('done');
    expect(result.stageLogs.every((l) => l.wfId === cur.stageWfIds![l.stageId])).toBe(true);
  });

  it('prepareStageWorkflows：running 状态拒绝', async () => {
    const orch = makeReadyOrch();
    updateOrchestration(orch.id, { status: 'running' });
    const { deps: f } = fakeDeps();
    expect(() => prepareStageWorkflows(orch.id, f)).toThrow(/不允许提前固化绑定/);
  });

  it('createDraftOrchestration：readonly 从请求固化到 Orchestration.readonly（P0）', async () => {
    const readonlyOrch = createDraftOrchestration(
      { goal: '只读目标', source: 'ui', constraints: { readonly: true } },
      deps(),
    );
    expect(readonlyOrch.readonly).toBe(true);
    // 非只读请求不误写 readonly
    const normalOrch = createDraftOrchestration({ goal: '普通目标', source: 'ui' }, deps());
    expect(normalOrch.readonly).toBeUndefined();
  });

  it('bindStageWorkflow：重新绑定会清除该阶段旧固化 stageWfIds（P0，防执行对象错配）', async () => {
    const orch = makeReadyOrch();
    const { deps: f } = fakeDeps();
    // 先固化：plan 绑定到旧工作流
    prepareStageWorkflows(orch.id, f);
    let cur = getOrchestration(orch.id)!;
    const oldPlanWfId = cur.stageWfIds!.plan;
    expect(oldPlanWfId).toBeDefined();
    // 重新绑定 plan → 旧固化绑定被清除（执行器不得再用旧 wfId）
    bindStageWorkflow(orch.id, 'plan', { kind: 'existing', wfId: 'wf-B' });
    cur = getOrchestration(orch.id)!;
    expect(cur.stageWfIds!.plan).toBeUndefined();
    // 其它阶段的固化绑定保留
    expect(cur.stageWfIds!.construction).toBeDefined();
    expect(cur.stageWfIds!.acceptance).toBeDefined();
    // 再次固化：plan 按新 wfRef 重新绑定（不再复用旧 id）
    prepareStageWorkflows(orch.id, f);
    cur = getOrchestration(orch.id)!;
    expect(cur.stageWfIds!.plan).toBeDefined();
  });

  it('stagesReadyToRun：new 未固化 / 固化空图 → false；固化非空 / existing 非空 → true', async () => {
    const orch = makeReadyOrch(); // 三阶段默认 new 且未固化
    expect(stagesReadyToRun(orch, {})).toBe(false);
    // 全部固化且对应工作流非空
    const full: Orchestration = {
      ...orch,
      stageWfIds: { plan: 'w1', construction: 'w2', acceptance: 'w3' },
    };
    const wfs = { w1: { nodes: [{}] }, w2: { nodes: [{}] }, w3: { nodes: [{}] } };
    expect(stagesReadyToRun(full, wfs as never)).toBe(true);
    // 某阶段固化后对应工作流为空图 → false
    const emptyBound: Orchestration = {
      ...full,
      stageWfIds: { ...full.stageWfIds!, construction: 'w-empty' },
    };
    expect(stagesReadyToRun(emptyBound, { ...wfs, 'w-empty': { nodes: [] } } as never)).toBe(false);
    // existing 引用非空工作流（未固化）→ true
    const allExisting: Orchestration = {
      ...orch,
      draft: {
        ...orch.draft!,
        stages: orch.draft!.stages.map((s) => ({
          ...s,
          wfRef: { kind: 'existing', wfId: s.id === 'plan' ? 'w1' : s.id === 'construction' ? 'w2' : 'w3' },
        })),
      },
    };
    expect(stagesReadyToRun(allExisting, wfs as never)).toBe(true);
  });

  it('stagesReadyToRun：固化后空白工作流 → false（复现 GUI 验收 D：2、3 为空白画布仍可点执行）', () => {
    const orch = makeReadyOrch();
    const bound: Orchestration = {
      ...orch,
      stageWfIds: { plan: 'wf-a', construction: 'wf-b', acceptance: 'wf-c' },
    };
    const emptyWfs = { 'wf-a': { nodes: [] }, 'wf-b': { nodes: [] }, 'wf-c': { nodes: [] } };
    // 全部空白 → false
    expect(stagesReadyToRun(bound, emptyWfs as never)).toBe(false);
    // 阶段 1 非空、2/3 空白 → false（用户报告场景：不应可执行）
    const partialWfs = { ...emptyWfs, 'wf-a': { nodes: [{ id: 'n1' }] } };
    expect(stagesReadyToRun(bound, partialWfs as never)).toBe(false);
    // 全部非空 → true
    const fullWfs = {
      'wf-a': { nodes: [{ id: 'n1' }] },
      'wf-b': { nodes: [{ id: 'n2' }] },
      'wf-c': { nodes: [{ id: 'n3' }] },
    };
    expect(stagesReadyToRun(bound, fullWfs as never)).toBe(true);
  });

  it('effectiveStageWfId：existing 未固化取 wfRef；new 未固化 undefined；固化后 stageWfIds 优先', () => {
    const orch = makeReadyOrch();
    // new 未固化 → undefined
    expect(effectiveStageWfId(orch, 'plan')).toBeUndefined();
    // existing 未固化（复用已有工作流，旧固化被清除）→ 取 wfRef.wfId
    bindStageWorkflow(orch.id, 'plan', { kind: 'existing', wfId: 'wf-B' });
    expect(effectiveStageWfId(getOrchestration(orch.id)!, 'plan')).toBe('wf-B');
    // 固化后 stageWfIds 优先（即使 wfRef 是 existing 引用别的）
    bindStageWorkflow(orch.id, 'construction', { kind: 'existing', wfId: 'wf-C' });
    prepareStageWorkflows(orch.id, fakeDeps().deps);
    const cur = getOrchestration(orch.id)!;
    const constructionWfId = cur.stageWfIds!.construction;
    expect(effectiveStageWfId(cur, 'construction')).toBe(constructionWfId);
  });

  it('failed → running 重试：runOrchestration 接受 failed 状态，复用已固化 stageWfIds 重跑至 done', async () => {
    const orch = makeReadyOrch();
    const { deps: f } = fakeDeps();
    const mockRun = f.runWorkflow as unknown as ReturnType<typeof vi.fn>;
    // 先固化全部阶段
    prepareStageWorkflows(orch.id, f);
    const planWfId = getOrchestration(orch.id)!.stageWfIds!.plan;
    // 第一次运行：plan 阶段失败（error 结果 → 编排 failed，首败即停）
    mockRun.mockResolvedValueOnce({ status: 'error', runId: 1, error: '节点失败' });
    const first = await runOrchestration(orch.id, f);
    expect(first.status).toBe('failed');
    expect(first.stageLogs.find((l) => l.stageId === 'plan')?.status).toBe('failed');
    expect(first.stageLogs.find((l) => l.stageId === 'construction')?.status).toBe('pending');
    // 重试：failed 状态可直接启动（迁移 failed → running），复用已固化绑定不重建
    const second = await runOrchestration(orch.id, f);
    expect(second.status).toBe('done');
    expect(second.stageLogs.every((l) => l.status === 'success')).toBe(true);
    expect(second.stageWfIds!.plan).toBe(planWfId);
    // 其它状态仍拒绝启动（未确认的 awaiting-confirm 编排）
    const unconfirmed = createOrchestration('x', generateDraft({ goal: 'x', source: 'ui' }, deps()));
    await expect(runOrchestration(unconfirmed.id, f)).rejects.toThrow(/不允许启动/);
  });
});
