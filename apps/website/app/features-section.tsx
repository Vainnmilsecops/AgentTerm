const FEATURES = [
  {
    title: 'Provider-neutral',
    body: 'Codex, Claude Code, Gemini, OpenCode, or your own. Pick the executable per session, not per project.',
    icon: '⌬',
  },
  {
    title: 'Immutable history',
    body: 'Every plan, review, and quality gate is written to disk. Replay any decision at any time.',
    icon: '◇',
  },
  {
    title: 'Keyboard-first',
    body: 'Command palette, focus modes, terminal splits, and pane cycling all reachable from the home row.',
    icon: '⌘',
  },
  {
    title: 'Worktree per task',
    body: 'Each Task owns a Git worktree. No shared dirty state, no accidental cross-contamination.',
    icon: '⎇',
  },
  {
    title: 'Pull request handoff',
    body: 'Validate, push, and open a PR without leaving AgentTerm. The decision stays attached to the code.',
    icon: '↗',
  },
  {
    title: 'Local by default',
    body: 'No accounts, no telemetry, no surprise processes. The CLI owns authentication.',
    icon: '◉',
  },
];

import { Reveal } from './reveal';

export function FeaturesSection() {
  return (
    <section className="section features" id="features">
      <div className="container">
        <Reveal>
          <p className="eyebrow eyebrow--muted">Features</p>
          <h2 className="section-title">A studio terminal that respects your workflow.</h2>
          <ul className="features__grid">
            {FEATURES.map((feature) => (
              <li key={feature.title} className="features__card">
                <span aria-hidden="true" className="features__icon">
                  {feature.icon}
                </span>
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}
