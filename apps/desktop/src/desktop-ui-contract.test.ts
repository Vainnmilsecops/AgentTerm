import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const workspaceSource = readFileSync(
  new URL('./renderer/agent-workspace.tsx', import.meta.url),
  'utf8',
);
const styles = readFileSync(new URL('./renderer/styles.css', import.meta.url), 'utf8');

describe('desktop workspace visual contract', () => {
  it('offers a keyboard skip route into the selected Task workspace', () => {
    expect(workspaceSource).toContain('className="skip-link"');
    expect(workspaceSource).toContain('href="#workspace-main"');
  });

  it('defines the shared OLED design tokens used by the desktop workspace', () => {
    expect(styles).toContain('--surface-canvas: #020617');
    expect(styles).toContain('--accent-primary: #22c55e');
    expect(styles).toContain('--focus-ring: #ffffff');
    expect(styles).toContain('--font-interface: Inter');
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

  it('keeps Settings controls aligned and exposes a wide sidebar resize target', () => {
    expect(workspaceSource).toContain('className="sidebar-resize-handle"');
    expect(workspaceSource).toContain('aria-orientation="vertical"');
    expect(styles).toContain('width: var(--sidebar-width, 17.5rem)');
    expect(styles).toMatch(/\.settings-form input,[\s\S]*width:\s*100%/);
    expect(styles).toMatch(/\.executable-setting small[\s\S]*overflow-wrap:\s*anywhere/);
  });
});
