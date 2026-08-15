import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const rendererUrl = new URL('./renderer/', import.meta.url);
const workspaceSource = readFileSync(new URL('agent-workspace.tsx', rendererUrl), 'utf8');
const boardSource = readFileSync(new URL('workspace-project-board.tsx', rendererUrl), 'utf8');
const terminalRendererSource = readFileSync(new URL('terminal-renderer.tsx', rendererUrl), 'utf8');
const workspaceTerminalsSource = readFileSync(
  new URL('workspace-terminals.tsx', rendererUrl),
  'utf8',
);
const rendererEntry = readFileSync(new URL('main.tsx', rendererUrl), 'utf8');
const styleEntry = readFileSync(new URL('styles.css', rendererUrl), 'utf8');

const styleModules = [
  'foundation.css',
  'workspace.css',
  'evidence.css',
  'terminal.css',
  'overlays.css',
  'responsive.css',
] as const;

const stylesByModule = Object.fromEntries(
  styleModules.map((name) => {
    const url = new URL(`styles/${name}`, rendererUrl);
    return [name, existsSync(url) ? readFileSync(url, 'utf8') : ''];
  }),
) as Record<(typeof styleModules)[number], string>;

const allStyles = styleModules.map((name) => stylesByModule[name]).join('\n');

describe('desktop workspace visual contract', () => {
  it('has one explicit stylesheet composition instead of layered visual-system overrides', () => {
    expect(styleEntry.trim()).toBe(
      styleModules.map((name) => `@import './styles/${name}';`).join('\n'),
    );
    for (const name of styleModules) {
      expect(stylesByModule[name].trim().length, `${name} should not be empty`).toBeGreaterThan(0);
    }
    expect(allStyles).not.toContain('generated from the UI/UX Pro Max direction');
    expect(allStyles).not.toContain('Studio Terminal');
  });

  it('defines the Stitch Technical Precision tokens once for dark and light themes', () => {
    const foundation = stylesByModule['foundation.css'];
    expect(foundation).toContain('--surface-floor: #0d1117');
    expect(foundation).toContain('--surface-plane: #161b22');
    expect(foundation).toContain('--surface-elevated: #1c2128');
    expect(foundation).toContain('--accent-primary: #a2c9ff');
    expect(foundation).toContain('--phase-planning: #d8baff');
    expect(foundation).toContain('--phase-review: #ffba42');
    expect(foundation).toMatch(/:root\[data-theme='light'\][\s\S]*--surface-floor:/u);
    expect(foundation).toContain("--font-ui: 'Inter Variable'");
    expect(foundation).toContain("--font-mono: 'JetBrains Mono Variable'");
  });

  it('keeps each structural pane under one CSS owner and supports a right sidebar', () => {
    const workspace = stylesByModule['workspace.css'];
    expect(workspace.match(/\.workspace-shell\s*\{/gu)).toHaveLength(1);
    expect(workspace.match(/\.workspace-main\s*\{/gu)).toHaveLength(1);
    expect(workspace.match(/\.workspace-sidebar\s*\{/gu)).toHaveLength(1);
    expect(workspace).toContain(".workspace-shell[data-sidebar-position='right']");
    expect(workspace).toContain('.workspace-board-pane');
    expect(workspace).toContain('.task-inspector');
    expect(workspace).toContain('.workspace-console-dock');
    expect(workspace).not.toContain('radial-gradient');
  });

  it('defines deterministic default, compact, and minimum-window layouts', () => {
    const responsive = stylesByModule['responsive.css'];
    expect(responsive).toContain('@media (max-width: 1120px)');
    expect(responsive).toContain('@media (max-width: 760px)');
    expect(responsive).toContain('@media (max-width: 560px)');
    expect(responsive).toMatch(/max-width: 760px[\s\S]*grid-column:\s*1/u);
    expect(responsive).toMatch(/max-width: 560px[\s\S]*\.workspace-topbar/u);
  });

  it('keeps keyboard focus visible and removes non-essential motion when requested', () => {
    const foundation = stylesByModule['foundation.css'];
    const responsive = stylesByModule['responsive.css'];
    expect(foundation).toMatch(/:focus-visible[\s\S]*outline:\s*2px solid var\(--focus-ring\)/u);
    expect(responsive).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('uses vector workspace icons and does not ship replacement glyphs', () => {
    expect(workspaceSource).toContain('WorkspaceIcon');
    expect(workspaceSource).not.toContain('\uFFFD');
    expect(boardSource).not.toContain('\uFFFD');
    expect(workspaceSource).not.toMatch(/[⌕＋↻ⓘ]/u);
  });

  it('keeps the CLI terminal bounded and exposes named resize semantics', () => {
    expect(workspaceSource).toContain('aria-label="Resize Agent Console height"');
    expect(workspaceSource).toContain('aria-orientation="horizontal"');
    expect(workspaceSource).toContain('role="separator"');
    expect(stylesByModule['terminal.css']).toContain('height: var(--terminal-height)');
    expect(workspaceTerminalsSource).toContain('role="tablist"');
    expect(workspaceTerminalsSource).toContain('onActiveConnectionStateChange');
    expect(workspaceTerminalsSource).toContain('taskId: activePane.taskId');
    expect(workspaceSource).toContain('activeTerminalContext.taskId');
    expect(workspaceSource).not.toContain('terminalStateFor');
  });

  it('keeps compact action errors visible and restores focus when drawers close', () => {
    const actionError = workspaceSource.indexOf('workspace-action-error');
    const inspector = workspaceSource.indexOf('className="task-inspector"');
    expect(actionError).toBeGreaterThan(-1);
    expect(inspector).toBeGreaterThan(actionError);
    expect(workspaceSource).toContain('data-navigator-toggle');
    expect(workspaceSource).toContain('closeCompactNavigator');
    expect(workspaceSource).toContain('closeInspector');
  });

  it('keeps the Agent Console mounted across Project-level empty states', () => {
    expect(workspaceSource).toContain('<Fragment key="workspace-runtime">');
    expect(workspaceSource.match(/\{workspaceRuntime\}/gu)).toHaveLength(2);
    expect(workspaceSource).toContain('workspace-main--without-inspector');
  });

  it('keeps pane states, empty states, and overlays visually available without decorative glow', () => {
    expect(terminalRendererSource).toContain('terminal-panel__empty');
    expect(terminalRendererSource).toMatch(
      /terminal-panel__viewport[\s\S]*state === 'empty'[\s\S]*terminal-panel__empty/u,
    );
    expect(stylesByModule['terminal.css']).toMatch(
      /\.terminal-panel__viewport\s*\{[\s\S]*position:\s*relative/u,
    );
    expect(allStyles).toContain('.empty-state');
    expect(allStyles).toContain('.destructive-confirm');
    expect(allStyles).toContain('.command-palette');
    expect(allStyles).toContain('.toast-stack');
    expect(stylesByModule['overlays.css']).toMatch(
      /\.command-palette__shimmer[\s\S]*display:\s*none/u,
    );
    expect(allStyles).not.toContain('backdrop-filter');
    expect(allStyles).not.toContain('box-shadow');
  });

  it('self-hosts the UI and code typefaces in the renderer entry', () => {
    expect(rendererEntry).toContain('@fontsource-variable/inter');
    expect(rendererEntry).toContain('@fontsource-variable/jetbrains-mono');
  });
});
