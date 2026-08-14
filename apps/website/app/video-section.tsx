import { Reveal } from './reveal';

const SEQUENCE = [
  { time: '0:00', label: 'PLANNING', detail: 'Codex outlines the implementation.' },
  { time: '0:18', label: 'RUNNING', detail: 'Agent works in the Task worktree.' },
  { time: '0:42', label: 'CHECKS', detail: 'Lint, typecheck, and tests recorded as evidence.' },
  { time: '1:05', label: 'REVIEW', detail: 'Snapshot re-validated before approval.' },
  { time: '1:24', label: 'PULL REQUEST', detail: 'Approved code promoted to a tracked PR.' },
];

export function VideoSection() {
  return (
    <section className="section video" id="video">
      <div className="container">
        <Reveal>
          <p className="eyebrow eyebrow--muted">Demo</p>
          <h2 className="section-title">See AgentTerm run an end-to-end Task.</h2>
          <p className="section-lead">
            90 seconds. From &ldquo;Start planning&rdquo; to &ldquo;Open pull request&rdquo;, every
            transition visible and reproducible.
          </p>
          <figure className="video-frame" data-video-frame>
            <div aria-hidden="true" className="video-frame__placeholder">
              <span className="video-frame__play">▶</span>
              <p>
                Demo video placeholder — drops in here once the recording renders. Until then, watch
                the animated terminal below.
              </p>
            </div>
            <ol className="sequence" aria-label="Workflow timeline">
              {SEQUENCE.map((step) => (
                <li key={step.label}>
                  <span>{step.time}</span>
                  <strong>{step.label}</strong> — {step.detail}
                </li>
              ))}
            </ol>
            <figcaption>
              Captions: planning → execution → checks → review → pull request. Auto-paused when
              focus leaves the window.
            </figcaption>
          </figure>
        </Reveal>
      </div>
    </section>
  );
}
