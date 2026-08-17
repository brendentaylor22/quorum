/**
 * Bayesian weighted rating, the "top movies of all time" ordering.
 *
 *   score = (v / (v + m)) * R + (m / (v + m)) * C
 *
 * `R` is the movie's mean, `v` its vote count, `m` the confidence threshold,
 * and `C` the mean across the imported pool. A raw average lets a 9.5 from
 * twelve votes outrank a classic; this pulls thin records toward the pool mean
 * until they have earned their score.
 */
export function weightedRating(
  voteAverage: number,
  voteCount: number,
  minVotes: number,
  poolMean: number,
): number {
  if (minVotes < 0)
    throw new Error('Minimum vote threshold cannot be negative');
  const denominator = voteCount + minVotes;
  if (denominator <= 0) return poolMean;
  return (
    (voteCount / denominator) * voteAverage +
    (minVotes / denominator) * poolMean
  );
}

/**
 * Vote-weighted mean across the pool. Weighting by votes stops a long tail of
 * barely-rated titles dragging `C` around between imports.
 */
export function poolMeanRating(
  items: readonly { voteAverage: number; voteCount: number }[],
): number {
  let weighted = 0;
  let votes = 0;
  for (const item of items) {
    weighted += item.voteAverage * item.voteCount;
    votes += item.voteCount;
  }
  return votes === 0 ? 0 : weighted / votes;
}
