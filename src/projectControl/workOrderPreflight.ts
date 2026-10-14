import type { DomainEvent } from '../domain/contracts';

export const WORK_ORDER_PREFLIGHT_COMPLETED_EVENT = 'WorkOrderPreflightCompleted' as const;
export const WORK_ORDER_PREFLIGHT_WAIVED_EVENT = 'WorkOrderPreflightWaived' as const;

export const PREFLIGHT_PROMPT = `你稍后要独立完成下面这份施工单。现在不要写代码，也不要给方案。
逐条列出你必须靠猜才能动手的地方。只输出一个 JSON 数组，每条是一个对象，包含：
- quote：施工单里引起猜测的原文（逐字复制）
- question：你需要谁回答什么
- consequence：猜错会影响验收、接口、范围，还是只影响风格
- severity：猜错会影响验收、接口或范围时写 "blocking"，只影响风格或细节时写 "minor"
- options：可选，你能想到的几种理解（字符串数组）
没有需要猜的地方就输出 []。`;

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
  droppedCount: number;
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

/** Accept only well-shaped clarification points whose quote occurs in the current work-order text; malformed items are dropped.
 * A `blocking` result marks ambiguity, not approval or permission to proceed (ADR-SM-029).
 */
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

function unwrapJsonFence(raw: string): string {
  const match = raw.trim().match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
  return match?.[1] ?? raw;
}

export function parsePreflightResponse(raw: string, workOrderText: string): WorkOrderPreflightAssessment {
  let decoded: unknown;
  try {
    decoded = JSON.parse(unwrapJsonFence(raw)) as unknown;
  } catch {
    return { verdict: 'unknown', guessPoints: [], droppedCount: 0 };
  }
  if (!Array.isArray(decoded)) return { verdict: 'unknown', guessPoints: [], droppedCount: 0 };
  const guessPoints = decoded
    .map((item) => parseGuessPoint(item, workOrderText))
    .filter((item): item is WorkOrderPreflightGuessPoint => item !== undefined);
  const droppedCount = decoded.length - guessPoints.length;
  // Minor points stay visible in shadow records but do not make approval ambiguous.
  const verdict = decoded.length > 0 && guessPoints.length === 0
    ? 'unknown'
    : guessPoints.some((point) => point.severity === 'blocking') ? 'ambiguous' : 'clear';
  return { verdict, guessPoints, droppedCount };
}

export function isPreflightCurrent(
  record: Pick<WorkOrderPreflightRecord, 'workOrderDigest'>,
  currentDigest: string,
): boolean {
  return record.workOrderDigest === currentDigest;
}
