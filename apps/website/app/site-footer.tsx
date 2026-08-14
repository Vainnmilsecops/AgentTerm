import Link from 'next/link';

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container site-footer__inner">
        <div>
          <Link className="brand" href="/">
            <span aria-hidden="true" className="brand__mark">
              AT
            </span>
            <span className="brand__name">AgentTerm</span>
          </Link>
          <p className="site-footer__tag">A Windows-first studio terminal for coding agents.</p>
        </div>
        <nav aria-label="Footer">
          <ul className="site-footer__nav">
            <li>
              <Link href="#workflow">Workflow</Link>
            </li>
            <li>
              <Link href="#features">Features</Link>
            </li>
            <li>
              <Link href="#video">Demo</Link>
            </li>
            <li>
              <Link href="/docs">Docs</Link>
            </li>
            <li>
              <Link href="/changelog">Changelog</Link>
            </li>
          </ul>
        </nav>
        <small className="site-footer__legal">
          © AgentTerm contributors · Code under MIT · Agent binaries licensed by their respective
          owners.
        </small>
      </div>
    </footer>
  );
}
