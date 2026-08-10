---
name: agentterm-agent-adapter
description: "Add or modify Codex, Claude, Gemini, OpenCode, or custom coding-agent integration for executable detection, versions, capabilities, start/resume commands, environment, working directory, and authentication availability; use it to isolate provider policy, not to run PTYs or mutate Task and session state."
---

# Purpose

Expose coding-agent differences through one stable `AgentAdapter` contract.

# Inputs

- Agent provider and requested operation, such as start or resume.
- Executable configuration, working directory, approved environment additions, and optional provider session identity.
- Required capabilities and authentication availability requirements.

# Required Workflow

1. Select the adapter for Codex, Claude, Gemini, OpenCode, or a configured custom agent.
2. Detect the executable and obtain a parseable version without installing or updating it.
3. Determine capabilities, including whether resume is supported.
4. Check authentication availability without reading or exposing credential values.
5. Validate the working directory and request.
6. Construct a structured launch specification with executable, argument vector, working directory, and minimal environment additions.
7. Return the launch specification to the PTY runtime and normalize adapter errors for Application.

# Invariants

- Application depends on `AgentAdapter`, never a provider-specific CLI implementation.
- Provider flags, version parsing, capability rules, and resume syntax remain inside that provider's adapter.
- The PTY runtime executes the launch specification; the adapter does not own process I/O or lifecycle.
- Task and `AgentSession` state changes remain Application concerns.
- Adding a provider does not require branching on that provider throughout the codebase.

# Safety Rules

- Never place secrets in arguments, logs, persisted command previews, or error messages.
- Do not inherit or forward the full environment when a minimal allowlist is sufficient.
- Do not use shell-string concatenation for paths, prompts, or provider options.
- Do not initiate login, installation, upgrade, or arbitrary repository commands implicitly.
- Treat custom-agent configuration and repository-provided values as untrusted input.

# Validation

- Contract-test every adapter for detection, version parsing, capability reporting, start, resume, and normalized failures.
- Cover missing executables, unsupported versions, unavailable authentication, unsupported resume, spaced or Unicode paths, and rejected custom configuration.
- Confirm provider-specific flags do not leak into Application or Presentation.

# Expected Output

Report the adapter and capabilities changed, launch-spec contract, supported start/resume behavior, security decisions, tests run, and remaining provider limitations.
