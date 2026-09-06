# ADR-016: Complete the artifact + dependency renderer workflow (post-M5 polish)

Status: Accepted
Date: 2026-09-05
Owner: AgentTerm desktop renderer
Shipped: PR #44 (merge commit `bf86965`) on 2026-09-05; aggregated from
`feat/art-dep-foundation`, `feat/art-dep-artifact-ui`,
`feat/art-dep-dependency-ui`, `feat/art-dep-entry-points`,
`feat/art-dep-tests`, `feat/art-dep-verify`.

## Context

`docs/CURRENT_STATE.md` line 291 records that **"Artifact production and
dependency editing still have no renderer workflow."** Since that text was
written the renderer has gained `ArtifactProducer`, `ArtifactHistory`,
`DependencyEditor`, `TaskDependencies`, and the matching `add/removeTaskDependency`
+ `createArtifact` IPC channels — so the gap is now smaller and more concrete.

A targeted inspection of the existing Presentation surface (`agent-workspace.tsx`,
`artifact-producer*.ts(x)`, `dependency-editor*.ts(x)`, `workspace-controller.ts`)
shows five remaining, user-visible holes:

1. **`RESEARCH` artifact kind is unreachable from the UI.**
   `artifact-producer-state.ts` already maps `BACKLOG -> RESEARCH`, defines the
   heading `# Research`, and supplies validation for it. But
   `artifact-producer.tsx` (line 110-114) lists only `PLAN`,
   `EXECUTION_SUMMARY`, `REVIEW` in its `kindOptions` array, AND
   `isProducerAvailable` (line 188) returns `null` for `BACKLOG`. So a user
   with a `BACKLOG` Task who has the `agtx` workflow plugin cannot produce the
   required `research/research.md` evidence even though
   `packages/application/src/research-use-cases.ts` + `canEnterPlanning`
   expect it.

2. **No `startTaskResearch` UX.** Application exposes
   `startTaskResearch(input, deps)` and an IPC channel can be added, but
   today there is no renderer action, palette command, or button to launch
   a research Agent Session.

3. **`TaskDependencies` only shows outgoing edges.** The workspace read
   model exposes `dependencies` (Tasks this one waits on) but not the
   reverse direction (Tasks waiting on this one). A `DONE` Task that
   unblocks 3 others gets no recognition, and a `BLOCKED` Task does not
   call out which specific upstream Task is the blocker.

4. **`DependencyEditor` does not show reverse dependents.** Same root
   cause — the read model has no `dependents` projection.

5. **`ArtifactHistory` renders all kinds identically.** No badge or
   section distinction for `RESEARCH` vs `PLAN`/`EXECUTION_SUMMARY`/`REVIEW`,
   which makes it harder to scan a Task's evidence timeline.

All five gaps are **Presentation-only**: every required backend type,
use case, and IPC channel already exists. No Domain rule, Application
port, or Infrastructure adapter needs to change. The work is
mechanical, has high user value, and stays inside the
Presentation -> Application boundary that the existing renderer already
respects.

## Goals

1. A `BACKLOG` Task whose plugin requires a `research` artifact gets a
   visible, validated UI path to produce that artifact without leaving
   the workspace.
2. The user can launch a research Agent Session from the workspace (not
   only via the command palette guess).
3. The selected Task panel always shows both directions of the readiness
   graph: Tasks that block it AND Tasks that it blocks.
4. Artifact history clearly distinguishes `RESEARCH` evidence from
   post-research evidence so a reviewer can scan the timeline.

## Non-goals

- No autonomous research orchestrator (still M6 in ADR-009, deferred).
- No new Domain rules, Application use cases, or IPC channels beyond a
  single new `startResearch` channel that mirrors `startPlanning`.
- No new "brainstorm" / "sweep" capture (still M7, deferred).
- No change to the board view semantics; the board already groups by
  phase and inherits the read-model changes through the existing
  `loadAgentWorkspace` consumer.
- No auto merge-conflict resolution (still M8, deferred).

## Architectural decisions

### AD-1: Research UX lives in Presentation only

The renderer adds:

- A small `startTaskResearch` IPC channel (mirroring `startTaskPlanning`
  exactly — same `AgentTaskRequest` shape with optional `agentId`).
- A `startTaskResearch` controller method that mirrors
  `startSelectedPlanning`, including the `decideStartActionAgentId`
  plugin-binding override.
- One button in the Task inspector for `BACKLOG` tasks that have a
  plugin binding requiring `RESEARCH`.
- One palette command (`task:start-research`) with the same visibility
  rules as `task:start-planning`.

The `ArtifactProducer` becomes available for `BACKLOG` Tasks with a
plugin requiring `RESEARCH`; the `RESEARCH` kind is added to the radio
group; the default draft uses `# Research` and zero-session binding.

### AD-2: Readiness graph is bidirectional in the read model

Application adds `WorkspaceTaskOverview.dependents` — a bounded array of
`{ id, title, phase, projectId }` describing Tasks in the same Project
that list this Task as a dependency. This is a pure read-model addition
already supported by the existing `TaskDependencyRepository.listByProjectId`
plus the Project's task index. No new repository method is needed.

`TaskDependencies` in `agent-workspace.tsx` is split into
`TaskBlocksOn` (outgoing) and `TaskBlocksThese` (reverse dependents).
`DependencyEditor` shows the same two lists with `Remove` controls only
on the outgoing side (Reverse dependents are derived, not editable from
this Task).

### AD-3: Artifact history distinguishes research evidence

`ArtifactHistory` renders a `data-artifact-kind` attribute on each card
and uses one class per kind. `RESEARCH` cards get a different eyebrow
label and are rendered above the fold in the evidence timeline (oldest
first). The renderer never reorders by phase contract — only by
ordinal.

## Milestones

One milestone, shipped as one PR:

### M-ART-DEP — Close the renderer workflow gap

**Scope:**

1. **Application / IPC**
   - Add `startResearch` IPC channel + payload validation mirroring
     `startPlanning` (optional `agentId`, required `taskId`).
   - Add `WorkspaceTaskOverview.dependents: readonly TaskDependencySummary[]`
     populated by `loadAgentWorkspace` using the existing
     `taskDependencies` repository.
   - Add `startTaskResearch` controller method that delegates to the new
     IPC channel and respects `decideStartActionAgentId`.

2. **Renderer**
   - `ArtifactProducer`: add `RESEARCH` to `kindOptions`, extend
     `isProducerAvailable` to include `BACKLOG` Tasks that are bound to a
     plugin whose research phase is required, use the correct heading.
   - `ArtifactHistory`: tag each card with `data-artifact-kind`, render
     a kind-specific eyebrow, sort by ordinal (oldest first).
   - `TaskDependencies` → split into two read-only lists (`Blocks on`,
     `Blocks these`).
   - `DependencyEditor`: keep current behavior for outgoing edges; show
     the reverse list as a read-only summary above the editor.
   - Add `startTaskResearch` button in the Task inspector header for
     eligible `BACKLOG` Tasks.
   - Add `task:start-research` palette command with the same visibility
     rules as `task:start-planning`.

3. **Infrastructure / Domain**
   - Workspace read model query gains the reverse-dependents projection.
     Implementation reuses `TaskDependencyRepository.listByProjectId` +
     the Project's task index; one new private helper.

4. **Tests**
   - Application unit tests for the reverse-dependents projection.
   - Controller test for `startTaskResearch` + plugin-binding override.
   - IPC contract test for the new channel.
   - Renderer unit test for `ArtifactProducer` exposing `RESEARCH` for
     eligible `BACKLOG` Tasks.
   - Renderer snapshot for the new bidirectional dependency view.

## Risks

1. **Producer expansion scope.** Letting users produce a `RESEARCH`
   artifact by hand defeats the purpose of the agent. Mitigation:
   `ArtifactProducer` exposes `RESEARCH` only when the Task's plugin
   requires it AND the active session has not already produced a
   research artifact, AND a separate "Start research agent" button is
   the primary path. Manual production remains a fallback for offline
   recovery.
2. **Reverse-dependents projection cost.** The Project task index is
   bounded by the same Project membership, so the additional join is
   `O(edges × tasks_in_project)`. For typical Projects (≤ a few hundred
   Tasks) this is negligible; the read model still memoizes per load.
3. **Visibility of `task:start-research`.** Showing it on every
   `BACKLOG` Task would be noisy. Visibility = same as
   `task:start-planning`: only Tasks bound to a plugin with a
   `RESEARCH` phase AND no existing research artifact.

## Validation plan

- Per-step: `pnpm typecheck`, `pnpm lint`, `pnpm test`.
- New unit + IPC + snapshot tests.
- Manual smoke: open a Project with the `agtx` plugin bound to a Task,
  confirm the research action + RESEARCH kind are reachable, produce a
  research artifact, confirm the inspector now allows planning.
