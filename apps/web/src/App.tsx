import type { CatalogSource } from '@quorum/contracts';
import { useEffect, useState } from 'react';
import { api } from './api.js';
import { CreateScreen } from './screens/CreateScreen.js';
import { HostScreen } from './screens/HostScreen.js';
import { JoinScreen } from './screens/JoinScreen.js';

/**
 * Provider attribution comes from the server rather than being hard-coded, so
 * the notice always matches the catalog actually installed. TMDB requires its
 * notice wherever their data is shown, however small the deployment.
 */
function CatalogNotice() {
  const [source, setSource] = useState<CatalogSource | null>(null);

  useEffect(() => {
    let active = true;
    api
      .catalogSource()
      .then((value) => {
        if (active) setSource(value);
      })
      .catch(() => {
        // Attribution is not worth surfacing an error banner for.
      });
    return () => {
      active = false;
    };
  }, []);

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
 * Capabilities live in the URL path, so routing is a direct read of the
 * current location. No router dependency is needed for five screens.
 */
export function App() {
  const segments = globalThis.location.pathname.split('/').filter(Boolean);
  const [route, token] = segments;

  return (
    <main>
      <header>
        <p className="eyebrow">
          <a href="/">QUORUM</a>
        </p>
        <h1>Pick something to watch, together.</h1>
      </header>
      {route === 'join' && token !== undefined ? (
        <JoinScreen inviteToken={token} />
      ) : route === 'host' && token !== undefined ? (
        <HostScreen hostToken={token} />
      ) : (
        <CreateScreen />
      )}
      <footer>
        <CatalogNotice />
      </footer>
    </main>
  );
}
