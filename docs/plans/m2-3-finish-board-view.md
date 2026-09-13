# M2.3 — Finish Kanban board view closure

Status: Draft
Date: 2026-09-13
Owner: AgentTerm desktop renderer
Parent: ADR-009 (M2 — Kanban board view)

## Context

The Kanban board (`apps/desktop/src/renderer/board-view.tsx`,
`board-entry.tsx`, `board-main.tsx`, `board-keyboard.ts`,
`board-terminal-shortcut.ts`) shipped its core surface in two PRs:

- PR (commit `5180bb6`): wired the board window + command-palette entry
  + IPC `openBoardWindow` + `WorkspaceTaskOverview.workflowPlugin`
  projection so each card can render plugin name + per-phase agent.
- PR (commit `595eedc`): added the pure keyboard reducer + key
  resolver + URL-hash persistence + `Ctrl+f` shortcut with a
  `requires-main-window` notice (deferred).

The original ADR-009 M2 scope is now ~85 % complete. Three small gaps
remain before the milestone can be marked "Done":

1. **Latest artifact indicator** — the ADR-009 spec calls for
   "latest artifact indicator" alongside the plan indicator. The board
   card today only shows `latestPlan === undefined ? "no plan yet" :
   "plan ready"`. RESEARCH / EXECUTION_SUMMARY / REVIEW indicators are
   missing.

2. **`Ctrl+f` focuses the live terminal** — ADR-009 specifies that
   `Ctrl+f` "focuses the live terminal" for the focused Task. Today the
   shortcut returns `requires-main-window` and shows a 4-second notice.
   The board window cannot own the PTY directly (it is a separate
   `BrowserWindow`); the realistic UX is to surface the focused Task's
   terminal in the *main* workspace window and ask the user to switch.

3. **List view vs board view naming** — ADR-009 says "the existing
   `/workspace` route becomes 'List view' and stays the default". The
   command palette already names the board route; the list-view rename
   has not propagated to the workspace header.

This plan closes those three gaps in one PR. No Domain, no Application,
no Infrastructure change. Renderer + desktop shell only.

## Goal

1. Each board card renders indicators for every artifact kind declared
   by the bound workflow plugin (research, plan, execution-summary,
   review) plus dynamic brainstorm/sweep counts. The renderer never
   re-parses the plugin file — it consumes the existing
   `WorkflowPluginProjection.phaseArtifactKinds` array.
2. `Ctrl+f` on a focused board card focuses the existing terminal pane
   in the main workspace window for that Task. When the user is not in
   the board window, the shortcut switches focus to the main window
   and selects the Task. The 4-second "requires-main-window" notice is
   replaced with an actionable shortcut.
3. The workspace header surfaces the "List view / Board view" toggle so
   the user can reach either route in one keyboard stroke.

## Non-goals

- Drag-and-drop between columns (out of scope per ADR-009).
- Renaming columns or hiding them (out of scope).
- Cross-window IPC for terminal focus. The main workspace window
  already owns the terminal pane; the board window simply asks the
  shell to bring it to the front.
- Auto-advance / orchestrator behavior (M6, deferred in ADR-009).

## Architectural decisions

### AD-1: Latest artifact indicator is a pure renderer projection

The renderer derives `latestArtifactKinds: readonly ExecutionArtifactKind[]`
inside `board-view.tsx` by walking `task.artifacts`. The projection is
*pure*: given the same `WorkspaceTaskOverview`, it returns the same list.
We keep the derivation local (no helper file) because it consumes only
fields the projection already exposes (`artifacts`, `latestPlan`,
`workflowPlugin.phaseArtifactKinds`).

### AD-2: `Ctrl+f` uses the desktop shell's window-focus API

The board window calls a new `openMainWindowForTask(taskId)` IPC
channel. The main process:

1. Finds or creates the main workspace `BrowserWindow`.
2. Calls `webContents.send('agentterm:focusTaskTerminal', taskId)` so
   the renderer can focus the terminal pane that already owns the
   focused Task's session.
3. `mainWindow.focus()` to bring it to the front.

The board window never talks to Domain, never invokes `startTask*`,
and never re-attaches the terminal — it only requests that the
existing terminal pane be focused in the existing main window.

### AD-3: List/Board view toggle is a header affordance, not a route

`agent-workspace.tsx` already mounts the workspace header. We add a
segmented control bound to the workspace-controller state. The
controller grows `viewMode: 'list' | 'board'` (default `'list'` to
match ADR-009's "stays the default" note). The command palette keeps
its existing entries; we add no new keyboard shortcut to avoid
collisions with M12's `Alt+B`.

## Scope

### Files modified

1. `apps/desktop/src/renderer/board-view.tsx`
   - Add a pure helper `summarizeArtifacts(artifacts, pluginProjection)`
     that returns `{ research: boolean; plan: boolean;
     executionSummary: boolean; review: boolean; brainstormCount: number;
     sweepCount: number }`.
   - Render a `<ul class="board-view__artifacts">` with one `<li>` per
     declared phase artifact kind whose value is `true`, plus
     brainstorm/sweep counts in parentheses.
   - Each `<li>` carries `data-board-artifact-kind="<kind>"` so the
     snapshot/contract tests can assert it.
2. `apps/desktop/src/renderer/board-entry.tsx`
   - Replace the `Ctrl+f` notice with `handleOpenTerminalInMainWindow`:
     call `client.openMainWindowForTask(taskId)` and `await` the IPC
     response. On error, surface a status banner.
   - Remove the now-unused `terminalNotice` state.
3. `apps/desktop/src/renderer/board-terminal-shortcut.ts`
   - Keep the pure helper (still useful for tests); add a new exported
     `decideMainWindowFocusAction` that returns the discriminated
     `{ kind: 'focus'; taskId } | { kind: 'none' }` the entry uses to
     decide whether to call the IPC.
4. `apps/desktop/src/ipc-contract.ts`
   - Add `openMainWindowForTask: 'agentterm:focus-main-window-task'`.
   - Add `OpenMainWindowForTaskRequest { taskId }` and
     `OpenMainWindowForTaskResponse { focused: boolean }` types.
   - Extend `AgentTermDesktopApi.openMainWindowForTask(input)`.
5. `apps/desktop/src/desktop-bridge.ts`
   - Expose `openMainWindowForTask` over the existing `invoke` helper.
6. `apps/desktop/src/desktop-bridge.test.ts`
   - Add `'openMainWindowForTask'` to the allowlist assertion in the
     expected sorted-keys array.
7. `apps/desktop/src/desktop-main-handlers.ts`
   - Add the dispatch case under `desktopIpcChannels.openMainWindowForTask`.
   - Wire it through the `DesktopIpcMainEvent.input.openMainWindow`
     seam (a new optional field in the input; defaults to
     "create-if-missing" so the board window can request a focus on a
     freshly-launched main window).
8. `apps/desktop/src/desktop-application.ts`
   - Add `openMainWindowForTask(taskId)` to
     `ProductionDesktopApplication`. The desktop shell already owns the
     main-window lifecycle; the method closes over `openMainWindow`
     (already exported from `desktop-window.ts`) and the IPC sender
     helper to dispatch `focusTaskTerminal`.
9. `apps/desktop/src/main.ts`
   - Register the new IPC channel.
   - Forward `agentterm:focusTaskTerminal` events to the main window's
     `webContents` so the renderer can focus the terminal pane.
10. `apps/desktop/src/renderer/agent-workspace.tsx`
    - Add a `viewMode` prop to `AgentWorkspaceViewProps`. The smart
      wrapper (`AgentWorkspace`) reads `controller.viewMode` and
      toggles the segmented control between "List" and "Board".
11. `apps/desktop/src/renderer/workspace-controller.ts`
    - Add `viewMode: 'list' | 'board'` to `WorkspaceControllerState`
      (default `'list'`).
    - Add `setViewMode(mode)` that updates state and persists the
      preference in the existing `writePersistedLayout` helper.
12. `apps/desktop/src/renderer/workspace-layout-persistence.ts`
    - Extend the persisted layout type to include `viewMode`.
13. `apps/desktop/src/renderer/workspace-settings.tsx` (or a new
    `workspace-view-toggle.tsx` if the existing component is full)
    - Add a segmented control bound to `controller.setViewMode`. Place
      it next to the existing sidebar toggle in the workspace header.

### Files added

1. `apps/desktop/src/renderer/board-view-artifacts.test.ts`
   - Table-driven tests for `summarizeArtifacts`:
     - empty artifacts → all `false`, counts `0`
     - one of each kind → all `true`, counts `1`
     - plugin with no research phase → research indicator hidden
     - brainstorm/sweep counts accumulate

2. `apps/desktop/src/renderer/board-view.test.ts` (modify)
   - Add a test that asserts `data-board-artifact-kind="research"`
     appears when the projection says the plugin has a research phase
     and the Task has a research artifact.
   - Add a test that asserts `data-board-artifact-kind="execution-summary"`
     appears for a Task with an execution summary.
   - Add a test that asserts no artifact indicator renders for a Task
     with no plugin binding.

3. `apps/desktop/src/desktop-main-handlers.test.ts` (modify)
   - Add a test that routes `openMainWindowForTask` to the new
     `desktopApplication.openMainWindowForTask` seam.
   - Add a test that rejects `openMainWindowForTask` when `taskId` is
     blank (`INVALID_REQUEST`).

4. `apps/desktop/src/workspace-controller.test.ts` (modify)
   - Add a test that `setViewMode('board')` updates state and persists.
   - Add a test that `setViewMode('list')` restores the default.

### Files not modified

- `packages/domain/` — no Domain change.
- `packages/application/` — no Application change.
- `packages/infrastructure/` — no Infrastructure change.
- `packages/mcp-server/` — no MCP server change.
- `apps/desktop/src/renderer/board-keyboard.ts` — pure reducer unchanged.
- `apps/desktop/src/renderer/board-keyboard.test.ts` — unchanged.

## Tests

### Domain tests

None. No Domain change.

### Application tests

None. No Application change.

### Renderer tests

- `board-view-artifacts.test.ts`: 6 cases covering `summarizeArtifacts`
  happy path, empty input, missing kinds, and brainstorm/sweep counts.
- `board-view.test.ts`: 3 new cases for the artifact indicators (one
  per kind, plus a negative case).
- `desktop-main-handlers.test.ts`: 2 new cases for the new IPC route.
- `desktop-bridge.test.ts`: allowlist assertion grows by one entry.
- `workspace-controller.test.ts`: 2 new cases for `setViewMode`.

### Integration tests

None. The new IPC route is a thin shell seam; the existing
`workspace-controller.test.ts` covers the controller side, and the
existing desktop-bridge test covers the preload allowlist.

## Validation

- `pnpm --filter '@agentterm/desktop' typecheck`
- `npx vitest run apps/desktop` (506 tests currently pass; this PR
  should land at ~520 passing)
- `pnpm --filter '@agentterm/desktop' build` (Vite emits both
  `index.html` and `board.html`)
- Manual: open the board window, focus a Task, press `Ctrl+f`,
  verify the main workspace window comes to the front with that
  Task's terminal pane focused. Toggle the List/Board segmented
  control in the workspace header.

## Risks and mitigations

1. **Cross-window focus race.** The board window's `Ctrl+f` handler
   may fire before the main window is ready (fresh boot). Mitigation:
   the new IPC route accepts an optional `createIfMissing: true`
   flag (default `true`); the desktop shell ensures the main window
   is created and shown before dispatching `focusTaskTerminal`. If
   the main window's `webContents` is still loading, the IPC sender
   queues the message and the renderer flushes it on
   `did-finish-load`.
2. **Indicator drift.** Adding per-phase indicators depends on
   `WorkflowPluginProjection.phaseArtifactKinds`. If a future milestone
   adds a new `ExecutionArtifactKind`, the helper needs to know about
   it. Mitigation: the helper reads `phaseArtifactKinds` directly, so
   any new kind declared in Domain automatically appears once the
   application projection propagates it.
3. **Layout persistence churn.** Adding `viewMode` to the persisted
   layout will fail closed for users whose previous layout JSON lacks
   the new field. Mitigation: the `readPersistedLayout` helper
   already returns `undefined` for unknown shapes; we default
   `viewMode` to `'list'` on missing or malformed input.

## Out of scope (deferred)

- Drag-and-drop between columns (ADR-009 explicitly defers).
- Board columns rename / hide (ADR-009 deferred).
- Auto-refresh on Task phase changes — the existing `loadWorkspace`
  polling already covers this; we do not add a new refresh channel.
- Board keyboard shortcut to *transition* a Task's phase (e.g. `p` →
  PLANNING). That's M2.5 or M5 follow-up territory and warrants its
  own plan.
