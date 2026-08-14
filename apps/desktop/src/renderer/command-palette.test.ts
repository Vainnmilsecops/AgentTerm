import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { WorkspaceCommandPalette } from './command-palette';
import type { WorkspaceCommand } from './workspace-command-palette';

const commands: readonly WorkspaceCommand[] = [
  {
    category: 'Task',
    id: 'task:unicode',
    keywords: ['unicode'],
    label: 'Open Task: Kiểm tra tiếng Việt',
    run: () => undefined,
  },
  {
    category: 'Navigate',
    id: 'open:terminal',
    keywords: ['pty'],
    label: 'Open Terminal',
    run: () => undefined,
    shortcut: 'Alt+3',
  },
];

describe('WorkspaceCommandPalette', () => {
  it('renders a searchable accessible dialog with the active Unicode result', () => {
    const markup = renderToStaticMarkup(
      createElement(WorkspaceCommandPalette, {
        commands,
        onAction: vi.fn(),
        onRun: vi.fn(),
        recents: [],
        state: { activeIndex: 0, open: true, query: 'kiểm' },
      }),
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-label="Search commands"');
    expect(markup).toContain('value="kiểm"');
    expect(markup).toContain('Open Task: Kiểm tra tiếng Việt');
    expect(markup).not.toContain('Open Terminal');
  });

  it('renders nothing while closed', () => {
    const markup = renderToStaticMarkup(
      createElement(WorkspaceCommandPalette, {
        commands,
        onAction: vi.fn(),
        onRun: vi.fn(),
        recents: [],
        state: { activeIndex: 0, open: false, query: '' },
      }),
    );

    expect(markup).toBe('');
  });
});
