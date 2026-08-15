import type { ResultsResponse, RoomView } from '@quorum/contracts';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { usePoll } from '../hooks.js';
import { Results } from './Results.js';
import { SwipeDeck } from './SwipeDeck.js';

function Participants({ room }: { room: RoomView }) {
  return (
    <section aria-labelledby="people-heading">
      <h2 id="people-heading">In this room</h2>
      <ul className="people">
        {room.participants.map((participant) => (
          <li key={participant.participantId}>
            <span>{participant.displayName}</span>
            {participant.isHost ? <span className="tag">Host</span> : null}
            {room.state === 'VOTING' || room.state === 'COMPLETE' ? (
              <span className="tag">
                {participant.confirmedCount}/{room.slateSize}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function RoomScreen({ roomId }: { roomId: string }) {
  const load = useCallback(async () => api.room(roomId), [roomId]);
  const { data: room, error, refresh, setData } = usePoll(load, 2000);
  const [results, setResults] = useState<ResultsResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // A new round reopens voting, so last round's results must clear.
  useEffect(() => {
    if (room?.state === 'VOTING' && results !== null) setResults(null);
  }, [results, room?.state]);

  useEffect(() => {
    if (room?.state !== 'COMPLETE' || results !== null) return;
    void api
      .results(roomId)
      .then(setResults)
      .catch(() => {
        setNotice('Results are not ready yet.');
      });
  }, [results, room, roomId]);

  const onChoice = useCallback(
    (choice: 'LEFT' | 'RIGHT') => {
      const card = room?.card;
      if (card === undefined || card === null || busy) return;
      setBusy(true);
      setNotice(null);
      void api
        .swipe(roomId, card.exposureId, choice)
        .then((response) => {
          setData(response.room);
        })
        .catch((caught: unknown) => {
          setNotice(
            caught instanceof Error
              ? caught.message
              : 'That vote was not confirmed. Try again.',
          );
          void refresh();
        })
        .finally(() => {
          setBusy(false);
        });
    },
    [busy, refresh, room?.card, roomId, setData],
  );

  if (error !== null && room === null) {
    return (
      <section>
        <h2>This room is not available</h2>
        <p className="lede">
          The link may be invalid or the room may have expired.
        </p>
      </section>
    );
  }
  if (room === null) return <p className="lede">Loading room…</p>;

  return (
    <>
      {notice === null ? null : (
        <p className="notice" role="alert">
          {notice}
        </p>
      )}
      {room.state === 'LOBBY' ? (
        <section>
          <h2>Waiting for the host to start</h2>
          <p className="lede">
            Everyone who is here when the host starts votes on the same 20
            movies.
          </p>
        </section>
      ) : null}
      {room.state === 'VOTING' && room.card !== null ? (
        <SwipeDeck
          card={room.card}
          round={room.round}
          busy={busy}
          onChoice={onChoice}
        />
      ) : null}
      {room.state === 'VOTING' && room.card === null ? (
        <section>
          <h2>You are done</h2>
          <p className="lede">
            Results appear when everyone finishes or the host closes voting.
          </p>
        </section>
      ) : null}
      {room.state === 'COMPLETE' && room.completedRounds.length > 0 ? (
        <p className="hint">
          The host can start another round of 20 from what the group liked.
        </p>
      ) : null}
      {results === null ? null : <Results results={results} />}
      <Participants room={room} />
    </>
  );
}
