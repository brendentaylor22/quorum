/**
 * Per-participant taste profiles built from one room's swipes.
 *
 * A room gives roughly twenty binary judgements per person. That is enough for
 * a coarse, interpretable preference over tags — genre, decade, keyword — and
 * nowhere near enough for latent factors, so nothing here tries to learn one.
 */

/** One confirmed swipe. `liked` is a RIGHT; the opposite is a LEFT. */
export interface Judgement {
  participant: string;
  item: string;
  liked: boolean;
}

/** A candidate or judged item, described only by opaque tags. */
export interface TaggedItem {
  item: string;
  /** Namespaced tags, e.g. `genre:28`, `decade:1990`. Order is irrelevant. */
  tags: readonly string[];
}

export interface ProfileOptions {
  /**
   * How much a LEFT counts against a tag relative to a RIGHT counting for it.
   * Below 1 because "not tonight" is weaker evidence than "yes".
   */
  dislikeWeight?: number;
  /**
   * Pseudo-observations pulling a tag toward neutral. Without it a single
   * swipe on a rare tag would read as total certainty.
   */
  priorStrength?: number;
}

const DEFAULT_DISLIKE_WEIGHT = 0.6;
const DEFAULT_PRIOR_STRENGTH = 2;

/**
 * Affinity per tag in [-1, 1]: 1 means every exposure to that tag was liked,
 * -1 means none were, 0 means no evidence either way.
 */
export interface Profile {
  participant: string;
  affinity: ReadonlyMap<string, number>;
  /** Confirmed swipes behind this profile, for weighting and diagnostics. */
  sampleSize: number;
}

export function buildProfiles(
  judgements: readonly Judgement[],
  items: readonly TaggedItem[],
  options: ProfileOptions = {},
): Profile[] {
  const dislikeWeight = options.dislikeWeight ?? DEFAULT_DISLIKE_WEIGHT;
  const prior = options.priorStrength ?? DEFAULT_PRIOR_STRENGTH;
  const tagsByItem = new Map(items.map((entry) => [entry.item, entry.tags]));

  const perParticipant = new Map<
    string,
    { totals: Map<string, { score: number; weight: number }>; samples: number }
  >();

  for (const judgement of judgements) {
    const tags = tagsByItem.get(judgement.item);
    if (tags === undefined) continue;
    let entry = perParticipant.get(judgement.participant);
    if (entry === undefined) {
      entry = { totals: new Map(), samples: 0 };
      perParticipant.set(judgement.participant, entry);
    }
    entry.samples += 1;
    for (const tag of new Set(tags)) {
      const current = entry.totals.get(tag) ?? { score: 0, weight: 0 };
      current.score += judgement.liked ? 1 : -dislikeWeight;
      current.weight += judgement.liked ? 1 : dislikeWeight;
      entry.totals.set(tag, current);
    }
  }

  return [...perParticipant].map(([participant, entry]) => {
    const affinity = new Map<string, number>();
    for (const [tag, total] of entry.totals) {
      affinity.set(tag, total.score / (total.weight + prior));
    }
    return { participant, affinity, sampleSize: entry.samples };
  });
}

/**
 * Predicted willingness for one participant, in [0, 1].
 *
 * The mean over a candidate's tags is mapped from [-1, 1] onto [0, 1], so an
 * item with no evidence scores 0.5 rather than zero — unknown is not the same
 * as unwanted.
 */
export function predict(profile: Profile, candidate: TaggedItem): number {
  const tags = [...new Set(candidate.tags)];
  if (tags.length === 0) return 0.5;
  let total = 0;
  for (const tag of tags) total += profile.affinity.get(tag) ?? 0;
  return clamp01((total / tags.length + 1) / 2);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
