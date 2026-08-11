# AgentTerm Current State

Updated: 2026-08-11

## Current State

- The pnpm TypeScript monorepo, Electron desktop shell, Next.js website shell, and shared validation tooling are in place.
- `@agentterm/domain` now exposes pure TypeScript `Project`, `Task`, and `TaskPhase` models.
- `@agentterm/application` now exposes use cases to create Projects, create Tasks, and transition the current Task lifecycle.
- `@agentterm/infrastructure` implements the existing Project and Task repository ports with SQLite.
- Project Management can inspect and open an existing local Git working tree, persist it atomically, deduplicate canonical path aliases, and list recent Projects.
- A read-only Git repository adapter now returns canonical root, explicit attached/detached/unborn HEAD state, an offline base-branch suggestion, and structured working-tree status.
- Task Worktree use cases now create, reuse, inspect, and safely clean up one deterministic primary Worktree per Task while preserving its branch and dirty or ignored files.
- Migration 3 stores Worktree identity, exact base revision, and `PROVISIONING` / `PRESENT` / `REMOVING` / `REMOVED` reconciliation checkpoints.
- Temporary integration tests use real Git repositories, linked Worktrees, and SQLite databases, including collision, dirty-protection, and partial-persistence recovery cases.

## Decisions

- Application use cases are async functions with explicit inputs, Domain outputs, and injected repository ports.
- Project and Task IDs cannot be silently replaced through create use cases; Task creation also requires an existing Project.
- Task transitions load and persist state through `TaskRepository`, while transition validity remains owned by Domain.
- No PTY, agent-runtime, event, or generic query port has been introduced. Git/filesystem access is
  limited to `ProjectDiscovery`, the read-only `GitRepositoryInspector`, and the narrow Task
  Worktree lifecycle boundary.
- SQLite uses the built-in `node:sqlite` module and explicit prepared SQL; no ORM or additional runtime dependency was added.
- Persisted rows are reconstructed through Domain factories and valid transitions rather than trusted casts.
- Domain `Project` remains filesystem/Git-agnostic; Application owns `ProjectDiscovery` and `ProjectCatalog` ports.
- Local identity is an opaque hash of the native-realpath canonical Git top-level key. Folder name is display-only, and remote URL is not identity.
- Recent ordering uses an atomic monotonic open order. Migration infers no local root for legacy v1
  Projects; they remain outside recent-local results pending an explicit future association policy.
- Repository inspection uses one snapshot port rather than command-shaped methods. HEAD is a
  discriminated union, while base-branch provenance distinguishes remote HEAD, local conventions,
  and the current branch.
- Base selection is offline and deterministic: a valid local `origin/HEAD`, local `main`, local
  `master`, then the attached committed current branch. No remote is queried or mutated.
- Lazy object fetching is disabled, so a partial repository with missing promised metadata fails
  inspection instead of contacting its promisor remote.
- Git 2.45 or newer is required so lazy object fetching and configured filesystem monitors can be
  explicitly disabled during status inspection.
- Worktree create/cleanup is coordinated as a checkpointed saga: SQLite is written before Git
  mutation and finalized after verification; retry reconciles intermediate state without deleting
  branches or code.
- Opposing create/cleanup operations use compare-and-set intermediate checkpoints; stale Git
  registrations whose directories are already absent are reconciled only after their recoverable
  admin index is verified clean; staged blobs remain protected with a reported recovery path.
- Mutating Worktree calls are single-flight per Task in the coordinator process, and SQLite
  `RETURNING` keeps each checkpoint result tied to the row changed by that statement.
- Task branch and path names use a full SHA-256 of canonical repository identity plus Task ID, making
  retry names deterministic and Windows-safe without counters.

## Blockers

No implementation blocker is known. Node.js 22.13 emits its documented experimental warning for
`node:sqlite`; Electron 43's Node.js 24 runtime does not emit that warning in the current smoke test.
Git status can still execute repository-configured clean/process filters. Stronger isolation for
untrusted repositories is deferred; current inspection must follow an explicit user trust decision.
Worktree checkout can likewise execute configured clean/smudge/process filters even though hooks are
disabled for AgentTerm's mutating commands. Active-process coordination remains deferred to the
future session/runtime lifecycle; cleanup requires exclusive ownership because another writer could
otherwise race the final dirty/ignored-file inspection.

## Next Step

Compose SQLite, Project Management, repository inspection, and Task Worktree lifecycle in the
Electron main process behind narrow validated IPC. The renderer must not receive raw filesystem,
Git, or database capability.
