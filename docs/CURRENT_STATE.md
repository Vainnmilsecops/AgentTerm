# AgentTerm Current State

Updated: 2026-08-10

## Current State

- The pnpm TypeScript monorepo, Electron desktop shell, Next.js website shell, and shared validation tooling are in place.
- `@agentterm/domain` now exposes pure TypeScript `Project`, `Task`, and `TaskPhase` models.
- New tasks start in `BACKLOG`; the domain transition function enforces the primary lifecycle through `DONE`.

## Decisions

- Domain entities are immutable records created through small factory functions; a successful Task transition returns a new record.
- Only adjacent forward transitions are currently valid: `BACKLOG -> PLANNING -> RUNNING -> REVIEW -> DONE`.
- `TaskPhase` models business progress only. Runtime health, process exit, and future `AgentSessionStatus` cannot transition a Task automatically.
- No ADR was added because these rules refine the domain inside the dependency direction already recorded by ADR-001.

## Blockers

None known.

## Next Step

Define the first Application use cases and ports that coordinate Project and Task behavior without introducing persistence or runtime adapters prematurely.
