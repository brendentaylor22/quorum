import type { CreateRoomResponse } from '@quorum/contracts';
import { useState } from 'react';
import { api } from '../api.js';
import { rememberInvite } from '../hooks.js';

function absolute(path: string): string {
  return new URL(path, globalThis.location.href).toString();
}

function LinkRow({ label, path }: { label: string; path: string }) {
  const url = absolute(path);
  return (
    <div className="link-row">
      <span className="link-label">{label}</span>
      <a href={path}>{url}</a>
    </div>
  );
}

export function CreateScreen() {
  const [room, setRoom] = useState<CreateRoomResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (room !== null) {
    return (
      <section aria-labelledby="created-heading">
        <h2 id="created-heading">Room ready</h2>
        <p className="lede">
          Share the invite link. Keep the host link private: it controls the
          room.
        </p>
        <LinkRow label="Invite" path={room.invitePath} />
        <LinkRow label="Host controls" path={room.hostPath} />
        <p className="hint">
          The room expires at {new Date(room.expiresAt).toLocaleString()} if it
          is not used.
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="create-heading">
      <h2 id="create-heading">Start a room</h2>
      <p className="lede">
        Everyone swipes the same 20 movies in private. Quorum ranks them by
        group approval when voting ends.
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setNotice(null);
          void api
            .createRoom()
            .then((created) => {
              rememberInvite(created.roomId, created.inviteToken);
              setRoom(created);
            })
            .catch((caught: unknown) => {
              setNotice(
                caught instanceof Error
                  ? caught.message
                  : 'Could not create a room.',
              );
            })
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        Create room
      </button>
      {notice === null ? null : (
        <p className="notice" role="alert">
          {notice}
        </p>
      )}
    </section>
  );
}
