# AgentTerm Current State

Updated: 2026-08-12

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
- Application now owns a PTY runtime port with structured launch input, sequenced runtime events, and an owned input/resize/terminate handle.
- Infrastructure implements that port with Windows ConPTY through pinned `node-pty` 1.1.0 in one dedicated host process per terminal; real Windows and Electron 43 smoke tests cover input, output, resize, exit, cleanup, native loading, attached-child termination, and host/handle release.
- Application now owns a minimal provider-neutral `AgentAdapter` contract and launch use case; Infrastructure provides the first `CodexAdapter` for CLI discovery, version/capability inspection, and structured interactive launch through the PTY runtime.
- Domain now models immutable `AgentSession` attempts with independent runtime status and append-only event history; Application coordinates start, explicit active status, stop, exit, and failure without changing `TaskPhase`.
- Migration 4 stores every Task session plus ordered status/runtime evidence. SQLite appends history and its current-session snapshot atomically with revision checks, so new attempts never overwrite earlier sessions.

## Decisions

- Application use cases are async functions with explicit inputs, Domain outputs, and injected repository ports.
- Project and Task IDs cannot be silently replaced through create use cases; Task creation also requires an existing Project.
- Task transitions load and persist state through `TaskRepository`, while transition validity remains owned by Domain.
- The PTY port is runtime-only: Infrastructure owns `node-pty` and ConPTY mechanics, while process
  exit remains evidence and never changes `TaskPhase`. Agent-specific commands, session policy,
  validated IPC, and terminal UI remain outside this slice.
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
- PTY launch uses an absolute executable, argv, canonical working directory, exact caller-supplied
  environment, and bounded terminal dimensions. Runtime failures are sanitized and cleanup is
  idempotent; output is drained before exit, and Application receives `exited` only after the owned
  host process has closed.
- `node-pty` is isolated from the long-lived Electron process because its released Windows native
  addon can retain ConPTY handles after a terminal exits. Per-terminal host teardown makes Windows
  process cleanup the final resource-ownership boundary without exposing host identity through the
  Application port.
- Windows ConPTY requires build 18309 or newer and uses the system implementation, not the bundled
  experimental ConPTY DLL. The pinned dependency patch removes PID-based termination, releases its
  output worker after natural exit, converts output-worker startup/runtime failure into bounded
  cleanup evidence, and permits input, resize, and termination before first output.
- Codex discovery accepts a configured native executable or a recognized `@openai/codex` npm layout from
  absolute `PATH` entries. Npm command shims are never executed through a shell; the adapter validates
  the package entrypoint and invokes it through `node.exe`, rejecting Node injection variables.
  Provider flags stay in `CodexAdapter`; Task Worktree cwd is both the PTY cwd and the structured
  `--cd` argument. The adapter forwards only the caller-approved complete environment, never
  installs, logs in, reads credentials, or infers Task completion from runtime exit.
- Agent Session status is independent from Task workflow: `STARTING`, `WORKING`, `IDLE`,
  `WAITING_INPUT`, `EXITED`, and `FAILED` are Domain states for one runtime attempt. The
  Application coordinator persists `STARTING` before launch, serializes PTY evidence, retains
  owned handles for stop, and records exit/failure as session evidence only. Multiple sessions per
  Task are preserved; output is not persisted or interpreted as idle/input/completion state.

## Blockers

No implementation blocker is known. Node.js 22.13 emits its documented experimental warning for
`node:sqlite`; Electron 43's Node.js 24 runtime does not emit that warning in the current smoke test.
Git status can still execute repository-configured clean/process filters. Stronger isolation for
untrusted repositories is deferred; current inspection must follow an explicit user trust decision.
Worktree checkout can likewise execute configured clean/smudge/process filters even though hooks are
disabled for AgentTerm's mutating commands. The in-process Agent Session coordinator now owns PTY
handles, but cross-process recovery and exclusive Worktree-cleanup coordination remain deferred;
another writer could otherwise race the final dirty/ignored-file inspection.
The unpacked packaged-desktop layout has not been introduced, so native loading has been verified in
Electron 43 development runtime but not yet from an installed artifact. The Infrastructure build
copies its PTY host asset beside the bundle; future packaging must retain that asset and the complete
`node-pty` module outside ASAR. PTY children run with the desktop process's privileges; executable
and environment policy belongs to the future session/agent coordinator.

## Next Step

Compose SQLite, Project Management, repository inspection, Task Worktree lifecycle, the Agent
Session coordinator, Codex launch, and the PTY runtime in the Electron main process behind narrow
validated IPC. The renderer must not receive raw filesystem, Git, database, process, or environment
capability. Full restart/recovery and resume policy remain a later lifecycle slice.
