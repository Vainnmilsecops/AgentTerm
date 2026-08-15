# ADR-010: WorkflowPlugin spec-driven plugin contract (M1)

Status: Accepted
Date: 2026-08-16
Owner: AgentTerm desktop + monorepo
Parent: ADR-009 (Port agtx concepts into AgentTerm)

## Context

ADR-009 ships five independent milestones. M1 establishes the spec-driven
WorkflowPlugin contract without changing existing Task lifecycle behavior.
The plugin model mirrors `fynnfluegge/agtx`'s `plugin.toml` shape but is
intentionally narrower so Application remains the only entry point for phase
transitions and PTY/process ownership stays in the runtime.

This ADR documents the M1 cut:

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

### Composition

M1 does not introduce a new IPC handler. `DesktopIpcApplication` stays
identical to its current shape, and the desktop composition root in
`apps/desktop/src/desktop-application.ts` is untouched. The next milestone
(M2) will add `selectWorkflowPluginPath` + `loadWorkflowPlugin` IPC
handlers and the Settings panel entry point.

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