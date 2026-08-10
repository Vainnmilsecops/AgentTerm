---
name: agentterm-session-lifecycle
description: "Manage AgentSession start, resume, retry, switch, stop, status, and immutable history. Use for session lifecycle changes; keep Task phase decisions, agent-specific commands, and PTY mechanics in their owning workflows."
---

# Purpose

Manage each coding-agent attempt as an explicit `AgentSession` without conflating it with the parent Task.

# Inputs

- Identify the Task, requested operation, selected agent, prior sessions, and current runtime evidence.
- Load persisted session events before deciding whether an operation is a start, resume, retry, restart, switch, or stop.

# Required Workflow

1. Reconstruct the current session state from durable records and live runtime evidence.
2. Validate the requested transition and reject stale or duplicate commands safely.
3. Create a new session record for a new attempt, retry, restart, or agent switch. Resume an existing session only when its adapter supports a real resume operation.
4. Move through explicit states: `STARTING`, `WORKING`, `IDLE`, `WAITING_INPUT`, `EXITED`, or `FAILED`.
5. Invoke agent-command construction through the AgentAdapter boundary and process operations through the PTY runtime boundary.
6. Append status events, timestamps, agent identity, runtime identifiers, and exit or failure evidence.
7. Re-read persisted and live state and report the resulting session without changing Task phase implicitly.

# Invariants

- Keep Task lifecycle and AgentSession lifecycle separate.
- Preserve every historical session; never overwrite an older attempt with a newer one.
- Treat process exit as session evidence, not as `TaskPhase = DONE`.
- Keep `TaskPhase`, `ExecutionHealth`, and `AgentSessionStatus` distinct. For example, a Task may remain `RUNNING` while health is `FAILED` and its latest session is `EXITED`.
- Let the application layer coordinate transitions. Let PTY runtime publish runtime events only.

# Safety Rules

- Make start, stop, and event handling idempotent where duplicate delivery is possible.
- Handle late exit events and concurrent stop/retry commands without corrupting the active-session pointer.
- Preserve failure details needed for retry and recovery while excluding credentials and sensitive environment values.

# Forbidden Changes

- Do not mark a Task ready, reviewed, complete, or done from a session transition.
- Do not embed Codex-, Claude-, Gemini-, or other CLI command rules here.
- Do not implement raw process, PTY, Git, or database access in session-domain logic.

# Validation

- Test every allowed and rejected transition, including spawn failure, normal exit, crash, stop, retry, resume, and agent switch.
- Test duplicate commands, stale runtime events, and preservation of multi-session history.
- Verify that no session event advances Task phase by itself.

# Expected Output

Report the transition performed, session identifier and state, preserved history, emitted evidence, validation results, and any application-level decision still required.
