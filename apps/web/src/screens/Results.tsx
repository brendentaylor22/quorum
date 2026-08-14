import type { ResultsResponse } from '@quorum/contracts';

export function Results({ results }: { results: ResultsResponse }) {
  return (
    <section aria-labelledby="results-heading">
      <h2 id="results-heading">Results</h2>
      <p className="lede">
        {results.closedEarly
          ? 'The host closed voting early. People who did not answer still count in the totals.'
          : 'Everyone finished voting.'}
      </p>
      <ol className="results">
        {results.items.map((item) => (
          <li key={item.catalogItemId} className={item.match ? 'match' : ''}>
            <span className="rank">{item.rank}</span>
            <span className="title">
              <span className="name">{item.item.title}</span>
              {item.match ? <span className="badge">Match</span> : null}
            </span>
            <span className="score">
              {item.approvalPct}% ({item.yesFraction})
            </span>
            <span className="coverage">{item.coveragePct}% answered</span>
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
