# ADR-010: WorkflowPlugin spec-driven plugin contract (M1 + M2 + M2.5 + M3.1)

Status: Accepted (M1 + M2 + M2.5 + M3.1 implemented)
Date: 2026-09-10
Owner: AgentTerm desktop + monorepo
Parent: ADR-009 (Port agtx concepts into AgentTerm)

## Context

ADR-009 ships five independent milestones. M1 establishes the spec-driven
WorkflowPlugin contract without changing existing Task lifecycle behavior.
The plugin model mirrors `fynnfluegge/agtx`'s `plugin.toml` shape but is
intentionally narrower so Application remains the only entry point for phase
transitions and PTY/process ownership stays in the runtime.

M2 follows on M1 to add the Settings entry point and the
main-process installer seam (`WorkflowPluginInstaller`) without revisiting
the Domain shape. M2 introduces the IPC channels that the renderer Settings
panel uses to install and surface the binding repository state.

M2.5 ships the symmetric removal path so users can drop a binding
without restarting the desktop: the `WorkflowPluginConfigurator` panel
gains a per-binding `Remove` button with an inline confirm/cancel pair,
and the main process exposes a dedicated
`removeWorkflowPluginBindingForTask` IPC channel. The application
use case enforces the same compare-and-set discipline as the install
path so a concurrent reinstall in another surface cannot silently race
a remove.

M3.1 completes the per-binding lifecycle. Users can switch a binding to a
different trusted plugin file (without uninstalling) and advance the
active phase forward, backward, or to an explicit phase id. Forward
jumps that would skip a phase with an already-recorded
`ExecutionArtifact` are refused unless the caller passes an explicit
`force: true` so the audit trail is never silently dropped. Two new
application use cases (`updateWorkflowPluginBindingForTask`,
`advanceActivePhaseForTask`) carry the same compare-and-set discipline
as install and remove; two new IPC channels
(`agentterm:workflow-plugin:switch`,
`agentterm:workflow-plugin:advance-phase`) and two new error codes
(`INVALID_PHASE_FOR_PLUGIN`, `ARTIFACT_ALREADY_RECORDED`) round out the
contract. The Workspace projection grows
`availablePhaseIds` / `phaseArtifactKinds` so the renderer can render
phase controls without re-parsing the bound plugin file.

This ADR documents the M1 + M2 cut:

- Plugin = Domain value (not a TOML tree).
- Built-in `void` and `agtx` plugins ship with the desktop binary.
- Per-Task binding persists in SQLite, recoverable across restart.
- No new IPC surface; composition root remains unchanged in M1.

## Decision

### Plugin shape

A WorkflowPlugin is the smallest Domain value that satisfies:

- `id` and `name` are non-empty `a-z0-9._{@r}{-}` shapes.
- `description` is optional, ≤ 256 bytes.
- `phases` is a non-empty list of `WorkflowPhase`.
- Each phase declares:
  - `id` (stable, lower-case, ≤ 64 bytes)
  - `artifactKind` ∈ `research | planning | running | review`
  - `artifactHeading` (Markdown `#…` heading)
  - `requiredHeadings` (non-empty, dedup, ≤ 16)
  - `promptTemplate` (≤ 64 KiB)
  - `kickoff.allowedAgents` (M1 freeze: research→`gemini`,
    planning→`claude|codex|gemini`, running+review→`claude|codex`)

The factory rejects empty graphs, duplicate phase IDs, oversize payloads,
malformed headings, invalid agent IDs, unknown artifact kinds, and
oversized prompt templates. Every error maps to a precise
`WorkflowPluginValidationReason`.

### Loading + persistence

- `WorkflowPluginConfigurator` (Infrastructure) parses JSON plugin files.
- Trust root: `AT_DESKTOP_PLUGIN_ROOT` env var (semicolon list), parsed
  via `resolvePathInside`. Outside the trust root → `PATH_NOT_TRUSTED`.
- The configurator validates the parsed record through Domain's
  `createWorkflowPlugin`, so any Domain-level failure surfaces as
  `INVALID_FORMAT` with no Platform-specific data leaking to the caller.
- Per-Task binding lives in `workflow_plugin_bindings` (migration 15):
  `task_id` PK + FK to `tasks`, `plugin_id`, `source_path`,
  `active_phase_id`, `revision`, `installed_at`.
- Upsert uses compare-and-set on `revision`; first install requires
  `expectedRevision = 0`, subsequent updates must match the stored revision.

### Application surface

Two use cases ship in M1:

- `bindPhaseAgent({ plugin, phaseId, settings }, catalog)` returns the
  `AgentIdentity` for the phase, choosing the first catalog adapter in the
  phase allow-list and falling back to `Settings.defaultAgentId`.
- `selectPhaseArtifactContract({ plugin, phaseId })` returns the phase
  artifact contract (canonical name, heading, task phase binding).

`installWorkflowPluginForTask({ path, taskId, expectedRevision }, deps)`
loads the file, validates, and persists the binding. Errors map to:

- `PATH_NOT_TRUSTED | PATH_UNREADABLE | INVALID_FORMAT` (configurator)
- `CONFLICT` (revision mismatch)
- `WorkflowPluginConflictError` (Application-level compare-and-set)

`removeWorkflowPluginBindingForTask({ taskId, expectedRevision }, deps)`
(M2.5) is the symmetric removal entry point. It re-reads the binding,
rejects `NOT_FOUND` when the row is missing, rejects `CONFLICT` when
`expectedRevision` does not match, and otherwise calls
`bindingRepository.removeByTaskId(taskId)`. The
`RemoveWorkflowPluginBindingError` is mapped by `desktop-main-handlers`
to the `CONFLICT` / `NOT_FOUND` IPC error codes so the renderer can
surface them as inline feedback.

`updateWorkflowPluginBindingForTask({ path, taskId, expectedRevision }, deps)`
(M3.1) replaces the plugin file behind a binding while preserving the
`activePhaseId`. It runs the same configurator path as install, refuses
with `INVALID_PHASE_FOR_PLUGIN` if the new plugin does not declare the
current active phase, and otherwise calls `bindingRepository.upsert` with
`expectedRevision`. Errors map to `WorkflowPluginConfiguratorError`
(install-side) or `WorkflowPluginUpdateError` (`CONFLICT`,
`INVALID_PHASE_FOR_PLUGIN`, `UNKNOWN_PLUGIN`). The
desktop `WorkflowPluginInstaller` seam grows a `switchWorkflowPluginBindingForTask`
adapter so the renderer never mutates bindings directly.

`advanceActivePhaseForTask({ direction, taskId, expectedRevision, force?, phaseId? }, deps)`
(M3.1) moves the active phase forward, backward, or to an explicit
`phaseId`. The configurator re-loads the bound plugin file so a stored
file that has become unreadable surfaces as `UNKNOWN_PLUGIN`. Forward
jumps (including explicit `set`) consult
`artifactRepository.findLatestByTaskIdAndKind` and refuse with
`ARTIFACT_ALREADY_RECORDED` when the target phase already produced an
artifact, unless the caller passes `force: true`. Boundary moves
(past the last phase, before the first) surface as `BOUNDARY_REACHED`.
The desktop seam grows an `advanceWorkflowPluginPhase` adapter; the IPC
contract exposes `INVALID_PHASE_FOR_PLUGIN` and
`ARTIFACT_ALREADY_RECORDED` error codes so the renderer can render the
inline hint without leaking typed application reasons.

### Composition

M1 does not introduce a new IPC handler. M2 ships:

- `selectWorkflowPluginPath` (`agentterm:workflow-plugin:select-path`) — the
  native main-process dialog is the only allowed source of a plugin path;
  the renderer never receives an arbitrary filesystem path from untrusted
  code.
- `installWorkflowPluginForTask`
  (`agentterm:workflow-plugin:install`) — routes through the dedicated
  `WorkflowPluginInstaller` seam that closes over the production
  `WorkflowPluginConfigurator` and the SQLite binding repository. The
  request carries `expectedRevision` so concurrent windows cannot silently
  overwrite the binding.
- `WorkflowPluginConfigurator` renderer panel — uses the typed
  `InstallWorkflowPluginRequest` / `InstallWorkflowPluginResponse` and the
  `SelectWorkflowPluginPathResponse` shapes from `ipc-contract.ts` and
  binds the result back into `AgentWorkspaceView` via the
  `onInstallWorkflowPlugin` / `onSelectWorkflowPluginPath` callbacks.

M2.5 extends the composition with a single new IPC channel and a single
renderer control:

- `removeWorkflowPluginBindingForTask`
  (`agentterm:workflow-plugin:remove`) — routed through the same
  `WorkflowPluginInstaller` seam and forwarded to
  `removeWorkflowPluginBindingForTask` in `@agentterm/application`. The
  request carries the same `expectedRevision` compare-and-set so a
  concurrent reinstall in another surface cannot be silently dropped.
- The `WorkflowPluginConfigurator` panel gains a per-binding `Remove`
  button plus an inline confirm/cancel pair. The smart wrapper
  (`AgentWorkspace`) optimistically drops the row on success and the
  `WorkflowPluginInstaller` seam closes over the production
  `removeWorkflowPluginBindingForTask` use case so the binding
  repository remains the only writer.

M3.1 extends the composition with two new IPC channels and two new
renderer controls:

- `switchWorkflowPluginBindingForTask`
  (`agentterm:workflow-plugin:switch`) — routed through the same
  `WorkflowPluginInstaller` seam and forwarded to
  `updateWorkflowPluginBindingForTask` in `@agentterm/application`. The
  request carries the same `expectedRevision` compare-and-set and the
  same configurator trust-root check as install, so a concurrent
  reinstall cannot silently switch the binding to an untrusted file.
- `advanceWorkflowPluginPhase`
  (`agentterm:workflow-plugin:advance-phase`) — routed through the same
  `WorkflowPluginInstaller` seam and forwarded to
  `advanceActivePhaseForTask` in `@agentterm/application`. Errors map to
  `INVALID_PHASE_FOR_PLUGIN`, `ARTIFACT_ALREADY_RECORDED`,
  `BOUNDARY_REACHED`, `CONFLICT`, or `NOT_FOUND`. The renderer cannot
  decide the target phase; it must pass the explicit `phaseId` it wants
  the main process to advance to.
- The `WorkflowPluginConfigurator` panel grows a per-binding `Switch…`
  button and a phase fieldset (`◀ Previous` / phase label / `Next ▶`).
  The smart wrapper (`AgentWorkspace`) optimistically mirrors the new
  active phase and binding revision on success so the
  `WorkflowPluginInstaller` seam remains the only writer. The workspace
  projection (`WorkflowPluginProjection`) now exposes
  `availablePhaseIds` and `phaseArtifactKinds` so the renderer can render
  the phase controls without re-parsing the bound plugin file.

The desktop composition root in
`apps/desktop/src/desktop-application.ts` owns the
`installWorkflowPluginForTask` use case and the trust-root environment
variable (`AT_DESKTOP_PLUGIN_ROOT`); the renderer never sees the trust
root.

## Alternatives Considered

- **TOML parsing** — keeps agtx-compatible syntax but introduces a parser
  dependency and ambiguous escape rules. JSON is sufficient and the
  configurator shape stays small.
- **Auto-load `~/.agentterm/plugins/*.json`** — silently mutates state at
  start-up. Keeping the loader strictly trust-root + path-driven matches
  the Quality Gate precedent.
- **Prompt triggers / auto dismiss / cyclic flags** — agenttx features
  that imply autonomous phase advance and shell hooks. Both are explicitly
  out of scope per ADR-009.
- **YAML / msgpack** — no operational benefit, more parser surface area.

## Risks

1. **Plugin schema drift** — operators expect `prompt_triggers` /
   `auto_dismiss`. The configurator treats unknown keys as fail-closed
   `INVALID_FORMAT` so authors learn the M1 subset immediately.
2. **Per-phase adapter surface × 3** — the freeze on `codex | claude |
   gemini` prevents surprise; new adapters require an ADR.
3. **MCP abuse** — N/A in M1; M4 introduces a read-only MCP server with
   token auth, default-off.
4. **Sequencing discipline** — M1 is intentionally narrow; M2/M3 expand
   without rewriting M1 contracts.

## Consequences

- Domain owns the plugin shape and validation; Application owns the
  selection and persistence contract; Infrastructure owns the file system
  and SQLite details.
- The `loadWorkflowPlugin` use case can later be reused by M4's MCP
  server, since the configurator returns the validated Domain value.
- M2 and M3 will add the IPC handler, kanban board, and research phase
  without revisiting the Domain shape.
- Migration 15 only appends a new table; existing databases are not
  rewritten and the prior 14 migrations continue to apply in order.