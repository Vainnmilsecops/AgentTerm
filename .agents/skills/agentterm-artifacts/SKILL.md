---
name: agentterm-artifacts
description: "Define, store, validate, and hand off structured phase artifacts such as plans, execution summaries, and reviews. Use for artifact naming or phase-readiness evidence; do not equate agent claims or file existence with Task completion."
---

# Purpose

Manage durable workflow outputs and make their validity available to application readiness policies.

# Inputs

- Identify the Task, phase, producing session, artifact contract, storage root, and consumers.
- Start from canonical examples such as `planning/plan.md`, `running/execution-summary.md`, and `review/review.md` when the use case does not require a more specific contract.

# Required Workflow

1. Define the minimum artifact contract: canonical name, phase, format, required content, provenance, and validation rules.
2. Resolve the destination beneath the authorized Task artifact root.
3. When storing an artifact, write through the filesystem/storage port using an atomic or recoverable operation.
4. When persistence is in scope, record artifact identity, producer, timestamps, location, and validation result without discarding prior history.
5. When validating an existing or stored artifact, validate content, not only path existence.
6. When readiness evaluation is requested, expose artifact evidence to the readiness policy alongside runtime, Git, quality-gate, and policy signals.
7. When handoff is requested, hand off only validated artifacts and report any missing or stale evidence.

# Invariants

- Treat an agent saying "Done" as a claim, not readiness evidence.
- Treat artifact existence as necessary only when policy requires it and never as sufficient proof of validity.
- Let the Task workflow own phase transitions and let Quality Gate own command-run results.
- Preserve provenance across agents, sessions, retries, and phases.

# Safety Rules

- Reject absolute paths, traversal, symlink escapes, and writes outside the authorized artifact root.
- Avoid silent overwrite; version, append, or require an explicit replacement policy.
- Exclude credentials, tokens, and unnecessary raw terminal output from durable artifacts.

# Forbidden Changes

- Do not advance a Task phase directly from artifact storage or validation.
- Do not fabricate passed quality gates or clean Git state from artifact content.
- Do not store arbitrary files merely because an agent produced them.

# Validation

- For implementation, test canonical naming, valid content, missing fields, malformed content, stale versions, duplicate writes, overwrite policy, and path attacks.
- Test readiness with missing artifact, valid artifact plus failed gate, and complete evidence when readiness behavior is implemented.
- Verify handoff retains source Task, session, phase, and validation provenance when handoff behavior is implemented.
- For contract-only work, provide these cases as a validation plan without claiming execution.

# Expected Output

Report artifact contracts and paths, provenance, validation results, readiness evidence supplied, and the application decision that remains outside this skill.
