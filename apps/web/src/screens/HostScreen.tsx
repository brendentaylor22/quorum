import type { ResultsResponse } from '@quorum/contracts';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { recallInvite, usePoll } from '../hooks.js';
import { Results } from './Results.js';

export function HostScreen({ hostToken }: { hostToken: string }) {
  const load = useCallback(async () => api.hostRoom(hostToken), [hostToken]);
  const { data: room, error, refresh } = usePoll(load, 2000);
  const [results, setResults] = useState<ResultsResponse | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  function act(action: 'start' | 'close') {
    if (room === null) return;
    setBusy(true);
    setNotice(null);
    const call = action === 'start' ? api.start : api.close;
    void call(room.roomId, hostToken)
      .then(() => refresh())
      .catch((caught: unknown) => {
        setNotice(
          caught instanceof Error ? caught.message : 'That action failed.',
        );
      })
      .finally(() => {
        setBusy(false);
      });
  }

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
        <div className="link-row">
          <span className="link-label">Invite</span>
          <a href={`/join/${invite}`}>
            {new URL(`/join/${invite}`, globalThis.location.href).toString()}
          </a>
        </div>
      )}
      <ul className="people">
        {room.participants.map((participant) => (
          <li key={participant.participantId}>
            <span>{participant.displayName}</span>
            <span className="tag">
              {participant.confirmedCount}/{room.slateSize || 20}
            </span>
          </li>
        ))}
      </ul>
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
      {notice === null ? null : (
        <p className="notice" role="alert">
          {notice}
        </p>
      )}
      {results === null ? null : <Results results={results} />}
    </section>
  );
}
