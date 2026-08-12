/**
 * H4 DevEvaluator：确定性验收判定（docs/H4_SELF_DEVELOPMENT_FOUNDATION.md §4）。
 *
 * 依据「针对任务的验收规则」+「宿主采集的证据」判定通过/失败，而非固定公式——
 * 例如 exitCode===0 并不总是等于任务完成（可能 typecheck 过了但碰了保护路径、
 * 测试过了但没有实际 diff）。uncertainties 来自模型，不作为事实证据来源。
 */
import type { DevAcceptance, EvidenceRecord } from './evidence';

/** 验收规则：一条规则对应一条必须满足的证据。 */
export interface AcceptanceRule {
  id: string;
  kind: EvidenceRecord['kind'];
  /** 限定匹配某条命令（command/test 类用） */
  command?: string;
  /** 非零退出码也视为通过（验收分支是预期失败时用） */
  acceptNonZero?: boolean;
}

/** 单条规则是否满足（依据证据记录判定）。 */
function ruleSatisfied(rule: AcceptanceRule, evidence: readonly EvidenceRecord[]): boolean {
  const matches = evidence.filter(
    (e) => e.kind === rule.kind && (!rule.command || e.command === rule.command),
  );
  if (matches.length === 0) return false; // 无证据 = 未满足（不得用「没有失败」当通过）

  switch (rule.kind) {
    case 'command':
    case 'test': {
      // 取最近一条作为判定基准；exitCode 缺失视为未通过
      const last = matches[matches.length - 1];
      if (last.exitCode == null) return false;
      if (rule.acceptNonZero) return true;
      return last.exitCode === 0;
    }
    case 'path-policy':
      return matches.some((e) => e.status === 'passed');
    case 'diff':
      // diff 证据由宿主在「确认有改动」时采集；存在即视为满足。
      // 注意：不依赖 headRevision/baseRevision（对 worktree 未提交修改不适用）。
      return matches.some((e) => e.status === 'passed');
    case 'artifact':
      return matches.some((e) => e.status === 'passed' || !!e.contentHash);
    default:
      return false;
  }
}

/**
 * 确定性验收：
 * - 所有规则满足 → 通过；
 * - **changedProtectedPaths 非空 → 硬失败（P1 审计修复）**——即使测试全绿，只要改动受保护
 *   路径（workflowStore/executor/sandbox/capabilities/orchestrator）就不得自动验收，
 *   除非存在明确的人工批准证据（MVP 阶段一律硬失败，留待人工 diff 审查）；
 * - uncertainties 只记录模型不确定性，不直接置 failed——但上层可据此要求人工复核。
 */
export function evaluateDevAcceptance(
  rules: AcceptanceRule[],
  evidence: readonly EvidenceRecord[],
  changedProtectedPaths: string[],
  uncertainties: string[] = [],
): DevAcceptance {
  const failedChecks: string[] = [];
  for (const rule of rules) {
    if (!ruleSatisfied(rule, evidence)) failedChecks.push(rule.id);
  }
  const protectedTouched = changedProtectedPaths.length > 0;
  const passed = failedChecks.length === 0 && !protectedTouched;
  return {
    passed,
    requiredChecks: rules.map((r) => r.id),
    failedChecks: protectedTouched ? [...failedChecks, 'protected-paths'] : failedChecks,
    changedProtectedPaths,
    uncertainties,
  };
}
