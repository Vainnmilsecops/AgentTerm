---
name: agentterm-pty-runtime
description: "Implement or change AgentTerm's Windows-first PTY process runtime for spawn, input, output, resize, exit, kill, errors, and cleanup; use it for ConPTY lifecycle behavior while excluding Task business transitions and agent-provider command policy."
---

# Purpose

Provide a reliable terminal-process boundary from AgentTerm's PTY abstraction to Windows ConPTY and coding-agent CLIs.

# Inputs

- A validated launch specification from an agent adapter or application use case.
- Working directory, explicit environment additions, and initial terminal dimensions.
- Input, resize, cancellation, and shutdown requests.

# Required Workflow

1. Validate the launch specification, working directory, and terminal dimensions.
2. Allocate the PTY and process resources through the runtime abstraction.
3. Spawn the process and expose stdin, stdout, and runtime events.
4. Preserve byte ordering while handling output, input, and resize requests.
5. Emit explicit started, output, exited, and failed events to Application.
6. On stop, error, or exit, close handles and streams exactly once and verify cleanup.

# Invariants

- PTY runtime owns process and terminal resources, not Task business logic.
- Process exit, kill, or spawn failure never sets a Task phase directly.
- Application receives runtime evidence and decides how session and task workflows respond.
- Resize operations maintain valid terminal dimensions and target only the owned PTY.
- Exit and failure reporting remains observable even when cleanup also encounters an error.

# Safety Rules

- Accept structured executable and argument data; do not concatenate untrusted values into a shell command.
- Keep command construction and provider-specific flags in the agent adapter.
- Do not expose credentials or a full inherited environment in logs or events.
- Do not kill an unverified process or process tree; bind termination to the runtime-owned process identity.
- Make shutdown and cleanup idempotent.

# Validation

- Test spawn, ordered output, stdin, resize, normal exit, spawn failure, kill, cancellation, and repeated cleanup.
- Use a fake PTY for deterministic failure tests and a focused Windows integration test for ConPTY behavior.
- Verify no handle, stream, listener, or child process remains after terminal completion.

# Expected Output

Report the runtime behavior changed, emitted event contract, cleanup guarantees, Windows validation performed, and any platform limitation.
