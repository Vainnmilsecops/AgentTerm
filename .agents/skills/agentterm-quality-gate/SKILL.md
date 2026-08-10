---
name: agentterm-quality-gate
description: "Execute and record lint, typecheck, test, build, or approved custom validation runs with durable evidence and retries. Use for Review/Done readiness checks; do not design the test suite or advance Task phases directly."
---

# Purpose

Produce trustworthy, auditable quality-check evidence for application readiness policies and coding-agent feedback.

# Inputs

- Identify the configured gate, authorized command, worktree, working directory, environment policy, timeout, output policy, and prior runs.
- Distinguish a gate execution from the test strategy owned by `agentterm-testing`.

# Required Workflow

1. Confirm whether the request is execution, retry, or inspection of existing readiness evidence.
2. For inspection, load the relevant immutable runs, verify their project, worktree, command, freshness, and policy match, then report evidence gaps and stop without starting a process or creating a run.
3. For execution or retry, validate that the command and working directory are allowed for the selected project or worktree.
4. For execution or retry, create a run record with command, `status`, `startedAt`, and immutable run identity.
5. Execute through the process-runtime boundary with explicit arguments, environment, cancellation, and timeout behavior.
6. Capture bounded output and persist an `outputReference` instead of reducing the run to a boolean.
7. Finalize `status`, `exitCode`, `duration`, `finishedAt`, and failure category even when spawning or persistence fails.
8. Return actionable failure evidence to the application or coding agent.
9. Create a new run for each retry and preserve earlier results.

# Invariants

- Record at least command, status, exit code when available, duration, output reference, start time, and finish time.
- Derive pass or failure from the exact recorded run and policy; never accept an agent assertion as proof.
- Let readiness policy consume gate results and let the Task workflow own phase transitions.
- Keep cancellation, timeout, spawn error, command failure, and infrastructure error distinguishable.

# Safety Rules

- Prefer executable-plus-argument invocation over interpolated shell strings.
- Run only configured or explicitly approved custom commands within the intended worktree.
- Redact secrets from environment and output, bound retained logs, and terminate timed-out process trees safely.

# Forbidden Changes

- Do not store only `passed = true/false`.
- Do not overwrite a failed run when retrying.
- Do not mark Review or Done directly from a successful process exit.

# Validation

- For implementation, test pass, nonzero exit, spawn failure, timeout, cancellation, truncated output, retry, and result-persistence failure.
- For executed or inspected runs, verify command, timestamps, duration, exit code, status, and output reference remain internally consistent.
- Verify readiness respects required-gate policy and rejects stale or wrong-worktree runs; for review-only work, report missing evidence without editing.

# Expected Output

Report each run identifier, command, final status, exit code, duration, output reference, retry relationship, and resulting readiness evidence.
