import { useEffect, useRef, useState } from 'react';

import type { PtyRuntimeEvent } from '@agentterm/application';

import {
  TerminalController,
  type TerminalConnectionState,
  type TerminalSessionClient,
} from './terminal-controller';
import { XtermTerminalSurface } from './xterm-terminal-surface';

export interface TerminalRendererProps {
  readonly client?: TerminalSessionClient;
  readonly onRuntimeEvent?: (event: PtyRuntimeEvent) => void;
  readonly sessionId?: string;
}

export function TerminalRenderer({ client, onRuntimeEvent, sessionId }: TerminalRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<TerminalController | undefined>(undefined);
  const runtimeEventRef = useRef(onRuntimeEvent);
  const [state, setState] = useState<TerminalConnectionState>('empty');

  useEffect(() => {
    runtimeEventRef.current = onRuntimeEvent;
  }, [onRuntimeEvent]);

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
    void controller.setSession(sessionId, client);
    return () => {
      if (controllerRef.current === controller) {
        controllerRef.current = undefined;
      }
      controller.dispose();
    };
  }, [client, sessionId]);

  return (
    <section
      className="terminal-panel"
      aria-label="Agent Session terminal"
      id="workspace-terminal"
      onFocus={(event) => {
        if (event.currentTarget === event.target) {
          controllerRef.current?.focus();
        }
      }}
      tabIndex={-1}
    >
      <header className="terminal-panel__header">
        <span className={`terminal-status terminal-status--${state}`} aria-hidden="true" />
        <span aria-live="polite">{statusLabel(state)}</span>
        <kbd>Alt+3</kbd>
      </header>
      <div className="terminal-panel__viewport" ref={containerRef} />
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
