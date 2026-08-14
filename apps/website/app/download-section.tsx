import Link from 'next/link';

export function DownloadSection() {
  return (
    <section className="section download" id="download">
      <div className="container download__inner">
        <div>
          <p className="eyebrow eyebrow--muted">Download</p>
          <h2 className="section-title">Get the foundation preview.</h2>
          <p className="section-lead">
            A portable Windows archive. Unzip, double-click{' '}
            <span className="mono">agentterm.exe</span>, and point it at any local repository.
          </p>
          <ul className="download__list">
            <li>
              <span className="mono">win-x64</span> · portable archive
            </li>
            <li>
              <span className="mono">SHA-256</span> checksums published per release
            </li>
            <li>
              <span className="mono">Node.js ≥ 22.13</span> detected at first run
            </li>
          </ul>
        </div>
        <aside className="download__card">
          <h3>v0.0.0 · foundation preview</h3>
          <p>
            The preview focuses on architecture, layering, and the desktop shell. Functional parity
            with the reference tracker lands in the next milestones.
          </p>
          <Link className="primary-action primary-action--lg" href="/releases/latest">
            Download AgentTerm.exe
          </Link>
          <Link className="secondary-action secondary-action--lg" href="/changelog">
            View changelog
          </Link>
        </aside>
      </div>
    </section>
  );
}
