# M8 — Check + auto-resolve merge conflicts at REVIEW (Recommended)

This slice closes the last item from ADR-009 §"Deferred" and ADR-009
§AD-6. ADR-009 deferred it on the rationale "auto-resolving requires
agent intervention, which itself requires plugin hooks" — but AgentTerm's
plugin contract (ADR-010) deliberately does **not** expose a plugin hook
to launch an agent skill (ADR-010 AD-2), and the M7.5 renderer-side
slash-command detector already supplies the input pipeline that agtx
expected the plugin shell hooks for. The reasoning that originally
justified the deferral no longer applies, and a Task sitting in
`REVIEW` after a real Codex/Claude/Gemini session often discovers
rebase conflict against the persisted `suggestedBaseBranch` only when
the human opens GitHub or runs `git rebase` themselves.

The slice stays inside AgentTerm's architecture: a non-destructive
`git merge-tree` check plus a renderer-triggered slash command. No new
Domain rule, no new plugin hook, no new shell out, no new agent
adapter surface. Auto-resolution is opt-in (one palette command and
one Task inspector button), so the existing explicit Review/Done flow
is untouched.

## Why now

- ADR-009 AD-6 names `git merge-tree` as the read-only conflict probe.
  The Git command is supported by the same `GitCli` wrapper every other
  Infrastructure command uses today; no new infrastructure library is
  needed.
- The persisted `suggestedBaseBranch` already lives on
  `WorkspaceProjectOverview.repository.repository.suggestedBaseBranch`
  (see ADR-005), so the conflict probe can resolve a base identity
  for any Task without an extra round-trip.
- The renderer already has a slash-command detector
  (`detectSlashCommand` in `apps/desktop/src/renderer/terminal-keyboard-controller.ts`)
  that recognises `/agtx:brainstorm` and `/agtx:sweep` and forwards a
  typed decision to the smart wrapper. Adding `merge-conflicts` to the
  regex widens the same primitive without introducing a new pathway.
- ADR-009 §"Deferred" lists M8 as the only remaining agtx-port item;
  closing it lets us retire the "anything still deferred" caveat in
  `CURRENT_STATE.md`.

## Goals

1. Surface the merge-conflict status of the focused Task against the
   persisted `suggestedBaseBranch` lazily — never in a poller, never
   in a background loop.
2. Replace the manual `git fetch && git rebase origin/<base>` step
   with one typed Application use case
   (`checkTaskMergeConflicts`) that returns the same conflict set the
   user would see locally.
3. When the Task is in `REVIEW` and the latest attached Session is
   `IDLE`/`WAITING_INPUT`, and there are real conflicts, give the user
   one explicit affordance (`Send merge-conflicts prompt`) that
   forwards `/agtx:merge-conflicts<Enter>` to the active PTY using
   the M7.5 input pipeline.
4. Record the auto-resolution attempt as a structured immutable
   Session event (`MERGE_CONFLICT_CHECK` / `MERGE_CONFLICT_RESOLUTION`)
   so audits show what was probed and what was sent.
5. The conflict probe never changes the Worktree, the HEAD, or any
   persisted state — failures fail closed with a sanitized reason.

## Non-goals

- No plugin hooks, no shell-script execution, no `prompt_triggers`
  re-introduction. The whole point of this slice is that M8 fits
  AgentTerm *without* a plugin-hook mechanism.
- No autonomous resolution loop. The slice only sends the slash
  command when the user explicitly clicks the affordance — the
  orchestrator never loops on conflicts. (Auto-advance is M6; M6 ADR
  explicitly excludes auto-merge.)
- No MCP write tools and no change to the MCP read surface
  (ADR-009 §AD-5).
- No actual `git merge` / `git rebase` execution. The slice is a
  conflict *probe* + a prompt trigger, not an agent-driven merge.
- No multi-base comparison (compare Task branch against multiple
  candidate bases). The probe uses the single persisted
  `suggestedBaseBranch` and reports missing base / detached HEAD
  with a typed result.
- No change to the board view semantics; the slice is renderer-only
  for the auto-resolution button, mirroring M2.3's invariant.

## Architectural decisions

### AD-1: `git merge-tree` is wrapped in `GitCli` Infrastructure

A new method `GitCli.mergeTreeConflictProbe(repositoryPath, baseRef, headRef)`
runs `git merge-tree --write-tree <baseRef>...<headRef>` (the
non-destructive 3-way virtual merge) through the existing
`GitCli.run` path. It returns one of:

- `{ kind: 'clean' }` — exit code 0, no conflict lines in stdout.
- `{ kind: 'conflicts', files: readonly MergeConflictFile[] }` —
  parsed from the `git merge-tree --write-tree --name-only <base> <ours>`
  variant used for human-readable output.
- `{ kind: 'unavailable', reason: 'NO_BASE_REF' | 'NOT_HEAD_ATTACHED'
  | 'GIT_INSPECTION_FAILED' }` — sanitized error reasons that map
  to existing `GitCli` failures (no new error classes).

The probe is pure Infrastructure; it does not know about Tasks. The
Application use case is the one that holds the Task identity.

### AD-2: One Application use case, one Git port

The new use case `checkTaskMergeConflicts(input, deps)` lives in
`packages/application/src/task-merge-conflict-use-cases.ts`. It
accepts `{ taskId }`, loads the persisted primary Worktree + the
project's `suggestedBaseBranch` (already exposed via the existing
`loadAgentWorkspace` read model), and asks Infrastructure for a
`TaskMergeConflictProbe` port (`GitCli.mergeTreeConflictProbe`
implemented in `git-cli-task-worktree-lifecycle.ts`).

The use case emits an immutable `MERGE_CONFLICT_CHECK` event on the
attached Session (or creates a synthetic observer event if no live
Session is attached) and returns the conflict set. Failures are
sanitized — the same discipline as `TaskReviewCodeInspector`.

### AD-3: An opt-in auto-resolution trigger is renderer-only

A second use case `sendMergeConflictResolutionTaskPrompt(input, deps)`
is renderer-only in spirit — Application exposes a typed
`AgentTaskRequest`-shaped IPC channel and the renderer invokes it
through the existing `WorkspaceController` pattern. The use case:

1. Verifies the Task is in `REVIEW`.
2. Verifies the attached Session is `IDLE` or `WAITING_INPUT`.
3. Persists a `MERGE_CONFLICT_RESOLUTION_SENT` Session event.
4. Asks the PTY port to write the bytes
   `/agtx:merge-conflicts\r` to the attached Session (same path that
   M7.5 uses for brainstorm/sweep).

The slash-command text rides the existing input pipeline. The
agent receives it as ordinary keystrokes; AgentTerm does **not**
synthesize a `prompt_triggers`-style plugin hook.

### AD-4: Slash-command detector widened by exactly one token

`detectSlashCommand` in
`apps/desktop/src/renderer/terminal-keyboard-controller.ts` accepts
`merge-conflicts` in the same regex:

```
const SLASH_COMMAND_REGEX = /^\/agtx:(brainstorm|sweep|merge-conflicts)\s?$/;
export interface SlashCommandDecision {
  readonly kind: 'brainstorm' | 'sweep' | 'merge-conflicts';
}
```

User-typed `/agtx:merge-conflicts` is treated like a session-note
trigger: the renderer suppresses the line forward, surfaces a
feedback toast, and calls the controller's new
`sendSelectedMergeConflictResolution()` method. Auto-triggered
calls (from the inspector button) bypass the detector and call the
same controller method directly.

### AD-5: Conflict probe is opt-in; no background polling

The probe only runs when the user explicitly requests it (palette
command `task:check-merge-conflicts` and a "Check conflicts" button
in the Task inspector). Render-side results are cached on the
`WorkspaceController` snapshot under
`mergeConflictInspection: { kind: 'idle' | 'checking' | 'ready' | 'failed' }`
mirroring the existing `changeInspection` / `pullRequestInspection`
pattern. No background timer, no `useEffect` polling, no IPC
subscription fan-out.

### AD-6: Errors are sanitized and never leak Git internals

The Task inspector renders the conflict set as `{ path, hunks }`
where `hunks` is a bounded number (default 64, hard cap 256). Path
strings are escaped React children, never raw HTML. Failure reasons
(`NO_BASE_REF`, `NOT_HEAD_ATTACHED`, `GIT_INSPECTION_FAILED`) are
typed enum strings the renderer maps to localized copy; raw `git`
output never crosses the IPC boundary.

## Scope

### Files added

1. `packages/application/src/task-merge-conflict-use-cases.ts`
   - `TaskMergeConflictProbe` port interface
   - `checkTaskMergeConflicts(input, deps)`
   - `sendMergeConflictResolutionTaskPrompt(input, deps)`
   - typed errors (`TaskMergeConflictUnavailableError`,
     `TaskMergeConflictPromptError`)
2. `packages/application/src/task-merge-conflict-use-cases.test.ts`
   - coverage for clean / conflicts / unavailable / wrong phase /
     wrong session status cases
3. `docs/decisions/ADR-019-m8-merge-conflict-probe.md` — Accepts M8
   and supersedes the ADR-009 §M8 entry in the deferred list.

### Files modified

1. `packages/infrastructure/src/git/git-cli.ts`
   - add `mergeTreeConflictProbe(repositoryPath, baseRef, headRef)`
     to `GitCli`
2. `packages/infrastructure/src/git/git-cli-task-worktree-lifecycle.ts`
   - implement the `TaskMergeConflictProbe` port using the new Git
     method
3. `packages/application/src/ports.ts`
   - export the new port + the `MergeConflictFile` type
4. `packages/infrastructure/src/task-merge-conflict-probe.integration.test.ts`
   - end-to-end probe against a real Git repo with deliberate
     conflict cases (clean branch, conflict on a tracked file,
     detached HEAD, missing base ref)
5. `packages/application/src/workspace-overview.ts`
   - extend `WorkspaceTaskOverview` with `mergeConflictStatus`:
     `{ kind: 'not-checked' } | { kind: 'clean' } | { kind: 'conflicts', count }`
6. `apps/desktop/src/ipc-contract.ts`
   - add `checkMergeConflicts: 'agentterm:task:check-merge-conflicts'`
     + `sendMergeConflictResolutionTaskPrompt:
     'agentterm:task:send-merge-conflict-resolution'` channels
   - validate payload keys exactly
   - new error codes `MERGE_CONFLICT_UNAVAILABLE`,
     `MERGE_CONFLICT_PROMPT_NOT_IDLE`
7. `apps/desktop/src/desktop-main-handlers.ts`
   - dispatch the two channels to the new Application use cases
8. `apps/desktop/src/desktop-bridge.ts`
   - expose `client.checkMergeConflicts` and
     `client.sendMergeConflictResolutionTaskPrompt`
9. `apps/desktop/src/desktop-application.ts`
   - wire the two seam methods into `createProductionDesktopApplication`
10. `apps/desktop/src/main.ts`
    - pass `checkMergeConflicts` + `sendMergeConflictResolutionTaskPrompt`
      through `registerDesktopIpcHandlers`
11. `apps/desktop/src/renderer/workspace-controller.ts`
    - add `MergeConflictInspection` discriminator to the snapshot
    - new `mergeConflictListeners` set + `observeMergeConflictInspection`
    - new `checkSelectedMergeConflicts` controller method
    - new `sendSelectedMergeConflictResolution` controller method
12. `apps/desktop/src/renderer/agent-workspace.tsx`
    - extend `WorkspaceTaskOverview`-derived props with
      `mergeConflictStatus`
    - surface a "Check conflicts" button when the Task is in
      `REVIEW`
    - surface a "Send resolution prompt" button when
      `mergeConflictStatus.kind === 'conflicts'` and the attached
      session is `IDLE`/`WAITING_INPUT`
13. `apps/desktop/src/renderer/terminal-keyboard-controller.ts`
    - widen `SLASH_COMMAND_REGEX` to include `merge-conflicts`
    - extend `SlashCommandDecision.kind`
14. `apps/desktop/src/renderer/workspace-command-palette.tsx`
    - register the two palette commands
15. `apps/desktop/src/renderer/workspace-command-palette.test.tsx`
    - cover the new commands and their disabled states
16. `apps/desktop/src/desktop-main-handlers.test.ts`
    - IPC validation tests for the two new channels
17. `apps/desktop/src/desktop-bridge.test.ts`
    - allowlist update
18. `apps/desktop/src/workspace-controller.test.ts`
    - extend the snapshot factory to include
      `mergeConflictStatus`
    - tests for `checkSelectedMergeConflicts` and
      `sendSelectedMergeConflictResolution`
19. `apps/desktop/src/agent-workspace.test.tsx`
    - assert the two buttons render in the right states
20. `apps/desktop/src/terminal-keyboard-controller.test.ts`
    - add `merge-conflicts` to the `detectSlashCommand` table
21. `docs/decisions/ADR-009-agtx-port-plan.md`
    - rewrite §M8 deferred note to `Accepted` reference
22. `docs/CURRENT_STATE.md`
    - remove the M8 deferred entry from the **Next Step** list
    - add an **M8** entry to **Recently Shipped**

### Files NOT modified

- All Domain rules. `TaskPhase`, `ExecutionArtifact`, quality gates,
  review state machine — untouched.
- The MCP read server (`packages/mcp-server`). ADR-009 §AD-5 still
  excludes write tools.
- The board view. M2.3 invariant holds: the board view is renderer
  for visualization, not for orchestrating the merge probe.
- Existing PTY input pipeline / M11 right-click wiring / M12
  mouse-mode badge.

## Architectural invariants preserved

- `Presentation -> Application -> Domain` direction unchanged.
- Infrastructure implements a port owned by Application; no Domain
  code reaches into Git.
- The probe is non-destructive; Worktree HEAD, staged changes,
  and persisted review evidence are read-only.
- Sanitization at every IPC boundary; the renderer never sees raw
  `git` output.
- No shell-string construction; only argv-based `git merge-tree`
  via the existing `GitCli.run` wrapper.
- Tracker events are immutable Session appends; no in-place
  mutation of session state.

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| False positive — probe reports conflict when the agent already resolved it | The probe uses `git merge-tree` against the persisted base ref; runs again only on user request, never on a timer. Affordance to re-check is explicit. |
| Prompt sent to a session that is no longer idle | `sendMergeConflictResolutionTaskPrompt` rejects with `MERGE_CONFLICT_PROMPT_NOT_IDLE` if the attached session status is not `IDLE`/`WAITING_INPUT`. Renderer disables the button when status is `WORKING`/`STARTING`. |
| `git merge-tree --write-tree` behaviour differs across Git versions | The slice requires Git 2.38+ for `--write-tree`; AgentTerm already requires Git 2.45+ (ADR-005). `mergeTreeConflictProbe` falls back to `git merge-tree <base> <head> -- <paths>` (legacy form) when `--write-tree` is unavailable; the typed result is identical. |
| Cross-Task race — two windows probe simultaneously | The probe is read-only against a frozen `suggestedBaseBranch` and a frozen worktree HEAD. The renderer treats the latest accepted payload as the source of truth. |
| Renderer accidentally leaks raw path names into HTML | All conflict rows render escaped React children; `path` strings never pass through `dangerouslySetInnerHTML`. |
| Plugin author confusion — operator expects hook-based dispatch | The plan does not introduce hooks. ADR-019 explicitly notes the design choice so future contributors can see why. |

## Validation

- `npx tsc -b` (full monorepo typecheck).
- `npx vitest run packages` (domain/application/infrastructure tests,
  including the new `integration.test.ts` against real Git).
- `npx vitest run apps/desktop` (renderer + IPC tests).
- One end-to-end smoke: open a Task in `REVIEW`, click "Check
  conflicts", observe conflict list, click "Send resolution prompt",
  confirm the active PTY receives `/agtx:merge-conflicts<Enter>`.
- Manual: verify the existing M7.5 slash-command detector still
  recognises `brainstorm`/`sweep` (no regression in `terminal-keyboard-controller.test.ts`).

## Out of scope

- Any change to ADR-009 §MCP write tools (`create_task`,
  `move_task`, `send_to_task`); they remain deferred.
- Auto-merging the resolved branch back to base — explicit Review
  approval flow is still the only path from `REVIEW -> DONE`.
- Auto-resolution looping — the orchestrator never retries on its
  own; the user re-invokes the probe.
- A `git fetch` step — AgentTerm already uses offline base-branch
  determination (ADR-005 AD-2). The probe assumes the local
  representation is authoritative.
- Adding a new plugin hook field. ADR-010 AD-2 remains.

## Acceptance criteria

1. A user on a `REVIEW` Task can request a merge-conflict check
   from the palette or inspector and see a sanitized conflict list
   (or `clean`) in under one second for typical repos.
2. When conflicts are present, the user can send `/agtx:merge-conflicts`
   to the active PTY with one click; the agent receives it as
   ordinary keystrokes.
3. `git merge-tree` runs only against the persisted
   `suggestedBaseBranch`; out-of-base runs are rejected.
4. No Domain / Application use case change other than the new
   `checkTaskMergeConflicts` + `sendMergeConflictResolutionTaskPrompt`.
5. ADR-009 §"Deferred" no longer lists M8; ADR-019 records the
   Accepted decision and links the implementation PR.

## Sources

- ADR-009 §"M8 — Auto merge-conflict resolution with `git merge-tree`".
- ADR-009 §AD-6 (rationale for deferral).
- ADR-005 §"Base selection is offline and deterministic".
- ADR-010 AD-2 (plugin hook exclusion).
- ADR-018 AD-1 (slash-command trigger pattern).
- `packages/infrastructure/src/git/git-cli.ts` (existing argv-based Git
  wrapper).
- `apps/desktop/src/renderer/terminal-keyboard-controller.ts`
  (`detectSlashCommand`).
- `packages/application/src/agent-session-coordinator.ts` (existing
  PTY input + Session event surface).
