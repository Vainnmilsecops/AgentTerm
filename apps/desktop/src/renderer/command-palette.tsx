import type { KeyboardEvent, MouseEvent } from 'react';

import {
  filterWorkspaceCommands,
  resolveCommandPaletteKey,
  type CommandPaletteAction,
  type CommandPaletteState,
  type WorkspaceCommand,
} from './workspace-command-palette';

export interface WorkspaceCommandPaletteProps {
  readonly commands: readonly WorkspaceCommand[];
  readonly onAction: (action: CommandPaletteAction, resultCount: number) => void;
  readonly onRun: (command: WorkspaceCommand) => void;
  readonly state: CommandPaletteState;
}

const commandListId = 'workspace-command-list';

export function WorkspaceCommandPalette({
  commands,
  onAction,
  onRun,
  state,
}: WorkspaceCommandPaletteProps) {
  if (!state.open) {
    return null;
  }

  const filtered = filterWorkspaceCommands(commands, state.query);
  const active = filtered[state.activeIndex];

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const action = resolveCommandPaletteKey({
      isComposing: event.nativeEvent.isComposing,
      key: event.key,
    });
    if (action === undefined) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (action === 'RUN') {
      if (active !== undefined) {
        onRun(active);
      }
      return;
    }
    onAction(action, filtered.length);
  };

  const closeFromBackdrop = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) {
      onAction({ kind: 'CLOSE' }, filtered.length);
    }
  };

  return (
    <div className="command-palette-backdrop" onMouseDown={closeFromBackdrop}>
      <section
        aria-label="Command palette"
        aria-modal="true"
        className="command-palette"
        role="dialog"
      >
        <header className="command-palette__header">
          <div>
            <p className="eyebrow">Keyboard command</p>
            <h2>Go anywhere</h2>
          </div>
          <kbd>Ctrl+Shift+P</kbd>
        </header>
        <input
          aria-activedescendant={active === undefined ? undefined : commandElementId(active.id)}
          aria-autocomplete="list"
          aria-controls={commandListId}
          aria-expanded="true"
          aria-label="Search commands"
          autoFocus
          className="command-palette__search"
          onChange={(event) => {
            const query = event.currentTarget.value;
            onAction({ kind: 'SEARCH', query }, filterWorkspaceCommands(commands, query).length);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Search Tasks, views, actions, quality gatesâ€¦"
          role="combobox"
          type="text"
          value={state.query}
        />
        <div className="command-palette__results">
          {filtered.length === 0 ? (
            <p className="command-palette__empty" role="status">
              No commands match â€œ{state.query}â€.
            </p>
          ) : (
            <ul id={commandListId} role="listbox">
              {filtered.map((candidate) => (
                <li
                  aria-selected={candidate.id === active?.id}
                  id={commandElementId(candidate.id)}
                  key={candidate.id}
                  role="option"
                >
                  <button onClick={() => onRun(candidate)} tabIndex={-1} type="button">
                    <span>
                      <strong>{candidate.label}</strong>
                      <small>{candidate.category}</small>
                    </span>
                    {candidate.shortcut === undefined ? null : <kbd>{candidate.shortcut}</kbd>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <footer className="command-palette__footer">
          <span>â†‘â†“ Navigate</span>
          <span>Enter Run</span>
          <span>Esc Close</span>
        </footer>
      </section>
    </div>
  );
}

function commandElementId(commandId: string): string {
  return `workspace-command-${commandId.replace(/[^a-zA-Z0-9_-]/gu, '-')}`;
}
