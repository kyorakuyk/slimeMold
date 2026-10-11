import { describe, expect, it } from 'vitest';
import {
  MIN_SAMPLES,
  cpi,
  earnedValue,
  estimateAtCompletion,
  expectedCostPerAccepted,
} from './costModel';

describe('cost model pure metrics', () => {
  it('calculates expected cost per accepted task from attempts, review, and pass rate', () => {
    expect(expectedCostPerAccepted({
      attemptCost: 1,
      reviewCost: 1,
      passRate: 0.4,
      sampleCount: MIN_SAMPLES,
    })).toEqual({ status: 'ok', value: 5, sampleCount: MIN_SAMPLES });
  });

  it('matches the second approved expected-cost example', () => {
    expect(expectedCostPerAccepted({
      attemptCost: 3,
      reviewCost: 1,
      passRate: 0.9,
      sampleCount: MIN_SAMPLES,
    })).toMatchObject({ status: 'ok', value: 4.444444444444445 });
  });

  it('returns insufficient-data without a numeric result below the sample threshold', () => {
    const result = expectedCostPerAccepted({
      attemptCost: 1,
      reviewCost: 1,
      passRate: 0.4,
      sampleCount: MIN_SAMPLES - 1,
    });
    expect(result.status).toBe('insufficient-data');
    expect(result).not.toHaveProperty('value');
  });

  it('counts only host-accepted tasks as earned value', () => {
    expect(earnedValue({ tasks: [
      { budget: 10, acceptancePassed: true },
      { budget: 20, acceptancePassed: false },
      { budget: 30, acceptancePassed: true },
      { budget: 40, acceptancePassed: false },
      { budget: 50, acceptancePassed: true },
    ] })).toEqual({ status: 'ok', value: 90, sampleCount: MIN_SAMPLES });
  });

  it('does not publish earned value, CPI, or EAC below the minimum sample count', () => {
    const tasks = Array.from({ length: MIN_SAMPLES - 1 }, () => ({
      budget: 10,
      acceptancePassed: true,
    }));
    expect(earnedValue({ tasks })).toEqual({ status: 'insufficient-data' });
    expect(cpi({ earnedValue: 50, actualCost: 25, sampleCount: MIN_SAMPLES - 1 }))
      .toEqual({ status: 'insufficient-data' });
    expect(estimateAtCompletion({
      totalBudget: 100,
      earnedValue: 50,
      actualCost: 25,
      sampleCount: MIN_SAMPLES - 1,
    })).toEqual({ status: 'insufficient-data' });
  });

  it('computes CPI and estimate-at-completion from accepted value and actual spend', () => {
    expect(cpi({ earnedValue: 80, actualCost: 40, sampleCount: MIN_SAMPLES }))
      .toEqual({ status: 'ok', value: 2, sampleCount: MIN_SAMPLES });
    expect(estimateAtCompletion({
      totalBudget: 200,
      earnedValue: 80,
      actualCost: 40,
      sampleCount: MIN_SAMPLES,
    })).toEqual({ status: 'ok', value: 100, sampleCount: MIN_SAMPLES });
  });

  it('returns insufficient-data rather than Infinity when the denominator is zero', () => {
    expect(expectedCostPerAccepted({
      attemptCost: 1,
      reviewCost: 1,
      passRate: 0,
      sampleCount: MIN_SAMPLES,
    }).status).toBe('insufficient-data');
    expect(cpi({ earnedValue: 10, actualCost: 0, sampleCount: MIN_SAMPLES }).status)
      .toBe('insufficient-data');
    expect(estimateAtCompletion({
      totalBudget: 100,
      earnedValue: 0,
      actualCost: 10,
      sampleCount: MIN_SAMPLES,
    }).status).toBe('insufficient-data');
  });

  it('rejects an overflowing intermediate CPI in estimate-at-completion', () => {
    expect(estimateAtCompletion({
      totalBudget: 100,
      earnedValue: Number.MAX_VALUE,
      actualCost: Number.MIN_VALUE,
      sampleCount: MIN_SAMPLES,
    })).toEqual({ status: 'insufficient-data' });
  });
});
