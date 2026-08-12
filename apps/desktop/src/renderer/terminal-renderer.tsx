import { useEffect, useRef, useState } from 'react';

import {
  TerminalController,
  type TerminalConnectionState,
  type TerminalSessionClient,
} from './terminal-controller';
import { XtermTerminalSurface } from './xterm-terminal-surface';

export interface TerminalRendererProps {
  readonly client?: TerminalSessionClient;
  readonly sessionId?: string;
}

export function TerminalRenderer({ client, sessionId }: TerminalRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<TerminalConnectionState>('empty');

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }

    const controller = new TerminalController(new XtermTerminalSurface(), setState);
    controller.mount(container);
    void controller.setSession(sessionId, client);
    return () => controller.dispose();
  }, [client, sessionId]);

  return (
    <section className="terminal-panel" aria-label="Agent Session terminal">
      <header className="terminal-panel__header">
        <span className={`terminal-status terminal-status--${state}`} aria-hidden="true" />
        <span aria-live="polite">{statusLabel(state)}</span>
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
