---
name: agentterm-debug-recovery
description: "Diagnose and minimally recover stuck, crashed, missing, or inconsistent AgentTerm state across DB, Git, worktrees, filesystem, PTY, and processes. Use for partial operations and failed retries; gather evidence before mutation and never begin with delete or reset."
---

# Purpose

Reconstruct actual cross-system state, identify the root cause, and restore a safe recoverable state without losing user work or history.

# Inputs

- Collect the symptom, Task and session identifiers, expected state, recent operation, user-visible error, and recovery constraints.
- Use SQLite, Git, Git Worktree, filesystem, PTY, process state, `TaskEvent`, and logs as independent evidence sources.

# Required Workflow

1. **Observe:** Reproduce or characterize the failure without mutating state.
2. **Gather Evidence:** Capture relevant records, events, logs, process status, worktree registration, branch state, filesystem state, and dirty changes.
3. **Reconstruct Actual State:** Build a timeline and distinguish Task phase, execution health, session status, and external-resource state.
4. **Identify Root Cause:** Explain the first broken assumption or operation, not only the final symptom.
5. **Design Minimum Recovery:** Prefer idempotent completion, reconciliation, relinking, or a new session over deletion or reset.
6. **Check Authorization:** If the request is diagnosis-only, stop before mutation and report the proposed recovery. Otherwise confirm the repair is within the requested scope.
7. **Mutate:** Apply the smallest authorized and preferably reversible repair through the owning application ports.
8. **Verify:** Re-read every affected system, exercise the recovered path, and record remaining inconsistencies.

# Invariants

- Trust observed evidence over stale metadata while preserving discrepancies for diagnosis.
- Preserve uncommitted code, branches, worktrees, artifacts, session history, and audit events.
- Do not assume a database transaction can undo Git, filesystem, PTY, or process side effects.
- Keep recovery orchestration here; apply steady-state rules from the Git Worktree, PTY Runtime, Session Lifecycle, Persistence, Artifact, or Quality Gate skill that owns each subsystem.

# Safety Rules

- Never start recovery with delete, reset, force checkout, branch removal, or worktree cleanup.
- Inspect dirty state and active processes before any mutation; snapshot or back up material state when practical.
- Require explicit authorization before an irreversible repair and state exactly what could be lost.
- Stop if evidence is insufficient to identify a safe target.

# Forbidden Changes

- Do not conceal inconsistency by editing only the UI-visible status.
- Do not rewrite session or Task history to make the incident appear successful.
- Do not broaden a minimum repair into unrelated refactoring or cleanup.

# Validation

- Reproduce the failure in a disposable fixture when feasible and add a regression test for the root cause.
- Test crashes between external and database steps, missing filesystem state, stale worktree records, dead processes, duplicate retries, and interrupted recovery.
- Verify user work remains intact and a second recovery attempt is safe.

# Expected Output

Report the observed evidence, reconstructed timeline, root cause, repair performed, preserved data, verification results, and unresolved risks.
