import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionNoteCaptureOverlay, type SessionNoteKind } from './session-note-capture-overlay';

function renderOverlay(
  kind: SessionNoteKind,
  overrides: Partial<{
    onCancel: () => void;
    onSubmit: (input: { readonly content: string }) => void;
    busy: boolean;
    errorMessage: string | undefined;
  }> = {},
): string {
  const onCancel = overrides.onCancel ?? vi.fn();
  const onSubmit = overrides.onSubmit ?? vi.fn();
  return renderToStaticMarkup(
    createElement(SessionNoteCaptureOverlay, {
      busy: overrides.busy ?? false,
      errorMessage: overrides.errorMessage,
      kind,
      onCancel,
      onSubmit,
    }),
  );
}

describe('SessionNoteCaptureOverlay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the heading prefix in the preview for the selected kind', () => {
    const html = renderOverlay('brainstorm');
    expect(html).toContain('# Brainstorm');
    expect(html).toContain('data-testid="session-note-capture-brainstorm-textarea"');
    expect(html).toContain('data-testid="session-note-capture-brainstorm-submit"');
    expect(html).toContain('aria-modal="true"');
  });

  it('renders sweep heading and submit affordance for sweep kind', () => {
    const html = renderOverlay('sweep');
    expect(html).toContain('# Sweep');
    expect(html).toContain('data-testid="session-note-capture-sweep-textarea"');
    expect(html).toContain('data-testid="session-note-capture-sweep-submit"');
  });

  it('disables submit when busy', () => {
    const html = renderOverlay('brainstorm', { busy: true });
    expect(html).toContain('disabled=""');
  });

  it('surfaces server error messages', () => {
    const html = renderOverlay('brainstorm', { errorMessage: 'Server refused to record note' });
    expect(html).toContain('data-testid="session-note-capture-brainstorm-server-error"');
    expect(html).toContain('Server refused to record note');
  });

  it('renders the validation error placeholder when body is empty', () => {
    const html = renderOverlay('sweep');
    expect(html).toContain('data-testid="session-note-capture-sweep-validation-error"');
  });
});
