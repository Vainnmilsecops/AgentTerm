import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { PtyRuntimeEvent } from '@agentterm/application';

import {
  TerminalController,
  type TerminalConnectionFailure,
  type TerminalConnectionState,
  type TerminalSessionClient,
  type TerminalSurface,
} from './terminal-controller';
import {
  buildContextMenuActions,
  TerminalContextMenu,
  useTerminalContextMenu,
} from './terminal-context-menu';
import { isMouseModeActive, type MouseMode } from './terminal-mouse-mode-parser';
import {
  deriveSearchView,
  isSearchOpenShortcut,
  TerminalSearchBar,
  type TerminalSearchBarHandle,
} from './terminal-search-bar';
import {
  decideSearchAction,
  initialSearchState,
  type SearchEvent,
  type SearchState,
} from './terminal-search-state';
import { useTerminalInput } from './use-terminal-input';
import { WorkspaceIcon } from './workspace-icons';
import { registerTerminalLinkProvider, type IDisposableLinkProvider } from './xterm-link-provider';
import {
  registerWorktreeFileLinkProvider,
  type IDisposableWorktreeFileLinkProvider,
} from './xterm-worktree-file-link-provider';
import { XtermTerminalSurface } from './xterm-terminal-surface';

export interface TerminalRendererProps {
  readonly active?: boolean;
  readonly allowClipboardAccess?: boolean;
  readonly canClose?: boolean;
  readonly client?: TerminalSessionClient;
  readonly closeLabel?: string;
  readonly fontSize?: number;
  readonly label?: string;
  readonly onActivate?: () => void;
  readonly onClose?: () => void;
  readonly onConnectionStateChange?: (state: TerminalConnectionState) => void;
  readonly onOpenExternalLink?: (url: string) => void;
  readonly onOpenWorktreeFile?: (input: {
    readonly absolutePath: string;
    readonly taskId: string;
  }) => void;
  readonly onRuntimeEvent?: (event: PtyRuntimeEvent) => void;
  readonly onStopAgent?: (sessionId: string) => void;
  readonly onSlashCommand?: (kind: 'brainstorm' | 'merge-conflicts' | 'sweep') => void;
  readonly paneId?: string;
  readonly sessionId?: string;
  readonly taskId?: string;
}

export function TerminalRenderer({
  active = true,
  allowClipboardAccess = false,
  canClose = false,
  client,
  closeLabel = 'Close terminal pane',
  fontSize = 14,
  label = 'Agent Session terminal',
  onActivate,
  onClose,
  onConnectionStateChange,
  onOpenExternalLink,
  onOpenWorktreeFile,
  onRuntimeEvent,
  onSlashCommand,
  onStopAgent,
  paneId = 'primary',
  sessionId,
  taskId,
}: TerminalRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<XtermTerminalSurface | undefined>(undefined);
  const connectionStateChangeRef = useRef(onConnectionStateChange);
  const controllerRef = useRef<TerminalController | undefined>(undefined);
  const runtimeEventRef = useRef(onRuntimeEvent);
  const failureSinkRef = useRef<((failure: TerminalConnectionFailure) => void) | undefined>(
    undefined,
  );
  const searchBarRef = useRef<TerminalSearchBarHandle | null>(null);
  const [state, setState] = useState<TerminalConnectionState>('empty');
  const [mouseMode, setMouseMode] = useState<MouseMode>({ protocol: 'NONE', sgr: false });
  const [, setSelection] = useState('');
  const [searchState, setSearchState] = useState<SearchState>(initialSearchState);

  const inputHook = useTerminalInput({
    active,
    controller: controllerRef.current,
    paneId,
    sessionId,
    taskId,
  });

  const dispatchSearch = useCallback((event: SearchEvent): void => {
    setSearchState((prev) => {
      const decision = decideSearchAction(prev, event);
      for (const effect of decision.effects) {
        if (effect.kind === 'focus-input') {
          searchBarRef.current?.focus();
        }
      }
      return decision.state;
    });
  }, []);

  const searchView = useMemo(() => deriveSearchView(searchState), [searchState]);

  const runSearch = useCallback(
    (direction: 'next' | 'previous'): void => {
      if (searchState.term.trim().length === 0) return;
      if (searchState.mode === 'regex' && searchState.lastResult.kind === 'invalid-regex') {
        return;
      }
      const controller = controllerRef.current;
      if (controller === undefined) return;
      const request = {
        caseSensitive: searchState.caseSensitive,
        mode: searchState.mode,
        term: searchState.term,
      };
      const hit =
        direction === 'next'
          ? controller.findSearch(request)
          : controller.findSearchPrevious(request);
      dispatchSearch({
        kind: 'RECORD_RESULT',
        result: hit ? { kind: 'found' } : { kind: 'not-found' },
      });
    },
    [dispatchSearch, searchState],
  );

  useEffect(() => {
    failureSinkRef.current = inputHook.triggerControllerFailure;
  }, [inputHook.triggerControllerFailure]);

  useEffect(() => {
    runtimeEventRef.current = onRuntimeEvent;
  }, [onRuntimeEvent]);

  useEffect(() => {
    connectionStateChangeRef.current = onConnectionStateChange;
  }, [onConnectionStateChange]);

  useEffect(() => {
    connectionStateChangeRef.current?.(state);
  }, [state]);

  const allowClipboardAccessRef = useRef(allowClipboardAccess);
  useEffect(() => {
    allowClipboardAccessRef.current = allowClipboardAccess;
  }, [allowClipboardAccess]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }

    const surface = new XtermTerminalSurface({
      allowClipboardAccess: allowClipboardAccessRef.current,
    });
    surfaceRef.current = surface;
    const controller = new TerminalController(
      surface,
      setState,
      (event) => runtimeEventRef.current?.(event),
      (failure) => failureSinkRef.current?.(failure),
    );
    controllerRef.current = controller;
    const unsubscribeMouseMode = controller.onMouseModeChange(setMouseMode);
    const unsubscribeSlash = onSlashCommand
      ? controller.onSlashCommand((event) => onSlashCommand(event.kind))
      : undefined;
    controller.mount(container);
    return () => {
      unsubscribeMouseMode();
      unsubscribeSlash?.();
      if (controllerRef.current === controller) {
        controllerRef.current = undefined;
      }
      surfaceRef.current = undefined;
      controller.dispose();
    };
  }, [client, onSlashCommand]);

  useEffect(() => {
    void controllerRef.current?.setSession(sessionId, client);
  }, [client, sessionId]);

  useEffect(() => {
    controllerRef.current?.setFontSize(fontSize);
  }, [fontSize]);

  // Wire keyboard handler into xterm via the surface once both exist.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (surface === undefined) return undefined;
    const handler = (event: KeyboardEvent): boolean => inputHook.tryHandleKeyEvent(event);
    surface.setKeyHandler(handler);
    return () => {
      surface.setKeyHandler(undefined);
    };
  }, [inputHook]);

  // Route native paste through the same pane-local confirmation policy.
  useEffect(() => {
    const host = surfaceRef.current?.hostElement();
    if (host === undefined) return;
    let composing = false;
    const startComposition = (): void => {
      composing = true;
    };
    const endComposition = (): void => {
      composing = false;
    };
    const onPaste = (event: ClipboardEvent): void => {
      if (composing || !active || !host.contains(document.activeElement)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      inputHook.pasteText(event.clipboardData?.getData('text/plain') ?? '');
    };
    host.addEventListener('paste', onPaste, true);
    host.addEventListener('compositionstart', startComposition);
    host.addEventListener('compositionend', endComposition);
    return () => {
      host.removeEventListener('paste', onPaste, true);
      host.removeEventListener('compositionstart', startComposition);
      host.removeEventListener('compositionend', endComposition);
    };
  }, [active, inputHook]);

  // Register xterm link provider for HTTP/HTTPS URLs. The renderer is
  // intentionally limited to URL resolution — path resolution belongs to
  // the Application use case `resolveTerminalLinkTarget` and requires a
  // follow-up IPC channel that exposes Worktree inspection.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (surface === undefined || onOpenExternalLink === undefined) return undefined;
    const handle: IDisposableLinkProvider = registerTerminalLinkProvider({
      resolve: (text) => ({
        activate: (_event, url) => onOpenExternalLink(url),
        text,
      }),
      terminal: surface.getTerminal(),
    });
    return () => handle.dispose();
  }, [onOpenExternalLink]);

  // Register a sibling link provider for absolute filesystem paths that
  // live inside the persisted primary Task Worktree. The renderer
  // receives no native path until the user Ctrl+clicks a token, and the
  // Application resolver (`resolveTerminalLinkTarget`) decides what is
  // eligible.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (surface === undefined) return undefined;
    if (onOpenWorktreeFile === undefined || taskId === undefined) return undefined;
    const handle: IDisposableWorktreeFileLinkProvider = registerWorktreeFileLinkProvider({
      resolve: (text) => {
        if (taskId === undefined) return undefined;
        return {
          absolutePath: text,
          activate: (_event, absolutePath) => {
            onOpenWorktreeFile({ absolutePath, taskId });
          },
          text,
        };
      },
      terminal: surface.getTerminal(),
    });
    return () => handle.dispose();
  }, [onOpenWorktreeFile, taskId]);

  // Track selection on the surface so context menu can decide.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (surface === undefined) return undefined;
    const interval = window.setInterval(() => {
      const next = (surface as TerminalSurface).getSelection();
      setSelection((prev) => (prev === next ? prev : next));
    }, 250);
    return () => window.clearInterval(interval);
  }, [controllerRef.current]);

  // Pane-local Ctrl+Shift+F interceptor. We bind on the terminal host
  // element (rather than `document`) so that two terminal panes don't fight
  // over the same chord. xterm's own attachCustomKeyEventHandler only sees
  // copy / paste / send-bytes chords; this listener runs in the bubble phase
  // and prevents the browser from forwarding the chord to xterm.
  useEffect(() => {
    if (!active) return undefined;
    const surface = surfaceRef.current;
    if (surface === undefined) return undefined;
    const host = surface.hostElement();
    if (host === undefined) return undefined;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (inputHook.pendingConfirmation !== undefined) return;
      if (!isSearchOpenShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const wasOpen = searchState.open;
      dispatchSearch({ kind: wasOpen ? 'CLOSE' : 'OPEN' });
    };
    host.addEventListener('keydown', handleKeyDown);
    return () => {
      host.removeEventListener('keydown', handleKeyDown);
    };
  }, [active, dispatchSearch, inputHook.pendingConfirmation, searchState.open]);

  // Re-focus xterm and clear decorations whenever the bar closes.
  useEffect(() => {
    if (searchState.open) return;
    controllerRef.current?.clearSearch();
    if (state === 'connected' && active) {
      controllerRef.current?.focus();
    }
  }, [active, searchState.open, state]);

  const contextMenu = useTerminalContextMenu({
    enabled: state === 'connected',
    onClose: () => undefined,
    resolveActions: (ctx) =>
      buildContextMenuActions(ctx.sessionId, (surfaceRef.current?.getSelection().length ?? 0) > 0),
    sessionId,
    target: containerRef.current,
  });

  const contextMenuDispatch = (action: {
    readonly kind: 'copy' | 'paste' | 'select-all' | 'agent-stop' | 'agent-signal';
  }) => {
    const surface = surfaceRef.current as TerminalSurface | undefined;
    if (surface === undefined) return;
    contextMenu.dismiss();
    if (action.kind === 'copy') {
      const text = surface.getSelection();
      if (text.length > 0)
        void navigator.clipboard
          .writeText(text)
          .catch(() => inputHook.showFeedback({ level: 'error', message: 'Copy failed.' }));
    } else if (action.kind === 'paste') {
      void navigator.clipboard
        .readText()
        .then((text) => inputHook.pasteText(text))
        .catch(() => inputHook.showFeedback({ level: 'error', message: 'Paste failed.' }));
    } else if (action.kind === 'select-all') {
      surface.selectAll();
    } else if (action.kind === 'agent-stop') {
      if (sessionId !== undefined) onStopAgent?.(sessionId);
    } else if (action.kind === 'agent-signal') {
      const etx = '\x03'; // Ctrl+C = ETX
      controllerRef.current?.sendBytes(etx);
    }
  };

  const ctxMenuActions = contextMenu.actions;

  return (
    <section
      className="terminal-panel"
      aria-label={label}
      data-active-terminal-pane={active ? 'true' : 'false'}
      data-terminal-pane-id={paneId}
      onFocus={(event) => {
        onActivate?.();
        if (event.currentTarget === event.target) {
          controllerRef.current?.focus();
        }
      }}
      tabIndex={-1}
    >
      <header className="terminal-panel__header">
        <span className={`terminal-status terminal-status--${state}`} aria-hidden="true" />
        <span aria-live="polite">{statusLabel(state, inputHook.feedback)}</span>
        {isMouseModeActive(mouseMode) ? (
          <span
            className="terminal-panel__mouse-badge"
            aria-label={mouseModeBadgeLabel(mouseMode)}
            data-terminal-mouse-mode={mouseMode.protocol}
            data-terminal-mouse-sgr={mouseMode.sgr ? 'true' : 'false'}
            title={mouseModeBadgeTitle(mouseMode)}
          >
            mouse
          </span>
        ) : null}
        <span className="terminal-panel__identity">{sessionId ?? 'No Session'}</span>
        {active ? <kbd>Alt+3</kbd> : null}
        <button
          aria-label={closeLabel}
          className="terminal-panel__close"
          disabled={!canClose}
          onClick={(event) => {
            event.stopPropagation();
            onClose?.();
          }}
          title={
            canClose
              ? 'Detach this terminal pane without stopping the Agent Session.'
              : 'A workspace tab keeps at least one terminal pane.'
          }
          type="button"
        >
          <WorkspaceIcon name="close" size={14} />
        </button>
      </header>
      <div className="terminal-panel__viewport" ref={containerRef}>
        {state === 'empty' ? (
          <div className="terminal-panel__empty" data-terminal-empty role="status">
            <div className="terminal-panel__empty-card">
              <span className="terminal-panel__empty-icon" aria-hidden="true">
                <WorkspaceIcon name="terminal" size={24} />
              </span>
              <strong>No Agent Session attached</strong>
              <p>Start a task or accept a plan to open its terminal in this pane.</p>
              <div className="terminal-panel__empty-skeleton" aria-hidden="true">
                <span className="skeleton" style={{ width: '60%', height: '0.7rem' }} />
                <span className="skeleton" style={{ width: '80%', height: '0.7rem' }} />
                <span className="skeleton" style={{ width: '40%', height: '0.7rem' }} />
              </div>
            </div>
          </div>
        ) : null}
        {searchState.open ? (
          <TerminalSearchBar
            caseSensitive={searchView.caseSensitive}
            mode={searchView.mode}
            ref={searchBarRef}
            result={searchView.result}
            term={searchView.term}
            onCaseChange={(next) => dispatchSearch({ kind: 'SET_CASE', caseSensitive: next })}
            onClose={() => dispatchSearch({ kind: 'CLOSE' })}
            onModeChange={(next) => dispatchSearch({ kind: 'SET_MODE', mode: next })}
            onNext={() => runSearch('next')}
            onPrevious={() => runSearch('previous')}
            onTermChange={(next) => dispatchSearch({ kind: 'SET_TERM', term: next })}
          />
        ) : null}
      </div>
      {inputHook.pendingConfirmation !== undefined ? (
        <div
          className="terminal-paste-confirmation"
          data-terminal-paste-confirm
          role="alertdialog"
          aria-modal="false"
        >
          <strong>Confirm paste</strong>
          <p>
            Paste {inputHook.pendingConfirmation.lineCount} lines (
            {inputHook.pendingConfirmation.byteLengthLabel}) into session{' '}
            {inputHook.pendingConfirmation.sessionId}?
          </p>
          <div className="terminal-paste-confirmation__actions">
            <button
              type="button"
              className="secondary-action"
              onClick={() => inputHook.rejectPaste()}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary-action"
              onClick={() => inputHook.confirmPaste(inputHook.pendingConfirmation!)}
            >
              Send
            </button>
          </div>
        </div>
      ) : null}
      {inputHook.feedback !== undefined ? (
        <div
          className={`terminal-input-feedback terminal-input-feedback--${inputHook.feedback.level}`}
          data-terminal-input-feedback
          role="status"
        >
          {inputHook.feedback.message}
        </div>
      ) : null}
      <TerminalContextMenu
        actions={ctxMenuActions}
        onSelect={contextMenuDispatch}
        position={contextMenu.position}
      />
    </section>
  );
}

function statusLabel(
  state: TerminalConnectionState,
  feedback: { readonly message: string } | undefined,
): string {
  if (feedback !== undefined) return `${feedback.message}`;
  switch (state) {
    case 'empty':
      return 'No Agent Session attached';
    case 'attaching':
      return 'Attaching terminal';
    case 'connected':
      return 'Agent Session connected';
    case 'exited':
      return 'Agent Session exited — terminal output is preserved';
    case 'failed':
      return 'Terminal connection failed';
  }
}

function mouseModeBadgeLabel(mode: MouseMode): string {
  const protocol = mouseModeProtocolName(mode.protocol);
  return mode.sgr
    ? `Mouse reporting on (${protocol}, SGR encoding)`
    : `Mouse reporting on (${protocol})`;
}

function mouseModeBadgeTitle(mode: MouseMode): string {
  const protocol = mouseModeProtocolName(mode.protocol);
  const encoding = mode.sgr ? 'SGR extended' : 'legacy single-byte';
  return `Active TUI requested mouse reporting (${protocol}, ${encoding}). Shift+right-click forwards button-2 to it.`;
}

function mouseModeProtocolName(protocol: MouseMode['protocol']): string {
  switch (protocol) {
    case 'X10':
      return 'X10 button events';
    case 'DRAG':
      return 'button + drag events';
    case 'ANY':
      return 'any motion events';
    case 'NONE':
      return 'no mouse reporting';
  }
}
