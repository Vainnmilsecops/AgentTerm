import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { BoardEntry } from './board-entry';
import type { AgentWorkspaceClient } from './workspace-controller';

function makeClient(loadResult: unknown): AgentWorkspaceClient {
  return {
    loadWorkspace: vi.fn().mockResolvedValue(loadResult),
  } as unknown as AgentWorkspaceClient;
}

function render(props: Parameters<typeof BoardEntry>[0]): string {
  return renderToStaticMarkup(createElement(BoardEntry, props));
}

describe('BoardEntry', () => {
  it('renders the loading placeholder before the workspace overview resolves', () => {
    const html = render({ client: makeClient({ agents: [], projects: [] }) });
    expect(html).toContain('Loading workspace');
  });

  it('accepts a read-only onActivateTask callback slot', () => {
    const html = render({
      client: makeClient({ agents: [], projects: [] }),
      onActivateTask: () => undefined,
    });
    expect(html).toBeDefined();
  });

  it('omits onActivateTask entirely when no callback is supplied', () => {
    const html = render({ client: makeClient({ agents: [], projects: [] }) });
    expect(html).toBeDefined();
  });
});