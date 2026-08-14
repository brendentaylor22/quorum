import { CreateScreen } from './screens/CreateScreen.js';
import { HostScreen } from './screens/HostScreen.js';
import { JoinScreen } from './screens/JoinScreen.js';

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
        <p className="hint">
          Movie details are synthetic fixture data during development.
        </p>
      </footer>
    </main>
  );
}
