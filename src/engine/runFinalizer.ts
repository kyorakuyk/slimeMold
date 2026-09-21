/**
 * runFinalizer.ts — 运行收尾器（executor 拆分第一刀，Codex 推荐「先收尾」）。
 *
 * 把 runWorkflow 收尾段（原先在 executor.ts ~539-771 行）的整体职责收敛到单一函数：
 * - 运行状态归约（isCurrentRun 守卫、终态日志、节点最新视图重建）
 * - 运行历史（RunRecord 构建 + pushRunHistory）
 * - Agent 成本指标（recordAgentOutcome，始终记录不受 selfImprove 影响）
 * - checkpoint 终态写入（persistCheckpoint）
 * - 终态事件（run.completed/failed/aborted）
 * - 经验沉淀 + reviewer 复盘（selfImprove 开启时）
 * - 运行指针回退（非循环 + 干净结束）
 *
 * 设计原则：纯函数 + 显式输入对象，不直接持有 runWorkflow 的闭包；
 * 输出为 Promise<void>（checkpoint 落盘需 await）。所有副作用经 useWorkflowStore / rt / 事件总线。
 */
import type { CostRecord } from '../types/agent';
import type { FlowNode, RunRecord } from '../types';
import { useWorkflowStore } from '../store/workflowStore';
import { ownerRefId } from './subgraph';
import { buildCheckpoint } from './checkpoint';
import { emitRun, getRunBus } from './runEvents';
import type { RunContext } from './runContext';
import type { ExecutionRuntime } from './runtime';
import { ExperienceSink } from '../agents/experienceSink';
import { isSelfImprove, runReview } from '../agents/reviewer';
import { readProjectText } from '../platform/env';
import { MEMORY_REL } from '../agents/memoryIo';
import { mergeAgentPool } from '../agents/globalAgents';
import {
  addExperience,
  estimateUsageCostUsd,
  recordAgentOutcome,
  summarizeExperience,
} from '../agents/experienceStore';
import { modelPrice } from '../agents/routerScoring';
import { skippedCount } from './nodeCache';

/** 收尾结果（H3b 编排器依赖：status 判定执行成败） */
export interface RunFinalizeResult {
  /** executor 运行结果：success / error（有失败节点）/ aborted（手动停止） */
  status: 'success' | 'error' | 'aborted';
  /** 本次运行代次（作为 runId 语义） */
  runId: number;
}

/** 收尾器输入（由 runWorkflow 在收尾点构造传入）。 */
export interface FinalizeInput {
  wfId: string;
  myRun: number;
  /** 是否当前代次运行（false = 被 force/stop 淘汰的旧协程） */
  isCurrentRun: boolean;
  /** 目标工作流状态（用于 name 等） */
  workflowName: string;
  /** 计划节点（含子图展开），其运行态需从 store 重建 */
  nodes: FlowNode[];
  /** 起始墙钟（checkpoint/历史用） */
  startedWall: number;
  /** 起始 performance 时钟（耗时计算） */
  startAt: number;
  /** 运行上下文（终态事件） */
  runCtx: RunContext;
  /** 执行运行时（addLog/pushRunHistory） */
  rt: ExecutionRuntime;
  /** 轨迹采集器（reviewer 复盘用） */
  sink: ExperienceSink;
  /** 中止信号（判定 aborted） */
  signal: AbortSignal;
  /** 本轮成本账本 */
  costLog: CostRecord[];
  /** 节点 → 成本记录 */
  costByNode: Map<string, CostRecord[]>;
  /** 失败节点集 */
  failed: Set<string>;
  /** 是否循环工作流（指针回退判定） */
  hasLoop: boolean;
  /** 首层节点（指针回退目标） */
  stages: string[][];
}

/** 由 runWorkflow 收尾调用；返回 Promise<RunFinalizeResult>（checkpoint 落盘 await）。 */
export async function finalizeRun(input: FinalizeInput): Promise<RunFinalizeResult> {
  const {
    wfId,
    myRun,
    isCurrentRun,
    workflowName,
    nodes,
    startedWall,
    startAt,
    runCtx,
    rt,
    sink,
    signal,
    costLog,
    costByNode,
    failed,
    hasLoop,
    stages,
  } = input;

  const store = useWorkflowStore.getState();
  const elapsed = ((performance.now() - startAt) / 1000).toFixed(1);
  const skipped = skippedCount();

  // F2：从目标工作流的最新 store 状态重建节点运行态视图（局部 plan.nodes 不会自动同步）。
  const latestState = useWorkflowStore.getState();
  const latestNodes =
    wfId === latestState.activeWfId ? latestState.nodes : (latestState.workflows[wfId]?.nodes ?? []);
  const freshById = new Map(latestNodes.map((n) => [n.id, n.data]));
  const nodesNow = nodes.map((n) => {
    const fresh = freshById.get(ownerRefId(n.id) ?? n.id);
    if (!fresh) return n;
    return {
      ...n,
      data: {
        ...n.data,
        status: fresh.status,
        outputs: fresh.outputs,
        error: fresh.error,
        startedAt: fresh.startedAt,
        durationMs: fresh.durationMs,
      },
    };
  });
  const pruned = nodesNow.filter((n) => n.data.status === 'skipped').length;

  if (!isCurrentRun) {
    // 手动停止（stopWorkflow 已自增代次）会走到这里，但这并非「被新运行替代」。
    // 用 signal.aborted 区分：停止是用户主动中止，stopWorkflow 已打过「已停止」日志，
    // 这里只补一条收尾说明，不写历史/复盘（避免污染后续运行）。
    if (signal.aborted) {
      rt.addLog('info', `已停止（旧协程收尾，用时 ${elapsed}s）`);
      return { status: 'aborted', runId: myRun };
    }
    // 真正被新一次运行顶替的旧运行：只留最简日志，不写历史/复盘
    rt.addLog('warn', `旧运行已由新一次运行替代，不再记录本次收尾（用时 ${elapsed}s）`);
    return { status: 'aborted', runId: myRun };
  }
  if (signal.aborted && failed.size === 0) {
    rt.addLog('info', `已手动停止（用时 ${elapsed}s）`);
  } else if (failed.size > 0) {
    rt.addLog('error', `有 ${failed.size} 个步骤没跑通，请检查标红的节点（用时 ${elapsed}s）`);
  } else {
    const skipMsg = skipped > 0 ? `，${skipped} 步用了缓存结果` : '';
    const pruneMsg = pruned > 0 ? `，${pruned} 步因条件不成立而跳过` : '';
    rt.addLog('info', `全部完成 ✓（用时 ${elapsed}s${skipMsg}${pruneMsg}）`);
  }

  const status: RunRecord['status'] = failed.size > 0 ? 'error' : signal.aborted ? 'aborted' : 'success';

  // 成本聚合：按模型归类，便于「性价比」分析
  const byModel: Record<string, { promptTokens: number; completionTokens: number; calls: number }> = {};
  let totalPrompt = 0;
  let totalCompletion = 0;
  let totalDuration = 0;
  let cacheHitTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  let replyTokens = 0;
  for (const r of costLog) {
    totalDuration += r.durationMs;
    if (!r.usage) continue;
    const prompt = r.usage.promptTokens ?? 0;
    const completion = r.usage.completionTokens ?? 0;
    totalPrompt += prompt;
    totalCompletion += completion;
    cacheHitTokens += r.usage.cachedPromptTokens ?? 0;
    cacheWriteTokens += r.usage.writtenPromptTokens ?? 0;
    reasoningTokens += r.usage.reasoningTokens ?? 0;
    replyTokens += r.usage.replyTokens ?? completion;
    const m = (byModel[r.model] ??= { promptTokens: 0, completionTokens: 0, calls: 0 });
    m.promptTokens += prompt;
    m.completionTokens += completion;
    m.calls += 1;
  }
  const cacheMissTokens = Math.max(0, totalPrompt - cacheHitTokens - cacheWriteTokens);
  const hasCost = costLog.length > 0;

  // P2/G3：Agent 运行指标（成功/失败 + token + 估算成本）始终记录，不受 selfImprove 开关影响
  const metricProjectId = useWorkflowStore.getState().projectId ?? '';
  if (metricProjectId) {
    try {
      for (const r of costLog) {
        if (r.agentId) {
          const p = modelPrice(r.model);
          const costUsd = estimateUsageCostUsd(p, r.usage);
          recordAgentOutcome(metricProjectId, r.agentId, !!r.ok, r.usage, costUsd);
        }
      }
    } catch {
      /* 指标记录失败不影响运行 */
    }
  }

  const rec: RunRecord = {
    id: `run_${Date.now()}`,
    name: workflowName,
    startedAt: new Date(startedWall).toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - startAt),
    status,
    nodeCount: nodes.length,
    nodes: nodesNow.map((n) => ({
      id: n.id,
      label: n.data.label,
      typeId: n.data.typeId,
      status: n.data.status ?? 'idle',
      outputs: n.data.outputs ?? null,
      error: n.data.error ?? null,
      startedAt: n.data.startedAt ?? null,
      durationMs: n.data.durationMs ?? null,
      cost: costByNode.get(n.id) ?? null,
    })),
    cost: hasCost
      ? {
          totalPromptTokens: totalPrompt,
          totalCompletionTokens: totalCompletion,
          totalTokens: totalPrompt + totalCompletion,
          totalDurationMs: totalDuration,
          cache: {
            hitTokens: cacheHitTokens,
            missTokens: cacheMissTokens,
            writeTokens: cacheWriteTokens,
          },
          output: {
            reasoningTokens,
            replyTokens,
          },
          byModel,
          records: costLog,
        }
      : null,
  };
  rt.pushRunHistory(rec);

  // C：可恢复执行——运行结束即独立落盘检查点（覆盖式，不标脏、await 落盘完成）
  await useWorkflowStore
    .getState()
    .persistCheckpoint(buildCheckpoint(nodesNow, { wfId, runId: myRun, status, startedAt: startedWall }));

  // A3：运行级终态事件（completed / failed / aborted）统一在此发出，与历史记录状态一致。
  const finalKind: 'run.completed' | 'run.failed' | 'run.aborted' =
    status === 'error' ? 'run.failed' : status === 'aborted' ? 'run.aborted' : 'run.completed';
  emitRun(getRunBus(), finalKind, runCtx, {
    status,
    durationMs: rec.durationMs,
    nodeCount: nodes.length,
    skipped,
    pruned,
    failed: failed.size,
    elapsed: Number(elapsed),
  });

  // #8 自优化闭环：selfImprove 开启且配置了 reviewer 角色时，本轮结束后异步触发综合复盘
  if (isSelfImprove()) {
    // E 自我学习：运行结果归约为结构化经验入经验库（零 LLM 费用）
    try {
      const agentByNode: Record<string, string> = {};
      for (const r of costLog) {
        if (r.nodeId && r.agentId && !agentByNode[r.nodeId]) agentByNode[r.nodeId] = r.agentId;
      }
      const projectId = useWorkflowStore.getState().projectId ?? '';
      const expList = summarizeExperience({
        projectId,
        wfId,
        runId: myRun,
        status,
        agentByNode,
        nodes: nodesNow.map((n) => ({
          id: n.id,
          typeId: n.data.typeId,
          status: n.data.status ?? 'idle',
          error: n.data.error ?? null,
          durationMs: n.data.durationMs ?? null,
          label: n.data.label,
        })),
      });
      let learned = 0;
      for (const exp of expList) {
        if (addExperience(projectId, exp)) learned += 1;
      }
      if (learned > 0) {
        rt.addLog('info', `自我学习：已沉淀 ${learned} 条运行经验（${status}）`);
      }
    } catch (e) {
      rt.addLog('warn', `经验沉淀失败（不影响本次运行）：${e instanceof Error ? e.message : String(e)}`);
    }

    const stReview = useWorkflowStore.getState();
    const reviewerAgent = mergeAgentPool(stReview.agents, stReview.globalAgents).find((a) => a.id === 'role.reviewer');
    if (reviewerAgent) {
      sink.setOutcome(failed.size > 0 ? 'failure' : 'success');
      const root = useWorkflowStore.getState().projectPath ?? null;
      void (async () => {
        try {
          const memory = root ? (await readProjectText(root, MEMORY_REL)) ?? undefined : undefined;
          const skills = Object.values(useWorkflowStore.getState().subgraphs).map((s) => s.name);
          runReview({
            kind: '_COMBINED',
            reviewerAgent,
            context: { goal: workflowName, trace: sink.toTraceText(), memory, skills },
            async: true,
            projectRoot: root,
          });
        } catch (e) {
          rt.addLog('warn', `复盘触发失败（不影响本次运行）：${e instanceof Error ? e.message : String(e)}`);
        }
      })();
    }
  }

  // 非循环工作流 + 正常跑完（无失败、未被手动停止）：将「运行指针」回退到第一个节点
  const finishedClean = !hasLoop && failed.size === 0 && !signal.aborted;
  if (finishedClean) {
    const firstId = stages[0]?.[0] ?? nodes[0]?.id;
    if (firstId && firstId !== store.selectedNodeId) {
      store.setSelected(firstId, wfId);
    }
    rt.addLog('info', '工作流已就绪，运行指针已回到首个节点，可直接开始下一个任务');
  }

  // 返回明确运行结果（H3b 编排器依赖：status 判定执行成败，runId 精确对应本次运行）
  return { status, runId: myRun };
}
