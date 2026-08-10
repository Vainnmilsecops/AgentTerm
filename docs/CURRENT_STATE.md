# AgentTerm Current State

Updated: 2026-08-11

## Current State

- The pnpm TypeScript monorepo, Electron desktop shell, Next.js website shell, and shared validation tooling are in place.
- `@agentterm/domain` now exposes pure TypeScript `Project`, `Task`, and `TaskPhase` models.
- `@agentterm/application` now exposes use cases to create Projects, create Tasks, and transition the current Task lifecycle.
- `@agentterm/infrastructure` implements the existing Project and Task repository ports with SQLite.
- Migration 1 creates only `projects`, `tasks`, and a migration ledger; temporary-database integration tests cover migrations, constraints, repository contracts, reopen behavior, and every `TaskPhase`.

## Decisions

- Application use cases are async functions with explicit inputs, Domain outputs, and injected repository ports.
- Project and Task IDs cannot be silently replaced through create use cases; Task creation also requires an existing Project.
- Task transitions load and persist state through `TaskRepository`, while transition validity remains owned by Domain.
- No runtime, Git, filesystem, PTY, agent, event, or query port has been introduced.
- SQLite uses the built-in `node:sqlite` module and explicit prepared SQL; no ORM or additional runtime dependency was added.
- Persisted rows are reconstructed through Domain factories and valid transitions rather than trusted casts.

## Blockers

None known. Node.js 22.13 emits its documented experimental warning for `node:sqlite`; Electron 43's Node.js 24 runtime does not emit that warning in the current smoke test.

## Next Step

Compose the SQLite adapter at the desktop boundary with an approved application-data path and lifecycle; do not add future tables until their Domain/Application behavior exists.
