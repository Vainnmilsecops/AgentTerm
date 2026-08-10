# ADR-003 — SQLite Persistence

- Status: Accepted
- Date: 2026-08-10

## Decision

Use the built-in Node.js `node:sqlite` module with explicit prepared SQL for the first
Infrastructure implementation of the Application-owned `ProjectRepository` and
`TaskRepository` ports. Keep versioned migrations in source-controlled TypeScript so they are
included in the existing package bundle.

The initial schema contains only `projects`, `tasks`, and the private migration ledger. Row
mapping reconstructs Domain values through Domain factories and transitions instead of casting
database rows into trusted entities.

## Rationale

The repository baseline (Node.js 22.13+) and Electron 43 runtime both provide `node:sqlite`.
Using it avoids an ORM and an additional native addon/build lifecycle while the schema and query
surface are small. Direct SQL also keeps migration behavior, constraints, and port mappings
explicit.

## Tradeoffs and Consequences

- The API is synchronous. Database calls must remain in Infrastructure and outside the renderer;
  move them to a worker or reconsider the driver if measured workloads could block the desktop
  main process.
- Node.js 22.13 reports `node:sqlite` as experimental, while the Node.js 24 runtime shipped with
  the current Electron version has a more mature API. The Node.js warning is accepted for local
  tooling and must be reassessed when the runtime baseline changes.
- SQL and mappings require deliberate maintenance, but no generic repository or ORM abstraction
  is introduced before it has demonstrated value.
- New persisted concepts require a new ordered migration; migration history is append-only.
