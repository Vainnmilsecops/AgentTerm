import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { DestructiveConfirm } from './destructive-confirm';

describe('DestructiveConfirm', () => {
  it('renders a disabled confirm button until the typed value matches the expected name', () => {
    const markup = renderToStaticMarkup(
      createElement(DestructiveConfirm, {
        busy: false,
        confirmLabel: 'Delete forever',
        expectedName: 'production-database',
        message: 'This cannot be undone.',
        onCancel: vi.fn(),
        onConfirm: vi.fn(),
        title: 'Confirm deletion',
      }),
    );

    expect(markup).toContain('Confirm deletion');
    expect(markup).toContain('This cannot be undone.');
    expect(markup).toContain('production-database');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('type="button"');
  });

  it('exposes stable focus management hooks via data attributes', () => {
    const markup = renderToStaticMarkup(
      createElement(DestructiveConfirm, {
        busy: false,
        confirmLabel: 'Drop session',
        expectedName: 'agent-session-42',
        onCancel: vi.fn(),
        onConfirm: vi.fn(),
        title: 'Drop Agent Session',
      }),
    );

    expect(markup).toContain('data-destructive-confirm');
    expect(markup).toContain('data-destructive-confirm-input');
    expect(markup).toContain('data-destructive-confirm-action');
  });
});
