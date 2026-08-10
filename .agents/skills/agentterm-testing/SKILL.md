---
name: agentterm-testing
description: "Design or implement AgentTerm tests for domain rules, state machines, path validation, agent capabilities, Git and worktrees, SQLite persistence, PTY or process behavior, end-to-end workflows, failures, recovery, cleanup, and regressions. Use whenever behavior changes need evidence; test observable behavior rather than incidental implementation details."
---

# Purpose

Provide proportionate, durable evidence that AgentTerm behavior works on Windows-first workflows and remains safe under failure.

# Inputs

- The requirement, acceptance criteria, and changed behavior.
- Relevant invariants and external side effects.
- Existing test conventions and available validation commands.

# Required Workflow

1. Identify the behavior and failure boundary before selecting a test level.
2. Use unit tests for state machines, domain rules, path validation, and agent capability logic.
3. Use integration tests for temporary real Git repositories and worktrees, temporary SQLite databases, fake or mock PTYs, and process failures.
4. Use end-to-end tests for critical journeys such as Open Project -> Create Task -> Start -> Worktree -> Agent Session -> Retry -> Review.
5. Cover the relevant happy path, invalid input, edge case, failure, partial failure, recovery, cleanup, and regression.
6. When implementing or validating, run the narrowest useful tests first, then the broader affected suite. For strategy-only work, specify the commands and cases without claiming they ran.

# Invariants

- Isolate tests from user repositories, databases, processes, credentials, and global configuration.
- Assert externally visible state and side effects, including cleanup.
- Make time, process exit, and concurrency behavior deterministic where practical.
- Preserve enough failure output to diagnose a failed assertion.

# Forbidden Changes

- Do not test private implementation structure without a behavioral reason.
- Do not replace valuable real Git integration coverage with command-string assertions alone.
- Do not make a flaky test pass by adding arbitrary sleeps or weakening assertions.
- Do not leave temporary worktrees, processes, databases, or files behind.

# Validation

For implementation or validation work, run the documented repository commands, confirm the new test fails for the targeted regression when feasible, and verify cleanup after both success and failure. For strategy-only work, state the planned commands and evidence gaps.

# Expected Output

List test levels and cases added or proposed, commands executed when applicable, results or evidence gaps, skipped coverage, and any remaining risk.
