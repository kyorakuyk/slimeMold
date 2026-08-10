/**
 * runLoop.ts — 循环控制辅助（executor 拆分第三刀，Codex 推荐「收尾 → 调度 → 循环」）。
 *
 * 把 runWorkflow 主循环里与「循环语义」相关的纯逻辑抽离：
 * - `prepareLoopRound`：每轮开始前把循环变量注入 dirtySet/force，并清缓存使循环体强制重算；
 *   同时递增循环变量（round 值）。
 * - 继续判定仍复用 graphAlgo.shouldContinueLoop（已有纯函数，无需重复）。
 *
 * 设计原则：纯函数，不持有 store；dirtySet/force/loopVarsState 作为可变容器传入。
 */
import type { FlowNode } from '../types';

/** 每轮循环的循环体信息：gateId → 循环体节点 id 集合（来自 runPlan 的 loopBodyOf）。 */
export type LoopBodies = Map<string, Set<string>>;

/**
 * 每轮开始前的循环变量注入：
 * - round > 0 时，把每个 loopGate 的循环体节点加入 dirtySet/force，并 strike 其缓存
 *   （避免循环体命中上一轮缓存结果）；
 * - 递增该 gate 的循环变量为当前 round 值。
 *
 * 关键：loopGate 自身也必须 force 每轮重新执行——它的 cacheKey 不含循环变量值，
 * 若命中缓存会直接返回上轮 outputs、setBranches/onGate 不再触发，gateTaken 无记录
 * 导致循环误判停止。force 保证每轮重算条件、上报分支，循环才能真正跑满。
 *
 * 纯函数：修改传入的 dirtySet / force / loopVarsState（与 executor 共享引用），返回 void。
 */
export function prepareLoopRound(args: {
  round: number;
  loopBodies: LoopBodies;
  loopVarOf: Map<string, string>;
  nodeById: Map<string, FlowNode>;
  dirtySet: Set<string>;
  force: Set<string>;
  loopVarsState: Record<string, number>;
  strike: (typeId: string) => void;
}): void {
  const { round, loopBodies, loopVarOf, nodeById, dirtySet, force, loopVarsState, strike } = args;
  if (round <= 0) return;
  for (const [gid, body] of loopBodies) {
    // loopGate 自身每轮强制重算（见上方注释：防缓存命中吞掉分支上报）
    dirtySet.add(gid);
    force.add(gid);
    strike(nodeById.get(gid)?.data.typeId ?? '');
    for (const bid of body) {
      dirtySet.add(bid);
      force.add(bid);
      strike(nodeById.get(bid)?.data.typeId ?? '');
    }
    const lv = loopVarOf.get(gid);
    if (lv) loopVarsState[lv] = round;
  }
}

/**
 * 轮次递增后的收尾日志判定（纯函数，返回日志文案；空数组表示不记日志）。
 * - reachedMax：已达最大轮数，输出强制结束提示
 */
export function loopLogMessages(args: {
  round: number;
  maxRounds: number;
  reachedMax: boolean;
}): string[] {
  const { maxRounds, reachedMax } = args;
  const msgs: string[] = [];
  if (reachedMax) msgs.push(`已达到最大循环轮数 ${maxRounds}，强制结束循环`);
  return msgs;
}
