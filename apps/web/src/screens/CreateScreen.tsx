import { useState } from 'react';
import { api } from '../api.js';
import { rememberInvite } from '../hooks.js';

export function CreateScreen() {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <section aria-labelledby="create-heading">
      <h2 id="create-heading">Start a room</h2>
      <p className="lede">
        Everyone swipes the same 20 movies in private. Quorum ranks them by
        group approval when voting ends.
      </p>
      <ol className="steps">
        <li>Create the room and share the invite link.</li>
        <li>Everyone picks a name — no account, no email.</li>
        <li>You start voting when the group is in.</li>
      </ol>
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
              // The host link is the room's private address, so navigate to it
              // rather than rendering the host screen behind the landing URL:
              // a refresh or a bookmark then returns to these same controls.
              globalThis.location.assign(created.hostPath);
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
