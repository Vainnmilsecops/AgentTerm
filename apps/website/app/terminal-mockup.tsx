const PHASES = [
  {
    label: '01 · Plan',
    title: 'PLANNING',
    body: 'Codex drafts the implementation outline.',
    prompt: '$ agentterm run plan',
  },
  {
    label: '02 · Execute',
    title: 'RUNNING',
    body: 'Agent works inside the task worktree.',
    prompt: '$ agentterm run execute',
  },
  {
    label: '03 · Validate',
    title: 'CHECKS',
    body: 'Lint, typecheck, test recorded as evidence.',
    prompt: '$ agentterm checks run --all',
  },
  {
    label: '04 · Review',
    title: 'REVIEW',
    body: 'Re-validate the code snapshot before approving.',
    prompt: '$ agentterm review request',
  },
  {
    label: '05 · Ship',
    title: 'DONE',
    body: 'Approved and merged with a recorded decision.',
    prompt: '$ agentterm approve --snapshot',
  },
];

export function TerminalMockup() {
  return (
    <div aria-hidden="true" className="terminal-mockup">
      <header className="terminal-mockup__chrome">
        <span className="terminal-mockup__dot" data-color="red" />
        <span className="terminal-mockup__dot" data-color="amber" />
        <span className="terminal-mockup__dot" data-color="green" />
        <span className="terminal-mockup__title">agentterm — task-42 (PLANNING)</span>
      </header>
      <div className="terminal-mockup__viewport">
        <ol className="terminal-mockup__phases">
          {PHASES.map((phase) => (
            <li key={phase.title} className="terminal-mockup__phase">
              <span className="terminal-mockup__phase-label">{phase.label}</span>
              <strong className="terminal-mockup__phase-title">{phase.title}</strong>
              <p className="terminal-mockup__phase-body">{phase.body}</p>
              <code className="terminal-mockup__phase-prompt">{phase.prompt}</code>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
