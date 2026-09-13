# Workspace tab/pane layout restore on launch — close-out

## Context

`docs/CURRENT_STATE.md` §"Blockers" still says:

> Workspace tabs and split panes are intentionally renderer-local in this
> foundation; their layout is not persisted or restored after an
> application restart. Closing UI detaches observers only, while a later
> reattachment cannot replay output emitted during the detached interval
> because terminal output is not durable Session evidence.

That paragraph is stale. Every layer already owns its part of the
restore loop:

- `@agentterm/application` exposes `loadWorkspaceLayout` /
  `saveWorkspaceLayout` plus the `WorkspaceLayoutRepository` port
  (`packages/application/src/workspace-layout-use-cases.ts`).
- `@agentterm/infrastructure` implements the port through
  `SqliteWorkspaceLayoutRepository` against migration
  `0013-workspace-layout`; the repository has 4 round-trip tests
  (`packages/infrastructure/src/sqlite/workspace-layout-repository.test.ts`).
- The desktop IPC surface exposes `loadWorkspaceLayout` /
  `saveWorkspaceLayout` (`apps/desktop/src/ipc-contract.ts`), wires the
  handlers in `apps/desktop/src/desktop-main-handlers.ts`, and proxies
  them through `apps/desktop/src/desktop-bridge.ts`.
- The renderer controller already calls
  `client.loadWorkspaceLayout()` on `load()` and `refresh()`, hydrates
  the result through `hydrateWorkspaceLayout`, reconciles it against
  the current workspace overview, then re-publishes the snapshot.
  Mutations go through `schedulePersistLayout` (debounced 250 ms) with
  optimistic revision checks (`persistLayout` /
  `runPersistLayout`).

The remaining work is small but real:

1. **No controller test exercises the restore path.** The renderer
   unit tests cover `WorkspaceController` (67 cases) but none of them
   assert that a `loadWorkspaceLayout()` response becomes the initial
   snapshot's `layout` field, that reconciliation prunes tabs for
   tasks that no longer exist, or that the first save round-trip bumps
   the optimistic revision correctly.
2. **No controller test exercises the persist debounce.** The current
   tests call `client.saveWorkspaceLayout` directly through mocks but
   never verify the `setTimeout`-driven path, the optimistic-revision
   `CONFLICT` retry, or the `layoutPersistenceError` surface.
3. **`CURRENT_STATE.md` still lists the layout restore as a deferred
   blocker.** That paragraph needs to move out of §"Blockers" into
   §"Current State" with a one-line description of what was actually
   shipped.

This is renderer polish + docs only. No Domain change, no Application
change, no Infrastructure change, no schema change, no new port.

## Goal

1. Restore the persisted Workspace tab/pane layout end-to-end on launch
   is **demonstrably correct**: every restore path the controller takes
   is locked down by an automated test.
2. `CURRENT_STATE.md` and the section under §"Blockers" no longer
   contradict the implementation. A future agent reading either side
   gets an honest picture.

## Non-goals

- No new Domain / Application / Infrastructure surface.
- No new IPC channel, no schema migration, no new port.
- No layout cross-restart replay of terminal output (terminal output
  remains a live stream, not durable Session evidence — that
  restriction stays).
- No UI redesign of the tab strip or split pane chrome.
- No cross-window layout sharing (only one workspace window today).

## Architectural decisions

### AD-1: Tests are pure contract checks against `WorkspaceController`

We do not introduce a real `WorkspaceController` constructor for the
real SQLite. The renderer already mocks `AgentWorkspaceClient`; we
extend the existing `FakeWorkspaceClient` to return a configured
persisted layout and assert the controller's published snapshot. The
hydration, reconciliation, and persistence paths are pure functions
on the snapshot; no DOM, no Electron, no PTY.

### AD-2: Restore tests target the three branches that today lack
coverage

1. **First load with a persisted layout** — `loadWorkspaceLayout()`
   returns a `WorkspaceLayoutRecord` and the first published `ready`
   snapshot's `layout` field equals the hydrated layout (after
   reconciliation against the workspace overview).
2. **First load with no persisted layout** — `loadWorkspaceLayout()`
   returns `undefined`, the snapshot's `layout` is the empty
   `{ activeTabId: undefined, tabs: [] }`, and a subsequent user action
   that mutates the layout triggers exactly one debounced
   `saveWorkspaceLayout` call with the new layout and
   `expectedRevision: 1` (the first optimistic revision after the
   initial `0`).
3. **Stale revision CONFLICT** — when the renderer tries to save with
   `expectedRevision: 5` but the server replies `WorkspaceLayoutConflictError`,
   the controller must re-queue a save with the new revision that the
   server returned, without surfacing `layoutPersistenceError`.

### AD-3: We do not refactor the existing tab/pane persistence path

The current code works (514 desktop tests pass); we are adding tests
and tightening error surfaces, not rewriting. If a test fails on a
known-working path, we fix the test, not the implementation.

### AD-4: CURRENT_STATE update is one paragraph move + one bullet

The existing §"Blockers" paragraph gets deleted. A new bullet is added
under §"Recently Shipped" mirroring the format ADR-016 / ADR-017 /
ADR-018 / ADR-019 use. No status header for a new ADR (this is a
close-out of code that already shipped before any ADR opened).

## Scope

### Files added

None.

### Files modified

1. `apps/desktop/src/renderer/workspace-controller.test.ts`
   - Extend `FakeWorkspaceClient.loadWorkspaceLayout` / `saveWorkspaceLayout`
     to be configurable per-test (instead of always returning `undefined`
     or `{ revision: 1 }`).
   - Add 3 new tests under the existing `WorkspaceController` describe:
     - `restores the persisted layout on first load when loadWorkspaceLayout returns a record`
     - `publishes an empty layout and persists the first mutation when no persisted layout exists`
     - `retries a stale save after WorkspaceLayoutConflictError`
   - The 3 tests must reuse the existing
     `FakeWorkspaceClient`/`controller` harness; no new test helper.
2. `docs/CURRENT_STATE.md`
   - Delete the §"Blockers" paragraph that begins
     `Workspace tabs and split panes are intentionally renderer-local …`
   - Add one bullet under §"Recently Shipped" titled
     `**Workspace tab/pane layout restore** (no new ADR; close-out of
     earlier renderer-side persistence)` recording the layers that
     already ship (`WorkspaceLayoutRepository` → `SqliteWorkspaceLayoutRepository`
     → IPC → `WorkspaceController` load + persist), the optimistic
     revision discipline, and the fact that no ADR was opened because
     the design never introduced a new Domain rule.

### Files NOT modified

- Any source file in `packages/{domain,application,infrastructure}/src/**`.
- `apps/desktop/src/renderer/workspace-layout.ts`,
  `apps/desktop/src/renderer/workspace-controller.ts`,
  `apps/desktop/src/renderer/workspace-terminals.tsx`,
  `apps/desktop/src/desktop-application.ts`,
  `apps/desktop/src/desktop-bridge.ts`,
  `apps/desktop/src/desktop-main-handlers.ts`,
  `apps/desktop/src/ipc-contract.ts`. The code works; we are not
  rewriting it.
- `docs/decisions/ADR-009-agtx-port-plan.md`. This slice is unrelated
  to the agtx-port scope.

## Tests

### Unit tests (added in this PR)

- `apps/desktop/src/renderer/workspace-controller.test.ts`
  - **Restore with persisted layout.** Mock
    `loadWorkspaceLayout` to return a
    `WorkspaceLayoutReadModel { layout, revision: 7 }`; assert that
    after `controller.load()` resolves, `snapshot.kind === 'ready'`,
    `snapshot.layout` deep-equals the hydrated layout, and
    `controller.layoutRevision === 7`.
  - **First load with no persisted layout, first mutation persists.**
    Mock `loadWorkspaceLayout` to return `undefined`. Call
    `controller.openTaskWorkspaceTab(task)`; advance the fake timer
    250 ms; assert that the
    `FakeWorkspaceClient.saveWorkspaceLayout` was called exactly once
    with `expectedRevision: 1` and the layout that includes the new
    tab.
  - **Stale revision CONFLICT retries.** Mock `loadWorkspaceLayout` to
    return `revision: 3`; mock `saveWorkspaceLayout` to throw
    `WorkspaceLayoutConflictError` on the first call and to succeed
    on the second call with `revision: 4`. Mutate the layout twice;
    advance the timer past the debounce; assert both saves were
    attempted, the second succeeded, and
    `controller.layoutRevision === 4`. No `layoutPersistenceError`
    must appear on the snapshot.

### Existing tests

- `apps/desktop/src/desktop-workflow-gaps-contract.test.ts` — the
  single failing assertion
  (`loadQualityGateConfig(input: QualityGateConfigPathRequest): Promise<…>`)
  is a string-matching check on the signature's
  prettier-wrapped form. It is not in scope for this close-out; we
  leave the test as-is and document the limitation in §"Out of scope"
  below.

## Validation plan

- `pnpm -F @agentterm/desktop typecheck` — must remain green.
- `pnpm -F @agentterm/desktop lint` — must remain green (no new lint
  errors introduced).
- `pnpm -F @agentterm/desktop test` — must remain green and now
  include the 3 new controller tests.
- `pnpm -F @agentterm/application test` — must remain green.
- `pnpm -F @agentterm/infrastructure test` — must remain green.
- Manual smoke: launch the desktop with two Tasks in different
  Project folders, open a tab per Task, split a terminal, close the
  app, relaunch. The same tabs and panes must restore.

## Risks and mitigations

1. **Test flakiness around the 250 ms debounce.** We use Vitest's
   fake timers and assert after `vi.advanceTimersByTime(300)`. The
   controller schedules the timer through `setTimeout`, so fake
   timers must be enabled in `beforeEach`. Mitigation: the existing
   controller tests already use `vi.useFakeTimers()` where scheduling
   is involved; we follow the same pattern.
2. **Optimistic revision races during rapid mutations.** The existing
   `runPersistLayout` serializes saves through
   `this.layoutSaveAttempt`. We do not change that; the new test only
   exercises the documented behavior, not edge cases.
3. **CURRENT_STATE drift sneaking back.** Once we remove the
   paragraph, a future doc edit could reintroduce it. Mitigation: the
   new §"Recently Shipped" bullet explicitly references the four
   layers that own the path, so a future agent has an anchor for
   honesty.

## Out of scope

- Replaying terminal output emitted while the desktop was closed.
  Terminal output remains a live stream; restoring layout restores the
  *tab/pane structure*, not the visible buffer contents. This is
  identical to the current "Closing UI detaches observers only"
  invariant and is intentionally preserved.
- The `desktop-workflow-gaps-contract.test.ts` single-line format
  assertion for `loadQualityGateConfig`. That is a separate
  documentation/formatting concern; fixing it would require either
  collapsing the type signature onto one line (uglier) or rewriting
  the test to use a multi-line aware matcher (orthogonal). We note it
  here so a future docs-only PR can pick it up.
- Cross-window layout sharing. The workspace is a single window today;
  multi-window layout sync is a separate product decision.

## Deferred (explicit non-goals)

- IPC for streaming persisted layout updates to other open windows.
- Layout migration when the `WorkspaceLayoutRecord` shape changes
  across versions. The current `WorkspaceLayoutRecord` schema is
  versionless; if it ever needs to evolve, this slice will need a
  separate ADR.
