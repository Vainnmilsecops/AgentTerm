import Link from 'next/link';

import { Reveal } from './reveal';
import { TerminalMockup } from './terminal-mockup';
import { TerminalTyper } from './terminal-typer';

const PROMPTS = [
  '$ agentterm run plan',
  '$ agentterm run execute',
  '$ agentterm checks run --all',
  '$ agentterm review request',
  '$ agentterm approve --snapshot',
];

export function Hero() {
  return (
    <section className="hero">
      <div className="container hero__grid">
        <div className="hero__copy">
          <Reveal>
            <p className="eyebrow">Windows-first · Studio Terminal</p>
            <h1 className="hero__title">
              Coordinate coding agents
              <span className="hero__title-em"> without leaving your terminal.</span>
            </h1>
            <p className="hero__lead">
              AgentTerm is a Windows desktop workspace for running Codex, Claude Code, and other
              coding agents through a single, keyboard-first surface. Five predictable phases. Every
              decision recorded. No SaaS required.
            </p>
            <div className="terminal-typer--hero">
              <TerminalTyper intervalMs={2200} lines={PROMPTS} />
            </div>
            <div className="hero__actions">
              <Link className="primary-action primary-action--lg" href="#download">
                Download AgentTerm for Windows
              </Link>
              <Link className="secondary-action secondary-action--lg" href="#video">
                Watch the 90-second demo
              </Link>
            </div>
            <ul className="hero__meta">
              <li>
                <span className="mono">v0.0.0</span> foundation preview
              </li>
              <li>
                <span className="mono">win-x64</span> portable archive
              </li>
              <li>
                <span className="mono">MIT-licensed agents</span>
              </li>
            </ul>
          </Reveal>
        </div>
        <Reveal className="hero__preview">
          <TerminalMockup />
        </Reveal>
      </div>
    </section>
  );
}
