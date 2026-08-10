# AgentTerm

AgentTerm is a Windows-first desktop terminal workspace for coordinating coding agents. This repository also contains the separate public landing and documentation website.

The project is currently at foundation stage: the monorepo, architecture modules, desktop shell, website shell, tooling, tests, architecture decisions, Project/Task domain model, and initial Application use cases exist; infrastructure adapters and native terminal capabilities are intentionally deferred.

## Repository Layout

```text
apps/
├── desktop/          Electron + React/Vite desktop shell
└── website/          Next.js landing/documentation shell
packages/
├── domain/           Pure business rules
├── application/      Use cases, ports, orchestration
├── infrastructure/   External-system adapters
├── shared/           Proven shared primitives
└── config/           Shared tooling/config support
docs/
├── decisions/        Architecture decision records
├── ARCHITECTURE.md   Dependency direction and package ownership
└── SKILLS.md         Agent skill routing
```

## Prerequisites

- Windows for the supported desktop runtime
- Node.js 22.13 or newer
- pnpm 11.21.0 through Corepack

Do not install pnpm globally. With a Corepack-enabled Node installation, the pinned `packageManager` field selects the repository version.

## Getting Started

```powershell
pnpm install
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Run the desktop shell:

```powershell
pnpm --filter @agentterm/desktop start
```

Run the website in development:

```powershell
pnpm --filter @agentterm/website dev
```

## Architecture

Dependencies point inward: Presentation calls Application, Application depends on Domain, and Infrastructure implements ports owned by inner modules. The marketing website stays separate from desktop product workflows.

See [Architecture](docs/ARCHITECTURE.md), [ADR-001](docs/decisions/ADR-001-monorepo-structure.md), and [ADR-002](docs/decisions/ADR-002-desktop-application-framework.md).

## Security Baseline

The Electron renderer is sandboxed with context isolation enabled and Node integration disabled. It loads local content only. Future filesystem, process, Git, PTY, database, and agent capabilities must be exposed through narrow validated ports and IPC contracts.

Dependency lifecycle scripts are denied by default through pnpm 11. Only the explicitly reviewed build requirements for Electron, esbuild, and sharp are allowlisted in `pnpm-workspace.yaml`.

## Deliberately Not Implemented Yet

There are no session/runtime state models, infrastructure adapters, PTY or ConPTY integration, Git Worktree commands, coding-agent adapters, SQLite/Drizzle persistence, terminal renderer, product UI, installer, updater, authentication, billing, or backend business service in this foundation.

## Agent Workflows

Repository instructions live in [AGENTS.md](AGENTS.md). Project-local Agent Skills are documented in [docs/SKILLS.md](docs/SKILLS.md), with third-party provenance in [docs/THIRD_PARTY_SKILLS.md](docs/THIRD_PARTY_SKILLS.md).
