import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const workspaceSource = readFileSync(
  new URL('./renderer/agent-workspace.tsx', import.meta.url),
  'utf8',
);
const terminalRendererSource = readFileSync(
  new URL('./renderer/terminal-renderer.tsx', import.meta.url),
  'utf8',
);
const workspaceTerminalsSource = readFileSync(
  new URL('./renderer/workspace-terminals.tsx', import.meta.url),
  'utf8',
);
const styles = readFileSync(new URL('./renderer/styles.css', import.meta.url), 'utf8');
const rendererEntry = readFileSync(new URL('./renderer/main.tsx', import.meta.url), 'utf8');

describe('desktop workspace visual contract', () => {
  it('offers a keyboard skip route into the selected Task workspace', () => {
    expect(workspaceSource).toContain('className="skip-link"');
    expect(workspaceSource).toContain('href="#workspace-main"');
  });

  it('defines the shared OLED design tokens used by the desktop workspace', () => {
    expect(styles).toContain('--surface-canvas: #020617');
    expect(styles).toContain('--accent-primary: #22c55e');
    expect(styles).toContain('--focus-ring: #ffffff');
    expect(styles).toContain('--font-interface:');
  });

  it('keeps keyboard focus visible and honors reduced-motion preferences', () => {
    expect(styles).toMatch(/:focus-visible[\s\S]*outline:\s*2px solid var\(--focus-ring\)/);
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('keeps the CLI terminal bounded and exposes a horizontal resize separator', () => {
    expect(workspaceSource).toContain('className="terminal-resize-handle"');
    expect(workspaceSource).toContain('aria-orientation="horizontal"');
    expect(workspaceSource).toContain('role="separator"');
    expect(styles).toContain('.resizable-terminal');
    expect(styles).toContain('height: var(--terminal-height)');
  });

  it('defines motion tokens and routes every transition through them', () => {
    expect(styles).toContain('--motion-fast: 120ms');
    expect(styles).toContain('--motion-base: 180ms');
    expect(styles).toContain('--motion-slow: 280ms');
    expect(styles).toContain('--ease-out:');
    expect(styles).toContain('--ease-in-out:');
    const transitionLines = styles.match(/transition[^;]*;/g) ?? [];
    expect(transitionLines.length).toBeGreaterThan(0);
    for (const line of transitionLines) {
      if (line.includes('!important')) {
        continue;
      }
      expect(line).toMatch(/var\(--motion-/);
      expect(line).toMatch(/var\(--ease-/);
    }
  });

  it('defines a Studio Terminal type scale and self-hosted Inter Tight stack', () => {
    expect(styles).toContain('--text-xs: 0.68rem');
    expect(styles).toContain('--text-base: 0.875rem');
    expect(styles).toContain('--text-3xl:');
    expect(styles).toMatch(/--font-display:[\s\S]*Inter Tight/);
    expect(styles).toMatch(/--font-body:[\s\S]*Inter/);
    expect(styles).toMatch(/--font-code-pro:[\s\S]*JetBrains Mono/);
    expect(rendererEntry).toContain('@fontsource-variable/inter');
    expect(rendererEntry).toContain('@fontsource-variable/inter-tight');
    expect(rendererEntry).toContain('@fontsource-variable/jetbrains-mono');
  });

  it('color-codes every Task phase and pulses only the RUNNING dot', () => {
    expect(styles).toContain('--phase-backlog:');
    expect(styles).toContain('--phase-planning:');
    expect(styles).toContain('--phase-running:');
    expect(styles).toContain('--phase-review:');
    expect(styles).toContain('--phase-done:');
    expect(styles).toMatch(/@keyframes phase-pulse[\s\S]*scale/);
    expect(styles).toMatch(/\.phase-running--active[\s\S]*animation:\s*phase-pulse/);
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-iteration-count:\s*1/,
    );
  });

  it('glows the focused terminal pane, pulses the session dot, and exposes split affordance', () => {
    expect(styles).toMatch(/\.terminal-panel:focus-within[\s\S]*box-shadow/);
    expect(styles).toMatch(/\.terminal-status--running[\s\S]*animation:\s*phase-pulse/);
    expect(styles).toContain('.terminal-layout-actions');
    expect(styles).toMatch(/\.terminal-split-affordance/);
    expect(workspaceTerminalsSource).toMatch(/Split terminal|\+ Split/);
  });

  it('exposes EmptyState, Skeleton, and a name-typed DestructiveConfirm', () => {
    expect(styles).toContain('.empty-state');
    expect(styles).toContain('@keyframes skeleton-shimmer');
    expect(styles).toContain('.destructive-confirm');
    expect(styles).toContain('.destructive-confirm__prompt code');
    expect(styles).toContain('.primary-action--danger');
  });

  it('persists workspace layout across sessions and exposes a settings gear', () => {
    expect(workspaceSource).toContain('readPersistedLayout');
    expect(workspaceSource).toContain('writePersistedLayout');
    expect(workspaceSource).toContain('WorkspaceSettingsGear');
    expect(workspaceSource).toContain('workspace-shell--sidebar-collapsed');
    expect(styles).toContain('.workspace-settings-gear');
    expect(styles).toContain('.workspace-settings__segment');
    expect(styles).toContain('--sidebar-width:');
  });

  it('exposes mnemonic keyboard hints and binds Alt+key shortcuts', () => {
    expect(workspaceSource).toContain('handleMnemonicKeyDown');
    expect(workspaceSource).toContain('data-action-hint="begin-planning"');
    expect(workspaceSource).toContain('data-action-hint="accept-plan"');
    expect(workspaceSource).toContain('data-action-hint="request-review"');
    expect(workspaceSource).toContain('data-action-hint="approve-review"');
    expect(styles).toContain('.button-with-hint');
    expect(styles).toContain('.button-hint');
  });

  it('renders a Geist-style empty state with skeleton rows for terminal panes', () => {
    expect(terminalRendererSource).toContain('terminal-panel__empty');
    expect(terminalRendererSource).toContain('terminal-panel__empty-card');
    expect(styles).toContain('.terminal-panel__empty-card');
    expect(styles).toContain('.terminal-panel__empty-skeleton');
  });

  it('exposes a footer status bar with terminal state, agent, branch, and shortcut hints', () => {
    expect(workspaceSource).toContain('WorkspaceFooterStatus');
    expect(workspaceSource).toContain('terminalStateFor');
    expect(styles).toContain('.workspace-footer');
    expect(styles).toContain('.workspace-footer__dot');
    expect(styles).toContain('.workspace-footer__hint');
  });

  it('applies the Studio Terminal aesthetic with two-tone surface + scanline + cyan glow', () => {
    expect(styles).toMatch(/terminal-panel::after[\s\S]*repeating-linear-gradient/);
    expect(styles).toMatch(/terminal-panel:focus-within[\s\S]*rgb\(94 234 212/);
    expect(styles).toMatch(/workspace-shell[\s\S]*radial-gradient[\s\S]*rgb\(94 234 212/);
  });

  it('paints the active task with a pill indicator and shows keyboard hint chevrons', () => {
    expect(workspaceSource).toContain('task-option__hint');
    expect(styles).toContain('.task-option__hint');
    expect(styles).toMatch(/task-option\[aria-pressed='true'\]::after/);
  });

  it('redesigns workspace tabs with status dot, agent badge, and close-on-hover', () => {
    expect(workspaceTerminalsSource).toContain('workspace-tab__dot');
    expect(workspaceTerminalsSource).toContain('workspace-tab__agent-badge');
    expect(styles).toMatch(/workspace-tab:hover[\s\S]*workspace-tab__close[\s\S]*opacity:\s*1/);
    expect(styles).toContain('.workspace-tab__dot--running');
  });

  it('exposes a Geist-style context card with delay and metadata rows', () => {
    expect(workspaceSource).toContain('ContextCard');
    expect(workspaceSource).toContain('focusWorkspaceTarget(\'terminal\')');
    expect(styles).toContain('.context-card');
    expect(styles).toContain('.context-card__panel');
    expect(styles).toContain('.context-card__meta');
  });

  it('paints the command palette with animated gradient border, shimmer, and right-aligned shortcuts', () => {
    expect(styles).toContain('.command-palette__border');
    expect(styles).toContain('@keyframes command-palette-border');
    expect(styles).toContain('.command-palette__shimmer');
    expect(styles).toContain('.command-palette__option-shortcut');
  });

  it('renders an inline toast stack with success/info/danger tones paired to action verbs', () => {
    expect(workspaceSource).toContain('ToastStack');
    expect(workspaceSource).toContain('toastForAction');
    expect(styles).toContain('.toast-stack');
    expect(styles).toContain('.toast--success');
    expect(styles).toContain('.toast--danger');
    expect(styles).toContain('@keyframes toast-in');
  });
});
