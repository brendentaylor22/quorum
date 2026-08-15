import type { ResultsResponse } from '@quorum/contracts';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { recallInvite, usePoll } from '../hooks.js';
import { Results } from './Results.js';
import { SwipeDeck } from './SwipeDeck.js';

export function HostScreen({ hostToken }: { hostToken: string }) {
  const load = useCallback(async () => api.hostRoom(hostToken), [hostToken]);
  const { data: room, error, refresh } = usePoll(load, 2000);
  const [results, setResults] = useState<ResultsResponse | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [displayName, setDisplayName] = useState('');

  useEffect(() => {
    if (room?.state !== 'COMPLETE' || results !== null) return;
    void api
      .results(room.roomId, hostToken)
      .then(setResults)
      .catch(() => {
        // Another poll retries; the room is complete, so results will land.
        setNotice('Waiting for results…');
      });
  }, [hostToken, results, room]);

  function act(action: 'start' | 'close' | 'continue') {
    if (room === null) return;
    setBusy(true);
    setNotice(null);
    const call =
      action === 'start'
        ? api.start
        : action === 'close'
          ? api.close
          : api.continueVoting;
    void call(room.roomId, hostToken)
      .then(() => {
        // A new round replaces the previous round's results.
        if (action === 'continue') setResults(null);
        return refresh();
      })
      .catch((caught: unknown) => {
        setNotice(
          caught instanceof Error ? caught.message : 'That action failed.',
        );
      })
      .finally(() => {
        setBusy(false);
      });
  }

  // The host votes through the same session cookie as everyone else, so the
  // host view refresh — not the swipe response — stays the source of truth.
  const onChoice = useCallback(
    (choice: 'LEFT' | 'RIGHT') => {
      const card = room?.card;
      if (room === null || card === undefined || card === null || busy) return;
      setBusy(true);
      setNotice(null);
      void api
        .swipe(room.roomId, card.exposureId, choice)
        .catch((caught: unknown) => {
          setNotice(
            caught instanceof Error
              ? caught.message
              : 'That vote was not confirmed. Try again.',
          );
        })
        .finally(() => {
          void refresh();
          setBusy(false);
        });
    },
    [busy, refresh, room],
  );

  if (error !== null && room === null) {
    return (
      <section>
        <h2>This host link is not available</h2>
        <p className="lede">The room may have expired or been closed.</p>
      </section>
    );
  }
  if (room === null) return <p className="lede">Loading host controls…</p>;

  const invite = recallInvite(room.roomId);
  const everyoneDone =
    room.participants.length > 0 &&
    room.participants.every((participant) => participant.complete);
  const playing = room.you !== null;

  return (
    <section aria-labelledby="host-heading">
      <h2 id="host-heading">Host controls</h2>
      <p className="lede">
        Room state: <strong>{room.state}</strong>
        {room.closedEarly ? ' (closed early)' : ''}
      </p>
      {invite === null ? (
        <p className="hint">
          Open this page on the device that created the room to see the invite
          link again.
        </p>
      ) : (
        <>
          <div className="link-row">
            <span className="link-label">Invite</span>
            <a href={`/join/${invite}`}>
              {new URL(`/join/${invite}`, globalThis.location.href).toString()}
            </a>
          </div>
          <p className="hint">
            Share the invite link. Keep this page&rsquo;s address private: it
            controls the room.
          </p>
        </>
      )}
      <ul className="people">
        {room.participants.map((participant) => (
          <li key={participant.participantId}>
            <span>{participant.displayName}</span>
            {participant.participantId === room.you?.participantId ? (
              <span className="tag">You</span>
            ) : null}
            <span className="tag">
              {participant.confirmedCount}/{room.slateSize || 20}
            </span>
          </li>
        ))}
      </ul>
      {room.state === 'LOBBY' && !playing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setNotice(null);
            void api
              .hostJoin(hostToken, displayName)
              .then(() => refresh())
              .catch((caught: unknown) => {
                setNotice(
                  caught instanceof Error
                    ? caught.message
                    : 'Could not join as a player.',
                );
              })
              .finally(() => {
                setBusy(false);
              });
          }}
        >
          <label htmlFor="host-display-name">
            Vote too? Pick a display name
          </label>
          <input
            id="host-display-name"
            name="displayName"
            maxLength={40}
            required
            autoComplete="off"
            value={displayName}
            onChange={(event) => {
              setDisplayName(event.target.value);
            }}
          />
          <button
            type="submit"
            disabled={busy || displayName.trim().length === 0}
          >
            Join as a player
          </button>
        </form>
      ) : null}
      {room.state === 'LOBBY' ? (
        <button
          type="button"
          disabled={busy || room.participants.length === 0}
          onClick={() => {
            act('start');
          }}
        >
          Start voting ({room.participants.length} joined)
        </button>
      ) : null}
      {room.state === 'VOTING' && room.card !== null ? (
        <SwipeDeck
          card={room.card}
          round={room.round}
          busy={busy}
          onChoice={onChoice}
        />
      ) : null}
      {room.state === 'VOTING' && playing && room.card === null ? (
        <p className="lede">
          You are done voting. Results appear when everyone finishes or you
          close voting.
        </p>
      ) : null}
      {room.state === 'VOTING' ? (
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={() => {
            if (
              everyoneDone ||
              globalThis.confirm(
                'Close voting now? People who have not finished still count in the totals.',
              )
            ) {
              act('close');
            }
          }}
        >
          Close voting now
        </button>
      ) : null}
      {room.canContinue ? (
        <section aria-labelledby="continue-heading">
          <h3 id="continue-heading">Not settled yet?</h3>
          <p className="lede">
            Keep going with 20 more, chosen from what everyone liked this round.
            Nothing you have already voted on comes back.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              act('continue');
            }}
          >
            Keep voting
          </button>
        </section>
      ) : null}
      {room.state === 'COMPLETE' && !room.canContinue && room.round !== null ? (
        <p className="hint">
          Not enough unseen movies remain for another round.
        </p>
      ) : null}
      {notice === null ? null : (
        <p className="notice" role="alert">
          {notice}
        </p>
      )}
      {results === null ? null : <Results results={results} />}
    </section>
  );
}
