# ADR-006 — Task Git Worktree Lifecycle

- Status: Accepted
- Date: 2026-08-11

## Decision

Keep Git Worktree metadata and orchestration in Application, outside the Git-agnostic Domain
`Task`. A task-keyed SQLite row is the durable primary-Worktree identity and records deterministic
repository, path, branch, and exact base-revision metadata. Its lifecycle checkpoints are
`PROVISIONING`, `PRESENT`, `REMOVING`, and `REMOVED`.

Application persists `PROVISIONING` before Git creation and `REMOVING` before Git cleanup, then
records the verified terminal checkpoint after the external side effect. A failure after Git has
succeeded leaves the intermediate checkpoint and the Git state intact; retry inspects both and
reconciles instead of trying to roll Git back with a database transaction. Compare-and-set
transitions also prevent ensure and cleanup from taking the same Task in opposite directions; a
caller encountering the opposite intermediate checkpoint must retry after that operation resolves.
Application additionally runs mutating lifecycle calls as a per-Task single flight inside the
coordinator process, so a retry cannot continue from a stale intermediate snapshot while another
call reverses it. SQLite mutations return the exact row changed by their compare-and-set statement.

Infrastructure derives a Windows-safe task branch and managed Worktree path from a full SHA-256 of
the canonical repository identity and Task ID. It reuses only an exact registered path/branch match,
adopts an unregistered deterministic branch without resetting it, and fails closed on occupied paths,
branches checked out elsewhere, locked registrations, or metadata mismatches.

An exact registration whose managed directory is already absent is surfaced separately from a live
Worktree. Its exact linked-Worktree administration directory and index are inspected against HEAD;
staged paths make the state dirty and expose that administration directory as a recovery location.
Only a verified clean stale record may be removed without force before cleanup or recreation from
the preserved deterministic branch.

Cleanup first inspects tracked, untracked, conflicted, and ignored files. It invokes ordinary
`git worktree remove` only for the exact clean managed target, never uses force, and never deletes the
Task branch. Mutating Git commands disable hooks for that invocation; checkout filters remain part of
the explicit repository-trust boundary.

## Consequences

- The `task_id` primary key enforces at most one durable primary Worktree identity per Task and keeps
  a `REMOVED` tombstone for later reuse and reconciliation.
- Retry/restart reuses a valid Worktree or the preserved deterministic branch; it does not allocate
  counter- or time-based replacements.
- One Electron main coordinator serializes create/reuse and cleanup for a Task. Durable checkpoints
  handle process restart; independently mutating the same database from multiple AgentTerm processes
  is outside this contract.
- Git and SQLite are a small saga rather than one transaction. Intermediate checkpoints describe
  reconciliation work, not a claim that the filesystem currently matches the database.
- Active-process coordination is not part of this lifecycle yet. A future session/runtime use case
  must hold exclusive ownership and stop or detach its process before requesting cleanup. Status and
  ignored-file inspection cannot by themselves prevent an unrelated process from writing between
  the final inspection and Git removal.
- Worktree checkout can still execute repository-configured clean/smudge/process filters. Opening and
  mutating a repository therefore requires the same explicit trust decision as repository status.
