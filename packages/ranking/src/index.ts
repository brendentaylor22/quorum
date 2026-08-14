/**
 * Quorum ranking contract `quorum-ranking-v1`.
 *
 * Normative examples live in `tests/contracts/ranking.examples.json`; this
 * module is a pure function with no I/O so it can be tested against them
 * directly.
 */

export interface RankingTally {
  /** Stable identifier of the slate item; opaque to ranking. */
  item: string;
  /** Persisted slate position, used only for presentation order of ties. */
  slatePosition: number;
  /** Confirmed RIGHT interactions. */
  yes: number;
  /** Confirmed LEFT + RIGHT interactions. */
  responses: number;
}

export interface RankedItem extends RankingTally {
  rank: number;
  /** Frozen participant count; the denominator for both percentages. */
  eligible: number;
  /** Whole-number display value of `100 * yes / eligible`. */
  approvalPct: number;
  /** Whole-number display value of `100 * responses / eligible`. */
  coveragePct: number;
  /** Exact numerator/denominator display, e.g. `3/4`. */
  yesFraction: string;
  match: boolean;
}

function assertTally(eligible: number, tally: RankingTally): void {
  const { item, yes, responses } = tally;
  if (!Number.isInteger(yes) || !Number.isInteger(responses)) {
    throw new Error(`Ranking tally must be integral: ${item}`);
  }
  if (yes < 0 || responses < 0) {
    throw new Error(`Ranking tally cannot be negative: ${item}`);
  }
  if (yes > responses) {
    throw new Error(`Yes count cannot exceed responses: ${item}`);
  }
  if (responses > eligible) {
    throw new Error(`Responses cannot exceed eligible participants: ${item}`);
  }
}

/**
 * Rank a slate by approval percentage, then response coverage.
 *
 * Non-responses stay in the denominator, so an early close cannot inflate a
 * single yes into 100% group approval. Equal scores share a competition rank
 * (1, 2, 2, 4) and are presented in slate order.
 */
export function rankSlate(
  eligible: number,
  tallies: readonly RankingTally[],
): RankedItem[] {
  if (!Number.isInteger(eligible) || eligible < 1) {
    throw new Error('Ranking requires at least one eligible participant');
  }
  for (const tally of tallies) assertTally(eligible, tally);

  const ordered = [...tallies].sort(
    (left, right) =>
      right.yes - left.yes ||
      right.responses - left.responses ||
      left.slatePosition - right.slatePosition,
  );

  let rank = 0;
  let previous: RankingTally | undefined;
  return ordered.map((tally, index) => {
    const tied =
      previous?.yes === tally.yes && previous.responses === tally.responses;
    if (!tied) rank = index + 1;
    previous = tally;
    return {
      ...tally,
      rank,
      eligible,
      approvalPct: Math.round((100 * tally.yes) / eligible),
      coveragePct: Math.round((100 * tally.responses) / eligible),
      yesFraction: `${tally.yes.toString()}/${eligible.toString()}`,
      match: tally.yes === eligible,
    };
  });
}
