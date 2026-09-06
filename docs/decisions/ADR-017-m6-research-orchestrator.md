# ADR-017: M6 — Minimal research orchestrator (auto-advance BACKLOG → PLANNING)

Status: Accepted
Date: 2026-09-05
Owner: AgentTerm Application + Desktop
Supersedes scope item: ADR-009 §"M6 — Orchestrator agent" (deferred)
Shipped: PR #45 (merge commit `1d8301e`) on 2026-09-06;
feature branch `feat/m6-research-orchestrator` commit `319de50`.

## Context

ADR-009 records that **M6 — Orchestrator agent (autonomous phase advance)** is
deferred pending product decision. After ADR-015 + ADR-016 shipped (M2 board
keyboard nav, M5 per-phase agent resolver, RESEARCH artifact UX, bidirectional
dependency graph), three small but real facts are now true:

1. `canEnterPlanning(input)` in `packages/application/src/can-enter-planning.ts`
   already gives a deterministic, idempotent yes/no for "is this `BACKLOG` Task
   ready to enter `PLANNING`?" — it checks (a) phase, (b) RESEARCH artifact
   presence, (c) `validation === 'VALID'`.
2. `recordResearchArtifact(input, deps)` in
   `packages/application/src/research-use-cases.ts` lines 43–66 persists the
   artifact today, but does **not** advance the Task — the user still has to
   click "Begin planning" manually.
3. `ApplicationSettings` (`packages/domain/src/application-settings.ts`)
   already owns a Settings-shaped extension point with CAS revision and
   IPC validator discipline.

That gap is small but visible: a user who runs a research Agent and watches a
valid `research/research.md` appear must then perform one no-brainer click
("Begin planning") that the system could perform itself. ADR-009 deferred this
deliberately because the **autonomous-advance** framing risks surprising the
user; the minimal slice below does not have that risk because:

- It triggers from an **explicit artifact write** (the research session
  finalizing evidence), not from PTY events or session status.
- It is gated by a **user opt-in Settings flag** that defaults to off.
- It performs only **one transition** (`BACKLOG → PLANNING`); it never touches
  PLANNING → RUNNING, REVIEW → DONE, or any session lifecycle.

This ADR records that minimal slice. It deliberately does **not** commit to a
full orchestrator (no retry orchestration, no multi-phase advance, no rollback,
no notification system).

## Goals

1. When a `BACKLOG` Task has its plugin binding set to a phase whose
   `research` evidence is required, and a `VALID` RESEARCH artifact has just
   been recorded for that Task, **automatically** transition the Task to
   `PLANNING` — but only if the user has opted in via Settings.
2. The opt-in is a single boolean (`researchAutoAdvance: boolean`) in
   `ApplicationSettings`, defaulting to `false`.
3. The auto-advance path is observable, idempotent, and easy to disable:
   - The transition uses the existing `transitionTask({ taskId, to: 'PLANNING' }, tasks, artifacts)`
     use case so Domain validation, Application policy, and the
     `canEnterPlanning` gate are all reused.
   - The transition is wrapped in `serializeTaskWorkflow(taskId, …)` so a
     concurrent research write + manual "Begin planning" click cannot double-fire.
   - On failure (e.g. concurrent PLANNING already started) the orchestrator
     silently no-ops; it never raises to the renderer.
4. The user can audit what happened: a new `researchAutoAdvance` field in the
   workspace read model and a tiny `ResearchAutoAdvanceEvent` row persisted
   on the `AgentSession` event history (or, if that proves too coupled, a new
   `TaskTransitionAudit` table — see AD-2).

## Non-goals

- No autonomous advance from `PLANNING → RUNNING` or `REVIEW → DONE`. Those
  still require user action (`Accept plan` / `Request review`).
- No retry orchestration, no agent re-prompting, no rollback.
- No notification toasts, emails, or system notifications.
- No orchestrator brain, no LLM-driven phase decision.
- No change to the board view keyboard semantics (those shipped in ADR-015).
- No change to the WORKTREE lifecycle, no auto-merge, no push.
- No new IPC channel exposing auto-advance — it is triggered only by
  `recordResearchArtifact` and therefore invisible to the renderer.

## Architectural decisions

### AD-1: Settings opt-in is required (default = off)

Add one new boolean key to `ApplicationSettings`:

```ts
researchAutoAdvance: boolean;  // default false
```

Surface:

- Domain: extend `ApplicationSettings` + `ApplicationSettingsDefaults` +
  `CreateApplicationSettingsInput` + `InvalidApplicationSettingsReason`.
- Application: extend `UpdateApplicationSettingsInput` + validation in
  `inspectSettings`.
- IPC: extend `settings.update` payload validator in
  `apps/desktop/src/ipc-contract.ts` (around lines 645–685).
- Renderer: one toggle in `apps/desktop/src/renderer/settings-panel.tsx`
  next to `allowClipboardReadWrite`. Tooltip text copied from ADR.

Schema bump `schemaVersion: 2` → `schemaVersion: 3`. The SQLite
`application_settings` row uses a singleton_id=1 row; existing rows
migrate by writing defaults on read.

### AD-2: Auto-advance lives in Application, not Domain or Infrastructure

A new use case `autoAdvanceBacklogTaskAfterResearch(input, deps)` in
`packages/application/src/research-orchestrator.ts` (new file):

```ts
export interface AutoAdvanceBacklogTaskInput {
  readonly artifact: ExecutionArtifact;
}

export interface AutoAdvanceBacklogTaskDependencies {
  readonly artifacts: ExecutionArtifactRepository;
  readonly settings: ApplicationSettingsRepository;
  readonly tasks: TaskRepository;
  readonly transitions: TaskTransitionLog; // see AD-3
}

export async function autoAdvanceBacklogTaskAfterResearch(
  input: AutoAdvanceBacklogTaskInput,
  deps: AutoAdvanceBacklogTaskDependencies,
): Promise<{ transitioned: boolean; reason?: string }>;
```

Behavior (single function, no event bus):

1. Re-load settings via `settings.get()`; if `researchAutoAdvance === false`,
   return `{ transitioned: false, reason: 'DISABLED' }`.
2. Re-load task via `tasks.findById(input.artifact.taskId)`.
3. If `task.phase !== TaskPhase.BACKLOG` → `{ transitioned: false, reason: 'PHASE_NOT_BACKLOG' }`.
4. If `input.artifact.kind !== ExecutionArtifactKind.RESEARCH` or
   `input.artifact.validation !== 'VALID'` → `{ transitioned: false, reason: 'ARTIFACT_INVALID' }`.
5. Re-run `canEnterPlanning({ artifacts, taskId, taskPhase })` for
   belt-and-braces verification (it MUST pass because `input.artifact` is the
   latest VALID one).
6. Wrap the rest in `serializeTaskWorkflow(taskId, async () => …)` so any
   concurrent transition serializes. Use the existing `transitionTask` use
   case (already in `task-use-cases.ts` line 47) — do NOT call Domain
   `transitionTask` directly.
7. On success, append a `TaskTransitionAudit` row (see AD-3) with
   `trigger: 'RESEARCH_AUTO_ADVANCE'` and return `{ transitioned: true }`.
8. Catch `TaskResearchPhaseError`, `TaskPlanningFlowRequiredError`, and
   `EntityNotFoundError`; return `{ transitioned: false, reason: '<NAME>' }`.
   Never rethrow.

The use case is **only** called from inside `recordResearchArtifact` (in
`packages/application/src/research-use-cases.ts`) **after** the artifact is
successfully persisted. The call is fire-and-forget (no await) so a slow
SQLite write cannot block the renderer response.

### AD-3: A new `task_transition_audit` table preserves evidence

Persisted audit trail. Reusing `agent_session_events` would conflate Task
and Session lifecycles (violates `agentterm-session-lifecycle` skill). A new
table keeps the seam clean.

Domain: new file `packages/domain/src/task-transition-audit.ts`:

```ts
export const TaskTransitionTrigger = Object.freeze({
  MANUAL: 'manual',
  RESEARCH_AUTO_ADVANCE: 'research-auto-advance',
} as const);

export interface TaskTransitionAudit {
  readonly id: string;
  readonly taskId: string;
  readonly fromPhase: TaskPhase;
  readonly toPhase: TaskPhase;
  readonly trigger: TaskTransitionTrigger;
  readonly artifactId: string | undefined; // present iff RESEARCH_AUTO_ADVANCE
  readonly createdAt: number;
}

export function createTaskTransitionAudit(input: CreateTaskTransitionAuditInput): TaskTransitionAudit;
```

Persistence: extend `packages/infrastructure/src/sqlite/migrations.ts` with
migration `017_research_auto_advance.sql`:

```sql
CREATE TABLE task_transition_audit (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  from_phase TEXT NOT NULL,
  to_phase TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  artifact_id TEXT REFERENCES execution_artifacts(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_task_transition_audit_task ON task_transition_audit(task_id, created_at DESC);
```

New port in `packages/application/src/ports.ts`:

```ts
export interface TaskTransitionLog {
  append(audit: TaskTransitionAudit): Promise<void>;
  listByTaskId(taskId: string): Promise<readonly TaskTransitionAudit[]>;
}
```

SQLite implementation in
`packages/infrastructure/src/sqlite/task-transition-audit.ts`.

### AD-4: `transitionTask` writes the audit row alongside the phase change

Extend the existing Application `transitionTask` in
`packages/application/src/task-use-cases.ts` lines 47–81 to also write a
`TaskTransitionAudit` row with `trigger: 'MANUAL'` (when called from the
desktop `beginTaskPlanning` IPC handler) or with the supplied trigger when
the orchestrator calls it. The function signature gains an optional
`trigger: TaskTransitionTrigger` parameter; default = `'MANUAL'`. This is
the **only** change to `transitionTask`; it remains backwards compatible
because every existing call site can omit the new argument.

The orchestrator (`autoAdvanceBacklogTaskAfterResearch`) calls
`transitionTask` with `trigger: 'RESEARCH_AUTO_ADVANCE'`.

### AD-5: No renderer changes to the workspace

The renderer does **not** show a toast, an animation, or a notification when
auto-advance fires. The Task phase will simply update in the workspace on
the next read (existing behavior). This matches the explicit non-goal "no
notification toasts" and respects the "smallest coherent vertical slice"
rule from AGENTS.md.

However, the workspace read model surfaces the **count** of
`RESEARCH_AUTO_ADVANCE` transitions per task so the user can later audit
what happened:

- New field `WorkspaceTaskOverview.autoAdvanceCount: number` (default `0`)
  in `packages/application/src/workspace-overview.ts`.
- Populated by joining `task_transition_audit` rows where
  `trigger = 'RESEARCH_AUTO_ADVANCE'` per Task.
- Renderer shows it in the Task inspector footer as a tiny
  `<span data-auto-advance-count>` only when count > 0; no copy change to
  the board view.

This is the **only** renderer-visible change beyond the Settings toggle.

## Milestones

One milestone, one PR. The work is mechanical and small; staging it across
multiple branches would multiply review cost without value.

### M-RES-ORCH — Auto-advance BACKLOG → PLANNING

**Scope:**

1. **Domain** (`packages/domain/`)
   - `execution-artifact.ts`: no change.
   - `application-settings.ts`: add `researchAutoAdvance: boolean` (default
     `false`), bump `schemaVersion` to `3`, add
     `INVALID_RESEARCH_AUTO_ADVANCE` to `InvalidApplicationSettingsReason`.
   - `task-transition-audit.ts` (new): Domain value + `createTaskTransitionAudit`
     factory + `TaskTransitionTrigger` enum.

2. **Application** (`packages/application/src/`)
   - `ports.ts`: add `TaskTransitionLog` port.
   - `task-use-cases.ts`: extend `transitionTask` to accept optional
     `trigger` parameter and write audit row.
   - `research-orchestrator.ts` (new): `autoAdvanceBacklogTaskAfterResearch`
     use case (AD-2 spec).
   - `research-use-cases.ts`: after `dependencies.artifacts.insert(artifact, task.phase)`
     succeeds, fire-and-forget call to
     `autoAdvanceBacklogTaskAfterResearch({ artifact }, deps)`. New
     dependency: `applicationSettings?: ApplicationSettingsRepository` and
     `taskTransitions: TaskTransitionLog`.
   - `workspace-overview.ts`: populate `autoAdvanceCount` per task.

3. **Infrastructure** (`packages/infrastructure/`)
   - `sqlite/migrations.ts`: add `017_research_auto_advance.sql` (AD-3 SQL).
   - `sqlite/repositories.ts`: register `SqliteTaskTransitionLog` mapping.
   - `sqlite/task-transition-audit.ts` (new): implementation of `TaskTransitionLog`.
   - `sqlite/application-settings.ts`: ensure the singleton read path
     defaults `researchAutoAdvance` to `false` when the column is absent
     (forward-compatible read of legacy rows).
   - `desktop-application.ts`: pass `taskTransitions: new SqliteTaskTransitionLog(db)`
     and the existing `applicationSettings` into `executionDependencies` /
     `researchDependencies`.

4. **Desktop composition + IPC**
   - `ipc-contract.ts`: extend `settings.update` validator to accept
     `researchAutoAdvance: boolean`; bump payload schema version.
   - `desktop-main-handlers.ts`: no new handler; existing `settings.update`
     handler already delegates to `updateApplicationSettings`.

5. **Renderer**
   - `settings-panel.tsx`: add a labeled checkbox "Auto-advance to Planning
     after a valid Research artifact" bound to
     `view.settings.researchAutoAdvance`. Disabled while saving.
   - `agent-workspace.tsx`: in the Task inspector footer, when
     `selected.autoAdvanceCount > 0`, render
     `<span class="auto-advance-badge" data-auto-advance-count>↻ auto-advanced N×</span>`.
   - No palette command, no mnemonic, no toast.

6. **Tests**
   - Domain: `task-transition-audit.test.ts` — factory validation.
   - Domain: extend `application-settings.test.ts` for the new field.
   - Application: `research-orchestrator.test.ts` (new) — covers:
     - Disabled by default → `transitioned: false, reason: 'DISABLED'`.
     - Wrong artifact kind → no-op.
     - Phase not BACKLOG → no-op.
     - `canEnterPlanning` failure (re-runs for belt-and-braces) → no-op.
     - Happy path → task phase is PLANNING, audit row exists with
       `trigger: 'RESEARCH_AUTO_ADVANCE'`.
     - Concurrent transition (mock `serializeTaskWorkflow` collision) →
       no double-write, no exception leaked.
   - Application: extend `task-use-cases.test.ts` for the new audit write.
   - Application: extend `research-use-cases.test.ts` for the
     fire-and-forget call (verify it's called with the persisted artifact).
   - Infrastructure: `sqlite/task-transition-audit.integration.test.ts`
     (new) — round-trip insert + `listByTaskId` returns rows in DESC order.
   - Renderer: extend `settings-panel.test.tsx` (or similar) — toggle
     persists; round-trips via `updateSettings`.
   - Renderer: snapshot test for the new
     `<span data-auto-advance-count>` element.
   - Architecture: `tests/architecture/workspace-boundaries.test.ts` — no
     change expected because no new dependency edge is added.

## Risks

1. **Silent surprise.** A user enables auto-advance, walks away, comes back
   to a Task in `PLANNING` without a session running.
   Mitigation: (a) default off; (b) explicit Settings label that says
   "Auto-advance to Planning after a valid Research artifact"; (c) the
   auto-advance count is visible in the inspector; (d) this ADR explicitly
   does NOT auto-start the planning session — only the phase advances, the
   user still presses "Begin planning" / presses `Alt+P` to start the
   planning Agent.

2. **Concurrent transition race.** Two research sessions writing
   `research/research.md` simultaneously; or a manual "Begin planning"
   click racing an auto-advance.
   Mitigation: (a) the orchestrator wraps the whole advance in
   `serializeTaskWorkflow`; (b) Domain `transitionTask` rejects illegal
   transitions; (c) the orchestrator catches
   `InvalidTaskPhaseTransitionError` and returns
   `{ transitioned: false, reason: 'CONCURRENT_TRANSITION' }`.

3. **Settings migration.** Existing users have `schemaVersion: 2` rows
   without `research_auto_advance`. Mitigation: the SQLite read path
   defaults the missing column to `false`. Migration file is additive
   (column added with default), no data loss.

4. **Audit table growth.** `task_transition_audit` is append-only. For a
   project with 10k Tasks and 5 transitions each, that's 50k rows.
   Mitigation: indexed by `(task_id, created_at DESC)`; `listByTaskId` is
   bounded by realistic Task history; no global query path.

5. **Re-advance on every retry.** If a Task is rolled back from PLANNING
   to BACKLOG (existing accepted behavior) and a new RESEARCH artifact is
   written, the orchestrator will re-advance. This is desired behavior;
   the audit log makes it auditable.

## Validation plan

- `pnpm typecheck` — must pass with `schemaVersion: 3` bumped.
- `pnpm lint` — must pass.
- `pnpm test` — new + extended tests above; full suite must remain green.
- **Manual smoke (Windows ConPTY + Electron 43 dev):**
  1. Open a Project with the `agtx` plugin bound to a `BACKLOG` Task.
  2. Settings → confirm "Auto-advance to Planning" is **off** by default.
  3. Start a research Agent (`Alt+Shift+E`); wait for the session to
     produce `research/research.md` with a valid body.
  4. Confirm the Task stays in `BACKLOG` after the artifact appears (auto
     advance off).
  5. Toggle "Auto-advance to Planning" on in Settings.
  6. Roll the Task back to `BACKLOG` (or use a second test Task), run a
     fresh research session, confirm the Task automatically advances to
     `PLANNING` after the valid artifact lands.
  7. Confirm `task_transition_audit` has a new row with
     `trigger = 'research-auto-advance'`.
  8. Confirm the Task inspector shows `↻ auto-advanced 1×` (or `2×` for
     the second test).
  9. Roll the Task back to BACKLOG again, manually press
     "Begin planning" (Alt+P). Confirm audit row with
     `trigger = 'manual'`.
- **Architecture check:** `tests/architecture/workspace-boundaries.test.ts`
  must still pass (no new dependency edges introduced).
