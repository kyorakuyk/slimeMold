/**
 * workflowId.ts — 工作流 ID 生成器。
 *
 * 既有形态是 `wf-<毫秒时间戳>`；同一毫秒内连续创建会得到相同 ID，后创建的工作流会覆盖先创建的。
 * 这里保留原形态与时间部分，只在与既有 ID 冲突时追加递增后缀。
 */

const WORKFLOW_ID_PREFIX = 'wf-';

/**
 * 生成工作流 ID。
 * @param now 时间戳部分（调用方提供，便于测试固定时钟）
 * @param taken 当前上下文里已存在（或本次已发出）的工作流 ID
 */
export function createWorkflowId(now: number, taken: Iterable<string> = []): string {
  const existing = new Set(taken);
  const base = `${WORKFLOW_ID_PREFIX}${now}`;
  let candidate = base;
  let suffix = 2;
  while (existing.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}
