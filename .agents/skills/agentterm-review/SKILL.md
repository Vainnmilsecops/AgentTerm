---
name: agentterm-review
description: "Perform an independent, evidence-based review of AgentTerm changes when asked to review a git diff, patch, branch, behavior, or completed implementation. Default to read-only review and do not fix code unless explicitly requested; report substantive correctness, safety, lifecycle, consistency, security, architecture, regression, and test findings."
---

# Purpose

Find defects that could break behavior, lose user work, leak resources, or violate AgentTerm's architecture before changes are accepted.

# Inputs

- The requirement or intended behavior.
- The complete diff and relevant surrounding code.
- Test changes, test results, and current repository state.

# Required Workflow

1. Establish review scope and inspect the complete diff.
2. Trace affected behavior through its callers, state transitions, side effects, and cleanup paths.
3. Check tests against the intended behavior and meaningful failure modes.
4. Prioritize: correctness, user data loss, destructive Git behavior, invalid state, resource leaks, PTY or process lifecycle, worktree leaks, database or external-state inconsistency, races, security, architecture, regression, then missing tests.
5. Confirm every finding from code evidence and omit speculative or purely stylistic comments.
6. Report findings in severity order without modifying files.

# Invariants

- Use `CRITICAL`, `HIGH`, `MEDIUM`, or `LOW` severity.
- Give an accurate file and narrow location for every finding.
- Explain the concrete impact and a feasible direction for fixing it.
- Treat absence of a finding as different from proof that the change is correct.

# Finding Format

```text
Severity:
File:
Location:
Problem:
Impact:
Suggested Fix:
```

# Forbidden Changes

- Do not edit code, resolve findings, commit, or broaden the review unless asked.
- Do not report minor style preferences that do not materially affect quality.

# Validation

Re-check each cited location against the final diff, remove duplicates, and state any unreviewed area or unavailable test evidence.

# Expected Output

Lead with findings. If none are found, say so explicitly and note residual risks or test gaps.
