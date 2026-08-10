# AgentTerm Current State

Updated: 2026-08-11

## Current State

- The pnpm TypeScript monorepo, Electron desktop shell, Next.js website shell, and shared validation tooling are in place.
- `@agentterm/domain` now exposes pure TypeScript `Project`, `Task`, and `TaskPhase` models.
- `@agentterm/application` now exposes use cases to create Projects, create Tasks, and transition the current Task lifecycle.
- `@agentterm/infrastructure` implements the existing Project and Task repository ports with SQLite.
- Project Management can inspect and open an existing local Git working tree, persist it atomically, deduplicate canonical path aliases, and list recent Projects.
- Migration 2 adds only one-to-one `project_roots` metadata; temporary integration tests use real Git repositories and SQLite databases.

## Decisions

- Application use cases are async functions with explicit inputs, Domain outputs, and injected repository ports.
- Project and Task IDs cannot be silently replaced through create use cases; Task creation also requires an existing Project.
- Task transitions load and persist state through `TaskRepository`, while transition validity remains owned by Domain.
- No PTY, agent-runtime, event, or generic query port has been introduced; the only Git/filesystem
  boundary is the read-only `ProjectDiscovery` port required by Project Management.
- SQLite uses the built-in `node:sqlite` module and explicit prepared SQL; no ORM or additional runtime dependency was added.
- Persisted rows are reconstructed through Domain factories and valid transitions rather than trusted casts.
- Domain `Project` remains filesystem/Git-agnostic; Application owns `ProjectDiscovery` and `ProjectCatalog` ports.
- Local identity is an opaque hash of the native-realpath canonical Git top-level key. Folder name is display-only, and remote URL is not identity.
- Recent ordering uses an atomic monotonic open order. Migration infers no local root for legacy v1
  Projects; they remain outside recent-local results pending an explicit future association policy.

## Blockers

None known. Node.js 22.13 emits its documented experimental warning for `node:sqlite`; Electron 43's Node.js 24 runtime does not emit that warning in the current smoke test.

## Next Step

Compose SQLite and Project Management in the Electron main process behind narrow validated IPC. The renderer must not receive raw filesystem, Git, or database capability.
