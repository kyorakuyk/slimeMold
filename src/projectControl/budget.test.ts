import { describe, expect, it } from 'vitest';
import {
  createBudgetLedger,
  reserveBudget,
  settleBudget,
  type BudgetUsage,
} from './budget';

const limit: BudgetUsage = {
  tokens: 1_000,
  calls: 2,
  moneyCents: 100,
  durationMs: 10_000,
};

describe('deterministic budget manager', () => {
  it('reserves capacity before execution and settles actual usage', () => {
    let ledger = createBudgetLedger('project-1', 'budget-1', limit);
    const reservation = reserveBudget(ledger, {
      reservationId: 'reservation-1',
      taskId: 'task-1',
      requested: { tokens: 600, calls: 1, moneyCents: 40, durationMs: 4_000 },
    });
    ledger = reservation.ledger;

    const settled = settleBudget(ledger, {
      reservationId: 'reservation-1',
      actual: { tokens: 500, calls: 1, moneyCents: 35, durationMs: 3_000 },
    });

    expect(settled.outcome).toBe('within-budget');
    expect(settled.ledger).toMatchObject({
      consumed: { tokens: 500, calls: 1, moneyCents: 35, durationMs: 3_000 },
      reserved: { tokens: 0, calls: 0, moneyCents: 0, durationMs: 0 },
    });
  });

  it('rejects a reservation that exceeds remaining capacity', () => {
    const ledger = createBudgetLedger('project-1', 'budget-1', limit);
    const first = reserveBudget(ledger, {
      reservationId: 'reservation-1',
      taskId: 'task-1',
      requested: { tokens: 600, calls: 1, moneyCents: 40, durationMs: 4_000 },
    }).ledger;

    expect(() => reserveBudget(first, {
      reservationId: 'reservation-2',
      taskId: 'task-2',
      requested: { tokens: 500, calls: 1, moneyCents: 40, durationMs: 4_000 },
    })).toThrow(/budget|预算|capacity/);
  });

  it('records over-budget settlement and rejects unknown reservations', () => {
    const ledger = createBudgetLedger('project-1', 'budget-1', limit);
    const reserved = reserveBudget(ledger, {
      reservationId: 'reservation-1',
      taskId: 'task-1',
      requested: { tokens: 500, calls: 1, moneyCents: 40, durationMs: 4_000 },
    }).ledger;

    const settled = settleBudget(reserved, {
      reservationId: 'reservation-1',
      actual: { tokens: 1_200, calls: 1, moneyCents: 40, durationMs: 4_000 },
    });
    expect(settled.outcome).toBe('over-budget');
    expect(() => settleBudget(ledger, {
      reservationId: 'missing',
      actual: { tokens: 1, calls: 1, moneyCents: 1, durationMs: 1 },
    })).toThrow(/reservation|预算/);
  });

  it('rejects unsafe aggregate usage instead of creating an imprecise ledger', () => {
    const ledger = createBudgetLedger('project-1', 'budget-large', {
      tokens: Number.MAX_SAFE_INTEGER,
      calls: 2,
      moneyCents: 100,
      durationMs: 10_000,
    });
    const reserved = reserveBudget(ledger, {
      reservationId: 'reservation-large',
      taskId: 'task-large',
      requested: { tokens: 1, calls: 1, moneyCents: 1, durationMs: 1 },
    }).ledger;
    const corrupted = {
      ...reserved,
      consumed: { ...reserved.consumed, tokens: Number.MAX_SAFE_INTEGER },
    };

    expect(() => settleBudget(corrupted, {
      reservationId: 'reservation-large',
      actual: { tokens: 1, calls: 1, moneyCents: 1, durationMs: 1 },
    })).toThrow(/overflow|safe|预算/);
  });
});
