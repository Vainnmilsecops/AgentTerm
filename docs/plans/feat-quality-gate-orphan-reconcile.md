# Auto-reconcile orphan Quality Gate attempts at startup

## Context

`docs/CURRENT_STATE.md` §"Blockers" still records:

> If AgentTerm exits after a gate process finishes but before its
> final SQLite checkpoint, or process tree cleanup cannot be confirmed,
> that run remains durably `RUNNING` and Review admission is blocked.
> Automatic reconciliation of such orphan or unsettled gate attempts
> is deferred; a retry must use a new run id and preserve the old row.

This is exactly the same shape as the Agent Session startup restore
that already ships. `restoreAgentSessionsAfterRestart` runs at
`desktop-application.ts:219`, iterates `sessions.listActive()`, appends
a `RUNTIME_OWNERSHIP_LOST` event for the ones that no longer have a
live process, and uses revision-checked append to keep two concurrent
desktop windows honest. The Quality Gate side never got the symmetric
treatment: `RUNNING` gate rows from a previous process stay `RUNNING`
forever, `canRunQualityGate` stays `false` in the workspace read
(`packages/application/src/workspace-overview.ts:363` blocks on
`!hasRunningGate`), and Review admission stays blocked through the
unchanged `hasUnsettledReviewWriter` and gate evidence checks. The
human workaround today is "delete the SQLite row by hand" — neither
safe nor explainable.

The reconciliation has to honor every invariant the existing finalize
path already enforces:

- the existing `finalize(run, 'RUNNING')` port method does
  compare-and-set against `status = 'RUNNING'`, so a concurrent
  finalize from a still-live process (Windows ConPTY host that we
  have not killed yet) loses the race and we leave the row alone;
- `completeQualityGateRun` already accepts
  `kind: 'infrastructure-failed'` and produces a `RUNNING →
  INFRASTRUCTURE_FAILED` transition with `failureCategory:
  'INFRASTRUCTURE'` and a real `durationMs`/`finishedAt`;
- the gate row's `output` is intentionally **not** synthesized —
  we never invent redacted output for a process we did not observe.
  An empty `QualityGateOutput { reference: '<unobserved>',
  text: '', truncated: false }` is honest: the runner never wrote a
  byte to its bounded sink because the process settlement was
  unconfirmed.

This slice is the smallest possible close-out: one Domain helper,
one Application use case + test, one repository method, one wiring
call in `desktop-application.ts`, one integration test. No new port
beyond `listUnsettledRuns` (a thin query) and no schema migration.

## Goal

1. On every desktop startup, every Quality Gate row that is still
   `status = 'RUNNING'` from a previous process is finalized as
   `INFRASTRUCTURE_FAILED` with an explicit, sanitized reason
   (`PROCESS_TREE_UNCONFIRMED_AT_RESTART`) and a real
   `finishedAt`/`durationMs`.
2. The finalize is revision-checked: if another desktop window has
   already finalized the row (live process we did not own), the
   reconciliation loses the compare-and-set and leaves the row
   alone.
3. The reconciliation runs **after** SQLite is opened and **before**
   the first `loadAgentWorkspace` IPC response. Review admission,
   `canRunQualityGate`, and the workspace's gate evidence projection
   all reflect the reconciled state on the first paint.
4. Existing test suite stays green; new tests cover the happy path,
   the conflict-on-reconcile path, and the "no RUNNING rows" path.

## Non-goals

- Replaying the process output we never observed. We do not invent
  bytes; an empty bounded output with `reference: '<unobserved>'`
  replaces the missing redacted sink evidence.
- Re-running the gate. The user retries manually with a new run id;
  the existing `runQualityGate` use case enforces that.
- Detecting a live process for the gate. Gate processes do not have
  a per-process host (unlike `node-pty`) — they live inside the
  Windows Job Object owned by the runner that died. There is nothing
  safe to reattach; finalize-and-warn is the only honest answer.
- Adding a new Audit or Transition record for the reconciliation.
  The Quality Gate's `finishedAt` + `failureCategory: 'INFRASTRUCTURE'`
  is the audit trail; we do not invent a second write.
- Migrating `quality_gate_runs` to a new column. The existing schema
  already stores `status`, `finished_at`, `duration_ms`,
  `failure_category`, `output_*`; no DDL change.
- Touching the `mcp-server` package. The orphan gate is internal
  SQLite state; AI agents see the reconciled state through the
  existing read tools.

## Architectural decisions

### AD-1: Domain owns the orphan finalization

We add a tiny Domain helper `reconcileOrphanQualityGateRun(run, finishedAt)`
that returns a new `QualityGateRun` with `status: INFRASTRUCTURE_FAILED`,
`failureCategory: 'INFRASTRUCTURE'`, `durationMs: finishedAt - run.startedAt`,
`finishedAt`, and a `QualityGateOutput { reference: '<unobserved>',
text: '', truncated: false }`. The function throws if `run.status !==
RUNNING`. This mirrors the existing `completeQualityGateRun` invariant
and lets Domain tests assert the shape without touching the
Application port.

Reusing `completeQualityGateRun` with `kind: 'infrastructure-failed'`
is tempting but produces the wrong `failureCategory` (it would still
emit `'INFRASTRUCTURE'`, but the `text: ''` output is harder to
plumb through `CompleteQualityGateRunInput`). The new helper is six
lines and keeps the read-only evidence explicit.

### AD-2: One new Application use case, one new repository method

`reconcileOrphanQualityGateRuns(dependencies)`:

1. `runs.listUnsettled()` returns every `status = 'RUNNING'` row,
   ordered by `startedAt ASC` so older orphans finalize first.
2. For each row: `domain.reconcileOrphanQualityGateRun(row, clock())`.
3. `runs.finalize(reconciled, 'RUNNING')` — the existing compare-and-set
   rejects if another window has already finalized; the use case
   swallows that rejection by reading the row again and proceeding.
4. Return a `ReconcileOrphanQualityGateRunsResult { readonly
   reconciledRunIds: readonly string[] }` so the desktop composition
   can log the count (and so the test can assert the right rows were
   finalized).

The new repository method `listUnsettled(): Promise<readonly
QualityGateRun[]>` is a single prepared statement on
`SqliteQualityGateRunRepository`, mirroring the existing
`listRecentByTaskId`. It returns the row shape the rest of the
repository already exposes, so no new mapper.

### AD-3: The use case is read-only outside the `finalize` call

It does not delete rows. It does not insert a "second" RUNNING row.
It does not touch any other repository. The compare-and-set on
`status = 'RUNNING'` is the cross-process backstop; the in-process
serialization through `Promise` chain is not necessary because we
do not launch any concurrent finalize from this process.

### AD-4: Wire it into `desktop-application.ts` next to the agent restore

The existing pattern is:

```ts
await restoreAgentSessionsAfterRestart(persistence.sessions, clock, {
  reattachAttempt,
  resumeAttempt,
  resumeInitialSize: initialTerminalSize,
});
```

We add **one line** immediately after:

```ts
await reconcileOrphanQualityGateRuns(persistence.qualityGateRuns, { clock });
```

It runs before any IPC handler can be invoked (the desktop returns
404-equivalent until composition finishes) and before
`loadAgentWorkspace` can be called by the renderer. The first paint
the renderer receives is already reconciled.

### AD-5: Renderer does not change

`canRunQualityGate` is already a pure projection of the persisted
state. Once the rows are reconciled, the renderer naturally flips
the gate action to available. We add no new event, no new IPC
channel, and no new reducer.

### AD-6: Test discipline matches the agent-restore slice

We add three Application unit tests + one Infrastructure integration
test:

1. **Reconcile happy path.** Two `RUNNING` rows finalize in `startedAt`
   order. Final `finalize` calls were made with the compare-and-set
   `expectedStatus: 'RUNNING'`. Result reports both ids.
2. **Reconcile loses a race.** A second concurrent finalize turns the
   row into `PASSED` before our reconcile reaches it. Our
   `runs.finalize(reconciled, 'RUNNING')` throws. The use case reads
   the row, sees `status !== 'RUNNING'`, and continues with the next
   row. Final report does **not** include that id.
3. **No orphans.** `listUnsettled()` returns `[]`. No finalize calls.
   Result reports `reconciledRunIds: []`.
4. **SQLite integration.** Real temporary database with two inserted
   `RUNNING` rows + one `PASSED` row + one `FAILED` row. After
   reconcile, the two `RUNNING` rows are `INFRASTRUCTURE_FAILED` with
   `failure_category = 'INFRASTRUCTURE'`; the `PASSED` and `FAILED`
   rows are untouched.

## Scope

### Files added

1. `packages/application/src/quality-gate-restore.ts`
   - `reconcileOrphanQualityGateRuns(dependencies)` async function.
   - `ReconcileOrphanQualityGateRunsResult` typed export.
2. `packages/application/src/quality-gate-restore.test.ts`
   - Three tests described in AD-6.
3. `packages/infrastructure/src/quality-gate-restore.integration.test.ts`
   - One test described in AD-6 against a real SQLite database.
4. `docs/decisions/ADR-020-quality-gate-orphan-reconcile.md`
   - Accepted status, mirroring the existing ADR-019 layout. Records
     AD-1 … AD-6, the new ports, the validation plan, and the
     deferred list.

### Files modified

1. `packages/domain/src/quality-gate.ts`
   - Export `reconcileOrphanQualityGateRun(run, finishedAt)` and a
     frozen `UNOBSERVED_OUTPUT` sentinel.
   - Domain test (1 new case) asserting the helper rejects a non-`RUNNING`
     row and produces the documented shape.
2. `packages/application/src/ports.ts`
   - Add `listUnsettled(): Promise<readonly QualityGateRun[]>` to
     `QualityGateRunRepository`.
3. `packages/application/src/index.ts`
   - Re-export `reconcileOrphanQualityGateRuns`,
     `reconcileOrphanQualityGateRun`, and
     `ReconcileOrphanQualityGateRunsResult`.
4. `packages/infrastructure/src/sqlite/repositories.ts`
   - Add `listUnsettledStatement` and `listUnsettled()` to
     `SqliteQualityGateRunRepository`. No new migration.
5. `apps/desktop/src/desktop-application.ts`
   - One new `await reconcileOrphanQualityGateRuns(...)` call right
     after `restoreAgentSessionsAfterRestart`. Import the new symbol.
6. `docs/CURRENT_STATE.md`
   - Delete the §"Blockers" paragraph that begins
     `If AgentTerm exits after a gate process finishes but before
     its final SQLite checkpoint …`.
   - Add one bullet under §"Recently Shipped" titled
     `**Quality Gate orphan reconciliation at startup** (ADR-020)`
     recording that `RUNNING` gate rows from a previous process are
     finalized as `INFRASTRUCTURE_FAILED` on every desktop startup,
     matching the Agent Session restore discipline.
7. `docs/decisions/ADR-009-agtx-port-plan.md`
   - No change. This slice is unrelated to the agtx-port scope.

### Files NOT modified

- Any renderer file. The `canRunQualityGate` projection flips
  automatically once SQLite reflects the reconciled rows.
- Any Quality Gate test fixture. The existing
  `packages/infrastructure/src/sqlite-quality-gate-persistence.integration.test.ts`
  covers the happy finalize path and stays green.
- `packages/infrastructure/src/quality-gate/node-quality-gate-process-runner.ts`.
  The runner owns process settlement; reconciliation is a separate
  responsibility and runs **before** the runner can observe anything.

## Tests

### Unit tests (added in this PR)

- `packages/application/src/quality-gate-restore.test.ts` (3 tests).
- `packages/domain/src/quality-gate.test.ts` (1 test for the new
  Domain helper — same file, new `describe`).

### Integration test (added in this PR)

- `packages/infrastructure/src/quality-gate-restore.integration.test.ts`
  (1 test): real SQLite, mixed status rows, end-to-end reconcile.

### Existing tests

- `packages/infrastructure/src/sqlite-quality-gate-persistence.integration.test.ts`
  must remain green (no schema change; the existing finalize path is
  reused).
- `packages/application/src/quality-gate-use-cases.test.ts` must
  remain green (no public surface change to `runQualityGate`).
- Desktop test suite: 516 currently passing tests must remain green
  (no IPC, bridge, controller, or view change).

## Validation plan

- `pnpm -F @agentterm/domain typecheck`
- `pnpm -F @agentterm/application typecheck`
- `pnpm -F @agentterm/infrastructure typecheck`
- `pnpm -F @agentterm/desktop typecheck`
- `pnpm -F @agentterm/domain test`
- `pnpm -F @agentterm/application test`
- `pnpm -F @agentterm/infrastructure test`
- `pnpm -F @agentterm/desktop test`
- `pnpm -F @agentterm/desktop lint`
- Manual smoke:
  1. Build the desktop.
  2. Start a Task in `RUNNING`, open the SQLite database, insert one
     synthetic `quality_gate_runs` row with `status = 'RUNNING'`.
  3. Launch the desktop, observe the reconciliation log line, open
     the workspace, confirm the gate action is available again.

## Risks and mitigations

1. **Two desktops racing the same orphan.** Both windows boot, both
   call `reconcileOrphanQualityGateRuns`. The first finalize wins,
   the second loses the compare-and-set and skips the row.
   Mitigation: AD-2 swallows the conflict by re-reading the row and
   continuing. The unit test in AD-6 case 2 covers this.
2. **False positive on a still-live Windows Job Object.** A gate
   runner that the Windows Job Object keeps alive after the Electron
   process dies would be falsely finalized. The gate runner's
   contract is "process settlement is recorded through `finalize`;
   no one else owns the Job Object after we exit". We rely on the
   existing `runQualityGate` invariants: any live gate process is
   attached to a runner that has already issued `finalize`. There is
   no orphan in that case. Mitigation: AD-1 throws if the row is not
   `RUNNING`; a runner that is mid-flight will already have moved
   the row to `PASSED` / `FAILED` before we boot.
3. **Clock drift between windows.** `reconcileOrphanQualityGateRun`
   uses `clock()` for `finishedAt`. Two windows racing the same
   orphan may record slightly different `finishedAt`; the first one
   to call `finalize` wins. Mitigation: the second window loses the
   compare-and-set and does not overwrite. The audit trail is
   consistent.
4. **CURRENT_STATE drift sneaking back.** Once we delete the §"Blockers"
   paragraph, a future doc edit could reintroduce it. Mitigation:
   the new §"Recently Shipped" bullet explicitly references ADR-020
   and `desktop-application.ts:reconcileOrphanQualityGateRuns`, so a
   future agent has an anchor for honesty.

## Out of scope

- Replaying the bounded redacted output we never observed. We never
  invent bytes; the empty output with `<unobserved>` reference is
  the honest answer.
- Migration of historical `RUNNING` rows. The reconciliation runs at
  every startup; legacy orphans are closed the first time the
  upgraded desktop boots. No DDL change is necessary.
- Cross-process live execution reconciliation. That work belongs to
  the deferred terminal output replay slice (CURRENT_STATE §"Blockers"
  second paragraph) and is a much larger surface area.

## Deferred (explicit non-goals)

- Synthesizing output bytes from the runner's bounded sink. The
  runner's sink is in-memory and dies with the Electron process; no
  recovery is possible.
- Adding a per-attempt Transition Audit row for the reconciliation.
  The Quality Gate row's `failureCategory` + `finishedAt` is the
  audit trail; we do not invent a second one.
- Cleaning up the gate row instead of finalizing. The slice explicitly
  preserves every attempt per `packages/application/src/quality-gate-use-cases.ts`'s
  invariant ("earlier evidence is preserved").
