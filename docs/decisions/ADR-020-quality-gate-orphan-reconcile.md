# ADR-020: Auto-reconcile orphan Quality Gate attempts at startup

Status: Accepted
Date: 2026-09-13
Owner: AgentTerm domain + application + infrastructure + desktop
Shipped: this PR.

## Context

`docs/CURRENT_STATE.md` §"Blockers" recorded:

> If AgentTerm exits after a gate process finishes but before its
> final SQLite checkpoint, or process tree cleanup cannot be confirmed,
> that run remains durably `RUNNING` and Review admission is blocked.
> Automatic reconciliation of such orphan or unsettled gate attempts
> is deferred; a retry must use a new run id and preserve the old row.

The orphan is a real failure mode. The Quality Gate runner writes
exactly one `RUNNING` row to SQLite before launching the gate process,
and exactly one terminal row after the process settles
(`PASSED | FAILED | TIMED_OUT | LAUNCH_FAILED | INFRASTRUCTURE_FAILED`).
Between those two writes the runner owns the process. If the
AgentTerm process dies in that window — a host crash, a power loss,
the user ending the process from Task Manager before the runner
finalizes — the gate process's outcome is lost forever and the
SQLite row stays `RUNNING`. Two downstream consequences follow:

- `canRunQualityGate` in `workspace-overview.ts:363` stays `false`
  because the gate evidence summary still says `hasRunning = 1`.
- Review admission through the unchanged `hasUnsettledReviewWriter`
  and gate evidence checks stays blocked.

The only human workaround today is "delete the SQLite row by hand."
Neither safe (no audit trail of who deleted what and why) nor
explainable (no record that the process died before settlement).
The symmetric agent-session restore (ADR-019's reference work plus
the existing `restoreAgentSessionsAfterRestart`) already solved the
AgentSession side with a single compare-and-set finalize at every
desktop startup. The Quality Gate side never got the symmetric
treatment.

The slice this ADR records is the smallest close-out:

1. Domain owns the orphan finalization: a tiny helper that
   transitions `RUNNING → INFRASTRUCTURE_FAILED` with a synthesized
   empty bounded output. The helper refuses non-`RUNNING` rows and
   refuses chronology violations.
2. Application owns the startup reconcile: one use case that reads
   every still-`RUNNING` row, finalizes each as
   `INFRASTRUCTURE_FAILED`, swallows the compare-and-set loss when a
   concurrent window has already finalized the row, and reports
   exactly which ids this process actually finalized.
3. Infrastructure exposes one new repository method (`listUnsettled`)
   on the existing `QualityGateRunRepository` port; no schema
   change.
4. Desktop wires the use case into the existing startup sequence
   immediately after `restoreAgentSessionsAfterRestart`.
5. Renderer is untouched. `canRunQualityGate` flips automatically once
   SQLite reflects the reconciled rows, and the very first
   `loadAgentWorkspace` IPC response already returns the reconciled
   state because the reconcile runs before any handler can be
   invoked.

## Goals

1. Every Quality Gate row whose `status = 'RUNNING'` at the moment
   the previous AgentTerm process exits is finalized as
   `INFRASTRUCTURE_FAILED` on the next startup, with a real
   `finishedAt` / `durationMs` derived from the wall clock.
2. The finalize is compare-and-set against `status = 'RUNNING'` —
   if another desktop window has already finalized the row, the
   orphan reconcile skips it instead of overwriting.
3. The reconcile runs **after** SQLite is opened and **before** any
   IPC handler can be invoked. Review admission, `canRunQualityGate`,
   and the workspace's gate evidence projection all reflect the
   reconciled state on the first paint.
4. No Domain event is invented. The Quality Gate's `finishedAt` +
   `failureCategory: 'INFRASTRUCTURE'` row is the audit trail.
5. Existing test suite stays green; new tests cover the happy path,
   the conflict-on-reconcile path, the "no orphans" path, and the
   end-to-end SQLite integration.

## Non-goals

- **Replaying output we never observed.** The bounded redacted sink
  is in-memory and dies with the Electron process. We never invent
  bytes; the empty output with reference
  `${UNOBSERVED_GATE_OUTPUT_REFERENCE}:${run.id}` makes the absence
  observable to audit reviewers.
- **Re-running the gate.** The user retries manually with a new run
  id; the existing `runQualityGate` use case already enforces that
  invariant.
- **Detecting a live process.** Gate processes do not have a
  per-process host (unlike `node-pty`). They live inside the Windows
  Job Object owned by the runner that died. There is nothing safe to
  reattach; finalize-and-mark-as-infrastructure-failed is the only
  honest answer.
- **Adding a new Transition Audit record.** The Quality Gate row's
  `failureCategory` and `finishedAt` is the audit trail; we do not
  invent a second write.
- **Migrating the schema.** No DDL change; the existing schema
  already stores `status`, `finished_at`, `duration_ms`,
  `failure_category`, and `output_*`. The empty bounded output
  satisfies the existing constraints.
- **Touching the MCP server.** The orphan gate is internal SQLite
  state; AI agents see the reconciled state through the existing
  read tools without any new protocol surface.
- **Touching the renderer.** `canRunQualityGate` is a pure projection
  of the persisted state; once SQLite reflects the reconciled rows,
  the renderer naturally flips the gate action to available.

## Architectural decisions

### AD-1: Domain owns the orphan finalization

`packages/domain/src/quality-gate.ts` exports a new helper
`reconcileOrphanQualityGateRun(run, finishedAt)` that returns a new
`QualityGateRun` with `status: INFRASTRUCTURE_FAILED`,
`failureCategory: 'INFRASTRUCTURE'`, `durationMs: finishedAt - run.startedAt`,
`finishedAt`, and a `QualityGateOutput` whose `reference` is
`${UNOBSERVED_GATE_OUTPUT_REFERENCE}:${run.id}`. The function throws
`InvalidQualityGateRunTransitionError` if `run.status !== RUNNING`
and throws `TypeError` if `finishedAt` is missing, negative,
non-integer, or earlier than `run.startedAt`.

Reusing `completeQualityGateRun` with `kind: 'infrastructure-failed'`
is tempting but its input shape was designed around an observed
process result, not a synthesized audit entry. The new helper is
short, accepts the existing Domain invariant shape, and keeps the
"no synthesis of bytes we never observed" discipline explicit.

The synthesized `output.reference` includes `run.id` because the
schema enforces `UNIQUE` on `output_reference`, and several orphans
from the previous process must coexist in the same database.

### AD-2: One new Application use case, one new repository method

`packages/application/src/quality-gate-restore.ts` exports
`reconcileOrphanQualityGateRuns(dependencies)`. The function:

1. Reads every still-`RUNNING` row ordered by `startedAt ASC`.
2. For each row: builds a finalized replacement via
   `reconcileOrphanQualityGateRun(row, clock())`.
3. Calls `runs.finalize(reconciled, 'RUNNING')` — the existing
   compare-and-set rejects if a concurrent window has already
   finalized. The use case swallows that rejection and continues.
4. Returns `ReconcileOrphanQualityGateRunsResult { readonly
reconciledRunIds: readonly string[] }`.

The new repository method `listUnsettled(): Promise<readonly
QualityGateRun[]>` is a single prepared statement on
`SqliteQualityGateRunRepository`. It returns rows ordered by
`started_at, ordinal` so older orphans finalize first. No mapper
change — `mapQualityGateRunRow` already handles the column shape.

### AD-3: The use case stays read-only outside `finalize`

It does not delete rows, does not insert a second `RUNNING` row, and
does not touch any other repository. The compare-and-set on
`status = 'RUNNING'` is the cross-process backstop; the in-process
serialization through `Promise` chain is unnecessary because we do
not launch any concurrent finalize from this process.

### AD-4: Wire into `desktop-application.ts` next to the agent restore

The existing pattern is:

```ts
await restoreAgentSessionsAfterRestart(persistence.sessions, clock, {
  reattachAttempt,
  resumeAttempt,
  resumeInitialSize: initialTerminalSize,
});
```

We add **one line** after that block:

```ts
await reconcileOrphanQualityGateRuns({
  clock,
  runs: persistence.qualityGateRuns,
});
```

It runs before any IPC handler can be invoked (the desktop returns
404-equivalent until composition finishes) and before
`loadAgentWorkspace` can be called by the renderer. The first paint
the renderer receives is already reconciled.

### AD-5: Renderer does not change

`canRunQualityGate` is a pure projection of the persisted gate
evidence summary (`hasRunning` flag from
`SqliteQualityGateRunRepository.reviewEvidenceSummaryByTaskId`).
Once SQLite reflects the reconciled rows, the renderer naturally
flips the gate action to available. We add no new event, no new IPC
channel, and no new reducer.

### AD-6: Test discipline matches the agent-restore slice

Three Application unit tests cover:

1. **Happy path.** Two `RUNNING` rows finalize in `startedAt` order.
   Final `finalize` calls were made with `expectedStatus: 'RUNNING'`.
   Result reports both ids. A pre-existing `PASSED` row stays
   untouched.
2. **Race lost.** A second concurrent finalize turns the row into
   `PASSED` before our reconcile reaches it. Our
   `runs.finalize(reconciled, 'RUNNING')` throws. The use case reads
   the row, sees `status !== 'RUNNING'`, and continues with the next
   row. Final report does **not** include that id.
3. **No orphans.** `listUnsettled()` returns `[]`. No finalize calls.

Plus one SQLite integration test that opens a real temporary
database, mixes two `RUNNING` orphan rows with one `PASSED` and one
`FAILED` row, runs the reconcile, and asserts:

- The two orphans become `INFRASTRUCTURE_FAILED` with
  `failure_category = 'INFRASTRUCTURE'`, real `finished_at`,
  `duration_ms`, and the synthesized empty output.
- The `PASSED` and `FAILED` rows are byte-for-byte identical after
  reconcile.
- A second reconcile call returns an empty `reconciledRunIds` and
  makes no `finalize` calls.

Plus three Domain tests for `reconcileOrphanQualityGateRun` itself:

1. Rejects any non-`RUNNING` row without touching the input.
2. Finalizes a `RUNNING` row with `INFRASTRUCTURE_FAILED`, the
   expected `durationMs` / `finishedAt`, and the empty
   `${UNOBSERVED_GATE_OUTPUT_REFERENCE}:${run.id}` output.
3. Rejects `finishedAt` that is missing, negative, non-integer, or
   precedes `startedAt`.

## Scope

### Files added

1. `packages/application/src/quality-gate-restore.ts` — the use
   case.
2. `packages/application/src/quality-gate-restore.test.ts` — three
   unit tests.
3. `packages/infrastructure/src/quality-gate-restore.integration.test.ts` —
   one SQLite end-to-end test.
4. `docs/decisions/ADR-020-quality-gate-orphan-reconcile.md` — this
   document.

### Files modified

1. `packages/domain/src/quality-gate.ts` — add
   `reconcileOrphanQualityGateRun`, `UNOBSERVED_GATE_OUTPUT_REFERENCE`.
2. `packages/domain/src/index.ts` — re-export the new symbols.
3. `packages/domain/src/quality-gate.test.ts` — add the three new
   tests for the helper.
4. `packages/application/src/ports.ts` — add `listUnsettled()` to
   `QualityGateRunRepository`.
5. `packages/application/src/index.ts` — re-export the use case.
6. `packages/infrastructure/src/sqlite/repositories.ts` — add
   `listUnsettledStatement` and `listUnsettled()` on
   `SqliteQualityGateRunRepository`. No new migration.
7. `apps/desktop/src/desktop-application.ts` — import and call the
   use case right after `restoreAgentSessionsAfterRestart`.
8. `docs/CURRENT_STATE.md` — delete the §"Blockers" paragraph and
   add one bullet under §"Recently Shipped".

### Files NOT modified

- Any renderer file. The `canRunQualityGate` projection flips
  automatically once SQLite reflects the reconciled rows.
- Any Quality Gate test fixture. The existing
  `packages/infrastructure/src/sqlite-quality-gate-persistence.integration.test.ts`
  covers the happy finalize path and stays green.
- `packages/infrastructure/src/quality-gate/node-quality-gate-process-runner.ts`.
  The runner owns process settlement; reconciliation is a separate
  responsibility and runs **before** the runner can observe anything.
- Any MCP server file. The orphan gate is internal SQLite state.

## Tests

### Unit tests (added in this PR)

- `packages/application/src/quality-gate-restore.test.ts` — 3 tests.
- `packages/domain/src/quality-gate.test.ts` — 3 tests in a new
  `describe('reconcileOrphanQualityGateRun', ...)` block.

### Integration test (added in this PR)

- `packages/infrastructure/src/quality-gate-restore.integration.test.ts` —
  2 tests: end-to-end reconcile with mixed rows, plus a "no orphans"
  steady state.

### Existing tests

- `packages/infrastructure/src/sqlite-quality-gate-persistence.integration.test.ts`
  must remain green (no schema change; the existing finalize path is
  reused).
- `packages/application/src/quality-gate-use-cases.test.ts` must
  remain green (no public surface change to `runQualityGate`).
- Desktop test suite must remain green (no IPC, bridge, controller,
  or view change).

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
  2. Open the SQLite database, insert one synthetic
     `quality_gate_runs` row with `status = 'RUNNING'` for an
     existing Task.
  3. Launch the desktop, observe the reconciliation log line, open
     the workspace, confirm `canRunQualityGate` is available again
     and the gate row is `INFRASTRUCTURE_FAILED` with the synthesized
     empty output.

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
   no one else owns the Job Object after we exit." A runner that is
   mid-flight has already moved the row to a terminal status before
   we boot, so `listUnsettled` does not return it. Mitigation: AD-1
   throws if the row is not `RUNNING`.
3. **Clock drift between windows.** Two windows racing the same
   orphan may record slightly different `finishedAt`; the first
   window to call `finalize` wins. Mitigation: the second window
   loses the compare-and-set and does not overwrite. The audit trail
   is consistent.
4. **CURRENT_STATE drift sneaking back.** Once we delete the
   §"Blockers" paragraph, a future doc edit could reintroduce it.
   Mitigation: the new §"Recently Shipped" bullet explicitly
   references ADR-020 and the desktop wiring, so a future agent has
   an anchor for honesty.
5. **Schema `output_reference` uniqueness.** Two orphan rows with
   the same synthesized reference would violate the schema's
   `UNIQUE` constraint. Mitigation: AD-1 builds the reference from
   `${UNOBSERVED_GATE_OUTPUT_REFERENCE}:${run.id}`, making each
   reference unique by construction.

## Out of scope

- Replaying the bounded redacted output we never observed. We never
  invent bytes; the empty output with the per-row reference is the
  honest answer.
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
- Cleaning up the gate row instead of finalizing. The slice
  explicitly preserves every attempt per the existing
  `runQualityGate` invariant.
