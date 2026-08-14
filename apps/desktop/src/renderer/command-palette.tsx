import type { KeyboardEvent, MouseEvent } from 'react';

import {
  groupCommandsByCategory,
  rankByFuzzyScore,
  type CommandGroup,
  type CommandWithRun,
} from './command-palette-search';
import {
  resolveCommandPaletteKey,
  type CommandPaletteAction,
  type CommandPaletteState,
  type WorkspaceCommand,
} from './workspace-command-palette';

export interface WorkspaceCommandPaletteProps {
  readonly commands: readonly WorkspaceCommand[];
  readonly onAction: (action: CommandPaletteAction, resultCount: number) => void;
  readonly onRun: (command: WorkspaceCommand) => void;
  readonly recents: readonly string[];
  readonly state: CommandPaletteState;
}

const commandListId = 'workspace-command-list';
const MAX_RECENTS = 5;

export function WorkspaceCommandPalette({
  commands,
  onAction,
  onRun,
  recents,
  state,
}: WorkspaceCommandPaletteProps) {
  if (!state.open) {
    return null;
  }

  const commandsById = new Map<string, WorkspaceCommand>();
  for (const command of commands) {
    commandsById.set(command.id, command);
  }

  const ranked = rankByFuzzyScore(commands, state.query);
  const recentGroups = buildRecentStrip(commands, recents, ranked);
  const otherGroups = filterOutRecent(ranked, recentGroups);
  const allGroups: readonly CommandGroup[] = [...recentGroups, ...otherGroups];
  const flat = allGroups.flatMap((group) => group.commands);
  const active = flat[state.activeIndex];
  const flatIndexLookup = buildFlatIndexLookup(allGroups);

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
        const original = commandsById.get(active.id);
        if (original !== undefined) {
          onRun(original);
        }
      }
      return;
    }
    onAction(action, flat.length);
  };

  const closeFromBackdrop = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) {
      onAction({ kind: 'CLOSE' }, flat.length);
    }
  };

  return (
    <div className="command-palette-backdrop" onMouseDown={closeFromBackdrop}>
      <div className="command-palette__border">
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
            const next = rankByFuzzyScore(commands, query);
            onAction({ kind: 'SEARCH', query }, next.length);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Search Tasks, views, actions, quality gates…"
          role="combobox"
          type="text"
          value={state.query}
        />
        <div className="command-palette__shimmer" data-command-shimmer aria-hidden="true">
          <span />
        </div>
        <div className="command-palette__results">
          {flat.length === 0 ? (
            <p className="command-palette__empty" role="status">
              No commands match <strong>{state.query || 'this query'}</strong>. Try <em>open</em>,{' '}
              <em>focus</em>, or <em>run</em>.
            </p>
          ) : (
            <ul id={commandListId} role="listbox">
              {allGroups.map((group, groupIndex) => (
                <li className="command-palette__group" key={group.category}>
                  <header className="command-palette__group-header">
                    <span>{group.category}</span>
                    <small>{group.commands.length}</small>
                  </header>
                  <ul>
                    {group.commands.map((candidate) => {
                      const flatIndex = flatIndexLookup.get(candidate.id);
                      const isActive = flatIndex === state.activeIndex;
                      return (
                        <li
                          aria-selected={isActive}
                          id={commandElementId(candidate.id)}
                          key={`${groupIndex}:${candidate.id}`}
                          role="option"
                        >
                          <button
                            className="command-palette__option"
                            onClick={() => {
                              const original = commandsById.get(candidate.id);
                              if (original !== undefined) {
                                onRun(original);
                              }
                            }}
                            onMouseEnter={() => {
                              if (flatIndex !== undefined) {
                                onAction({ kind: 'SEARCH', query: state.query }, flatIndex);
                              }
                            }}
                            tabIndex={-1}
                            type="button"
                          >
                            <span className="command-palette__option-label">
                              <strong>{candidate.label}</strong>
                              <em className="command-palette__option-category">{candidate.category}</em>
                            </span>
                            {candidate.shortcut === undefined ? null : (
                              <kbd className="command-palette__option-shortcut">{candidate.shortcut}</kbd>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
        <footer className="command-palette__footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> Navigate
          </span>
          <span>
            <kbd>↵</kbd> Run
          </span>
          <span>
            <kbd>Esc</kbd> Close
          </span>
        </footer>
        </section>
      </div>
    </div>
  );
}

function buildRecentStrip(
  commands: readonly WorkspaceCommand[],
  recents: readonly string[],
  ranked: readonly ReturnType<typeof rankByFuzzyScore>[number][],
): readonly CommandGroup[] {
  if (recents.length === 0) {
    return [];
  }
  const byId = new Map<string, WorkspaceCommand>();
  for (const command of commands) {
    byId.set(command.id, command);
  }
  const recentCommands: CommandWithRun[] = [];
  for (const id of recents) {
    const command = byId.get(id);
    if (command === undefined) {
      continue;
    }
    if (ranked.some((entry) => entry.id === id)) {
      recentCommands.push({
        category: command.category,
        id: command.id,
        keywords: command.keywords,
        label: command.label,
        run: command.run,
        score: 0,
        ...(command.shortcut === undefined ? {} : { shortcut: command.shortcut }),
      });
    }
  }
  if (recentCommands.length === 0) {
    return [];
  }
  return [{ category: 'Recent', commands: recentCommands.slice(0, MAX_RECENTS) }];
}

function filterOutRecent(
  ranked: readonly ReturnType<typeof rankByFuzzyScore>[number][],
  recents: readonly CommandGroup[],
): readonly CommandGroup[] {
  const recentIds = new Set<string>();
  for (const group of recents) {
    for (const command of group.commands) {
      recentIds.add(command.id);
    }
  }
  return groupCommandsByCategory(ranked.filter((command) => !recentIds.has(command.id)));
}

function buildFlatIndexLookup(groups: readonly CommandGroup[]): ReadonlyMap<string, number> {
  const lookup = new Map<string, number>();
  let index = 0;
  for (const group of groups) {
    for (const command of group.commands) {
      lookup.set(command.id, index);
      index += 1;
    }
  }
  return lookup;
}

function commandElementId(commandId: string): string {
  return `workspace-command-${commandId.replace(/[^a-zA-Z0-9_-]/gu, '-')}`;
}
