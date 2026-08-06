/**
 * runtime.ts — 执行引擎与具体状态存储之间的「解耦接缝」。
 *
 * 背景：Codex 分析指出 executor 直接 `useWorkflowStore.getState()` 会导致执行引擎与 UI 状态紧耦合，
 * 难以在 CLI / headless / 测试中替换实现。为渐进解耦，这里先定义一组「只写不读」的输出动作接口
 * `ExecutionRuntime`（日志 / 进度 / 历史 / 成本），并提供基于 Zustand store 的默认实现。
 *
 * 后续步骤可把更多 store 访问收口到该接口（或提供测试桩 / 无头实现），从而让 executor 不依赖具体 store。
 * 当前阶段：工厂实现仍委托 store，行为完全等价，仅建立接缝、零回归。
 */
import type { CostRecord, LogEntry, RunProgressShape, RunRecord } from '../types';
import { useWorkflowStore } from '../store/workflowStore';

/** 执行引擎对外输出的运行时动作（聚焦「输出」侧，便于解耦与测试替身） */
export interface ExecutionRuntime {
  /** 追加一条运行日志 */
  addLog: (level: LogEntry['level'], message: string) => void;
  /** 上报调度进度（层 / 轮次） */
  setRunProgress: (p: Partial<RunProgressShape>, wfId?: string) => void;
  /** 记录一条运行历史 */
  pushRunHistory: (rec: RunRecord) => void;
  /** 写回成本账本快照 */
  setCostLog: (log: CostRecord[]) => void;
  /** 重置成本统计 */
  resetUsage: () => void;
}

/** 基于 Zustand workflowStore 的默认运行时实现（委托现有 store，行为等价） */
export function createStoreRuntime(_wfId: string): ExecutionRuntime {
  const store = () => useWorkflowStore.getState();
  return {
    addLog: (level, message) => store().addLog(level, message),
    setRunProgress: (p, wfId) => store().setRunProgress(p, wfId),
    pushRunHistory: (rec) => store().pushRunHistory(rec),
    setCostLog: (log) => store().setCostLog(log),
    resetUsage: () => store().resetUsage(),
  };
}
