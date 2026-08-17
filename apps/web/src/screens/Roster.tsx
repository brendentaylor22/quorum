import type { ParticipantSummary } from '@quorum/contracts';

/**
 * Who is in the room and how far through they are.
 *
 * During voting this is the only visible sign that anything is happening, so
 * each row carries a bar rather than a bare fraction: a host glancing at it
 * should see who to chase without having to read numbers. It deliberately
 * shows progress and never choices — how far someone has got is public, what
 * they picked is not.
 */
export function Roster({
  participants,
  slateSize,
  youId,
}: {
  participants: readonly ParticipantSummary[];
  slateSize: number;
  youId: string | null;
}) {
  const finished = participants.filter(
    (participant) => participant.complete,
  ).length;

  return (
    <section aria-labelledby="roster-heading">
      <h2 id="roster-heading">
        In this room{' '}
        <span className="count">
          {participants.length}
          {participants.length === 1 ? ' person' : ' people'}
        </span>
      </h2>
      {participants.length === 0 ? (
        <p className="lede">Nobody has joined yet.</p>
      ) : (
        <ul className="people">
          {participants.map((participant) => (
            <li key={participant.participantId}>
              <span className="who">
                {participant.displayName}
                {participant.participantId === youId ? (
                  <span className="tag">You</span>
                ) : null}
                {participant.isHost ? (
                  <span className="tag subtle">Host</span>
                ) : null}
              </span>
              {slateSize === 0 ? null : (
                <span className="progress-cell">
                  <span
                    className="bar"
                    role="progressbar"
                    aria-valuenow={participant.confirmedCount}
                    aria-valuemin={0}
                    aria-valuemax={slateSize}
                    aria-label={`${participant.displayName} voting progress`}
                  >
                    <span
                      className={participant.complete ? 'fill is-done' : 'fill'}
                      style={{
                        width: `${((participant.confirmedCount / slateSize) * 100).toString()}%`,
                      }}
                    />
                  </span>
                  <span className="tally">
                    {participant.complete
                      ? 'Done'
                      : `${participant.confirmedCount.toString()}/${slateSize.toString()}`}
                  </span>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {slateSize === 0 || participants.length === 0 ? null : (
        <p className="hint">
          {finished} of {participants.length} finished.
        </p>
      )}
    </section>
  );
}
