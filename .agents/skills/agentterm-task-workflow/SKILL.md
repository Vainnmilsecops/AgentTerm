---
name: agentterm-task-workflow
description: "Model and change AgentTerm coding-task phases, transitions, readiness, completion, retry, or blocked behavior; use it whenever Task state changes, and keep TaskPhase separate from execution health and agent-session process status."
---

# Purpose

Protect the business lifecycle of a coding task independently from runtime and session lifecycles.

# Inputs

- The current `TaskPhase` and requested business action.
- Relevant readiness policy, artifacts, quality-gate results, Git state, and application events.
- Current `ExecutionHealth` and `AgentSessionStatus` as separate evidence.

# Required Workflow

1. Confirm whether the request is modeling, design, review, or execution, then name the business action such as Advance, Move Back, Review, Complete, Retry, Ready, or Blocked.
2. Read the current task state and the evidence required by its transition policy.
3. Validate the transition and its preconditions in Domain logic.
4. For modeling, design, or review, describe the transition contract and evidence gaps without changing state.
5. When execution is requested, perform the transition through an Application use case.
6. Persist an executed transition and record the relevant event through ports.
7. Return an explicit proposal, success, or domain failure without inferring a transition from a process event.

# Invariants

- The primary progression is `BACKLOG -> PLANNING -> RUNNING -> REVIEW -> DONE`; any reverse or exceptional transition must be explicit and validated.
- `TaskPhase`, `ExecutionHealth`, and `AgentSessionStatus` are distinct concepts and fields.
- Domain rules define `ExecutionHealth` semantics; Application updates it from explicit runtime evidence without treating it as a phase transition.
- A valid combined state can be `TaskPhase = RUNNING`, `ExecutionHealth = FAILED`, and `AgentSessionStatus = EXITED`.
- Agent process exit does not mean Task Done.
- `DONE` is a business decision made through a use case after its policy is satisfied.
- Runtime events may provide evidence but never mutate `TaskPhase` directly.

# Forbidden Changes

- Do not encode Task transitions in PTY callbacks, agent adapters, UI components, repositories, or database triggers.
- Do not collapse failed execution, exited session, blocked work, and completed task into one status.
- Do not mark a task ready or done solely because an agent reports "Done."
- Do not bypass transition validation during retry or recovery.

# Validation

- For implementation, test every added transition, invalid source phase, missing precondition, and idempotency expectation.
- Test process exit and execution failure without an automatic transition to `DONE` when behavior is implemented or changed.
- For design or review, specify these cases and identify missing evidence without claiming tests ran.
- For executed transitions, confirm persistence and emitted events represent the same accepted transition.

# Expected Output

Report the business action, prior and proposed or resulting phase, evidence evaluated, rejected conditions, events recorded when applicable, and validation results or plan.
