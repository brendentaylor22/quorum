/**
 * Group recommendation for a room's later rounds.
 *
 * The whole package is pure: no I/O, no provider, no persistence. Items arrive
 * described only by opaque namespaced tags, and the caller decides what
 * supplies them — so the feature source can change without touching any of the
 * scoring here.
 *
 * The approach is deliberately interpretable rather than learned. A room
 * yields about twenty binary swipes per person and no history across rooms,
 * which supports a coarse tag preference and rules out collaborative
 * filtering: every member rated the same twenty items, so there is nothing to
 * generalise from. See `docs/recommendations.md`.
 */
export const RECOMMENDER_VERSION = 'quorum-recommend-v1';

export { scoreForGroup, type GroupOptions, type GroupScore } from './group.js';

export {
  buildProfiles,
  predict,
  type Judgement,
  type Profile,
  type ProfileOptions,
  type TaggedItem,
} from './profile.js';

export {
  selectRecommendedSlate,
  type SelectOptions,
  type SelectedItem,
} from './select.js';
