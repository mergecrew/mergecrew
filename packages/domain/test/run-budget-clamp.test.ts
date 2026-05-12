/**
 * Pure-math clamp tests for #351 per-kind run budgets. The runner
 * loads prior model-turn spend by kind and hands it to
 * `clampBudgetForRun`; this file covers the arithmetic without a DB.
 */
import { describe, expect, it } from 'vitest';
import { clampBudgetForRun } from '../src/stock-agents.js';

describe('clampBudgetForRun (#351)', () => {
  it('returns perStep unchanged when runBudget is unset (legacy single-pass agents)', () => {
    expect(
      clampBudgetForRun({
        perStep: { tokens: 100, usd: 1 },
        runBudget: undefined,
        prior: { tokens: 50, usd: 0.5 },
      }),
    ).toEqual({ tokens: 100, usd: 1 });
  });

  it('clamps perStep to runBudget minus prior spend', () => {
    expect(
      clampBudgetForRun({
        perStep: { tokens: 200, usd: 4 },
        runBudget: { tokens: 600, usd: 12 },
        prior: { tokens: 500, usd: 11 },
      }),
    ).toEqual({ tokens: 100, usd: 1 });
  });

  it('keeps perStep when it is smaller than the remaining run budget', () => {
    expect(
      clampBudgetForRun({
        perStep: { tokens: 200, usd: 4 },
        runBudget: { tokens: 600, usd: 12 },
        prior: { tokens: 100, usd: 2 },
      }),
    ).toEqual({ tokens: 200, usd: 4 });
  });

  it('returns 0 for a kind that has already spent its full runBudget', () => {
    expect(
      clampBudgetForRun({
        perStep: { tokens: 200, usd: 4 },
        runBudget: { tokens: 600, usd: 12 },
        prior: { tokens: 700, usd: 14 },
      }),
    ).toEqual({ tokens: 0, usd: 0 });
  });

  it('handles tokens-only runBudget (no usd cap)', () => {
    expect(
      clampBudgetForRun({
        perStep: { tokens: 200, usd: 4 },
        runBudget: { tokens: 600 },
        prior: { tokens: 500, usd: 14 },
      }),
    ).toEqual({ tokens: 100, usd: 4 });
  });

  it('handles usd-only runBudget (no tokens cap)', () => {
    expect(
      clampBudgetForRun({
        perStep: { tokens: 200, usd: 4 },
        runBudget: { usd: 12 },
        prior: { tokens: 99_999, usd: 11.5 },
      }),
    ).toEqual({ tokens: 200, usd: 0.5 });
  });

  it('walks a 3-round coder budget under the stock coder cap', () => {
    const coderPerStep = { tokens: 200_000, usd: 4 };
    const coderRunBudget = { tokens: 600_000, usd: 12 };
    // First pass: zero prior — full per-step.
    expect(clampBudgetForRun({ perStep: coderPerStep, runBudget: coderRunBudget, prior: { tokens: 0, usd: 0 } }))
      .toEqual({ tokens: 200_000, usd: 4 });
    // Second pass: 200k already burned — full per-step still available
    // because 600k - 200k = 400k > 200k per-step.
    expect(
      clampBudgetForRun({ perStep: coderPerStep, runBudget: coderRunBudget, prior: { tokens: 200_000, usd: 4 } }),
    ).toEqual({ tokens: 200_000, usd: 4 });
    // Third pass: 400k burned — full per-step still available
    // (600k - 400k = 200k = per-step). After this the cumulative reaches the cap.
    expect(
      clampBudgetForRun({ perStep: coderPerStep, runBudget: coderRunBudget, prior: { tokens: 400_000, usd: 8 } }),
    ).toEqual({ tokens: 200_000, usd: 4 });
    // Hypothetical fourth pass: cap reached, born exhausted.
    expect(
      clampBudgetForRun({ perStep: coderPerStep, runBudget: coderRunBudget, prior: { tokens: 600_000, usd: 12 } }),
    ).toEqual({ tokens: 0, usd: 0 });
  });
});
