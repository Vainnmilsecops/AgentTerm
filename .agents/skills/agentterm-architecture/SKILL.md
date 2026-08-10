---
name: agentterm-architecture
description: "Protect AgentTerm's Presentation-to-Application-to-Domain dependency direction when adding modules, use cases, ports, adapters, cross-layer features, refactors, or architecture decisions; use it to prevent UI or Domain code from bypassing boundaries, not to justify speculative abstractions."
---

# Purpose

Keep AgentTerm's architecture explicit while making the smallest coherent change.

# Inputs

- The requested behavior and affected domain concepts.
- The current modules, dependency graph, and relevant decisions.
- The presentation surface, application use case, required port, and infrastructure capability involved.

# Required Workflow

1. Identify the affected domain concept and rule.
2. Identify the application use case that coordinates the behavior.
3. Define or reuse only the port the use case actually needs.
4. Identify the infrastructure adapter that implements that port.
5. Identify the presentation surface that invokes the use case.
6. Trace dependency direction before editing.
7. Propose or implement, as requested, the smallest coherent architectural change.

# Invariants

- Dependencies flow `Presentation -> Application -> Domain`.
- Infrastructure implements ports owned by an inner layer and depends inward; inner layers do not depend on infrastructure adapters.
- Presentation invokes application behavior instead of issuing raw Git, PTY, or SQLite operations.
- Domain code does not depend on Git, PTY, filesystem, process APIs, terminal rendering, or other infrastructure details.
- Application orchestrates side effects through ports; adapters contain technology-specific behavior.

# Forbidden Changes

- Do not add an abstraction solely because it may be useful later.
- Do not bypass a layer to make a local implementation shorter.
- Do not mix unrelated architectural cleanup into the requested change.
- Do not move business rules into UI components or infrastructure adapters.

# Validation

- Inspect changed imports and call paths for inward dependency direction.
- Confirm each external side effect is reached through an explicit port.
- Confirm the change introduces no speculative interface or unused layer.
- Run focused architecture, domain, and use-case tests when they exist.

# Expected Output

Report the affected domain concept, use case, port, adapter, presentation surface, validation performed, and any deliberate architecture decision.
