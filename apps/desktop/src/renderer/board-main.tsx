import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';

import type { AgentWorkspaceClient } from './workspace-controller';
import { mountBoardEntry } from './board-entry';

declare global {
  interface Window {
    readonly agenttermWorkspace?: AgentWorkspaceClient;
  }
}

const rootElement = document.getElementById('root');

if (rootElement === null) {
  throw new Error('AgentTerm board root element was not found.');
}

mountBoardEntry('root');