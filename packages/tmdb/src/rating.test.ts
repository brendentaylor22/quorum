import { describe, expect, it } from 'vitest';
import { poolMeanRating, weightedRating } from './rating.js';

describe('weightedRating', () => {
  it('returns the movie mean when votes vastly exceed the threshold', () => {
    expect(weightedRating(8.5, 100_000, 500, 6.5)).toBeCloseTo(8.49, 2);
  });

  it('sits halfway when votes equal the threshold', () => {
    expect(weightedRating(9, 1000, 1000, 7)).toBeCloseTo(8, 5);
  });

  it('collapses to the pool mean with no votes', () => {
    expect(weightedRating(9, 0, 1000, 6.8)).toBe(6.8);
  });

  it('returns the pool mean when both terms are zero', () => {
    expect(weightedRating(9, 0, 0, 6.8)).toBe(6.8);
  });

  it('passes a raw average through when the threshold is zero', () => {
    expect(weightedRating(9, 10, 0, 6.8)).toBe(9);
  });

  it('rejects a negative threshold', () => {
    expect(() => weightedRating(8, 100, -1, 7)).toThrow(/cannot be negative/u);
  });
});

describe('poolMeanRating', () => {
  it('weights the mean by vote count', () => {
    const mean = poolMeanRating([
      { voteAverage: 9, voteCount: 1 },
      { voteAverage: 6, voteCount: 999 },
    ]);
    expect(mean).toBeCloseTo(6.003, 3);
  });

  it('is zero for an empty or unvoted pool', () => {
    expect(poolMeanRating([])).toBe(0);
    expect(poolMeanRating([{ voteAverage: 9, voteCount: 0 }])).toBe(0);
  });
});
