# M2.5 — Workflow plugin uninstall UX (ADR-010)

## Goal

Close the asymmetry left open by M2: when an operator installs a Workflow
Plugin binding through the Settings panel, the same panel must let them
remove that binding without bypassing the main-process trust boundary or
losing the compare-and-set revision discipline.

M2.5 ships:

1. A new Application use case `removeWorkflowPluginBindingForTask` that
   atomically removes a binding using `expectedRevision` for
   compare-and-set, returns the removed binding record for the renderer,
   and rejects the call when the binding has already changed in another
   window.
2. A dedicated IPC channel `removeWorkflowPluginBindingForTask`
   (`agentterm:workflow-plugin:remove`) routed through the same
   `WorkflowPluginInstaller` seam that M2 already uses for install.
3. A `removeBinding` button in the `WorkflowPluginConfigurator` panel,
   gated by the same `selectedTaskId` policy as install, with a small
   confirmation step that exposes the plugin id + source path so the
   user cannot accidentally remove the wrong binding.
4. Targeted tests for the use case, the IPC dispatch, and the panel
   (confirmation copy, success feedback, error surfacing, multi-binding
   isolation).
5. Doc refresh: `CURRENT_STATE.md` and ADR-010 record the M2.5 milestone
   and the panel's symmetric install/remove surface.

## Scope

- Domain: no change. The existing `WorkflowPluginBindingRecord` shape
  covers everything remove needs.
- Application: add `removeWorkflowPluginBindingForTask` use case next to
  `installWorkflowPluginForTask`; add a `WorkflowPluginBindingNotFoundError`
  for the "no binding to remove" path so the renderer can surface a
  precise reason; reuse the existing `WorkflowPluginConflictError` for
  the compare-and-set mismatch.
- Infrastructure: no schema change. Reuse
  `SqliteWorkflowPluginBindingRepository.removeByTaskId` (already
  returns a boolean) plus an explicit pre-read for the compare-and-set
  guard. No new migration.
- Presentation: extend `WorkflowPluginConfigurator` with a Remove button
  per binding and a small inline confirmation step (no global modal —
  the panel already owns the install affordance and the existing
  `<details>` element pattern keeps the UX consistent).
- IPC: add `agentterm:workflow-plugin:remove` channel; expand the
  `WorkflowPluginInstaller` seam with `removeWorkflowPluginBindingForTask`
  and let the production wiring route both calls into
  `application.installWorkflowPluginForTask` /
  `application.removeWorkflowPluginBindingForTask`.

## Decisions

### D1. Compare-and-set remove, not unconditional delete

`removeWorkflowPluginBindingForTask` must take an `expectedRevision` so
two windows cannot silently race the same binding into inconsistent
states. The renderer reads the binding revision from the local mirror
(per the install flow) and passes it back; the main process re-reads the
binding through the repository and rejects the call when the stored
revision no longer matches. This mirrors `installWorkflowPluginForTask`'s
discipline and keeps ADR-010 AD-2 ("plugins are loaded, not run")
intact: remove is a binding-repository mutation, never a side-effect on
the plugin file itself.

### D2. Separate `RemoveWorkflowPluginBindingInput` / `Response` shapes

Install and remove have different failure modes (conflict vs not-found
vs no prior binding), so the typed IPC payload must not be a
boolean-overload. Add:

```ts
export interface RemoveWorkflowPluginBindingRequest {
  readonly expectedRevision: number;
  readonly taskId: string;
}

export interface RemoveWorkflowPluginBindingResponse {
  readonly pluginId: string;
  readonly removedAt: number;
  readonly revision: number;
  readonly sourcePath: string;
}
```

`removedAt` is the wall-clock timestamp the main process recorded
during the remove transaction; the renderer uses it to surface a
human-readable confirmation message ("Removed `agtx` for `task-1` at
14:32.").

### D3. Inline confirmation, not a global modal

A Remove button on every installed binding is enough surface for a
foundation milestone. The panel already owns the install affordance,
and the existing `<details>` element pattern keeps confirmations
scoped to the binding being removed. The confirmation reveals the
plugin id, source path, and active phase so the user can spot the
wrong target before clicking the final "Confirm remove" button.

When the user changes their mind, clicking outside the confirmation or
hitting `Esc` reverts the row to the read-only state without sending a
request to the main process.

### D4. Renderer mirrors the binding list, main process is the source of truth

The local `workflowPluginBindings` state in `AgentWorkspace` already
mirrors what the user installed in the current session. The Remove
button reads the same state to capture the current `revision` and
optimistically removes the row from the local mirror; the main process
is still the only writer that touches the binding repository. If the
main process rejects the request (e.g. `CONFLICT`), the renderer
restores the row so the local mirror and the persisted binding stay
consistent.

### D5. No new ports, no new use case, just remove

Remove is binding-repository-only. The configurator (`WorkflowPluginConfigurator`)
and the `WorkflowPluginBindingRepository` ports are unchanged; the
existing `findByTaskId` + `removeByTaskId` pair is sufficient when the
use case owns the compare-and-set discipline.

## Milestone breakdown

### M2.5.1 — Application use case

- Add `removeWorkflowPluginBindingForTask` to
  `packages/application/src/workflow-plugin-loader.ts`:
  - Inputs: `{ taskId, expectedRevision }`.
  - Behaviour: re-read the binding, reject `NOT_FOUND` when no binding
    exists, reject `CONFLICT` when the stored revision does not match
    `expectedRevision`, otherwise call
    `bindingRepository.removeByTaskId(taskId)` and return the
    `{ pluginId, sourcePath, revision, removedAt }` summary.
- Add a typed `RemoveWorkflowPluginBindingFailure = 'CONFLICT' | 'NOT_FOUND'`
  and a `RemoveWorkflowPluginBindingError` class that mirrors the
  install error shape.
- Extend `installMessage` (or add a parallel `removeMessage`) to surface
  the new reasons to the renderer.
- Export the new use case through `packages/application/src/index.ts`.
- Unit tests in `workflow-plugin-use-cases.test.ts` (or a sibling file)
  covering: happy path, conflict (wrong revision), not-found, repository
  error propagation.

### M2.5.2 — Desktop composition + main-process seam

- Extend the `WorkflowPluginInstaller` interface in
  `apps/desktop/src/desktop-main-handlers.ts` with
  `removeWorkflowPluginBindingForTask`.
- Add a production implementation in
  `apps/desktop/src/desktop-application.ts` that calls the new
  Application use case (mirror of the existing
  `installWorkflowPluginForTask` wiring) and returns the typed
  response.
- Update the desktop-bridge stubs (`desktop-bridge.ts`) to expose the
  new capability.
- Update the IPC contract: add the `removeWorkflowPluginBindingForTask`
  channel, request/response types, validators, and `AgentTermDesktopApi`
  method.
- Update `FakeWorkspaceClient` in
  `apps/desktop/src/renderer/workspace-controller.test.ts` with a
  working stub.

### M2.5.3 — IPC main handler + tests

- Add a new case in
  `apps/desktop/src/desktop-main-handlers.ts` that dispatches
  `desktopIpcChannels.removeWorkflowPluginBindingForTask` to the
  installer seam.
- Add `selectWorkflowPluginFile` / `workflowPluginInstaller` fixtures to
  every `registerDesktopIpcHandlers` call in
  `desktop-main-handlers.test.ts` (only the new tests need them; the
  install fixtures are already in place from M2).
- Add 4 new test cases:
  - happy path returns the typed response
  - `CONFLICT` is mapped to `DesktopIpcError` with the right code
  - `NOT_FOUND` is mapped to a distinct code
  - `INVALID_REQUEST` when the renderer passes a non-integer revision

### M2.5.4 — Renderer panel: confirmation + button

- Extend `WorkflowPluginConfigurator` (`apps/desktop/src/renderer/workflow-plugin-configurator.tsx`)
  with:
  - A `Remove` button on every installed binding.
  - A two-step inline confirmation that reveals plugin id, source path,
    and active phase, with a `Confirm remove` button and a
    cancel-via-`Esc` affordance.
  - A local `removing` state (per row) so a slow main process does not
    double-submit.
  - A `removeBinding(input: { taskId, expectedRevision })` callback
    prop; the panel calls it after the user confirms.
- Add the corresponding data-testid attributes for the new buttons
  (`data-workflow-plugin-remove`, `data-workflow-plugin-confirm-remove`)
  so the test harness can drive them deterministically.
- Add `onRemoveBinding` to `AgentWorkspaceViewProps`, plumbed from
  `AgentWorkspace` exactly like the install callback (with a guarded
  `controller?.removeWorkflowPluginBindingForTask` indirection and the
  same `exactOptionalPropertyTypes` spread trick).
- Update `workspace-controller.ts` with a thin
  `removeWorkflowPluginBindingForTask` method that calls the IPC
  client.
- Add `onRemoveBinding` and the test-only `TestWorkspaceViewProps`
  override in `workspace-controller.test.ts`.

### M2.5.5 — Tests for the panel

- Extend `workflow-plugin-configurator.test.tsx` with:
  - renders the Remove button per installed binding
  - confirmation reveals plugin id + source path
  - the cancel path returns the row to the read-only state without
    calling `onRemoveBinding`
  - the confirm path calls `onRemoveBinding` with `{ taskId, expectedRevision }`
  - `onRemoveBinding` rejection surfaces the error message under the row
- Add one controller test asserting that the local `workflowPluginBindings`
  state is restored when the IPC call rejects (consistency recovery).

### M2.5.6 — Doc refresh + ADR update

- Append a "M2.5 — Workflow plugin uninstall UX" entry to
  `docs/CURRENT_STATE.md` "Recently Shipped" with the same level of
  detail as the M2 entry.
- Update `docs/decisions/ADR-010-workflow-plugin-contract.md` to mark
  the IPC seam as covering "install + remove" and add a short
  "Consequences — M2.5" paragraph that notes the compare-and-set
  remove discipline and the panel's symmetric install/remove surface.
- Refresh the "Next Step" section in `CURRENT_STATE.md` to remove the
  "Workflow plugin Settings + IPC" wording now that the milestone is
  complete (the workspace install/remove UX is fully shipped).

## Files touched

- `packages/application/src/workflow-plugin-loader.ts` (new use case,
  error class, message helper)
- `packages/application/src/index.ts` (export new symbols)
- `packages/application/src/workflow-plugin-loader.test.ts` (new unit
  tests, or extend `workflow-plugin-use-cases.test.ts` if the
  existing file owns the install tests)
- `apps/desktop/src/ipc-contract.ts` (new channel, request/response
  types, validator, `AgentTermDesktopApi` method, `DesktopIpcRequestMap`
  / `ResponseMap` entries)
- `apps/desktop/src/desktop-bridge.ts` (capability stub)
- `apps/desktop/src/desktop-bridge.test.ts` (allowlist assertion)
- `apps/desktop/src/desktop-application.ts` (production
  `removeWorkflowPluginBindingForTask`)
- `apps/desktop/src/desktop-main-handlers.ts` (installer seam +
  dispatch case)
- `apps/desktop/src/desktop-main-handlers.test.ts` (4 new cases +
  fixtures)
- `apps/desktop/src/renderer/workflow-plugin-configurator.tsx` (Remove
  button, inline confirmation, busy state)
- `apps/desktop/src/renderer/workflow-plugin-configurator.test.tsx`
  (panel cases)
- `apps/desktop/src/renderer/workspace-controller.ts` (controller
  method)
- `apps/desktop/src/renderer/workspace-controller.test.ts`
  (`TestWorkspaceViewProps` allowance + consistency-recovery test)
- `apps/desktop/src/renderer/agent-workspace.tsx` (callback wiring)
- `docs/CURRENT_STATE.md` (Recently Shipped + Next Step refresh)
- `docs/decisions/ADR-010-workflow-plugin-contract.md` (M2.5
  consequences paragraph + IPC seam description)

## Tests

- Domain: 0 new (no Domain change).
- Application: 4 unit tests in
  `workflow-plugin-loader.test.ts` (happy, conflict, not-found,
  repository error).
- IPC contract: covered by the existing `validateDesktopIpcRequest`
  tests; no new dedicated contract tests required.
- Desktop main handler: 4 dispatch cases (happy, conflict, not-found,
  invalid request).
- Renderer panel: 5 new cases (render, confirmation copy, cancel path,
  confirm path, error surfacing).
- Controller: 1 new case for local-state restoration on rejection.
- Workspace controller test harness: 1 new case for the
  consistency-recovery path.

## Validation

- `pnpm --filter @agentterm/desktop typecheck` clean.
- `npx vitest run apps/desktop` clean (all 500+ desktop tests pass).
- `npx vitest run packages/application` clean (all application tests
  pass, including the new remove use case tests).
- Manual smoke: install a binding, observe it appears with a Remove
  button; click Remove, see the confirmation, confirm, observe the row
  disappears; restart the desktop, observe the binding is gone from
  the persisted `workflow_plugin_bindings` table.

## Risks

1. **Compare-and-set race between two windows.** A user with two
   windows could click Remove in window A after window B has already
   removed the binding. Mitigation: the use case rejects with
   `CONFLICT` when the stored revision no longer matches; the renderer
   restores the row to its local mirror so the user sees the truth.
2. **Removing a binding while a Task is in an active phase.** The
   binding is metadata, not a runtime artifact, so removing it does
   not destroy the active Agent Session. The renderer surfaces a
   plain "Removed" message; a follow-up "select another agent for
   this task" affordance is explicitly out of scope for M2.5.
3. **Confirmation copy leaking plugin file path.** The path is already
   shown in the install list, so showing it again in the confirmation
   is consistent with the existing Settings panel; it is also the
   only safe way for the user to confirm they are removing the right
   binding.

## Out of scope

- Per-phase plugin uninstall (e.g. removing a single phase from a
  multi-phase plugin) — the binding is a single record.
- "Reset to built-in `void`" or any auto-fallback after remove — the
  renderer will not synthesise a replacement binding; the next Task
  attempt will fall through to the existing per-phase agent selection
  policy in `resolveAgentForTask`.
- Plugin uninstall from the command palette — the Settings panel is
  the only entry point, matching the install UX.
- Removing bindings for completed Tasks. The use case accepts any
  `taskId`; the renderer may want to grey out Remove when the Task is
  `DONE`, but that is presentation-only and can land as a follow-up if
  product feedback asks for it.
