import { useEffect, useRef, useState } from 'react';

import type { PtyRuntimeEvent } from '@agentterm/application';

import {
  TerminalController,
  type TerminalConnectionState,
  type TerminalSessionClient,
} from './terminal-controller';
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
}: TerminalRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const connectionStateChangeRef = useRef(onConnectionStateChange);
  const controllerRef = useRef<TerminalController | undefined>(undefined);
  const runtimeEventRef = useRef(onRuntimeEvent);
  const [state, setState] = useState<TerminalConnectionState>('empty');

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

    const controller = new TerminalController(new XtermTerminalSurface(), setState, (event) =>
      runtimeEventRef.current?.(event),
    );
    controllerRef.current = controller;
    controller.mount(container);
    return () => {
      if (controllerRef.current === controller) {
        controllerRef.current = undefined;
      }
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
        <span aria-live="polite">{statusLabel(state)}</span>
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
    </section>
  );
}

function statusLabel(state: TerminalConnectionState): string {
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
