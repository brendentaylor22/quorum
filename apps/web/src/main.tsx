import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

function App() {
  return (
    <main>
      <p className="eyebrow">QUORUM</p>
      <h1>Pick tonight&rsquo;s movie together.</h1>
      <p className="lede">
        Private group voting. No account required. Secure room creation arrives
        in Phase 2.
      </p>
      <section aria-labelledby="foundation-heading">
        <h2 id="foundation-heading">Foundation online</h2>
        <p>
          API, durable storage, backup, and deployment shape are ready for
          product flows.
        </p>
      </section>
    </main>
  );
}

const root = document.querySelector('#root');
if (root === null) throw new Error('Missing #root element');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
