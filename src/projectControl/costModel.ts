export const MIN_SAMPLES = 5;

export type CostMetricResult =
  | { status: 'insufficient-data' }
  | { status: 'ok'; value: number; sampleCount: number };

export interface ExpectedCostPerAcceptedInput {
  attemptCost: number;
  reviewCost: number;
  passRate: number;
  sampleCount: number;
}

export interface BudgetedTaskAcceptance {
  budget: number;
  acceptancePassed: boolean;
}

export interface CpiInput {
  earnedValue: number;
  actualCost: number;
  sampleCount: number;
}

export interface EstimateAtCompletionInput extends CpiInput {
  totalBudget: number;
}

function isSampleCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertFiniteNonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${field} must be a finite non-negative number`);
}

function result(value: number, sampleCount: number): CostMetricResult {
  if (!Number.isFinite(value)) return { status: 'insufficient-data' };
  return { status: 'ok', value, sampleCount };
}

export function expectedCostPerAccepted(input: ExpectedCostPerAcceptedInput): CostMetricResult {
  assertFiniteNonNegative(input.attemptCost, 'attemptCost');
  assertFiniteNonNegative(input.reviewCost, 'reviewCost');
  if (!isSampleCount(input.sampleCount)) throw new RangeError('sampleCount must be a non-negative safe integer');
  if (!Number.isFinite(input.passRate) || input.passRate < 0 || input.passRate > 1) {
    throw new RangeError('passRate must be between 0 and 1');
  }
  if (input.sampleCount < MIN_SAMPLES || input.passRate === 0) return { status: 'insufficient-data' };
  return result((input.attemptCost + input.reviewCost) / input.passRate, input.sampleCount);
}

/** Earn budget only for tasks whose host acceptance passed. */
export function earnedValue(input: { tasks: readonly BudgetedTaskAcceptance[] }): CostMetricResult {
  for (const task of input.tasks) assertFiniteNonNegative(task.budget, 'task budget');
  if (input.tasks.length < MIN_SAMPLES) return { status: 'insufficient-data' };
  const value = input.tasks.reduce(
    (sum, task) => sum + (task.acceptancePassed ? task.budget : 0),
    0,
  );
  return result(value, input.tasks.length);
}

export function cpi(input: CpiInput): CostMetricResult {
  assertFiniteNonNegative(input.earnedValue, 'earnedValue');
  assertFiniteNonNegative(input.actualCost, 'actualCost');
  if (!isSampleCount(input.sampleCount)) throw new RangeError('sampleCount must be a non-negative safe integer');
  if (input.sampleCount < MIN_SAMPLES || input.actualCost === 0) return { status: 'insufficient-data' };
  return result(input.earnedValue / input.actualCost, input.sampleCount);
}

export function estimateAtCompletion(input: EstimateAtCompletionInput): CostMetricResult {
  assertFiniteNonNegative(input.totalBudget, 'totalBudget');
  assertFiniteNonNegative(input.earnedValue, 'earnedValue');
  assertFiniteNonNegative(input.actualCost, 'actualCost');
  if (!isSampleCount(input.sampleCount)) throw new RangeError('sampleCount must be a non-negative safe integer');
  if (input.sampleCount < MIN_SAMPLES || input.earnedValue === 0 || input.actualCost === 0) {
    return { status: 'insufficient-data' };
  }
  const cpiValue = input.earnedValue / input.actualCost;
  return result(input.totalBudget / cpiValue, input.sampleCount);
}
