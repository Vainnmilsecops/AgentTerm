# AgentTerm Current State

Updated: 2026-08-14

## Current State

- The pnpm TypeScript monorepo, Electron desktop shell, Next.js website shell, and shared validation tooling are in place.
- `@agentterm/domain` now exposes pure TypeScript Project, Task, Agent Session, and Quality Gate models.
- `@agentterm/application` now exposes use cases to create Projects, create Tasks, and transition the current Task lifecycle.
- `@agentterm/infrastructure` implements the existing Project and Task repository ports with SQLite.
- Project Management can inspect and open an existing local Git working tree, persist it atomically, deduplicate canonical path aliases, and list recent Projects.
- A read-only Git repository adapter now returns canonical root, explicit attached/detached/unborn HEAD state, an offline base-branch suggestion, and structured working-tree status.
- Task Worktree use cases now create, reuse, inspect, and safely clean up one deterministic primary Worktree per Task while preserving its branch and dirty or ignored files.
- Migration 3 stores Worktree identity, exact base revision, and `PROVISIONING` / `PRESENT` / `REMOVING` / `REMOVED` reconciliation checkpoints.
- Temporary integration tests use real Git repositories, linked Worktrees, and SQLite databases, including collision, dirty-protection, and partial-persistence recovery cases.
- Application now owns a PTY runtime port with structured launch input, sequenced runtime events, and an owned input/resize/terminate handle.
- Infrastructure implements that port with Windows ConPTY through pinned `node-pty` 1.1.0 in one dedicated host process per terminal; real Windows and Electron 43 smoke tests cover input, output, resize, exit, cleanup, native loading, attached-child termination, and host/handle release.
- Application now owns a provider-neutral coding-agent catalog. Each small `AgentAdapter` contributes an immutable stable identity, inspection result, capability identifiers, and structured launch command; Infrastructure provides built-in Codex, Claude, and Gemini adapters under stable IDs `codex`, `claude`, and `gemini`.
- The built-in registry probes installed CLI versions with bounded no-shell commands, exposes `SESSION_RESUME` only when the CLI advertises it, and launches each provider interactively in the exact Task Worktree through the existing PTY port. Windows npm shims are never executed directly: official package metadata and entrypoints are verified first, with Node injection variables rejected for Node-backed CLIs.
- Domain now models immutable `AgentSession` attempts with independent runtime status and append-only event history; Application coordinates start, explicit active status, stop, exit, and failure without changing `TaskPhase`.
- Migration 4 stores every Task session plus ordered status/runtime evidence. SQLite appends history and its current-session snapshot atomically with revision checks, so new attempts never overwrite earlier sessions.
- Application startup reconciliation now finds persisted Agent Sessions whose history still implies possible runtime ownership, including a fatal runtime failure with no observed process exit, and appends a fatal `RUNTIME_OWNERSHIP_LOST` event before workspace reads. Restored sessions become `FAILED`, retain their full history, and never change the parent Task phase.
- Application now exposes `startTaskPlanning` for a `PLANNING` Task: it resolves the user-selected stable agent before Git mutation, creates or reuses the primary Task Worktree, records a fresh Agent Session, and keeps the Task in `PLANNING`. Re-plan attempts append new Sessions in the same Worktree.
- A session-produced structured Plan is stored as a new immutable `planning/plan.md` artifact. Only explicit user acceptance of the exact latest persisted Plan moves `PLANNING -> RUNNING`; SQLite atomically rechecks Task phase, Plan identity/provenance, the complete Session revision snapshot, and absence of a possible live writer. Agent output and process exit never accept a Plan.
- `startTaskExecution` now requires an already-`RUNNING` history-free Task. After planning or an earlier execution attempt, `retryTaskExecution` creates the next selected-agent Session in the existing primary Worktree without cleaning it or replacing history.
- Application now exposes an explicit `retryTaskExecution`: it reconstructs the prior attempt from persisted history, requires its latest Session to be `FAILED` or `EXITED`, resolves the user's selected stable agent ID, reuses the primary Worktree without cleaning dirty code, and creates a new Session while preserving every earlier attempt.
- Domain and Application now model required same-Project Task dependencies as a small directed acyclic graph with explicit add, remove, list, and readiness use cases. `BLOCKED` is derived when any direct dependency is not explicitly `DONE`; it is not a new Task phase and completion never launches a dependent Task automatically.
- Migration 8 stores unique dependency edges with same-Project foreign keys and a cycle-prevention trigger. Planning, initial execution, and retry check readiness before Git work and again before Session launch, while SQLite rejects a new Session atomically if a required Task is incomplete. Existing Worktrees and immutable Session history remain untouched when admission is blocked.
- The desktop now supports multiple renderer-owned workspace tabs and up to two xterm.js panes per tab. Each pane owns one stable terminal controller and exact Agent Session attachment; hidden tabs stay mounted to preserve independent live buffers, while close detaches listeners without terminating the process. The Application coordinator rejects a second interactive consumer for the same live Session.
- The first desktop workspace view groups recent Projects and their Tasks, keeps Task phase and active/latest Agent Session status visibly separate, embeds tabbed/split terminals, and exposes the safe agent catalog through an application-shaped client. One keyboard-native selector chooses the agent for the next planning or execution attempt; the workspace shows the latest Plan and explicit Start planning, Revise plan, and Accept Plan actions while historical unknown agent IDs remain visible through a raw-ID fallback.
- The workspace read model and desktop also expose dependency summaries and a text-labeled `BLOCKED` / `READY` state. Incomplete required Tasks disable planning and execution actions with an explicit reason; no provider-specific or Git logic is added to Presentation.
- Domain now defines versioned `plan`, `execution-summary`, and `review` artifact contracts with canonical names, required Markdown structure, producing phase, validation state, Task provenance, and optional Agent Session provenance.
- Application exposes create/read/list artifact use cases. Migration 5 stores immutable artifact history in SQLite with per-Task ordering and same-Task Session foreign-key enforcement; the workspace read model and desktop show that history separately from Task and Session state.
- Domain now models configured `LINT`, `TYPECHECK`, `TEST`, and `BUILD` Quality Gates plus immutable runs whose runtime status and evidence are independent from `TaskPhase`.
- Application can run a configured gate only after read-only verification of the persisted primary Task Worktree, records `RUNNING` before process launch, and persists pass, command failure, timeout, launch failure, or infrastructure failure without changing the Task.
- Migration 6 preserves every gate attempt by Task ordinal with structured command, the Worktree base and observed start-time HEAD revisions, plus bounded, redacted diagnostic output. A compatibility migration safely converges databases that previously recorded Quality Gates as migration 5. An unconfirmed process settlement or failed final checkpoint retains the durable `RUNNING` record and surfaces the observed evidence for later reconciliation rather than rerunning it.
- Infrastructure executes gate commands as an absolute executable plus argv with no shell, an exact environment, bounded UTF-8 output, and a Windows Job Object that waits for the complete descendant tree or kills it on timeout. Real-process and Git integration prove detached descendants cannot outlive terminal gate evidence, while dirty user files and Worktree registration remain intact.
- The workspace read model and desktop show newest-first AgentTerm-recorded gate evidence separately from Task and Agent Session state. React receives no command, environment, output reference, or local Worktree path.
- Domain now models immutable structured Task Review attempts with a captured code-state fingerprint, changed-path summary, associated Artifact and Quality Gate evidence, and one `PENDING` to `APPROVED` or `CHANGES_REQUESTED` decision.
- Application exposes explicit request-review, approve, and request-changes workflows. Review admission requires a `RUNNING` Task, no unsettled Agent Session or Quality Gate, bounded evidence history, and a verified `PRESENT` primary Worktree; approval recaptures the exact code state before the user can move `REVIEW` to `DONE`.
- Migration 7 preserves ordered Review history and normalized evidence snapshots. SQLite atomically couples `RUNNING -> REVIEW`, `REVIEW -> DONE`, or `REVIEW -> RUNNING` with the corresponding Review revision, validates the exact Session revisions and Artifact/gate histories captured before code inspection, and prevents new Sessions or gates after Review admission. A pre-v7 `REVIEW` Task with no structured attempt remains unchanged and can explicitly capture its first structured Review in place.
- Infrastructure captures committed, staged, unstaged, untracked, and conflicted code context with a versioned content-sensitive Git/Worktree fingerprint. Hidden index flags are rejected; every stage-zero tracked file plus conflicted and visible untracked content is hashed under aggregate entry, byte, and time budgets that fail closed. Existing gates are associated honestly as `HEAD_MATCH_ONLY` or `STALE`; a passing gate never approves a Review.
- The workspace read model and desktop expose Review action policy, the 20 newest decision records, code/evidence summaries, and explicit Start review, Request changes, and Approve and mark done actions without exposing native Worktree paths. Artifact and gate payload reads are limited to the newest 20 while payload-free projections determine readiness; full immutable history remains available through explicit history use cases.
- Application now exposes explicit Pull Request inspection, Task-branch push, and create-or-refresh use cases. Infrastructure verifies the exact persisted primary Worktree, attached Task branch, base ancestry, clean code state, and a supported `github.com` HTTPS or SSH remote. Push pins the inspected commit to the named remote branch without force; no agent/session event invokes either mutation.
- GitHub PR lookup and mutation reuse the installed `gh` CLI through structured argv and bounded JSON stdin. Readiness separately checks an active authenticated `github.com` account through `gh auth status` without requesting or persisting its token. A matching open or merged PR is reused, a closed PR is reopened, and a new PR is created only when no exact repository/head/base/current-commit match exists. Migration 9 stores only bounded GitHub PR identity/status metadata; it excludes body, commands, environment, credentials, and provider output.
- The desktop loads Pull Request state lazily for the selected Task and shows repository, head/base, push readiness, stored PR number/status/URL, and explicit Push / Create or refresh controls. Errors are sanitized at the controller boundary, and PR evidence never changes Task phase or Review decisions.
- The desktop now has a searchable command palette opened by `Ctrl+Shift+P`, with accent-insensitive Vietnamese/Unicode search, wrapping arrow-key navigation, contextual Task/action commands, and explicit `Alt+1` / `Alt+2` / `Alt+3` focus shortcuts for sidebar, workspace, and terminal. `Alt+[` / `Alt+]` switch tabs and their Shift variants switch panes; ordinary terminal keys are not intercepted.
- Application exposes only configured Quality Gate `id`/`kind` summaries plus Task-level run readiness to Presentation. Eligible palette commands dispatch the existing explicit gate workflow through the workspace client; executable, argv, environment, and run-identity policy remain outside the renderer.

## Decisions

- Application use cases are async functions with explicit inputs, Domain outputs, and injected repository ports.
- Project and Task IDs cannot be silently replaced through create use cases; Task creation also requires an existing Project.
- Task transitions load and persist state through `TaskRepository`, while transition validity remains owned by Domain.
- The PTY port is runtime-only: Infrastructure owns `node-pty` and ConPTY mechanics, while process
  exit remains evidence and never changes `TaskPhase`. Agent-specific commands, session policy,
  and validated IPC remain outside that runtime layer.
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
- Claude discovery accepts a configured executable or the recognized `@anthropic-ai/claude-code`
  native npm layout; Gemini accepts a configured executable or the recognized
  `@google/gemini-cli` Node layout. Both use the PTY working directory as their project context and
  add no permission-bypass or authentication flags. Gemini launch rejects `CI_` markers that its
  documented runtime treats as non-interactive. Authentication setup, credential storage, upgrades,
  and installation remain owned by each CLI.
- Agent identity is registered once as a cloned, frozen catalog value; lookup, Presentation summaries,
  and persisted Session association all use that canonical stable ID. Capabilities are a small set of
  identifiers rather than one provider-shaped interface. The catalog exposes no executable path,
  version string, command, or environment to Presentation. `codex` remains the stable built-in ID,
  so migration-4 Sessions need no schema or data migration. Unknown historical IDs stay readable,
  and a later retry can explicitly select any currently available registered agent.
- Agent Session status is independent from Task workflow: `STARTING`, `WORKING`, `IDLE`,
  `WAITING_INPUT`, `EXITED`, and `FAILED` are Domain states for one runtime attempt. The
  Application coordinator persists `STARTING` before launch, serializes PTY evidence, retains
  owned handles for stop, and records exit/failure as session evidence only. Multiple sessions per
  Task are preserved; output is not persisted or interpreted as idle/input/completion state.
- Startup restore runs before the new process owns any PTY. Persisted `STARTING`, `WORKING`,
  `IDLE`, or `WAITING_INPUT` sessions, plus `FAILED` runtime sessions without process-exit or
  ownership-loss evidence, are not reattached or killed by PID; they receive one sanitized
  `RUNTIME_OWNERSHIP_LOST` failure event through revision-checked history append. The
  operation is idempotent, preserves partial progress for a later retry, and needs no schema change
  because migration 4 already stores the required lifecycle evidence.
- Planning and execution order external effects deliberately: validate the exact phase, ensure/reuse the Worktree,
  then create and launch a phase-bound new Session. Plan acceptance owns the explicit `PLANNING -> RUNNING`
  transition before any execution attempt. A later launch failure preserves the ready
  Worktree and durable Task/Session checkpoint for inspection; it never deletes Git state or
  pretends SQLite can roll back Git or a spawned process. Reusing an old Session id is rejected.
- Retry serializes execution admission per Task and rejects missing history, an unconfigured selected agent, any
  active Session, or a locally owned failed runtime still awaiting exit before Git mutation. An
  atomic SQLite admission check is the cross-process backstop. Earlier attempts remain immutable;
  an agent switch is a new Session in the existing valid primary Worktree, and a failed retry is another truthful Session checkpoint
  and never completes the Task or triggers an automatic retry loop.
- Dependency readiness is orthogonal to `TaskPhase`: an edge is satisfied only when its required Task is `DONE`.
  Dependency writes are serialized transactionally and constrained to one Project; they never create, clean, or
  replace a Worktree, Session, Artifact, gate, or Review record. A later completion only changes the next derived
  workspace read and does not schedule execution.
- Terminal rendering uses `@xterm/xterm` with the fit addon and a renderer-local controller. The
  controller consumes only the Application session attachment contract; detach is observer cleanup,
  not stop, and an exit disables input while preserving the visible terminal buffer. Application
  grants at most one interactive attachment for each owned live Session, so input, output, and
  resize cannot be routed through competing panes. Tab and pane layout is immutable Presentation
  state with a fixed two-pane limit rather than a general tiling model; inactive tabs remain mounted,
  activation refits the visible xterm, and closing a pane or tab disposes its subscriptions. Output
  is a live stream and is not persisted or replayed after a later attachment.
- Workspace reads use the Application `loadAgentWorkspace` use case over `ProjectCatalog`,
  `TaskCatalog`, and immutable session history. The read model selects the latest nonterminal
  session independently from the newest historical session, so a `FAILED` or `EXITED` attempt never
  relabels its Task as `DONE`; it also publishes execution availability without exposing local
  Project paths. React owns only loading, selection, action, and error presentation state;
  execution orchestration remains behind its client interface. Terminal lifecycle evidence triggers
  a read-model refresh rather than a Presentation-owned business transition.
- The workspace read model exposes Start and Retry lifecycle availability separately from the safe
  agent catalog. The desktop disables either action without an available selected agent, keeps the
  selector provider-neutral, and shows the previous attempt beside the newly active/latest Session.
- Execution Artifacts are structured evidence, never Task transitions. Their identity is insert-only;
  repeated canonical outputs receive new identities and per-Task ordinals rather than overwriting
  history. SQLite stores validated text and fixed contract metadata directly, so this slice adds no
  user-controlled filesystem path. Metadata excludes environment and credential data, and the
  desktop renders artifact content as escaped plain text instead of executable HTML.
- Plan creation is phase-bound and requires same-Task Agent Session provenance. Accept Plan uses the
  latest immutable Plan rather than a mutable file or agent claim; re-planning appends a new Session
  and Plan and makes older Plans historical without deleting either artifact or the Worktree.
- Quality Gate execution is a one-shot Application workflow, not an agent claim or Task transition.
  It serializes with in-process Worktree lifecycle operations, inspects but never provisions or
  cleans the Worktree, inserts `RUNNING` before spawn, and finalizes the same immutable run through
  SQLite compare-and-set. Each later attempt needs a new run id, so earlier evidence is preserved.
- Gate provenance records the attached commit observed immediately before launch. Dirty, ignored,
  and untracked content is deliberately left in place and is exercised by the command, but this
  foundation does not claim that such uncommitted content is a reproducible commit snapshot.
- Gate process policy uses a dedicated Infrastructure runner rather than the interactive PTY. The
  runner drains stdout and stderr, applies explicit sensitive-value redaction, retains at most
  256 KiB, and never persists its environment. On Windows, a static packaged host creates the
  configured process suspended, assigns it to a kill-on-close Job Object, then resumes it and waits
  for zero active descendants; missing or malformed settlement evidence fails closed.
- The desktop Vite build uses relative asset URLs for Electron's `file://` loader, and its smoke
  check verifies nonempty rendered content instead of accepting `did-finish-load` alone. The CSP
  permits only the inline style elements/attributes required by xterm while scripts remain self-only.
- Review completion is user-owned. Generic Task transitions cannot enter or leave `REVIEW`; only the
  structured Review workflows may do so, and neither agent output, process exit, Artifacts, nor a
  passing Quality Gate can move a Task to `DONE`.
- Each Review request creates a new append-only attempt and snapshots the exact current Artifact and
  Quality Gate histories plus a verified code state. Admission reads bounded, payload-free evidence
  projections before Git inspection, then SQLite rechecks the exact ordered histories and Session
  revisions in the phase-change transaction. Gate provenance without a matching content
  fingerprint is labeled `HEAD_MATCH_ONLY`, never current; approval independently recaptures and
  compares the full versioned code-state snapshot.
- Review admission and execution retry share per-Task workflow serialization. SQLite is the
  cross-process backstop: Review phase changes and decisions use compare-and-set transactions, and
  Session and Quality Gate insertion atomically require an eligible Task phase. A gate whose process
  cleanup cannot be confirmed remains durably `RUNNING`, so Review fails closed until explicit future
  reconciliation. Request changes only finalizes the Review and returns the Task to `RUNNING`;
  Worktree, Session, Artifact, and gate histories stay intact.
- Review commands are retry-idempotent after an ambiguous successful checkpoint when the same Review
  id, action, Task target, and decision note agree. Review snapshots accept at most 1,000 Artifact and
  1,000 Quality Gate associations; exceeding either limit is an explicit readiness failure rather
  than silently dropping evidence.
- Task change inspection is a read-only Application port implemented by the existing Git Worktree
  lifecycle adapter. It verifies the exact persisted primary Worktree, reads committed changes from
  the Task base commit through `HEAD`, and reads staged, unstaged, conflicted, and untracked state
  from porcelain-v2/name-status NUL records. The file list is capped at 500 paths; the renderer loads
  only the selected file's patch, omits binary/unsupported previews, and rejects patches above
  128 KiB or 2,000 changed lines. Inspector results are evidence only and never change Task phase.
- Pull Request integration is one narrow Application port: GitHub remote parsing, Git and `gh`
  command policy, API response validation, and duplicate prevention stay in Infrastructure. Remote
  inspection is read-only; push and PR mutation are separate user-triggered commands serialized per
  Task. Repository-local URL rewrites, SSH commands, credential helpers, and remote helpers are
  rejected before trusting or pushing a remote, while authentication remains owned by `gh` or the
  user's trusted Git credential configuration.
- The command palette is a renderer-owned command registry, not a workflow or plugin system. It consumes
  Application readiness flags and existing controller actions, restores focus when dismissed, and moves focus
  to stable workspace landmarks for navigation commands. Only the documented global chords are intercepted in
  the capture phase, including while xterm is focused; all other keystrokes continue to the terminal.

## Blockers

No implementation blocker is known. Node.js 22.13 emits its documented experimental warning for
`node:sqlite`; Electron 43's Node.js 24 runtime does not emit that warning in the current smoke test.
The current development environment does not have `gh` installed, so real GitHub API/authentication
was not exercised locally; the workspace reports GitHub CLI unavailable and disables Create/refresh
while retaining explicit branch inspection and push readiness. AgentTerm does not install or manage
GitHub credentials.
Git status and diff can still execute repository-configured clean/process filters. Stronger isolation
for untrusted repositories is deferred; current inspection must follow an explicit user trust decision.
Worktree checkout can likewise execute configured clean/smudge/process filters even though hooks are
disabled for AgentTerm's mutating commands. The in-process Agent Session coordinator owns PTY
handles, and startup can now reconcile persisted sessions that no longer have ownership.
Reattaching to an old process, provider-native resume, automatic retry policy, and exclusive Worktree-cleanup
coordination remain deferred; another writer could otherwise race the final dirty/ignored-file inspection.
The unpacked packaged-desktop layout has not been introduced, so native loading has been verified in
Electron 43 development runtime but not yet from an installed artifact. The Infrastructure build
copies its PTY host asset beside the bundle; future packaging must retain that asset and the complete
`node-pty` module outside ASAR. PTY children run with the desktop process's privileges; executable
and environment policy belongs to the future session/agent coordinator.
The renderer-side workspace and terminal contracts are implemented, but the sandboxed Electron
renderer still has no validated preload/IPC binding to the main-process repositories and execution
coordinator. Until that composition and its database/worktree/environment policy are added, the
desktop shell intentionally renders a recoverable connection-unavailable state rather than using
demo data or exposing Infrastructure to React.
Workspace tabs and split panes are intentionally renderer-local in this foundation; their layout is
not persisted or restored after an application restart. Closing UI detaches observers only, while a
later reattachment cannot replay output emitted during the detached interval because terminal output
is not durable Session evidence.
If AgentTerm exits after a gate process finishes but before its final SQLite checkpoint, or process
tree cleanup cannot be confirmed, that run remains durably `RUNNING` and Review admission is blocked.
Automatic reconciliation of such orphan or unsettled gate attempts is deferred; a retry must use a
new run id and preserve the old row.
Review code-state fingerprint schema 1 intentionally excludes ignored files and fails closed for
dirty submodules, nested repositories, and symlink/junction ancestor escapes. Its double capture and
open-file identity checks detect ordinary concurrent edits but cannot provide an atomic filesystem
snapshot against a privileged exact-ABA replacement. Fingerprinting reads at most 10,000 stage-zero
tracked, conflicted, and visible untracked entries and 64 MiB aggregate per capture within a
30-second budget. Git status also retains the existing
trusted-repository limitation around configured clean/process filters.

## Next Step

Bind startup session reconciliation, artifact/review/change-inspection/dependency/PR reads,
`loadAgentWorkspace`, `startTaskPlanning`, Plan creation/acceptance, `startTaskExecution`,
`retryTaskExecution`, the three explicit Review commands, terminal attachment, explicit Task-branch
push, configured Quality Gate listing/execution, and Pull Request create-or-refresh commands to the sandboxed renderer through a narrow validated
preload/IPC adapter in the Electron main process. Reconciliation must finish before new runtime
launches or workspace reads. That composition must own session identifiers, approved launch
environment, Review identifiers and decision timestamps, database path, and managed Worktree root;
validated dependency add/remove commands must likewise remain behind this Application boundary;
the renderer must not receive raw filesystem,
Git, database, process, or environment capability. Process reattachment, provider-native resume,
output replay, and cross-process live-execution reconciliation remain later lifecycle slices.
