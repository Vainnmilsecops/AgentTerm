# AgentTerm

AgentTerm is a Windows-first desktop terminal workspace for coordinating coding agents. This repository also contains the separate public landing and documentation website.

The project is currently at foundation stage: the monorepo, architecture modules, desktop shell, website shell, tooling, tests, Project/Task model and use cases, SQLite persistence, local Git Project Management, and read-only repository inspection exist. Native terminal and agent capabilities are intentionally deferred.

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
- Git 2.45 or newer for repository status inspection

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

See [Architecture](docs/ARCHITECTURE.md), [ADR-001](docs/decisions/ADR-001-monorepo-structure.md), [ADR-002](docs/decisions/ADR-002-desktop-application-framework.md), [ADR-003](docs/decisions/ADR-003-sqlite-persistence.md), [ADR-004](docs/decisions/ADR-004-local-project-identity.md), and [ADR-005](docs/decisions/ADR-005-git-repository-inspection.md).

## Project Management

Application use cases can open an existing local Git working tree and list recent Projects. The
Infrastructure adapter canonicalizes native paths, validates directory access, invokes a resolved
absolute Git executable without a shell, and records one canonical local identity. It never
initializes a non-Git folder. Desktop file-picker and IPC composition remain separate follow-up
work.

## Git Repository Inspection

`@agentterm/application` owns a read-only `GitRepositoryInspector` port. The Infrastructure adapter
returns one canonical snapshot containing HEAD state, a deterministic offline base-branch
suggestion, and structured staged, unstaged, untracked, and conflicted paths. It does not expose raw
Git output, contact remotes, or issue mutating Git operations.

Repository inspection resolves Git to an absolute executable, invokes it without a shell, restricts
the child environment, disables automatic lazy fetches and configured filesystem monitors, and never
contacts a promisor remote to fill missing objects. Git status evaluation can still run
repository-configured content filters; only inspect repositories the user has chosen to trust until
process isolation is introduced.

## Persistence

`@agentterm/infrastructure` implements the Application-owned Project, recent-Project catalog, and
Task repositories with the built-in `node:sqlite` module. It applies explicit versioned migrations
and preserves Domain validation when mapping rows. The adapter is not yet composed into the
desktop shell, and there are intentionally no future Session, Worktree, or Artifact tables.

## Security Baseline

The Electron renderer is sandboxed with context isolation enabled and Node integration disabled. It loads local content only. Future filesystem, process, Git, PTY, database, and agent capabilities must be exposed through narrow validated ports and IPC contracts.

Dependency lifecycle scripts are denied by default through pnpm 11. Only the explicitly reviewed build requirements for Electron, esbuild, and sharp are allowlisted in `pnpm-workspace.yaml`.

## Deliberately Not Implemented Yet

There are no session/runtime state models, mutating Git or Worktree commands, PTY or ConPTY integration, coding-agent adapters, desktop Project/database/Git IPC composition, terminal renderer, product UI, installer, updater, authentication, billing, or backend business service in this foundation.

## Agent Workflows

Repository instructions live in [AGENTS.md](AGENTS.md). Project-local Agent Skills are documented in [docs/SKILLS.md](docs/SKILLS.md), with third-party provenance in [docs/THIRD_PARTY_SKILLS.md](docs/THIRD_PARTY_SKILLS.md).
