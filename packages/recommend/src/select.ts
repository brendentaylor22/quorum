import { createHash } from 'node:crypto';
import { scoreForGroup, type GroupOptions, type GroupScore } from './group.js';
import {
  buildProfiles,
  type Judgement,
  type Profile,
  type ProfileOptions,
  type TaggedItem,
} from './profile.js';

export interface SelectOptions extends GroupOptions, ProfileOptions {
  size: number;
  /** Server-generated seed, persisted with the round so a slate replays. */
  seed: string;
  /**
   * Slots reserved for items chosen at random rather than by score. Guards
   * against overfitting twenty swipes, and stops repeated rounds collapsing
   * into a filter bubble.
   */
  explorationSlots?: number;
  /**
   * Most items allowed to share a value within `diversityNamespace`. Without
   * a cap, a group that liked two action films gets twenty. Defaults to half
   * the slate: generous enough that a real shared taste still dominates,
   * tight enough that one genre cannot take the whole slate.
   */
  maxPerFacet?: number;
  /** Tag namespace the diversity cap applies to. */
  diversityNamespace?: string;
}

export interface SelectedItem {
  item: string;
  /** Slate order, 1-based. */
  position: number;
  score: number;
  /** True when this slot was filled by exploration rather than by score. */
  exploration: boolean;
  /** Group members predicted to be willing. Zero for exploration picks. */
  supporters: number;
  /** Tags that drove the score, strongest first. Empty for exploration. */
  topTags: string[];
}

const DEFAULT_EXPLORATION_SLOTS = 5;
const DEFAULT_MAX_PER_FACET_RATIO = 0.5;
const DEFAULT_NAMESPACE = 'genre';

/** Deterministic 64-bit stream, so a seed reproduces a slate exactly. */
function seededOrder(seed: string, key: string): bigint {
  return createHash('sha256')
    .update(`${seed}:${key}`)
    .digest()
    .readBigUInt64BE(0);
}

/**
 * Choose a slate from what the group has already told us.
 *
 * Scored picks come first, subject to a diversity cap, then the reserved
 * exploration slots are filled at random from whatever is left. Ties and
 * exploration are both resolved through the seed, never through `Math.random`,
 * so the same inputs always produce the same slate.
 */
export function selectRecommendedSlate(
  judgements: readonly Judgement[],
  judgedItems: readonly TaggedItem[],
  candidates: readonly TaggedItem[],
  options: SelectOptions,
): SelectedItem[] {
  const { size, seed } = options;
  if (!Number.isInteger(size) || size < 1) {
    throw new Error('Slate size must be a positive integer');
  }
  if (candidates.length < size) {
    throw new Error(
      `Need ${size.toString()} candidates; got ${candidates.length.toString()}`,
    );
  }
  const explorationSlots = Math.min(
    Math.max(0, options.explorationSlots ?? DEFAULT_EXPLORATION_SLOTS),
    size,
  );
  const maxPerFacet = Math.max(
    2,
    options.maxPerFacet ?? Math.ceil(size * DEFAULT_MAX_PER_FACET_RATIO),
  );
  const namespace = `${options.diversityNamespace ?? DEFAULT_NAMESPACE}:`;

  const profiles = buildProfiles(judgements, judgedItems, options);
  const scored = candidates.map((candidate) => ({
    candidate,
    group: scoreForGroup(profiles, candidate, options),
  }));

  // Sort by score, breaking ties with the seed so equal scores do not fall
  // into catalog order — which would quietly favour the same films forever.
  scored.sort(
    (left, right) =>
      right.group.score - left.group.score ||
      compareSeeded(seed, left.candidate.item, right.candidate.item),
  );

  const chosen: SelectedItem[] = [];
  const taken = new Set<string>();
  const facetCounts = new Map<string, number>();
  const exploitSlots = size - explorationSlots;

  const facetsOf = (candidate: TaggedItem): string[] =>
    candidate.tags.filter((tag) => tag.startsWith(namespace));

  for (const entry of scored) {
    if (chosen.length >= exploitSlots) break;
    const facets = facetsOf(entry.candidate);
    if (facets.some((facet) => (facetCounts.get(facet) ?? 0) >= maxPerFacet)) {
      continue;
    }
    for (const facet of facets) {
      facetCounts.set(facet, (facetCounts.get(facet) ?? 0) + 1);
    }
    taken.add(entry.candidate.item);
    chosen.push({
      item: entry.candidate.item,
      position: 0,
      score: entry.group.score,
      exploration: false,
      supporters: entry.group.supporters,
      topTags: rankTags(profiles, entry.candidate),
    });
  }

  // The diversity cap can starve the scored pass; fall back to score order so
  // a slate is always full rather than short.
  if (chosen.length < exploitSlots) {
    for (const entry of scored) {
      if (chosen.length >= exploitSlots) break;
      if (taken.has(entry.candidate.item)) continue;
      taken.add(entry.candidate.item);
      chosen.push({
        item: entry.candidate.item,
        position: 0,
        score: entry.group.score,
        exploration: false,
        supporters: entry.group.supporters,
        topTags: rankTags(profiles, entry.candidate),
      });
    }
  }

  const remaining = candidates
    .filter((candidate) => !taken.has(candidate.item))
    .map((candidate) => ({
      candidate,
      order: seededOrder(seed, `explore:${candidate.item}`),
    }))
    .sort((left, right) => (left.order < right.order ? -1 : 1));

  for (const entry of remaining) {
    if (chosen.length >= size) break;
    taken.add(entry.candidate.item);
    chosen.push({
      item: entry.candidate.item,
      position: 0,
      score: 0,
      exploration: true,
      supporters: 0,
      topTags: [],
    });
  }

  return chosen
    .slice(0, size)
    .map((entry, index) => ({ ...entry, position: index + 1 }));
}

function compareSeeded(seed: string, left: string, right: string): number {
  const a = seededOrder(seed, left);
  const b = seededOrder(seed, right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Candidate tags the group likes most, strongest first. */
function rankTags(
  profiles: readonly Profile[],
  candidate: TaggedItem,
  limit = 2,
): string[] {
  if (profiles.length === 0) return [];
  const scores = [...new Set(candidate.tags)].map((tag) => {
    let total = 0;
    for (const profile of profiles) total += profile.affinity.get(tag) ?? 0;
    return { tag, score: total / profiles.length };
  });
  return scores
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((entry) => entry.tag);
}

export type { GroupScore };
