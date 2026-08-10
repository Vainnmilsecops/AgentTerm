---
name: agentterm-persistence
description: "Design and change AgentTerm persistence through schemas, migrations, repositories, mappings, and tests. Use for SQLite or Drizzle-backed state; keep Domain, UI, and external Git/process side effects independent of database details."
---

# Purpose

Persist AgentTerm state without leaking storage concerns into Domain or pretending database transactions can roll back external systems.

# Inputs

- Identify the use case, domain data, query needs, retention rules, current schema, and external side effects.
- Treat `projects`, `tasks`, `worktrees`, `agent_sessions`, `task_events`, `artifacts`, `quality_gate_runs`, `pull_requests`, `workspace_layouts`, and `settings` as candidate tables, not mandatory upfront schema.

# Required Workflow

1. Confirm whether the request is design, implementation, or review and keep later steps within that mode.
2. Design the smallest schema change that satisfies the use case and preserves required history.
3. Add an explicit migration with constraints, indexes, defaults, and compatibility behavior when implementing.
4. Define or update the application-facing repository port, as a proposal for design work or as code for implementation work.
5. Implement the SQLite/Drizzle repository in Infrastructure only when requested.
6. Map storage rows to domain and application types explicitly; do not expose ORM records across the boundary.
7. Analyze operation ordering and partial failures before coordinating Git, filesystem, or process effects.
8. Add repository, migration, mapping, and failure-path tests when implementing; otherwise provide the validation plan and evidence gaps.

# Invariants

- Keep Domain persistence-agnostic and make Infrastructure implement the ports Application needs.
- Preserve stable identifiers, timestamps, state history, and relationships required for reconstruction.
- Do not assume a database rollback reverses a branch, worktree, file write, spawned process, or stopped process.
- Represent incomplete external operations so they can be retried, compensated, or reconciled.
- Add tables and abstractions only when a current use case requires them.

# Safety Rules

- Preserve user data during migrations; require an explicit backup or recovery strategy for destructive transformations.
- Use constraints and idempotency deliberately for retryable operations.
- Avoid persisting secrets, raw credentials, or unredacted environment snapshots.

# Forbidden Changes

- Do not let Presentation or Domain execute raw SQLite or depend on Drizzle types.
- Do not edit schema without a migration.
- Do not hide a partial failure by marking a multi-system operation successful.

# Validation

- For implementation, apply migrations to an empty database and representative prior schema states, then verify mapping round trips, constraints, indexes, and repository behavior.
- Test `Git success + DB failure`, `DB success + process failure`, retries, and reconciliation paths when the behavior exists.
- For design or review, inspect the available evidence and provide the migration, mapping, and failure-path validation plan without claiming execution.

# Expected Output

Report the schema and migration decisions, repository contract, mapping behavior, partial-failure strategy, compatibility impact, and test results or planned evidence.
