import { useEffect, useRef, useState } from 'react';

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
import { useTerminalInput } from './use-terminal-input';
import { WorkspaceIcon } from './workspace-icons';
import { XtermTerminalSurface } from './xterm-terminal-surface';

export interface TerminalRendererProps {
  readonly active?: boolean;
  readonly canClose?: boolean;
  readonly client?: TerminalSessionClient;
  readonly closeLabel?: string;
  readonly fontSize?: number;
  readonly label?: string;
  readonly onActivate?: () => void;
  readonly onClose?: () => void;
  readonly onConnectionStateChange?: (state: TerminalConnectionState) => void;
  readonly onRuntimeEvent?: (event: PtyRuntimeEvent) => void;
  readonly paneId?: string;
  readonly sessionId?: string;
  readonly taskId?: string;
}

export function TerminalRenderer({
  active = true,
  canClose = false,
  client,
  closeLabel = 'Close terminal pane',
  fontSize = 14,
  label = 'Agent Session terminal',
  onActivate,
  onClose,
  onConnectionStateChange,
  onRuntimeEvent,
  paneId = 'primary',
  sessionId,
  taskId,
}: TerminalRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<XtermTerminalSurface | undefined>(undefined);
  const connectionStateChangeRef = useRef(onConnectionStateChange);
  const controllerRef = useRef<TerminalController | undefined>(undefined);
  const runtimeEventRef = useRef(onRuntimeEvent);
  const failureSinkRef = useRef<((failure: TerminalConnectionFailure) => void) | undefined>(undefined);
  const [state, setState] = useState<TerminalConnectionState>('empty');
  const [, setSelection] = useState('');

  const inputHook = useTerminalInput({
    controller: controllerRef.current,
    sessionId,
    taskId,
  });

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

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }

    const surface = new XtermTerminalSurface();
    surfaceRef.current = surface;
    const controller = new TerminalController(
      surface,
      setState,
      (event) => runtimeEventRef.current?.(event),
      (failure) => failureSinkRef.current?.(failure),
    );
    controllerRef.current = controller;
    controller.mount(container);
    return () => {
      if (controllerRef.current === controller) {
        controllerRef.current = undefined;
      }
      surfaceRef.current = undefined;
      controller.dispose();
    };
  }, [client]);

  useEffect(() => {
    void controllerRef.current?.setSession(sessionId, client);
  }, [client, sessionId]);

  useEffect(() => {
    controllerRef.current?.setFontSize(fontSize);
  }, [fontSize]);

  useEffect(() => {
    if (!active) {
      return;
    }
    controllerRef.current?.refreshLayout();
  }, [active]);

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

  const contextMenu = useTerminalContextMenu({
    enabled: state === 'connected',
    onClose: () => undefined,
    resolveActions: buildContextMenuActions,
    target: containerRef.current,
  });

  const contextMenuDispatch = (action: { readonly kind: 'copy' | 'paste' | 'select-all' }) => {
    const surface = surfaceRef.current as TerminalSurface | undefined;
    if (surface === undefined) return;
    if (action.kind === 'copy') {
      const text = surface.getSelection();
      if (text.length > 0) void navigator.clipboard.writeText(text);
    } else if (action.kind === 'paste') {
      void navigator.clipboard.readText().then((text) => inputHook.pasteText(text));
    } else {
      surface.selectAll();
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
            Paste {inputHook.pendingConfirmation.lineCount} lines ({inputHook.pendingConfirmation.byteLengthLabel}) into session {inputHook.pendingConfirmation.sessionId}?
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

function statusLabel(state: TerminalConnectionState, feedback: { readonly message: string } | undefined): string {
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
