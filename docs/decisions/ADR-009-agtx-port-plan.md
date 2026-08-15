# ADR-009: Port agtx concepts into AgentTerm

Status: Proposed — awaiting scope confirmation
Date: 2026-08-16
Owner: AgentTerm desktop + monorepo

## Context

`fynnfluegge/agtx` is a Rust TUI kanban + multi-agent orchestrator for coding
agents. It demonstrates several patterns AgentTerm does not yet own:

- A **board view** (Backlog / Planning / Running / Review / Done columns)
- **Per-phase agent switching** (`research = "gemini"`, `running = "claude"`,
  `review = "codex"`)
- A **spec-driven plugin contract** (`plugin.toml` with `commands`, `prompts`,
  `artifacts`, `prompt_triggers`, `copy_back`, `auto_dismiss`, `cyclic`)
- A **task worktree per task** (already present in AgentTerm as one
  deterministic primary worktree)
- An **AI orchestrator** that autonomously advances phases
- **Brainstorm / Sweep skills** for capturing ideas mid-session
- An **MCP server** exposing the board to other agents
- **Auto merge-conflict resolution** with `git merge-tree`

This ADR records **which** agtx concepts we want to port into AgentTerm and
**how** they map to our existing layered architecture
(`Presentation -> Application -> Domain`; Infrastructure implements ports owned
by inner layers; Domain must not depend on agent-provider CLIs, Git, PTY,
SQLite, or the renderer).

This ADR deliberately does **not** commit to one massive rewrite. It sequences
the work into independent, reviewable milestones so each can land, ship, and
be reverted without endangering the existing product.

## Mapping to current AgentTerm surface

| agtx concept            | AgentTerm state today                                                                 | Status       |
| ----------------------- | ------------------------------------------------------------------------------------- | ------------ |
| Kanban columns          | `TaskPhase` = `BACKLOG / PLANNING / RUNNING / REVIEW / DONE / BLOCKED`                | Domain only; **no board view** in Presentation |
| One worktree per task   | `ensureTaskWorktree` (deterministic, primary worktree per Task)                       | Already shipped |
| Multi-agent per task    | `Settings.defaultAgent` (single agent) + per-session override at retry                | One agent per Session; **no per-phase switching** |
| Spec-driven plugin      | Hard-coded kickoff string in `startTaskPlanning` / `startTaskExecution`               | **None** |
| Phase artifacts         | `planning/plan.md` artifact, `execution-summary`, `review`                            | Three artifact kinds; **no research artifact** |
| Brainstorm / Sweep      | Task creation wizard                                                                   | **No in-session capture** |
| Orchestrator agent      | Human-in-the-loop only                                                                 | **No autonomous advance** |
| MCP server              | IPC allowlist (`agenttermWorkspace`) via preload                                      | **Not exposed** to AI agents |
| Auto merge-conflict     | PR refresh, push, create                                                               | **No auto-resolution** |
| Multi-project dashboard | Recent projects list                                                                   | Functional, not a dedicated window |

## Goals

1. Make Phase the explicit unit of multi-agent collaboration: the same Task
   can use one agent for research, another for planning, another for code,
   another for review — without rewriting agent-selection plumbing.
2. Let operators define reusable, agent-aware workflows through a single
   declarative file (the plugin contract), instead of forking `agent-launch.ts`
   for each new method.
3. Give human users a real board view in the desktop so they can see and
   act on every Task in one place.
4. Preserve every AgentTerm invariant: TaskPhase, ExecutionHealth, and
   AgentSession status stay distinct; provider policy stays in adapters;
   Provider policy stays in adapters; PTY mechanics stay in runtime;
   Transition validation stays in Domain.

## Non-goals (this proposal)

- Autonomous AI orchestrator. Human-in-the-loop stays the default.
- Re-implementing the entire Rust TUI. AgentTerm stays an Electron desktop
  application; this ADR never replaces it.
- Replacing ConPTY or migrating to a Rust runtime.
- Skill marketplace, plugin distribution, or auto-update of plugins.
- Brainstorm / Sweep as in-session `/agtx:brainstorm` slash commands. Those
  need a unified agent session, which we do not have yet.

## Architectural decisions

### AD-1: A workflow plugin is a Domain concept

A plugin is not a TOML file, not a UI element, and not an adapter. It is a
Domain value that describes, declaratively:

- One or more **phases** (e.g. research / planning / running / review)
- For each phase: an **artifact contract** (canonical name, required sections,
  producing phase), a **kickoff policy** (agent identity, command shape,
  prompt template), and **readiness predicate** (what evidence is required
  before the next phase can start)

Domain owns the contract because readiness and phase validation already live
in Domain (`acceptTaskPlan`, `approveTaskReview`, etc.). Application loads
the plugin, resolves the per-phase agent, and coordinates transitions.
Infrastructure reads plugin files (TOML / JSON) and materializes them into
the Domain value. Presentation never parses a plugin file directly.

### AD-2: Plugins are loaded, not run

We do **not** execute plugin-defined shell commands, prompt triggers, or
auto-dismiss scripts. Those exist in agtx because it is a TUI that drives an
interactive agent through tmux. AgentTerm drives the agent through its own
Application use cases (`startTaskPlanning`, `startTaskExecution`,
`requestTaskReview`). The plugin contributes policy; AgentTerm keeps
ownership of execution. This is the single biggest divergence from agtx and
the reason a plugin can never bypass `TaskPhase` validation.

### AD-3: Per-phase agent identity is a Settings concern

The plugin names phases by stable string identifier. The operator binds a
phase identifier to an agent identity (or to "use the default agent") in
`ApplicationSettings`. This reuses the existing Settings Domain value
without inventing a new one and keeps presentation of agent selection
provider-neutral.

### AD-4: The board view is a Presentation feature only

Adding a board view does not change Domain, Application, or Infrastructure.
The desktop renders the same `loadAgentWorkspace` read model grouped by
phase. No new port. No new use case. Just a renderer-level view.

### AD-5: The MCP server is a separate process

We expose a minimal, read-mostly MCP server (`agentterm mcp-serve`) that
wraps existing Application ports. It never writes through Domain transition
ports. It only emits:

- `list_projects` → `loadAgentWorkspace` filtered
- `list_tasks` → `listProjectTasks`
- `get_task` → `loadAgentWorkspace` slice
- `read_pane_content` → terminal buffer snapshot from the existing per-window
  subscription (a new port: `AgentPaneSnapshotProvider`, read-only)

Write operations (create_task, move_task, send_to_task) are intentionally
out of scope for this ADR. Adding them later requires the same authorization
discipline we already use for IPC.

### AD-6: Auto merge-conflict resolution stays out

`git merge-tree` is non-destructive but auto-resolving requires agent
intervention, which itself requires plugin hooks. Defer until plugin
contracts are stable.

## Milestones

Each milestone ships as one PR with its own ADR addendum if it changes
Domain rules. Each is independently revertable.

### M1 — Spec-driven plugin contract (foundation)

**Why first**: every later milestone depends on this. Per-phase agent
switching and the board view are easier once plugins exist.

Scope:

- Domain
  - `WorkflowPlugin`: id, version, name, description, phases, default phase
    graph
  - `WorkflowPhase`: id, artifact contract, kickoff policy, readiness
    predicate identifier
  - `WorkflowArtifactContract`: canonical name, producing phase, required
    headings, byte/line bounds
  - `WorkflowPluginRegistry` (in-memory; persisted via Settings)
  - Pure validation: rejected plugins return `WorkflowPluginValidationFailure`
    with reason
  - Domain rule: a phase can be entered only when its required artifact
    contract exists in the persisted ExecutionArtifact history

- Application
  - `loadWorkflowPlugin(input)` → reads plugin file, validates, returns
    Domain value or sanitized failure
  - `bindPhaseAgent(plugin, phaseId, settings)` → returns the
    `AgentIdentity` for that phase, falling back to `settings.defaultAgent`
  - `selectPhaseArtifactContract(plugin, phaseId)`
  - Per-phase agent becomes the default for `startTaskPlanning`,
    `startTaskExecution`, `requestTaskReview` when a plugin is bound to the
    Task; the existing single-agent behavior remains the fallback when no
    plugin is loaded

- Infrastructure
  - `WorkflowPluginLoader`: reads TOML/JSON from a path under
    `AT_DESKTOP_PLUGIN_ROOT`, never from an arbitrary path (mirrors the
    Quality Gate trust root discipline)
  - Built-in `void` plugin shipped in the repo so the existing flow stays
    default
  - Built-in `agtx` plugin: ports agtx's 4-phase workflow (research /
    planning / running / review) using only the kickoff policy fields we
    actually support (no shell hooks, no `prompt_triggers`, no `auto_dismiss`)

- Presentation
  - Settings panel adds a "Workflow plugin" picker with the same trust-root
    disclosure used for Quality Gates
  - Task detail view shows the active plugin name + per-phase agent
  - No new IPC channel that can pass an arbitrary path

Tests:

- Domain tests for plugin validation (missing phase, cyclic phase graph,
  unknown artifact canonical name, version mismatch)
- Application tests for `bindPhaseAgent` (default fallback, missing plugin,
  unknown phase)
- Infrastructure tests for `WorkflowPluginLoader` (rejects paths outside
  root, malformed TOML, missing version)
- Snapshot tests for the built-in `agtx` plugin

### M2 — Kanban board view

**Depends on M1.**

Scope:

- Presentation only
- A new renderer route `/board` showing 5 columns (Backlog, Planning,
  Running, Review, Done) with optional Blocked badge
- Each column lists Tasks with title, plugin name, per-phase agent, latest
  artifact indicator, latest session status
- Keyboard navigation: `h/l` between columns, `j/k` within column, `↩`
  opens the existing Task detail modal, `Ctrl+f` focuses the live terminal
- The existing `/workspace` route becomes "List view" and stays the default

No Domain change. No Application change. No new port.

Tests:

- Snapshot tests for the board columns
- Keyboard navigation tests via the existing renderer harness
- A contract test that confirms the board view consumes the exact
  `loadAgentWorkspace` read model and does not introduce a second source

### M3 — Research artifact + research phase

**Depends on M1.**

Scope:

- Domain
  - New `ExecutionArtifactKind.RESEARCH` with contract `.agtx/research.md`
  - Domain rule: a Task bound to a plugin with a `research` phase may enter
    `PLANNING` only after a validated RESEARCH artifact exists for that Task

- Application
  - `recordResearchArtifact(input)` — same shape as
    `createExecutionArtifact`, bound to a research phase
  - `startTaskResearch(taskId)` — analogous to `startTaskPlanning`, but
    starts in `BACKLOG` and lands in a new internal phase or stays in
    `BACKLOG` with the artifact as evidence (decision: stay in `BACKLOG`,
    because TaskPhase is the public surface)
  - `canEnterPlanning(taskId)` consumes the artifact presence plus the
    existing dependency + worktree + agent readiness

- Infrastructure
  - `ResearchArtifactStore` mirrors `ExecutionArtifactStore`
  - No new filesystem path; uses the same `taskArtifactsRoot` (a subdir
    scoped by artifact kind)

- Presentation
  - Task detail adds a "Run research" action visible when the plugin has a
    research phase and the artifact is absent
  - Workspace list and board view show the research artifact indicator
    alongside the plan indicator

Tests:

- Domain tests for the new artifact contract
- Application tests for `recordResearchArtifact` (path validation,
  provenance, validation result)
- Integration test: research → plan → run lifecycle with two different
  agents per phase

### M4 — Minimal MCP server (read-only)

**Depends on M1, M2.**

Scope:

- New package `packages/mcp-server` exporting `agenttermMcpServe(deps)` —
  a stdio JSON-RPC server implementing the four read tools listed in AD-5
- Application ports expose the read use cases; the MCP server is a thin
  transport adapter
- Auth: the MCP server requires an explicit `agentterm-mcp-token` from
  Settings; never reads from a remote network

Tests:

- Server-side tests for JSON-RPC dispatch
- Client-server integration test using the `@modelcontextprotocol/sdk`
  only in `devDependencies`

### M5 — Per-phase agent switching end to end

**Depends on M1, M3.**

This is the integration milestone. It does not add new Domain or
Application surface — it wires M1 + M3 together and verifies a Task can
move through research (Gemini) → planning (Claude) → running (Codex) →
review (Claude) with three different agents, three different Sessions,
one shared Worktree, and one plugin file.

Tests:

- Integration test using the real SQLite + Git + mock adapters (matching
  the existing pattern in
  `packages/infrastructure/src/task-execution.integration.test.ts`)
- Manual: launch a research session, observe Gemini PTY, write a research
  artifact, launch a planning session, observe Claude PTY, accept the plan,
  launch a Codex execution session, request review with Claude

### Deferred (separate ADRs, after M5 lands)

- M6 — Orchestrator agent (autonomous phase advance). This is a large
  product decision and warrants its own ADR after we see how the plugin
  contract behaves in practice.
- M7 — Brainstorm / Sweep in-session capture. Requires unifying the
  brainstorm capture with the existing PTY input pipeline.
- M8 — Auto merge-conflict resolution with `git merge-tree`. Needs plugin
  hooks, which we explicitly excluded in AD-2.

## Risks

1. **Plugin schema drift.** Operators may want `prompt_triggers` or
   `auto_dismiss` because agtx ships them. We deliberately omit them. The
   plugin loader should fail closed with a clear message so operators
   know why, not silently drop fields.
2. **Per-phase agent identity explosion.** Three or four different agents
   per Task triples the surface area for adapter bugs and PTY failures.
   Mitigation: ship only the agents we already support (Codex, Claude,
   Gemini); the catalog freezes; we do not add new adapters in this work.
3. **MCP server abuse.** A read-only MCP server is still a surface that
   can leak Task content. Mitigation: explicit user-enabled token in
   Settings, never on by default, and the read tools expose the same
   read model the renderer already consumes.
4. **Full-rewrite scope.** This proposal splits the work into 5 milestones
   plus deferred items because a single PR is unreviewable and
   irreversible. Each milestone is independently shippable.

## Validation plan

- Per-milestone: typecheck, lint, prettier, full unit test suite
- Per-milestone: the matching `agentterm-testing` skill cases
- Cross-milestone integration test in M5 covering the full plugin
  lifecycle with three different agents
- Manual: each milestone needs a Windows ConPTY smoke run; the same
  Electron 43 smoke check from CURRENT_STATE.md applies