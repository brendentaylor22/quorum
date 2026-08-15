import type { ResultsResponse } from '@quorum/contracts';
import { Poster } from './SwipeDeck.js';

export function Results({ results }: { results: ResultsResponse }) {
  return (
    <section aria-labelledby="results-heading">
      <h2 id="results-heading">
        Results
        {results.roundNumber > 1
          ? ` — round ${results.roundNumber.toString()}`
          : ''}
      </h2>
      <p className="lede">
        {results.closedEarly
          ? 'The host closed voting early. People who did not answer still count in the totals.'
          : 'Everyone finished voting.'}
        {results.strategy === 'RECOMMENDED'
          ? ' This round was picked from what the group liked last time.'
          : ''}
      </p>
      <ol className="results">
        {results.items.map((item) => (
          <li key={item.catalogItemId} className={item.match ? 'match' : ''}>
            <span className="rank">{item.rank}</span>
            <span className="thumb">
              <Poster item={item.item} />
            </span>
            <span className="title">
              <span className="name">{item.item.title}</span>
              {item.item.year === null ? null : (
                <span className="year">{item.item.year}</span>
              )}
              {item.match ? <span className="badge">Match</span> : null}
            </span>
            <span className="score">
              {item.approvalPct}% ({item.yesFraction})
            </span>
            <span className="coverage">
              {item.coveragePct}% answered
              {item.item.genres.length === 0
                ? ''
                : ` · ${item.item.genres.join(', ')}`}
            </span>
            {item.reason === null && item.score === null ? null : (
              <span className="reason">
                {item.score === null ? null : (
                  <span className="predicted">
                    Predicted {item.score}%
                    {/* The gap between prediction and outcome is the whole
                        point of showing it: it says whether the recommender
                        is learning anything from the group's swipes. */}
                  </span>
                )}
                {item.reason}
              </span>
            )}
          </li>
        ))}
      </ol>
      <p className="hint">
        Approval is yes votes divided by the {results.eligibleCount} people in
        the room when voting started. Equal scores share a rank.
      </p>
    </section>
  );
}
