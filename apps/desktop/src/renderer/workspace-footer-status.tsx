import type { ReactNode } from 'react';

export interface WorkspaceFooterStatusProps {
  readonly agentName: string | undefined;
  readonly gitBranch: string | undefined;
  readonly oscillator?: boolean;
  readonly pullRequestNumber: number | undefined;
  readonly shortcutHints: readonly { readonly key: string; readonly label: string }[];
  readonly terminalState: 'attaching' | 'connected' | 'empty' | 'exited' | 'failed';
}

export function WorkspaceFooterStatus({
  agentName,
  gitBranch,
  oscillator = false,
  pullRequestNumber,
  shortcutHints,
  terminalState,
}: WorkspaceFooterStatusProps): ReactNode {
  return (
    <footer className="workspace-footer" data-workspace-footer>
      <div className="workspace-footer__group">
        <span className={`workspace-footer__dot workspace-footer__dot--${terminalState}`} aria-hidden="true" />
        <span className="workspace-footer__label workspace-footer__label--strong">{terminalLabel(terminalState)}</span>
      </div>
      <div className="workspace-footer__group">
        <span className="workspace-footer__label">Agent</span>
        <span className="workspace-footer__value">{agentName ?? 'No agent'}</span>
      </div>
      <div className="workspace-footer__group">
        <span className="workspace-footer__label">Branch</span>
        <span className="workspace-footer__value" data-footer-branch>
          {gitBranch ?? 'detached'}
        </span>
      </div>
      {pullRequestNumber === undefined ? null : (
        <div className="workspace-footer__group">
          <span className="workspace-footer__label">PR</span>
          <span className="workspace-footer__value">#{String(pullRequestNumber)}</span>
        </div>
      )}
      <div className="workspace-footer__group workspace-footer__group--hints">
        {shortcutHints.map((hint) => (
          <span className="workspace-footer__hint" key={hint.key}>
            <kbd>{hint.key}</kbd>
            <span>{hint.label}</span>
          </span>
        ))}
        {oscillator ? (
          <span className="workspace-footer__oscillator" aria-hidden="true">
            <span />
          </span>
        ) : null}
      </div>
    </footer>
  );
}

function terminalLabel(state: 'attaching' | 'connected' | 'empty' | 'exited' | 'failed'): string {
  switch (state) {
    case 'attaching':
      return 'Attaching terminal';
    case 'connected':
      return 'Terminal connected';
    case 'empty':
      return 'No Agent Session attached';
    case 'exited':
      return 'Terminal exited';
    case 'failed':
      return 'Terminal failed';
  }
}