import Link from 'next/link';

import { ThemeToggle } from './theme-toggle';

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="container site-header__inner">
        <Link className="brand" href="/">
          <span aria-hidden="true" className="brand__mark">
            AT
          </span>
          <span className="brand__name">AgentTerm</span>
          <span className="brand__role">Studio Terminal</span>
        </Link>
        <nav aria-label="Primary">
          <ul className="site-nav">
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
              <Link href="#download">Download</Link>
            </li>
          </ul>
        </nav>
        <div className="site-header__actions">
          <ThemeToggle />
          <Link className="primary-action" href="#download">
            Download for Windows
          </Link>
        </div>
      </div>
    </header>
  );
}
