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
  {
    category: 'Task',
    id: 'artifact:produce',
    keywords: ['artifact'],
    label: 'Produce artifact',
    run: () => undefined,
  },
  {
    category: 'Quality gates',
    id: 'gate:register',
    keywords: ['register'],
    label: 'Register Quality Gate',
    run: () => undefined,
  },
  {
    category: 'Task',
    id: 'dependency:require:task-1',
    keywords: ['dependency'],
    label: 'Require task: Foundation',
    run: () => undefined,
  },
  {
    category: 'Task',
    id: 'dependency:remove:task-2',
    keywords: ['dependency'],
    label: 'Remove required task: Cleanup',
    run: () => undefined,
  },
  {
    category: 'Quality gates',
    id: 'gate:remove:lint:eslint',
    keywords: ['unregister'],
    label: 'Unregister Quality Gate: lint:eslint',
    run: () => undefined,
  },
  {
    category: 'Quality gates',
    id: 'gate:lint:eslint',
    keywords: ['lint'],
    label: 'Run lint:eslint',
    run: () => undefined,
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

  it('attaches data-palette-anchor to workflow commands so keyboard users can rely on stable selectors', () => {
    const markup = renderToStaticMarkup(
      createElement(WorkspaceCommandPalette, {
        commands,
        onAction: vi.fn(),
        onRun: vi.fn(),
        recents: [],
        state: { activeIndex: 0, open: true, query: '' },
      }),
    );

    expect(markup).toContain('data-palette-anchor="produce-artifact"');
    expect(markup).toContain('data-palette-anchor="register-gate"');
    expect(markup).toContain('data-palette-anchor="add-dependency"');
    expect(markup).toContain('data-palette-anchor="remove-dependency"');
    expect(markup).toContain('data-palette-anchor="unregister-gate"');
    expect(markup).toContain('data-palette-anchor="lint:eslint"');
  });
});
