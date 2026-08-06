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
import type {
  AssetMeta,
  CostRecord,
  FlowEdge,
  LogEntry,
  NodeStatus,
  RunProgressShape,
  RunRecord,
  WorkflowNodeData,
} from '../types';
import { useWorkflowStore } from '../store/workflowStore';

/**
 * 执行引擎对外输出的运行时动作（聚焦「输出」侧，便于解耦与测试替身）。
 *
 * 接缝范围：executor 调度内核里的全部「只写」动作——日志 / 进度 / 历史 / 成本 / 节点状态 / 资产 / 边。
 * 读侧（defs / agents / variables / projectVariables / assets / llmChannel / workflows / nodes）
 * 仍属「输入」，留待后续 builtin / workflowStore 拆分处理，不在此接缝内。
 */
export interface ExecutionRuntime {
  /** 追加一条运行日志 */
  addLog: (level: LogEntry['level'], message: string) => void;
  /** 上报调度进度（层 / 轮次） */
  setRunProgress: (p: Partial<RunProgressShape>, wfId?: string) => void;
  /** 记录一条运行历史 */
  pushRunHistory: (rec: RunRecord) => void;
  /** 写回成本账本快照（运行期实时回写，供 Companion 浮窗读取） */
  setCostLog: (log: CostRecord[]) => void;
  /** 重置成本统计 */
  resetUsage: () => void;
  /** 更新单个节点运行状态（running/success/error/...）与附带的数据补丁 */
  setNodeStatus: (
    id: string,
    status: NodeStatus,
    patch?: Partial<WorkflowNodeData>,
    wfId?: string,
  ) => void;
  /** 写入一条资产（项目级库与当前工作流库合并） */
  addAsset: (meta: AssetMeta) => void;
  /** 以函数式更新替换边集合（执行引擎写回 task 连线 scope 时调用） */
  setEdges: (updater: (edges: FlowEdge[]) => FlowEdge[]) => void;
}

/** 基于 Zustand workflowStore 的默认运行时实现（委托现有 store，行为完全等价） */
export function createStoreRuntime(_wfId: string): ExecutionRuntime {
  const store = () => useWorkflowStore.getState();
  return {
    addLog: (level, message) => store().addLog(level, message),
    setRunProgress: (p, wfId) => store().setRunProgress(p, wfId),
    pushRunHistory: (rec) => store().pushRunHistory(rec),
    setCostLog: (log) => store().setCostLog(log),
    resetUsage: () => store().resetUsage(),
    setNodeStatus: (id, status, patch, wfId) => store().setNodeStatus(id, status, patch, wfId),
    addAsset: (meta) => store().addAsset(meta),
    setEdges: (updater) => store().setEdges(updater),
  };
}
