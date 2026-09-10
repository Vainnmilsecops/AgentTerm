# M3.1 — Workflow plugin switching UX (Recommended)

Builds on ADR-010 M1/M2/M2.5 and the deferred "workflow session
switcher" note in `apps/desktop/src/desktop-application.ts`. After
this slice the user can change which Workflow Plugin is bound to a
Task, and the active phase for a bound Task, directly from the
Settings panel without reinstalling the whole binding. The two
operations stay inside the same compare-and-set discipline M2/M2.5
already enforce.

## Why now

- `WorkflowPluginBindingRecord.activePhaseId` is already part of the
  persistence schema (migration 15) and a typed field of the
  read-model `WorkflowPluginProjection`.
- `pickActivePhaseId` in `apps/desktop/src/desktop-application.ts`
  (lines 724–735) is explicitly a stub that pre-fills the workflow
  session switcher with the first phase. The renderer side that
  *reads* this value already exists in the board/workspace view
  through `WorkflowPluginProjection.activePhaseId`, but the
  renderer has no control to *write* it.
- M2 (install) and M2.5 (uninstall) shipped the binding lifecycle
  without exposing the per-phase UI. Users currently have no way to
  recover when the wrong plugin or wrong active phase was selected
  without uninstalling + reinstalling the file.
- This slice is small, scoped, and preserves the architectural
  boundaries. No new Domain rules, no new ports, no new migrations.

## Goals

- Replace a binding (switch the plugin file for a Task) without
  removing + reinstalling, preserving `expectedRevision`.
- Move the active phase on a bound Task forward/backward through the
  plugin's declared phase list.
- Surface the active phase and the projected per-phase agent in the
  existing Settings panel so the user sees why their next attempt
  will use a different agent.
- Keep every mutation compare-and-set, single-writer
  (`bindingRepository`), and owned by an Application use case.

## Scope

### Application (`@agentterm/application`)

1. `updateWorkflowPluginBindingForTask({ taskId, expectedRevision,
   nextPluginPath })`
   - Re-runs the configurator on `nextPluginPath`; same failure
     reasons as `installWorkflowPluginForTask` (`PATH_NOT_TRUSTED`,
     `PATH_UNREADABLE`, `INVALID_FORMAT`, `UNKNOWN_PLUGIN`).
   - Refuses when the new plugin's phase list does not include the
     currently bound `activePhaseId` unless the caller passes an
     explicit `nextActivePhaseId`.
   - Reuses `bindingRepository.upsert` with `expectedRevision`.
   - Error shape: `WorkflowPluginConflictError` (revision mismatch)
     plus a typed `WorkflowPluginUpdateError` for
     `INVALID_PHASE_FOR_PLUGIN` / `UNKNOWN_PLUGIN`.

2. `advanceActivePhaseForTask({ taskId, expectedRevision, direction:
   'next' | 'previous' | 'set', phaseId? })`
   - Re-reads binding + plugin, validates the target phase id is in
     the plugin's phase list.
   - Refuses to advance to a phase whose artifact kind has already
     produced an `ExecutionArtifact` for the Task — we don't burn
     history by silently skipping a phase (the user can explicitly
     override by passing `force: true`).
   - Persists via `bindingRepository.upsert` with bumped revision.
   - Returns the new `{ bindingRevision, activePhaseId, phaseAgentId,
     pluginId }`.

3. `bindPhaseAgent` (already in M1) is reused to project the new
   per-phase agent for the renderer.

### Infrastructure (`@agentterm/infrastructure`)

- No new migrations. The existing
  `SqliteWorkflowPluginBindingRepository.upsert` already supports
  replacing the plugin path + active phase atomically; we just call
  it.
- New typed result `WorkflowPluginSwitcherProjection` exposing
  `{ bindingRevision, activePhaseId, pluginId, sourcePath,
  availablePhaseIds }` so the renderer can render the phase selector
  without re-parsing the plugin file.

### Desktop composition (`apps/desktop/src/desktop-application.ts`)

- `WorkflowPluginInstaller` seam grows two more methods:
  - `switchWorkflowPluginBindingForTask(input)` →
    `updateWorkflowPluginBindingForTask`
  - `advanceActivePhaseForTask(input)` →
    `advanceActivePhaseForTask`
- `pickActivePhaseId` stays as the install default; the new
  advance use case becomes the canonical way to change `activePhaseId`
  after install.
- `desktop-application.ts` exposes the typed
  `WorkflowPluginSwitcherProjection` through the existing
  `WorkflowPluginProjection` field that the workspace already pulls
  in `loadAgentWorkspace`.

### IPC contract (`apps/desktop/src/ipc-contract.ts`)

- New channels:
  - `agentterm:workflow-plugin:switch` →
    `SwitchWorkflowPluginBindingRequest` /
    `SwitchWorkflowPluginBindingResponse`
  - `agentterm:workflow-plugin:advance-phase` →
    `AdvanceActivePhaseRequest` /
    `AdvanceActivePhaseResponse`
- New typed error codes `INVALID_PHASE_FOR_PLUGIN` and
  `ARTIFACT_ALREADY_RECORDED` are added to `DesktopIpcErrorCode` and
  mapped from the new `WorkflowPluginUpdateError`.
- Pre-existing path validation (`readWorkflowPluginPath`,
  `readWorkflowPluginExpectedRevision`) is reused.

### Renderer (`apps/desktop/src/renderer`)

- `WorkflowPluginConfigurator` panel grows two new affordances per
  binding:
  - A `Switch to…` button that mirrors `Install from trusted file…`
    (native main-process dialog → `selectWorkflowPluginPath` →
    `switchWorkflowPluginBindingForTask` with revision guarding).
  - A `Phase` row showing
    `◀ {prev}  {activePhaseId}  {next} ▶` plus an "active agent"
    subtitle derived from `bindPhaseAgent`.
- The smart wrapper (`AgentWorkspace`) optimistically updates the
  mirrored `activePhaseId` / `bindingRevision` on success and
  surfaces inline feedback (`Switched to …`,
  `Phase advanced to …`, `Cannot skip: research artifact already
  recorded`).
- `WorkspaceController` gains matching `switchWorkflowPluginBindingForTask`
  and `advanceActivePhaseForTask` methods that forward to
  `desktopBridge`.

## Key decisions

- **D1** A single Application use case per operation (switch /
  advance) so the renderer never mutates bindings directly. The
  `WorkflowPluginInstaller` seam stays the single writer path.
- **D2** Compare-and-set on `expectedRevision` matches M2/M2.5. The
  renderer reads `WorkflowPluginSwitcherProjection` from the existing
  workspace read-model so it can render the phase list without
  re-parsing the plugin file.
- **D3** Phase advance refuses to skip a phase that already produced
  an artifact unless the caller passes `force: true`. This protects
  the agent-session evidence chain — silently skipping would lose
  the audit trail M5 already validates.
- **D4** Switching plugins reuses `WorkflowPluginConfigurator` so the
  trust-root check stays in the main process; the renderer never
  receives an arbitrary path from untrusted code (ADR-010 invariant).
- **D5** No new ports. `bindingRepository.upsert` already supports
  replacement; the seam extension stays inside the existing
  `WorkflowPluginInstaller` shape.

## Files touched

- `packages/application/src/workflow-plugin-loader.ts` —
  `updateWorkflowPluginBindingForTask`, `advanceActivePhaseForTask`,
  new error class + reasons.
- `packages/application/src/workflow-plugin-use-cases.ts` —
  `advanceActivePhaseForTask` body (re-uses `bindPhaseAgent` for the
  projection).
- `packages/application/src/index.ts` — export new use cases + types.
- `packages/application/src/workspace-overview.ts` — extend
  `WorkflowPluginProjection` with `availablePhaseIds` and
  `phaseArtifactKinds` so the renderer can render the phase selector
  without re-parsing.
- `apps/desktop/src/ipc-contract.ts` — two new channels, request /
  response shapes, validation cases, error codes.
- `apps/desktop/src/desktop-bridge.ts` — exposure.
- `apps/desktop/src/desktop-bridge.test.ts` — allowlist update.
- `apps/desktop/src/desktop-main-handlers.ts` — dispatch + error
  mapping.
- `apps/desktop/src/desktop-main-handlers.test.ts` — four new cases
  per channel (route, invalid, revision conflict, advance refuses
  artifact-already-recorded).
- `apps/desktop/src/desktop-application.ts` — `WorkflowPluginInstaller`
  grows two methods; `WorkflowPluginProjection` enriched.
- `apps/desktop/src/main.ts` — installer adapter methods.
- `apps/desktop/src/renderer/workflow-plugin-configurator.tsx` —
  per-binding Switch + Phase row.
- `apps/desktop/src/renderer/workflow-plugin-configurator.test.tsx`
  — switch / advance / disabled / error cases.
- `apps/desktop/src/renderer/workspace-controller.ts` — forwarding
  methods.
- `apps/desktop/src/renderer/workspace-controller.test.ts` —
  `FakeWorkspaceClient` mock extensions.
- `apps/desktop/src/renderer/agent-workspace.tsx` — smart-wrapper
  optimistically updates `activePhaseId` / `bindingRevision`; new
  callbacks wired.
- `docs/CURRENT_STATE.md` — M3.1 added to "Recently Shipped".
- `docs/decisions/ADR-010-workflow-plugin-contract.md` — status
  updated to `M1 + M2 + M2.5 + M3.1`, new bullets for the switch /
  advance use cases.
- `docs/plans/m3-1-workflow-plugin-switching.md` (this file).

## Tests

- Application use-case suite — success / revision conflict / invalid
  phase / artifact-already-recorded / force override / unknown plugin
  (~6 cases per use case × 2 use cases = ~12 new cases).
- IPC handler suite — route / invalid / `CONFLICT` /
  `INVALID_PHASE_FOR_PLUGIN` / `ARTIFACT_ALREADY_RECORDED`
  (~10 new cases).
- Renderer panel — switch row renders installed plugin's phase list;
  switch button disabled when binding removed; advance-disabled when
  no next phase; advance-disabled when artifact recorded (no force);
  advance-disabled when busy; surfaces `INVALID_PHASE_FOR_PLUGIN` /
  `ARTIFACT_ALREADY_RECORDED` errors inline.
- Workspace controller `FakeWorkspaceClient` extended with the two
  new methods so existing renderer tests keep their coverage.

## Validation

- `pnpm --filter '@agentterm/application' build && typecheck`
- `pnpm --filter '@agentterm/desktop' typecheck`
- Targeted vitest runs:
  `packages/application/src/workflow-plugin-use-cases.test.ts`,
  `packages/application/src/workflow-plugin-loader.test.ts`,
  `apps/desktop/src/desktop-main-handlers.test.ts`,
  `apps/desktop/src/desktop-bridge.test.ts`,
  `apps/desktop/src/renderer/workflow-plugin-configurator.test.tsx`.
- Full `apps/desktop` test suite (450 baseline, must remain green
  excluding the two pre-existing failures).

## Risks

- **Plugin shape change** — switching to a different plugin file
  could move the active phase's index. We refuse when the new plugin
  lacks the current `activePhaseId` unless the caller passes an
  explicit `nextActivePhaseId`. This keeps the seam explicit.
- **Audit-trail integrity** — silently skipping a phase would lose
  history. We refuse by default; `force: true` is opt-in.
- **Optimistic drop mismatch** — same pattern as M2.5; main process
  is source of truth, next refresh reconciles.
- **Renderer scope creep** — Settings panel already hosts install /
  remove; adding Switch + Phase rows stays under the same
  `WorkflowPluginConfigurator` so the seam is single-panel.

## Out of scope (deferred to M3.2+)

- Per-phase artifact-kind selector (defaults stay derived from
  `WorkflowPhase.artifactKind`).
- A free-form "set active phase to arbitrary id" affordance — we
  constrain to the plugin's declared phase list.
- Cross-tab optimistic update reconciliation (single-tab only;
  multi-tab still relies on next refresh).
- MCP exposure for the new use cases (deferred to M4).
