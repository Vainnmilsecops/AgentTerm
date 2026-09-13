# M2.3 — Finish Kanban board view closure

ADR-009 (board view scope) / docs/plans/m2-3-finish-board-view.md

Closes three long-standing gaps from the original Kanban board scope
without violating the renderer-only invariant for the standalone board
window.

## Renderer projection

- New pure helpers `summarizeArtifacts` and
  `summarizeArtifactsForPlugin` in `board-view.tsx` walk the Task's
  `ExecutionArtifact[]` once and emit indicator flags for the four
  stable phase kinds (`research`, `plan`, `execution-summary`,
  `review`) plus running counts for the two dynamic kinds
  (`brainstorm`, `sweep`).
- Plugin-bound gating: when a workflow plugin declares a known phase
  artifact set (`phaseArtifactKinds` from the workspace projection),
  indicators outside that set are suppressed so a board view loaded
  with a different plugin does not misrepresent the audit trail.
- Each board card now renders an indicator strip via a new `ul`
  element with `data-board-artifacts` and per-item
  `data-board-artifact-kind` attributes. The plan's
  `latestPlan === undefined` case is still rendered (the plan status
  text remains), and the new `plan` indicator is added in addition.

## Ctrl+f focuses the live terminal in the main workspace

- New IPC channel `agentterm:window:open-main-for-task` carries
  `{ focusTerminal, selectTask, taskId }` from the board renderer to
  the main process. The handler lives in `main.ts` because main owns
  the `BrowserWindow` lifecycle; the desktop-application seam simply
  forwards.
- New main → renderer channel `agentterm:workspace:focus-task` carries
  the validated `WorkspaceFocusTaskEvent` payload. The
  `desktop-bridge` exposes `observeWorkspaceFocusTask(listener)` which
  drops malformed payloads silently — the renderer state remains
  authoritative.
- `BoardEntry` now calls `client.openMainWindowForTask({ focusTerminal:
  true, selectTask: true, taskId })` when the focused cell resolves
  to `requires-main-window`. The notice copy is unchanged but the
  user is no longer left without a working terminal surface.

## List / Board view toggle

- `WorkspaceController` gains `viewMode: WorkspaceViewMode`
  (`'list' | 'board'`), `getViewMode`, `setViewMode`, and
  `observeViewMode`. `setViewMode` is a no-op when the mode is
  unchanged and notifies observers only on real transitions. The
  controller publishes the new mode on the next ready snapshot.
- `WorkspaceTopbar` grows a `List view / Board view` toggle button
  (`aria-pressed`, `data-view-mode-toggle`) next to the existing
  navigator toggle. Icons are new `kanban` and `list` entries in
  `workspace-icons.tsx`. The toggle is purely a topbar affordance —
  it does not collapse the standalone board window. Board users still
  open the dedicated window via the command palette to keep the focus
  model intact.
- `AgentWorkspace` smart wrapper wires the toggle through a single
  `onToggleViewMode` callback so `AgentWorkspaceView` (the testable
  dumb wrapper) never imports the controller.

## Tests

- 4 new `summarizeArtifacts` tests + 2 new
  `summarizeArtifactsForPlugin` tests in `board-view.test.ts`.
- 1 new viewMode-observation test in `workspace-controller.test.ts`
  (covers no-op transitions + listener unsubscribe).
- 2 new desktop-main-handlers tests for the `openMainWindowForTask`
  IPC routing (success path + invalid payload).
- `desktop-bridge.test.ts` allowlist updated for the two new methods.
- 514 desktop tests pass in total; 2 pre-existing integration
  failures remain (ConPTY parent disconnects + Git stat cache
  timeout) and are unrelated to this PR.

## Docs

- `docs/CURRENT_STATE.md` lists M2.3 under "Recently shipped" and
  bumps the `Updated` date to 2026-09-13.
- The existing `docs/plans/m2-3-finish-board-view.md` plan remains
  the canonical design record.
