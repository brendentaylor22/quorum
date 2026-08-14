import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { usePoll } from '../hooks.js';
import { RoomScreen } from './RoomScreen.js';

export function JoinScreen({
  inviteToken,
  hostToken,
}: {
  inviteToken: string;
  hostToken?: string | undefined;
}) {
  const load = useCallback(async () => api.invite(inviteToken), [inviteToken]);
  const { data: invite, error } = usePoll(load, 3000);
  const [displayName, setDisplayName] = useState('');
  const [joinedRoomId, setJoinedRoomId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A refresh keeps the room-scoped session cookie, so an existing participant
  // resumes instead of being asked for a name again.
  const inviteRoomId = invite?.roomId;
  useEffect(() => {
    if (inviteRoomId === undefined || joinedRoomId !== null) return;
    void api
      .room(inviteRoomId)
      .then(() => {
        setJoinedRoomId(inviteRoomId);
      })
      .catch(() => {
        // No session for this room yet; show the join form.
      });
  }, [inviteRoomId, joinedRoomId]);

  if (joinedRoomId !== null) return <RoomScreen roomId={joinedRoomId} />;
  if (error !== null && invite === null) {
    return (
      <section>
        <h2>This invite is not available</h2>
        <p className="lede">
          The link may be invalid, already started, or expired. Ask the host for
          a new one.
        </p>
      </section>
    );
  }
  if (invite === null) return <p className="lede">Checking the invite…</p>;

  return (
    <section aria-labelledby="join-heading">
      <h2 id="join-heading">Join this room</h2>
      <p className="lede">
        {invite.participants.length === 0
          ? 'You are first to arrive.'
          : `Already here: ${invite.participants
              .map((participant) => participant.displayName)
              .join(', ')}`}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setNotice(null);
          void api
            .join(inviteToken, displayName, hostToken)
            .then((response) => {
              setJoinedRoomId(response.room.roomId);
            })
            .catch((caught: unknown) => {
              setNotice(
                caught instanceof Error ? caught.message : 'Could not join.',
              );
            })
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        <label htmlFor="display-name">Display name</label>
        <input
          id="display-name"
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
          Join room
        </button>
      </form>
      {notice === null ? null : (
        <p className="notice" role="alert">
          {notice}
        </p>
      )}
      <p className="hint">
        No account needed. Your name is temporary and only used in this room.
      </p>
    </section>
  );
}
