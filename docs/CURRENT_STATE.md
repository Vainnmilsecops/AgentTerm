# AgentTerm Current State

Updated: 2026-08-10

## Current State

- The pnpm TypeScript monorepo, Electron desktop shell, Next.js website shell, and shared validation tooling are in place.
- `@agentterm/domain` now exposes pure TypeScript `Project`, `Task`, and `TaskPhase` models.
- `@agentterm/application` now exposes use cases to create Projects, create Tasks, and transition the current Task lifecycle.
- Application persistence seams are limited to `ProjectRepository` and `TaskRepository`; test coverage uses in-memory fakes only.

## Decisions

- Application use cases are async functions with explicit inputs, Domain outputs, and injected repository ports.
- Project and Task IDs cannot be silently replaced through create use cases; Task creation also requires an existing Project.
- Task transitions load and persist state through `TaskRepository`, while transition validity remains owned by Domain.
- No runtime, Git, filesystem, PTY, agent, event, or query port has been introduced.

## Blockers

None known.

## Next Step

Implement a persistence adapter for the existing repository ports with migrations and integration tests, without changing Domain ownership.
