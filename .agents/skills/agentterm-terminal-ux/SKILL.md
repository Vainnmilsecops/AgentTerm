---
name: agentterm-terminal-ux
description: "Design and implement the keyboard-first desktop terminal workspace UX, including panes, focus, command palette, terminal interaction, and runtime states. Use for AgentTerm desktop UI only; exclude the marketing website and keep business/infrastructure logic out of components."
---

# Purpose

Create a Windows-first developer workspace that makes concurrent coding-agent sessions understandable and controllable from the keyboard.

# Inputs

- Identify the user flow, application commands, view state, keyboard model, terminal capabilities, and window constraints.
- Account for loading, empty, error, `WORKING`, `IDLE`, `WAITING_INPUT`, `EXITED`, and `FAILED` states.

# Required Workflow

1. Map the workflow to application-layer commands and read models before designing components.
2. Establish information hierarchy for project, tasks, sessions, tabs, sidebar, and terminal panes.
3. Define deterministic keyboard navigation, focus movement, selected state, command-palette actions, and focus restoration.
4. Preserve terminal behaviors for input, copy/paste, selection, scrollback, resize, and split panes.
5. Design explicit loading, empty, unavailable, recoverable-error, and destructive-confirmation states.
6. Exercise narrow windows, resized panes, long paths, long task titles, Unicode, and Vietnamese text.
7. When implementing, connect UI actions only through application use cases and validate behavior at component and workflow levels. For design-only work, deliver the interaction contract and validation plan without editing code.

# Invariants

- Keep this skill scoped to the desktop terminal application, not the AgentTerm website.
- Do not use color as the only status, selection, focus, or error signal.
- Keep active Task, selected session, focused pane, and running process visually distinguishable.
- Preserve standard terminal expectations unless an AgentTerm-specific behavior is clearly communicated.

# Safety Rules

- Require clear confirmation and target context for destructive actions.
- Prevent accidental keystroke routing to the wrong pane or hidden session.
- Keep sensitive command output out of telemetry and incidental UI persistence.

# Forbidden Changes

- Do not call raw Git, PTY, SQLite, filesystem, or process APIs from UI components.
- Do not move Task transition rules into presentation state.
- Do not add website, SaaS dashboard, account, login, or billing behavior through this skill.

# Validation

- For implementation, test keyboard-only operation, focus order and restoration, split-pane resize, copy/paste, scrollback, and command-palette dispatch.
- Test every visible runtime state without relying on color alone, plus narrow layouts, long content, Unicode, Vietnamese text, errors, and empty data.
- For design-only work, provide these scenarios as an acceptance and validation plan without claiming execution.

# Expected Output

Report the user flow, keyboard and focus contract, component boundaries, state coverage, accessibility considerations, and validation evidence.
