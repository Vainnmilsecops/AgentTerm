import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';
import { AgentWorkspace } from './agent-workspace';
import type { AgentWorkspaceClient } from './workspace-controller';

declare global {
  interface Window {
    readonly agenttermWorkspace?: AgentWorkspaceClient;
  }
}

const rootElement = document.getElementById('root');

if (rootElement === null) {
  throw new Error('Desktop renderer root element was not found.');
}

createRoot(rootElement).render(
  <StrictMode>
    <AgentWorkspace
      {...(window.agenttermWorkspace === undefined ? {} : { client: window.agenttermWorkspace })}
    />
  </StrictMode>,
);
