import type { DomainEvent } from '../domain/contracts';

export const WORK_ORDER_PREFLIGHT_COMPLETED_EVENT = 'WorkOrderPreflightCompleted' as const;
export const WORK_ORDER_PREFLIGHT_WAIVED_EVENT = 'WorkOrderPreflightWaived' as const;

export const PREFLIGHT_PROMPT = `你稍后要独立完成下面这份施工单。现在不要写代码，也不要给方案。
逐条列出你必须靠猜才能动手的地方，每条给出：
- quote：施工单里引起猜测的原文（逐字复制）
- question：你需要谁回答什么
- consequence：猜错会影响验收、接口、范围，还是只影响风格
没有需要猜的地方就返回空列表。只输出 JSON。`;

export type WorkOrderPreflightVerdict = 'clear' | 'ambiguous' | 'unknown';
export type WorkOrderPreflightSeverity = 'blocking' | 'minor';
export type WorkOrderPreflightMode = 'shadow' | 'gate';

export type WorkOrderPreflightCost =
  | { status: 'not-metered' }
  | { status: 'metered'; amountUsd: number };

export interface WorkOrderPreflightGuessPoint {
  quote: string;
  question: string;
  consequence: string;
  severity: WorkOrderPreflightSeverity;
  options?: string[];
}

export interface WorkOrderPreflightAssessment {
  verdict: WorkOrderPreflightVerdict;
  guessPoints: WorkOrderPreflightGuessPoint[];
}

export interface WorkOrderPreflightRecord extends WorkOrderPreflightAssessment {
  preflightId: string;
  taskGraphId: string;
  taskId: string;
  graphVersion: number;
  workOrderDigest: string;
  model: string;
  cost: WorkOrderPreflightCost;
  mode: WorkOrderPreflightMode;
  createdAt: string;
}

export type WorkOrderPreflightCompletedPayload = WorkOrderPreflightRecord;

export interface WorkOrderPreflightWaivedPayload {
  preflightId: string;
  taskGraphId: string;
  taskId: string;
  graphVersion: number;
  workOrderDigest: string;
  decisionId: string;
  mode: 'shadow' | 'gate';
  createdAt: string;
}

export type WorkOrderPreflightCompletedEvent = DomainEvent<WorkOrderPreflightCompletedPayload> & {
  eventType: typeof WORK_ORDER_PREFLIGHT_COMPLETED_EVENT;
};

export type WorkOrderPreflightWaivedEvent = DomainEvent<WorkOrderPreflightWaivedPayload> & {
  eventType: typeof WORK_ORDER_PREFLIGHT_WAIVED_EVENT;
};

const FNV64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const FNV64_MASK = 0xffffffffffffffffn;

/** Deterministic cache digest only; it is not a security hash or authority proof. */
export function workOrderDigest(text: string): string {
  let hash = FNV64_OFFSET_BASIS;
  for (const byte of new TextEncoder().encode(text)) {
    hash = ((hash ^ BigInt(byte)) * FNV64_PRIME) & FNV64_MASK;
  }
  return hash.toString(16).padStart(16, '0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseGuessPoint(value: unknown, workOrderText: string): WorkOrderPreflightGuessPoint | undefined {
  if (!isRecord(value)) return undefined;
  const { quote, question, consequence, severity, options } = value;
  if (
    typeof quote !== 'string' || !quote.trim() || !workOrderText.includes(quote) ||
    typeof question !== 'string' || !question.trim() ||
    typeof consequence !== 'string' || !consequence.trim() ||
    (severity !== 'blocking' && severity !== 'minor')
  ) return undefined;
  if (options !== undefined && (!Array.isArray(options) || options.some((option) => typeof option !== 'string'))) {
    return undefined;
  }
  return {
    quote,
    question: question.trim(),
    consequence: consequence.trim(),
    severity,
    ...(Array.isArray(options) ? { options: options.map((option) => option.trim()).filter(Boolean) } : {}),
  };
}

export function parsePreflightResponse(raw: string, workOrderText: string): WorkOrderPreflightAssessment {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    return { verdict: 'unknown', guessPoints: [] };
  }
  if (!Array.isArray(decoded)) return { verdict: 'unknown', guessPoints: [] };
  const guessPoints = decoded
    .map((item) => parseGuessPoint(item, workOrderText))
    .filter((item): item is WorkOrderPreflightGuessPoint => item !== undefined);
  // Minor points stay visible in shadow records but do not make approval ambiguous.
  const verdict = guessPoints.some((point) => point.severity === 'blocking') ? 'ambiguous' : 'clear';
  return { verdict, guessPoints };
}

export function isPreflightCurrent(
  record: Pick<WorkOrderPreflightRecord, 'workOrderDigest'>,
  currentDigest: string,
): boolean {
  return record.workOrderDigest === currentDigest;
}
