---
name: agentterm-feature
description: "Provide the default vertical-slice workflow for implementing or extending an AgentTerm feature; use it with the relevant architecture, domain, runtime, security, and testing skills, while keeping review-only, recovery-only, and unrelated refactoring work outside the feature scope."
---

# Purpose

Deliver one requested AgentTerm behavior completely without expanding its scope.

# Inputs

- The feature requirement and acceptance criteria.
- Repository instructions, especially `AGENTS.md`.
- Existing implementation, tests, and applicable AgentTerm skills.

# Required Workflow

1. Read the requirement and define the requested outcome.
2. Read the applicable `AGENTS.md` instructions.
3. Select the domain, runtime, security, UX, persistence, and testing skills that the change actually needs.
4. Inspect the current implementation and tests before editing.
5. Identify the affected business behavior and architecture boundary.
6. Define the smallest complete vertical slice.
7. Implement only that slice.
8. Add or update behavior-focused tests.
9. Run proportionate validation.
10. Inspect the complete `git diff` for unintended changes.
11. Report the result, validation, and remaining limitations.

# Invariants

- Preserve existing behavior unless the requirement explicitly changes it.
- Keep business decisions in Domain or Application, not Presentation or Infrastructure.
- Treat tests and failure behavior as part of the feature, not optional follow-up work.

# Forbidden Changes

- Do not invent adjacent requirements or broaden the feature.
- Do not refactor unrelated code.
- Do not add or install a dependency unless the requested behavior genuinely requires it and its impact has been assessed.
- Do not conceal incomplete validation or known failure paths.

# Validation

- Verify the acceptance criteria through focused tests or direct inspection.
- Run relevant broader checks when the change can affect shared behavior.
- Review `git diff` and `git status`; preserve unrelated user changes.

# Expected Output

Summarize the behavior delivered, files changed, tests and checks run, results, known limitations, and any recommended follow-up that remains outside scope.
