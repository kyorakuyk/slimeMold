export interface BudgetUsage {
  tokens: number;
  calls: number;
  moneyCents: number;
  durationMs: number;
}

export interface BudgetReservation {
  reservationId: string;
  projectId: string;
  taskId: string;
  requested: BudgetUsage;
}

export interface BudgetLedger {
  version: 1;
  budgetId: string;
  projectId: string;
  limits: BudgetUsage;
  reserved: BudgetUsage;
  consumed: BudgetUsage;
  reservations: Record<string, BudgetReservation>;
}

export interface ReserveBudgetInput {
  reservationId: string;
  projectId?: string;
  taskId: string;
  requested: BudgetUsage;
}

export interface SettleBudgetInput {
  reservationId: string;
  projectId?: string;
  actual: BudgetUsage;
}

export interface BudgetReservationResult {
  ledger: BudgetLedger;
  reservation: BudgetReservation;
}

export interface BudgetSettlementResult {
  ledger: BudgetLedger;
  outcome: 'within-budget' | 'over-budget';
  reservation: BudgetReservation;
}

const USAGE_KEYS: readonly (keyof BudgetUsage)[] = ['tokens', 'calls', 'moneyCents', 'durationMs'];

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  return normalized;
}

function validateUsage(usage: BudgetUsage, field: string): BudgetUsage {
  for (const key of USAGE_KEYS) {
    const value = usage[key];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${field}.${key} 必须是非负安全整数`);
    }
  }
  return { ...usage };
}

function zeroUsage(): BudgetUsage {
  return { tokens: 0, calls: 0, moneyCents: 0, durationMs: 0 };
}

function addUsage(left: BudgetUsage, right: BudgetUsage): BudgetUsage {
  const result = {} as BudgetUsage;
  for (const key of USAGE_KEYS) {
    const sum = left[key] + right[key];
    if (!Number.isSafeInteger(sum)) throw new Error(`budget usage overflow：${key}`);
    result[key] = sum;
  }
  return result;
}

function subtractUsage(left: BudgetUsage, right: BudgetUsage): BudgetUsage {
  return {
    tokens: left.tokens - right.tokens,
    calls: left.calls - right.calls,
    moneyCents: left.moneyCents - right.moneyCents,
    durationMs: left.durationMs - right.durationMs,
  };
}

function exceeds(left: BudgetUsage, right: BudgetUsage): boolean {
  return USAGE_KEYS.some((key) => left[key] > right[key]);
}

function cloneLedger(ledger: BudgetLedger): BudgetLedger {
  return {
    ...ledger,
    limits: { ...ledger.limits },
    reserved: { ...ledger.reserved },
    consumed: { ...ledger.consumed },
    reservations: Object.fromEntries(
      Object.entries(ledger.reservations).map(([id, reservation]) => [id, {
        ...reservation,
        requested: { ...reservation.requested },
      }]),
    ),
  };
}

export function createBudgetLedger(
  projectId: string,
  budgetId: string,
  limits: BudgetUsage,
): BudgetLedger {
  return {
    version: 1,
    projectId: requiredText(projectId, 'projectId'),
    budgetId: requiredText(budgetId, 'budgetId'),
    limits: validateUsage(limits, 'limits'),
    reserved: zeroUsage(),
    consumed: zeroUsage(),
    reservations: {},
  };
}

export function reserveBudget(
  ledger: BudgetLedger,
  input: ReserveBudgetInput,
): BudgetReservationResult {
  const next = cloneLedger(ledger);
  const reservationId = requiredText(input.reservationId, 'reservationId');
  const projectId = input.projectId === undefined
    ? next.projectId
    : requiredText(input.projectId, 'projectId');
  if (projectId !== next.projectId) throw new Error('reservation 不属于当前 project');
  const taskId = requiredText(input.taskId, 'taskId');
  const requested = validateUsage(input.requested, 'requested');
  const existing = next.reservations[reservationId];
  if (existing) {
    if (JSON.stringify(existing.requested) === JSON.stringify(requested)
      && existing.taskId === taskId
      && existing.projectId === projectId) {
      return { ledger: next, reservation: { ...existing, requested: { ...existing.requested } } };
    }
    throw new Error(`reservationId 已存在但内容不同：${reservationId}`);
  }
  const available = subtractUsage(next.limits, addUsage(next.consumed, next.reserved));
  if (exceeds(requested, available)) throw new Error(`预算 capacity 不足：${reservationId}`);
  const reservation: BudgetReservation = { reservationId, projectId, taskId, requested };
  next.reservations[reservationId] = reservation;
  next.reserved = addUsage(next.reserved, requested);
  return { ledger: next, reservation: { ...reservation, requested: { ...requested } } };
}

export function settleBudget(
  ledger: BudgetLedger,
  input: SettleBudgetInput,
): BudgetSettlementResult {
  const next = cloneLedger(ledger);
  const reservationId = requiredText(input.reservationId, 'reservationId');
  const reservation = next.reservations[reservationId];
  if (!reservation) throw new Error(`不存在的 budget reservation：${reservationId}`);
  const projectId = input.projectId === undefined
    ? next.projectId
    : requiredText(input.projectId, 'projectId');
  if (projectId !== next.projectId || reservation.projectId !== projectId) {
    throw new Error('settlement 不属于当前 project');
  }
  const actual = validateUsage(input.actual, 'actual');
  delete next.reservations[reservationId];
  next.reserved = subtractUsage(next.reserved, reservation.requested);
  next.consumed = addUsage(next.consumed, actual);
  const outcome = exceeds(actual, reservation.requested) || exceeds(next.consumed, next.limits)
    ? 'over-budget'
    : 'within-budget';
  return {
    ledger: next,
    outcome,
    reservation: { ...reservation, requested: { ...reservation.requested } },
  };
}
