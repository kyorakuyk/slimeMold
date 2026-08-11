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
      return matches.some((e) => !!e.headRevision && e.headRevision !== e.baseRevision);
    case 'artifact':
      return matches.some((e) => e.status === 'passed' || !!e.contentHash);
    default:
      return false;
  }
}

/**
 * 确定性验收：所有规则满足 → passed；否则列出 failedChecks。
 * changedProtectedPaths 由能力层在 diff/path-policy 检查时采集传入（负向证据）。
 * uncertainties 只记录模型不确定性，不直接置 failed——但上层可据此要求人工复核。
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
  return {
    passed: failedChecks.length === 0,
    requiredChecks: rules.map((r) => r.id),
    failedChecks,
    changedProtectedPaths,
    uncertainties,
  };
}
