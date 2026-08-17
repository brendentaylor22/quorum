import { predict, type Profile, type TaggedItem } from './profile.js';

/**
 * Turning individual predictions into one group score.
 *
 * Pure average picks blandly agreeable films and will happily include one
 * person's strong no. Pure least-misery picks nobody's favourite. Blending the
 * two keeps a floor under the unhappiest member without flattening the slate.
 */
export interface GroupScore {
  item: string;
  score: number;
  /** Mean predicted willingness across the group. */
  average: number;
  /** The least willing member's prediction: the misery floor. */
  worst: number;
  /** Participants whose prediction clears `enthusiasmThreshold`. */
  supporters: number;
}

export interface GroupOptions {
  /**
   * Weight on average utility; the remainder goes to the least-misery floor.
   * At 1 this is a plain average, at 0 it is pure least-misery.
   */
  consensusWeight?: number;
  /** Prediction above which a member counts as a supporter, for reasons. */
  enthusiasmThreshold?: number;
}

const DEFAULT_CONSENSUS_WEIGHT = 0.7;
const DEFAULT_ENTHUSIASM = 0.55;

export function scoreForGroup(
  profiles: readonly Profile[],
  candidate: TaggedItem,
  options: GroupOptions = {},
): GroupScore {
  const consensusWeight = options.consensusWeight ?? DEFAULT_CONSENSUS_WEIGHT;
  const threshold = options.enthusiasmThreshold ?? DEFAULT_ENTHUSIASM;

  if (profiles.length === 0) {
    return {
      item: candidate.item,
      score: 0.5,
      average: 0.5,
      worst: 0.5,
      supporters: 0,
    };
  }

  let total = 0;
  let worst = Number.POSITIVE_INFINITY;
  let supporters = 0;
  for (const profile of profiles) {
    const prediction = predict(profile, candidate);
    total += prediction;
    if (prediction < worst) worst = prediction;
    if (prediction >= threshold) supporters += 1;
  }
  const average = total / profiles.length;
  return {
    item: candidate.item,
    score: consensusWeight * average + (1 - consensusWeight) * worst,
    average,
    worst,
    supporters,
  };
}
