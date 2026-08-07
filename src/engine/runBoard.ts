/**
 * runBoard.ts — Job Board 运行看板的「事件流 → 渲染快照」纯归约。
 *
 * 背景：Codex 第二阶段 A2——「JobBoard 改消费事件流（而非直接读 store 零散字段）」。
 * JobBoard 不再从 workflowStore 读 runStates / runProgress / nodes[].data.status，
 * 而是订阅统一事件总线，经 applyRunEvent 归约出本次运行的渲染快照。
 *
 * 设计原则：
 * - 纯函数、零 store / React 依赖，可在 jsdom 环境下直接单测。
 * - 事件过滤按 wfId（拆分视图左右栏独立看板）。
 * - run.created 重置快照（新一轮运行从空白开始），终态事件置 running=false。
 */
import type { RunEvent } from './runEvents';

/** JobBoard 关心的节点状态（事件流归约后的最小展示面）。 */
export interface BoardNode {
  label: string;
  typeId: string;
  status: string;
  durationMs: number | null;
  error?: string;
}

/** 一次运行的看板渲染快照。 */
export interface RunBoardState {
  wfId: string;
  runId: number | null;
  running: boolean;
  nodeCount: number;
  progress: {
    layer: number;
    totalLayers: number;
    round: number;
    totalRounds: number;
  };
  nodes: Record<string, BoardNode>;
}

export function initialBoardState(wfId: string): RunBoardState {
  return {
    wfId,
    runId: null,
    running: false,
    nodeCount: 0,
    progress: { layer: 0, totalLayers: 0, round: 0, totalRounds: 0 },
    nodes: {},
  };
}

/** 把单个事件归约进快照（事件 wfId 不匹配时原样返回）。 */
export function applyRunEvent(state: RunBoardState, e: RunEvent): RunBoardState {
  if (e.wfId !== state.wfId) return state;
  const nid = e.nodeId ?? '';
  switch (e.kind) {
    case 'run.created': {
      const p = (e.payload ?? {}) as { nodeCount?: number };
      return {
        ...state,
        runId: e.runId,
        nodeCount: p.nodeCount ?? 0,
        running: false,
        progress: { layer: 0, totalLayers: 0, round: 0, totalRounds: 0 },
        nodes: {},
      };
    }
    case 'run.started':
      return { ...state, running: true };
    case 'run.progress': {
      const p = e.payload ?? {};
      return {
        ...state,
        progress: {
          layer: (p.layer as number) ?? state.progress.layer,
          totalLayers: (p.totalLayers as number) ?? state.progress.totalLayers,
          round: (p.round as number) ?? state.progress.round,
          totalRounds: (p.totalRounds as number) ?? state.progress.totalRounds,
        },
      };
    }
    case 'node.started': {
      const p = (e.payload ?? {}) as { label?: string; typeId?: string };
      return {
        ...state,
        nodes: {
          ...state.nodes,
          [nid]: {
            label: p.label ?? nid,
            typeId: p.typeId ?? '',
            status: 'running',
            durationMs: null,
          },
        },
      };
    }
    case 'node.completed': {
      const prev = state.nodes[nid];
      const p = (e.payload ?? {}) as { status?: string; label?: string; typeId?: string; durationMs?: number };
      return {
        ...state,
        nodes: {
          ...state.nodes,
          [nid]: {
            label: p.label ?? prev?.label ?? nid,
            typeId: p.typeId ?? prev?.typeId ?? '',
            status: p.status ?? 'success',
            durationMs: p.durationMs ?? prev?.durationMs ?? null,
          },
        },
      };
    }
    case 'node.failed': {
      const prev = state.nodes[nid];
      const p = (e.payload ?? {}) as { error?: string; label?: string; typeId?: string; durationMs?: number };
      return {
        ...state,
        nodes: {
          ...state.nodes,
          [nid]: {
            label: p.label ?? prev?.label ?? nid,
            typeId: p.typeId ?? prev?.typeId ?? '',
            status: 'error',
            durationMs: p.durationMs ?? prev?.durationMs ?? null,
            error: p.error,
          },
        },
      };
    }
    case 'node.skipped': {
      const prev = state.nodes[nid];
      const p = (e.payload ?? {}) as { status?: string; label?: string; typeId?: string };
      return {
        ...state,
        nodes: {
          ...state.nodes,
          [nid]: {
            label: p.label ?? prev?.label ?? nid,
            typeId: p.typeId ?? prev?.typeId ?? '',
            status: p.status ?? prev?.status ?? 'skipped',
            durationMs: prev?.durationMs ?? null,
          },
        },
      };
    }
    case 'run.completed':
    case 'run.failed':
    case 'run.aborted':
      return { ...state, running: false };
    default:
      return state;
  }
}

/**
 * 挂载即同步（replay）：给定 wfId 的完整历史事件，归约出该 wfId 最近一次运行的快照。
 * 从最近一条 run.created 起回放，忽略更早的运行（JobBoard 只展示「当前/最近」运行）。
 */
export function replayBoardState(wfId: string, events: RunEvent[]): RunBoardState {
  let st = initialBoardState(wfId);
  let inRun = false;
  for (const e of events) {
    if (e.wfId !== wfId) continue;
    if (e.kind === 'run.created') {
      st = initialBoardState(wfId);
      inRun = true;
    }
    if (!inRun) continue;
    st = applyRunEvent(st, e);
  }
  return st;
}
