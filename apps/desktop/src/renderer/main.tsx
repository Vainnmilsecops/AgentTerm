import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';
import { TerminalRenderer } from './terminal-renderer';

function DesktopShell() {
  return (
    <main className="shell">
      <header className="shell__header">
        <div>
          <p className="eyebrow">Active terminal</p>
          <h1>AgentTerm</h1>
        </div>
        <p className="summary">
          One focused terminal surface for the active Agent Session. Process exit never marks its
          Task done.
        </p>
      </header>
      <TerminalRenderer />
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
