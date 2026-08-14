import { Reveal } from './reveal';

const STEPS = [
  {
    badge: '01',
    title: 'Plan',
    body: 'Outline the implementation and capture the agent’s evidence before any code is written.',
  },
  {
    badge: '02',
    title: 'Execute',
    body: 'Run the agent inside a dedicated worktree. Resumable, observable, and deterministic on the disk.',
  },
  {
    badge: '03',
    title: 'Validate',
    body: 'Run lint, typecheck, test, and build. Every gate is recorded with provenance and exit codes.',
  },
  {
    badge: '04',
    title: 'Review',
    body: 'Re-validate the exact code snapshot. Approve, request changes, or escalate — never silent.',
  },
  {
    badge: '05',
    title: 'Ship',
    body: 'Promote approved work to a pull request with a traceable decision trail.',
  },
];

export function WorkflowSection() {
  return (
    <section className="section workflow" id="workflow">
      <div className="container">
        <Reveal>
          <p className="eyebrow eyebrow--muted">Workflow</p>
          <h2 className="section-title">Five predictable phases. Every decision recorded.</h2>
          <p className="section-lead">
            AgentTerm models coding work as an explicit state machine. Each transition writes a
            durable artifact and is auditable from a single history view.
          </p>
          <ol className="workflow__steps">
            {STEPS.map((step) => (
              <li key={step.badge} className="workflow__step">
                <span aria-hidden="true" className="workflow__badge">
                  {step.badge}
                </span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </Reveal>
      </div>
    </section>
  );
}
