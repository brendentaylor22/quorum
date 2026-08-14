import { useState } from 'react';
import { api } from '../api.js';
import { rememberInvite } from '../hooks.js';
import { HostScreen } from './HostScreen.js';

export function CreateScreen() {
  const [hostToken, setHostToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (hostToken !== null) return <HostScreen hostToken={hostToken} />;

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
              // The host link is the room's private address: put it in the URL
              // so a refresh or a bookmark returns to these controls.
              globalThis.history.replaceState(null, '', created.hostPath);
              setHostToken(created.hostToken);
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
