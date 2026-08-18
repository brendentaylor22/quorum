import type {
  CatalogSource,
  InstanceInfo,
  RoomCreationMode,
} from '@quorum/contracts';
import { useEffect, useState } from 'react';
import { api } from './api.js';
import { CreateScreen } from './screens/CreateScreen.js';
import { HostScreen } from './screens/HostScreen.js';
import { JoinScreen } from './screens/JoinScreen.js';
import { PrivacyScreen } from './screens/PrivacyScreen.js';

/**
 * Provider attribution comes from the server rather than being hard-coded, so
 * the notice always matches the catalog actually installed. TMDB requires its
 * notice wherever their data is shown, however small the deployment.
 */
function CatalogNotice({ source }: { source: CatalogSource | null }) {
  if (source === null) return null;
  if (source.attribution !== null) {
    return (
      <p className="hint">
        {source.attribution}{' '}
        <a href="https://www.themoviedb.org" rel="noreferrer noopener">
          TMDB
        </a>
      </p>
    );
  }
  return (
    <p className="hint">
      Movie details are synthetic fixture data during development.
    </p>
  );
}

/**
 * Load a public description of the instance once. Neither call is worth an
 * error banner: a missing attribution or source link degrades the footer, not
 * the product.
 */
function useSiteInfo(): {
  catalog: CatalogSource | null;
  instance: InstanceInfo | null;
  roomCreation: RoomCreationMode | null;
} {
  const [catalog, setCatalog] = useState<CatalogSource | null>(null);
  const [instance, setInstance] = useState<InstanceInfo | null>(null);
  // Kept apart from `instance` so a failed call can fall back without inventing
  // a source URL for the footer. `public` is the right fallback: it is the
  // shipped default, and it leaves the button working rather than stuck
  // disabled on an instance that never closed anything.
  const [roomCreation, setRoomCreation] = useState<RoomCreationMode | null>(
    null,
  );

  useEffect(() => {
    let active = true;
    api
      .catalogSource()
      .then((value) => {
        if (active) setCatalog(value);
      })
      .catch(() => undefined);
    api
      .instance()
      .then((value) => {
        if (!active) return;
        setInstance(value);
        setRoomCreation(value.roomCreation);
      })
      .catch(() => {
        if (active) setRoomCreation('public');
      });
    return () => {
      active = false;
    };
  }, []);

  return { catalog, instance, roomCreation };
}

/**
 * Capabilities live in the URL path, so routing is a direct read of the
 * current location. No router dependency is needed for six screens.
 */
export function App() {
  const segments = globalThis.location.pathname.split('/').filter(Boolean);
  const [route, token] = segments;
  const { catalog, instance, roomCreation } = useSiteInfo();
  // Inside a room the headline has done its job, and on a phone it costs a
  // third of the screen that the voting card needs. Only the landing page,
  // where it is the pitch, keeps it.
  const inRoom = route === 'join' || route === 'host';

  return (
    <main className={inRoom ? 'in-room' : ''}>
      <header className={inRoom ? 'compact' : ''}>
        <p className="eyebrow">
          <a href="/">QUORUM</a>
        </p>
        {inRoom || route === 'privacy' ? null : (
          <h1>Pick something to watch, together.</h1>
        )}
      </header>
      {route === 'privacy' ? (
        <PrivacyScreen catalog={catalog} instance={instance} />
      ) : route === 'join' && token !== undefined ? (
        <JoinScreen inviteToken={token} />
      ) : route === 'host' && token !== undefined ? (
        <HostScreen hostToken={token} />
      ) : (
        <CreateScreen roomCreation={roomCreation} />
      )}
      <footer>
        <CatalogNotice source={catalog} />
        <p className="hint">
          <a href="/privacy">What Quorum knows about you</a>
          {instance === null ? null : (
            <>
              {' · '}
              <a href={instance.sourceUrl} rel="noreferrer noopener">
                Source
              </a>
            </>
          )}
        </p>
      </footer>
    </main>
  );
}
