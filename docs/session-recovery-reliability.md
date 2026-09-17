# Session recovery reliability

Startup recovery must settle lost ownership before launching a replacement.
A successful reattach callback must already have adopted the handle into its
coordinator; it must never also launch a provider resume process.

The production ConPTY host does not support cross-process reattachment, so the
desktop currently uses only the provider-native fallback. This fallback checks
the recorded worktree through Git inspection, keeps the current Task phase, and
starts a new session through `AgentSessionCoordinator`. The coordinator validates
the previous attempt's Task, agent, settled ownership, provider session id and
current adapter resume capability before inserting the new attempt. The provider
id is persisted on that new attempt before process launch. The coordinator owns
its input, output, stop and exit handling; previous history stays unchanged.

## Recorded conversation identity and explicit Resume

ClaudeAdapter now probes the installed CLI for `--session-id` and, when advertised,
assigns a UUID on a fresh launch. `AgentLaunchCommand.providerSessionId` carries
that exact identity to the coordinator, which persists it through the existing
ownership repository before opening the PTY. A persistence failure prevents spawn.
Resume continues to use `--resume` with the recorded identity, never `--continue`.
This follows the [Claude CLI reference](https://code.claude.com/docs/en/cli-reference).

The selected task displays a Resume conversation panel for a settled latest
session. Application readiness reports missing identity, live writers, newer
attempts, unavailable agents/worktrees, unsupported resume, task phase, running
gates and incomplete dependencies. The mutation rechecks readiness under existing
Task/worktree operation serialization. IPC accepts only AgentTerm's session id;
the renderer cannot select a provider id, executable or worktree path.

No schema migration is needed. SQLite already has `provider_session_id`. Existing
sessions are not backfilled with guesses. Automatic capture for Codex/Gemini is
not implemented; sessions without a recorded identity show the explicit reason.
An assigned Claude ID is not proof that the provider has saved a conversation:
provider errors still appear in its terminal and do not change Task phase.

Remaining validation: real authenticated provider conversation restart. Live
ConPTY reattachment still requires a separate host-lifecycle implementation.

Validation commands:

- `pnpm exec vitest run packages/application/src/agent-session-coordinator.test.ts packages/application/src/agent-session-restore.test.ts packages/application/src/agent-session-recovery.test.ts apps/desktop/src/desktop-application.test.ts`
- `pnpm --filter @agentterm/application build`
- `pnpm --filter @agentterm/application typecheck`
- `pnpm --filter @agentterm/desktop typecheck`
- `node apps/desktop/scripts/input-reliability-smoke.mjs --session-recovery`

The recovery smoke renders the real React panel in Electron with a controlled
Application client. It checks missing-id feedback, readiness refresh, duplicate
click suppression, workspace refresh and active-session lockout without reading
credentials or creating a paid provider conversation.
