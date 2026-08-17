import type { ResultsResponse } from '@quorum/contracts';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { recallInvite, usePoll } from '../hooks.js';
import { Results } from './Results.js';
import { Roster } from './Roster.js';
import { SwipeDeck } from './SwipeDeck.js';

/**
 * The invite link, with the two ways a host actually shares one: the phone's
 * own share sheet where there is one, and the clipboard everywhere else.
 * Reading the link is the fallback, so the anchor stays selectable text.
 */
function InvitePanel({ inviteToken }: { inviteToken: string }) {
  const [copied, setCopied] = useState(false);
  const url = new URL(
    `/join/${inviteToken}`,
    globalThis.location.href,
  ).toString();
  const canShare = typeof globalThis.navigator.share === 'function';

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => {
      setCopied(false);
    }, 2000);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);

  return (
    <section aria-labelledby="invite-heading" className="invite">
      <h2 id="invite-heading">Invite the group</h2>
      <div className="link-row">
        <span className="link-label">Invite link</span>
        <a href={`/join/${inviteToken}`}>{url}</a>
      </div>
      <div className="button-row">
        <button
          type="button"
          className="secondary"
          onClick={() => {
            // The clipboard API is absent on an insecure origin and can be
            // refused on a secure one. Either way the link is on screen to
            // read, so a failure needs no message.
            try {
              void globalThis.navigator.clipboard
                .writeText(url)
                .then(() => {
                  setCopied(true);
                })
                .catch(() => {
                  /* Refused. */
                });
            } catch {
              /* No clipboard here. */
            }
          }}
        >
          {copied ? 'Copied' : 'Copy link'}
        </button>
        {canShare ? (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              void globalThis.navigator
                .share({ title: 'Join my Quorum room', url })
                .catch(() => {
                  // Dismissing the share sheet rejects; nothing to report.
                });
            }}
          >
            Share…
          </button>
        ) : null}
      </div>
      <p className="hint">
        Anyone with this link can join. Keep this page&rsquo;s own address
        private: it controls the room.
      </p>
    </section>
  );
}

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
  const roundLabel =
    room.round === null || room.round.roundNumber === 1
      ? ''
      : ` — round ${room.round.roundNumber.toString()}`;

  return (
    <>
      {notice === null ? null : (
        <p className="notice" role="alert">
          {notice}
        </p>
      )}

      <section aria-labelledby="host-heading" className="host-status">
        <h2 id="host-heading">Host controls</h2>
        <p className="state-line">
          <span className={`state-dot state-${room.state.toLowerCase()}`} />
          {room.state === 'LOBBY'
            ? 'Waiting in the lobby. Nobody sees a film until you start.'
            : room.state === 'VOTING'
              ? `Voting is open${roundLabel}. Answers stay hidden until it ends.`
              : room.state === 'COMPLETE'
                ? `Voting is closed${roundLabel}.${
                    room.closedEarly
                      ? ' You closed it early, so people who did not answer still count.'
                      : ''
                  }`
                : 'This room has expired.'}
        </p>
      </section>

      {room.state === 'LOBBY' && invite !== null ? (
        <InvitePanel inviteToken={invite} />
      ) : null}
      {room.state === 'LOBBY' && invite === null ? (
        <section>
          <h2>Invite the group</h2>
          <p className="lede">
            Open this page on the device that created the room to see the invite
            link again.
          </p>
        </section>
      ) : null}

      {room.state === 'LOBBY' ? (
        <section aria-labelledby="start-heading">
          <h2 id="start-heading">Start voting</h2>
          {playing ? null : (
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
                Voting too? Pick a display name
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
                className="secondary"
                disabled={busy || displayName.trim().length === 0}
              >
                Join as a player
              </button>
            </form>
          )}
          <button
            type="button"
            disabled={busy || room.participants.length === 0}
            onClick={() => {
              act('start');
            }}
          >
            Start voting ({room.participants.length} joined)
          </button>
          <p className="hint">
            {room.participants.length === 0
              ? 'Share the invite link — at least one person has to join first.'
              : 'Starting locks the group: nobody can join after this.'}
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
      {room.state === 'VOTING' && playing && room.card === null ? (
        <section>
          <h2>You are done</h2>
          <p className="lede">
            Results appear when everyone finishes, or as soon as you close
            voting.
          </p>
        </section>
      ) : null}
      {room.state === 'VOTING' && !playing ? (
        <section>
          <h2>Voting is under way</h2>
          <p className="lede">
            You are hosting without voting. Nobody sees a result — including you
            — until the room finishes.
          </p>
        </section>
      ) : null}

      <Roster
        participants={room.participants}
        slateSize={room.slateSize}
        youId={room.you?.participantId ?? null}
      />

      {room.state === 'VOTING' ? (
        <section aria-labelledby="close-heading">
          <h2 id="close-heading">
            {everyoneDone ? 'Everyone has finished' : 'Not everyone is done'}
          </h2>
          <p className="lede">
            {everyoneDone
              ? 'Reveal the ranking now.'
              : 'You can reveal the ranking early. People who have not answered still count in the totals, which lowers every score.'}
          </p>
          <button
            type="button"
            className={everyoneDone ? '' : 'danger'}
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
            {everyoneDone ? 'Show results' : 'Close voting now'}
          </button>
        </section>
      ) : null}

      {/*
        Above the ranking, not below it. Twenty rows is a long scroll on a
        phone, and the verdict at the top of the results already says whether
        the round settled anything — so the decision this offers can be made
        without reaching the bottom of the list.
      */}
      {room.canContinue ? (
        <section aria-labelledby="continue-heading">
          <h2 id="continue-heading">Not settled yet?</h2>
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

      {results === null ? null : <Results results={results} />}
    </>
  );
}
