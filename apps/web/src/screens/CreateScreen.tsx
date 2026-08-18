import type { RoomCreationMode } from '@quorum/contracts';
import { useState } from 'react';
import { api } from '../api.js';
import { rememberInvite } from '../hooks.js';

/**
 * What a visitor sees on an instance that mints its rooms from the shell.
 *
 * A disabled button with a 403 behind it reads as breakage; this reads as
 * policy. It reveals nothing — `/api/instance` already publishes the mode —
 * and it points the one visitor who matters, somebody holding an invite, at
 * the link they already have.
 */
function InvitationOnly() {
  return (
    <section aria-labelledby="create-heading">
      <h2 id="create-heading">By invitation only</h2>
      <p className="lede">
        This instance creates rooms by invitation. Ask whoever is hosting for
        their link — it opens straight into the room, with no account and no
        email.
      </p>
    </section>
  );
}

export function CreateScreen({
  roomCreation,
}: {
  /** `null` while `/api/instance` is still in flight. */
  roomCreation: RoomCreationMode | null;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (roomCreation === 'operator') return <InvitationOnly />;

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
        // Also disabled until the mode is known, so a visitor to a closed
        // instance cannot press it during the instant before the notice
        // replaces it and collect a 403 for their trouble.
        disabled={busy || roomCreation === null}
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
