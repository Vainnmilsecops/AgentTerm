# ADR-008 — Agent Session Recovery (Reattach and Provider-Native Resume)

- Status: Accepted
- Date: 2026-08-15

## Decision

During startup reconciliation, AgentTerm must attempt to recover a persisted Agent Session
that no longer has in-process runtime ownership. Recovery is two-tiered and fail-closed:

1. **Reattach** through the new `HostReattacher` port. The inspector reads only the
   recorded host PID and ConPTY named pipes; it never spawns, never signals, never opens
   for write. A successful inspection is followed by `PtyRuntime.reattach`, which opens
   streams from the recorded pipes without spawning a child process.
2. **Provider-native resume** through the adapter when reattach is unavailable. The
   persisted `AgentSession.providerSessionId` is passed verbatim to the resolved
   adapter; the adapter is the only place that constructs the resume argv (Codex,
   Claude, Gemini each define their own). Resume creates a fresh `AgentSession` row
   while the previous attempt stays untouched for immutable history.
3. **Fail-closed**: when both paths are unavailable or refused, the session receives the
   existing `RUNTIME_OWNERSHIP_LOST` evidence and is finalized as `FAILED`. Task phase
   is never advanced.

## Trust Boundary

The recorded `AgentSessionHostOwnership` carries only Win32 kernel identifiers:

- `hostPid`: process identifier of the host child process
- `conptyInPipeName` / `conptyOutPipeName`: Win32 named pipes exposed by the host
- `startedAt`: timestamp

It deliberately excludes command argv, environment, working directory, and provider
identity. The renderer never observes the ownership record; recovery is owned entirely
by the Application composition.

## Resume argv

Adapter-owned, never Application-owned. Each adapter accepts `resumeSessionId` only when
its published `SESSION_RESUME` capability is true. The Application validates the session
id against a narrow alphanumeric shape (`^[A-Za-z0-9._-]{4,128}$`) before delegating.
The previous row's `providerSessionId` is the only legal source for the value.

## Reattach runtime limitation

The current Windows ConPTY runtime routes streams through `node-pty` and does not expose
the host's anonymous pipes as discoverable Win32 named pipes. Until the runtime migrates
to a named-pipe host, the inspector deterministically reports `PIPE_GONE` for any
ownership record. The coordinator then falls back to provider-native resume. This
limitation is documented and reflected in `CURRENT_STATE.md`.

## Alternatives Considered

- Mutating the persisted row to mark it resumed would violate the immutable Agent
  Session history invariant and confuse downstream review admission; rejected.
- Resuming automatically on every restart would remove the explicit user action the
  rest of the lifecycle preserves; rejected.
- Spawning a fresh provider with no session id (cold start) would lose the prior
  conversation state and any in-flight tool calls; rejected unless the adapter reports
  `SESSION_RESUME: false` and the user opts in.
- Reattaching without a pipe existence check would be vulnerable to OS PID-reuse races
  and could surface streams from a different process; rejected.

## Consequences

- `AgentSession` gains `hostOwnership` and `providerSessionId` fields. New SQLite
  migration 14 introduces nullable columns; existing rows stay `NULL` and never receive
  invented ownership.
- `PtyRuntime` gains `reattach(ownership, size, sink)`. Implementations that cannot
  honor it fail closed with `CONPTY_UNAVAILABLE`.
- `AgentSessionRepository` gains `updateOwnership(session, expectedSequence, input)` so
  the runtime can persist the ownership record (and the provider session id) after a
  successful launch without rewriting history.
- `restoreAgentSessionsAfterRestart` accepts an optional `RestoreAgentSessionsOptions`
  bag with `reattachAttempt`, `resumeAttempt`, `resumeInitialSize`, and
  `reattachEventSink`. Callers that omit them preserve the original `RUNTIME_OWNERSHIP_LOST`
  behavior.
- `tryReattachAgentSession` and `tryResumeAgentSession` are exported Application use cases
  with structured failure codes (`SESSION_NOT_FOUND`, `NO_OWNERSHIP`, `HOST_DEAD`,
  `RUNTIME_REJECTED`, `RESUME_UNSUPPORTED`, `PROVIDER_SESSION_ID_MISSING`,
  `PROVIDER_SESSION_ID_MISMATCH`, `AGENT_NOT_CONFIGURED`).
- The renderer IPC surface is unchanged. Recovery is invisible to the UI; the
  coordinator decides during startup before the renderer ever asks for a Session
  attachment.
