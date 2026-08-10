import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';

function DesktopShell() {
  return (
    <main className="shell">
      <p className="eyebrow">Project foundation</p>
      <h1>AgentTerm</h1>
      <p className="summary">
        Windows-first workspace shell. Terminal, task, Git, and coding-agent capabilities are
        intentionally deferred.
      </p>
    </main>
  );
}

const rootElement = document.getElementById('root');

if (rootElement === null) {
  throw new Error('Desktop renderer root element was not found.');
}

createRoot(rootElement).render(
  <StrictMode>
    <DesktopShell />
  </StrictMode>,
);
