---
name: agentterm-session-handoff
description: "Create a concise continuation handoff near the end of a substantial AgentTerm coding session or before work moves to another agent or session. Capture objectives, completed work, decisions, changed files, tests and results, unresolved issues, Git state, and the next recommended session; do not use for routine small-task summaries or copy the conversation verbatim."
---

# Purpose

Let a later Codex session resume from verified project state without reconstructing the entire conversation.

# Inputs

- The session objective and accepted scope.
- Current files, diffs, architecture and business decisions, and unresolved issues.
- Commands executed, test output, and current Git state.

# Required Workflow

1. Reconstruct the handoff from repository evidence and command results, not memory alone.
2. Separate completed work from partially completed or merely proposed work.
3. Record durable architecture and business decisions with their practical consequences.
4. List changed files by purpose, not by reproducing their contents.
5. Record exact validation commands and outcomes, including failures or skipped checks.
6. Capture unresolved issues, risks, and the smallest recommended next session.
7. Return the handoff in the response. Create or update a durable file only when the user or task explicitly requests it; prefer the existing `docs/progress/` convention when present.

# Invariants

- Keep statements factual, concise, and sufficient for continuation.
- Preserve blockers, failed tests, dirty state, and uncertainty instead of smoothing them over.
- Include no secrets, raw credentials, unnecessary logs, or full conversation transcript.
- Do not claim work is committed, pushed, or complete unless verified.

# Forbidden Changes

- Do not copy the whole conversation or full diff.
- Do not create unrelated progress-document structure.
- Do not commit, push, open a pull request, or alter code while producing the handoff.

# Expected Output

Use these sections: Session Objective, Completed Work, Architecture Decisions, Business Decisions, Files Changed, Tests Executed, Test Results, Unresolved Issues, Current Git State, and Next Recommended Session.

# Validation

Cross-check file paths, test results, and Git state immediately before delivery. Ensure the next session is actionable and does not repeat completed work.
