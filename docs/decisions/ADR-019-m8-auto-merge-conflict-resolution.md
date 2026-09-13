# ADR-019: M8 — Auto merge-conflict detection and resolution prompt

Status: Accepted
Date: 2026-09-13
Owner: AgentTerm desktop + application + infrastructure
Shipped: aggregated into the upcoming PR alongside M8. The work consumes
the same `git merge-tree` legacy mode (`git merge-tree <base> <head>`,
output lines shaped `CONFLICT (content): Merge conflict in <path>`) that
agtx uses; we deliberately do **not** invent plugin hooks or any
Domain-layer rule that depends on them, in line with ADR-009 §AD-2.

## Context

ADR-009 §"Deferred" listed M8 as deferred until plugin hooks stabilize.
The slice this ADR records is the smallest read-only surface that lets a
human reviewer detect and start resolving merge conflicts during
`REVIEW` without leaving the AgentTerm workspace:

- **Detection.** The renderer must be able to ask "would merging this
  Task's branch into the persisted base ref conflict?" without
  actually creating a merge. We use `git merge-tree` legacy mode
  (a non-destructive three-way merge) so the worktree, branch, and
  index stay untouched.
- **Resolution trigger.** Once conflicts are detected, the user can
  ask the active Agent Session to resolve them by writing a single
  slash command to the attached PTY: `/agtx:merge-conflicts\r`. The
  slash command is the same one agtx ships; we surface it through the
  existing terminal input pipeline (no new Domain rule).

The slice **explicitly does not**:

- Add a new `AgentSessionEvent` kind to Domain.
- Hijack `AgentSessionCoordinator.attachTerminal` from Application.
- Reimplement `git merge-tree` parsing in Domain; the only new
  parsing lives in `GitCli` and is adapter code, not Domain rules.
- Touch the plugin contract. The `/agtx:merge-conflicts` prompt is a
  renderer-typed keyboard convention, not a plugin hook. We accept the
  contract is frozen as ADR-009 §AD-2 stated; the prompt is owned by
  the renderer-side slash-command detector, which already owns
  `/agtx:brainstorm` and `/agtx:sweep` from ADR-018.

## Goals

1. Add a structured `TaskMergeConflictProbe` Application port whose
   single job is "would merging Task X's head into base ref Y conflict?"
2. Add one Application use case that returns a clean, structured
   result (`clean | conflicts | unavailable`) plus a typed
   `unavailable` reason for every failure mode the team has seen
   (`TASK_NOT_FOUND`, `WORKTREE_NOT_READY`, `NO_BASE_REF`,
   `GIT_INSPECTION_FAILED`).
3. Add a second Application use case that validates `REVIEW` + `IDLE`
   preconditions and returns the slash-command bytes the renderer
   forwards to the attached PTY. The use case never writes to the
   PTY itself.
4. Extend the workspace read model with a `mergeConflictStatus` field
   that the renderer can show without consulting Domain again.
5. Wire two IPC channels:
   - `agentterm:task:check-merge-conflicts` — runs the probe.
   - `agentterm:task:request-merge-conflict-resolution` — returns the
     prompt bytes after validation.
6. Surface both commands in the existing command palette and the
   slash-command detector so keyboard and palette both work.

## Non-goals

- Automated resolution: the slice stops at "the user typed the slash
  command and the agent took over." What happens next is owned by the
  agent CLI, not AgentTerm.
- Pulling `git merge-tree` parsing into Domain. Domain stays free of
  Git and CLI output shapes.
- Persisting an audit trail of "the user sent `/agtx:merge-conflicts`
  at 2026-09-13 14:00." The renderer's `WorkspaceController` flips
  `mergeConflictStatus` to `kind: 'sent'` immediately after a
  successful IPC response, which is the only durable signal the
  workspace shows. We do not introduce a new `AgentSessionEvent` to
  Domain for this — it is a renderer-state observation, not a
  Domain transition.
- Replacing the existing `resolveTerminalLinkTarget` trust boundary
  with anything that lets the renderer smuggle a path.
- Adding a plugin hook. If a future plugin contract needs to declare
  a merge-conflict prompt, ADR-009 §AD-2 will be amended first.

## Architectural decisions

### AD-1: The Domain layer stays untouched

No new `AgentSessionEvent`, no new `Task` field, no new
`MergeConflictFile` Domain type. The only Domain surface we read is
`Task.phase` (already `REVIEW`) and `AgentSession.status` (already
`IDLE | WAITING_INPUT`). The result is `MergeConflictFile`,
`MergeConflictProbe`, and `MergeConflictUnavailableReason` types are
defined in `packages/application/src/ports.ts` and
`task-merge-conflict-use-cases.ts`, not in `@agentterm/domain`.

### AD-2: Renderer owns the PTY write

`sendMergeConflictResolutionTaskPrompt` only validates and returns the
slash-command bytes. The renderer (`WorkspaceController`) forwards
them to the active `terminal-controller` exactly like every other
slash command. This keeps Application free of PTY mechanics (which
ADR-009 §"Architecture" reserved for Infrastructure) and keeps the
trust boundary the renderer already enforces for slash commands.

### AD-3: One Application port, one Infrastructure adapter

`TaskMergeConflictProbe` lives in `packages/application/src/ports.ts`.
The sole production adapter is `GitCliTaskMergeConflictProbe`, which
wraps `GitCli.mergeTreeConflictProbe`. The adapter is intentionally
thin: it maps the CLI's `MergeTreeConflictProbeResult` into the
`MergeConflictProbe` Application type and surfaces Git failures as
`unavailable` reasons. Domain never sees the CLI shape.

### AD-4: `git merge-tree` legacy mode is the only probe

We use `git merge-tree <base> <head>` in legacy mode. The output lines
we care about look like `CONFLICT (content): Merge conflict in
<path>`. We parse only those lines. The newer `--write-tree` and
`-z` modes are deliberately ignored; they need a working tree plus
conflict markers in the index, which is exactly the destructive
shape we do not want. The integration test in
`git-cli-task-merge-conflict-probe.integration.test.ts` covers all
three result shapes (`clean`, `conflicts`, `NO_BASE_REF`) so the
parser is locked to the legacy contract.

### AD-5: The workspace read model carries a `mergeConflictStatus`

`WorkspaceSnapshot` gains a single optional field
`mergeConflictInspection?: WorkspaceMergeConflictInspection` with
`kind: 'idle' | 'checking' | 'clean' | 'conflicts' | 'unavailable' | 'sent'`.
The renderer owns this state. Domain and SQLite do not see it; it is
a UI-level fact about what the user last asked. `selectTask` resets
the inspection to `idle` so stale inspections never leak across task
selections.

### AD-6: Two IPC channels, two narrow contracts

`agentterm:task:check-merge-conflicts` accepts `{ taskId }` and
returns `TaskMergeConflictResult`. The handler dispatches to the
Application use case; no other Application surface is reachable from
this channel.

`agentterm:task:request-merge-conflict-resolution` accepts
`{ taskId, sessionId }` and returns `{ bytes, sessionId, taskId }`.
The handler validates and returns the prompt bytes. The renderer
then writes the bytes to the PTY via the existing
`terminal-controller` slash-command pathway.

The IPC contract test (`desktop-bridge.test.ts`) extends the existing
`AgentTermDesktopApi` allowlist to cover both methods. No other
methods are added.

### AD-7: Slash-command detector owns the trigger

The renderer's `terminal-keyboard-controller` already recognises
`/agtx:brainstorm` and `/agtx:sweep` (ADR-018). This slice adds one
more entry, `merge-conflicts`, to the same `SLASH_COMMAND_REGEX`. The
terminal controller pipes the decision through `onSlashCommand` just
like every other slash command; the smart `AgentWorkspace` component
maps the `kind: 'merge-conflicts'` decision to the new
`onSendMergeConflictResolution` callback.

## Scope

### Files added

1. `packages/application/src/task-merge-conflict-use-cases.ts`
   - `MERGE_CONFLICTS_PROMPT_BYTES` constant (`'/agtx:merge-conflicts\r'`).
   - `checkTaskMergeConflicts(input, deps)` — uses `TaskRepository`,
     `TaskWorktreeRepository`, and `TaskMergeConflictProbe`.
   - `sendMergeConflictResolutionTaskPrompt(input, deps)` — uses
     `TaskRepository` and `AgentSessionRepository`.
   - All `MergeConflict*` types.
   - Exports `SendMergeConflictResolutionFailure` and
     `SendMergeConflictResolutionResult`.
   - Exports the typed error class (re-exported from `errors.ts`).
2. `packages/application/src/task-merge-conflict-use-cases.test.ts`
   - 11 unit tests covering every branch (TASK_NOT_FOUND,
     WORKTREE_NOT_READY, clean, conflicts, NO_BASE_REF,
     SESSION_NOT_IDLE, TASK_NOT_IN_REVIEW, mismatch, WAITING_INPUT
     acceptance, success path).
3. `packages/infrastructure/src/git/git-cli-task-merge-conflict-probe.ts`
   - `GitCliTaskMergeConflictProbe` adapter — maps CLI result to
     Application port.
4. `packages/infrastructure/src/git-cli-task-merge-conflict-probe.integration.test.ts`
   - 3 integration tests against a real temporary Git repository:
     clean, conflicts, NO_BASE_REF. Uses the `withRepository`
     test helper to keep fixtures isolated.

### Files modified

1. `packages/application/src/errors.ts` — adds
   `SendMergeConflictResolutionPromptError` (typed failure with
   `reason: 'SESSION_NOT_IDLE' | 'TASK_NOT_IN_REVIEW'`).
2. `packages/application/src/ports.ts` — adds `MergeConflictFile`,
   `MergeConflictProbe`, `MergeConflictUnavailableReason`,
   `ProbeTaskMergeConflictsInput`, `TaskMergeConflictProbe`.
3. `packages/application/src/index.ts` — re-exports the new symbols.
4. `packages/infrastructure/src/git/git-cli.ts` — adds
   `mergeTreeConflictProbe(baseRef, headRef, repositoryPath)` plus
   `parseMergeTreeConflictProbe` and `validateMergeTreeRefs`
   helpers.
5. `packages/infrastructure/src/index.ts` — re-exports the new
   adapter.
6. `apps/desktop/src/ipc-contract.ts` — adds
   `checkTaskMergeConflicts` and `requestMergeConflictResolution`
   channel constants plus payload validators; both registered in
   `DesktopIpcRequestMap` / `DesktopIpcResponseMap`.
7. `apps/desktop/src/desktop-main-handlers.ts` — adds two `case`
   entries that dispatch to the Application seam.
8. `apps/desktop/src/desktop-application.ts` — instantiates
   `GitCliTaskMergeConflictProbe` and implements the two new methods
   on `AgentTermDesktopApi`.
9. `apps/desktop/src/desktop-bridge.ts` — exposes the two new
   methods over the existing `invoke` channel.
10. `apps/desktop/src/renderer/workspace-controller.ts` — adds
    `mergeConflictInspection` to `WorkspaceSnapshot`, the
    `checkMergeConflictsForSelectedTask` and
    `triggerMergeConflictResolutionForSelectedTask` controller
    methods, and the matching `WorkspaceActionKind` /
    `WorkspaceAction` shapes.
11. `apps/desktop/src/renderer/workspace-command-palette.ts` —
    adds the two new command entries.
12. `apps/desktop/src/renderer/workspace-command-palette.test.ts` —
    extends the `baseContext` factory.
13. `apps/desktop/src/renderer/terminal-keyboard-controller.ts` —
    extends `SLASH_COMMAND_REGEX` to recognise `merge-conflicts`.
14. `apps/desktop/src/renderer/terminal-controller.ts` — extends
    `SlashCommandKind` to include `'merge-conflicts'`.
15. `apps/desktop/src/renderer/terminal-renderer.tsx` and
    `apps/desktop/src/renderer/workspace-terminals.tsx` — extend
    the `onSlashCommand` prop type.
16. `apps/desktop/src/renderer/agent-workspace.tsx` — wires the new
    slash-command kind to `onSendMergeConflictResolution` and adds
    the two callback props to `AgentWorkspaceViewProps`.

### Files NOT modified

- `packages/domain/**` — Domain is untouched (AD-1).
- `packages/infrastructure/src/git/git-cli-task-review-code-inspector.ts` —
  the existing review inspector is untouched; we deliberately reuse
  `git merge-tree` (different command) instead of teaching the review
  inspector about conflicts.
- `packages/infrastructure/src/git/git-cli-task-change-inspector.ts` —
  same: change inspection stays separate from conflict detection.

## Tests

### Unit tests

- `packages/application/src/task-merge-conflict-use-cases.test.ts`
  (new, 11 cases) — covers every typed failure path and the happy
  path for both use cases.
- `apps/desktop/src/renderer/workspace-command-palette.test.ts`
  (extended) — covers the new `canCheckMergeConflicts` /
  `canSendMergeConflictResolution` capability flags.

### Integration tests

- `packages/infrastructure/src/git-cli-task-merge-conflict-probe.integration.test.ts`
  (new, 3 cases) — exercises real `git merge-tree` against a
  temporary repo: clean branch, diverged branch with conflict,
  missing base ref.

### Existing tests extended

- `apps/desktop/src/desktop-bridge.test.ts` — extends the
  `AgentTermDesktopApi` allowlist to include the two new methods.

## Validation plan

- `pnpm -F @agentterm/desktop typecheck`
- `pnpm -F @agentterm/desktop lint`
- `pnpm -F @agentterm/desktop test`
- `pnpm -F @agentterm/application test`
- `pnpm -F @agentterm/infrastructure test`
- Smoke: open a Task in `REVIEW`, open the palette, run
  "Check merge conflicts" against a Task whose branch diverges from
  the base ref, observe `conflicts` plus the conflicted file path.
  Then run "Send /agtx:merge-conflicts" and observe the bytes land
  in the PTY and the active session begins to work.

## Risks and mitigations

1. **Git CLI output drift.** Git 2.38 changed `merge-tree` output
   shape again (the `-z` mode arrived). Mitigation: AD-4 pins us to
   legacy mode; the integration test exercises the exact line shape
   (`CONFLICT (content): Merge conflict in <path>`) and the parser
   ignores everything else. If Git removes legacy mode entirely,
   this is the only test that needs to be re-pointed.
2. **Renderer drift between slash-command detector and use case.**
   The slash command and the use case `MERGE_CONFLICTS_PROMPT_BYTES`
   constant must agree. Mitigation: a single source of truth — the
   use case exports the constant and the slash-command regex tests
   read it. If the constant changes, both move together.
3. **Slash command trigger on a non-idle session.** A user typing
   `/agtx:merge-conflicts` directly into the PTY bypasses the palette
   check. Mitigation: AD-7 keeps the slash-command detector as the
   only trigger outside the palette; the detector passes through to
   the same controller method, which still runs the same use case
   validation. If the session is `WORKING`, the use case rejects and
   the controller flips the workspace projection to
   `unavailable: SESSION_NOT_IDLE`.
4. **Audit-trail absence.** No `AgentSessionEvent` is recorded for
   "merge conflict resolution sent". If operators later need this for
   forensic review, AD-1 will need to be relaxed and a new event kind
   introduced. Until then, the workspace projection's `kind: 'sent'`
   is the only durable evidence and it lives in the renderer, not in
   SQLite.

## Deferred (explicit non-goals)

- Plugin-level merge-conflict prompts. ADR-009 §AD-2 still excludes
  plugin hooks. If the plugin contract ever grows one, the new hook
  will reuse the same `TaskMergeConflictProbe` port this ADR added.
- WCAG-style structured dialog for the conflict file list. The
  workspace projection shows the path; a future design pass can add
  a per-file diff preview without changing any of the layers this
  ADR touches.
- Batch merge-conflict detection across multiple Tasks. The current
  port is per-Task by design; the renderer can iterate if it ever
  needs the bulk view.
