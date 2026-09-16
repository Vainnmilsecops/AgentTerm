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

Remaining work before the complete resume feature can be called finished:

- Provider-specific capture/verification of conversation ids during normal
  interactive launches. Existing sessions without a recorded provider id cannot
  be resumed and must not silently start a fresh conversation.
- A renderer recovery summary with explicit resume readiness and failure reasons.
- Real provider restart testing, plus live ConPTY reattachment as a separate
  host-lifecycle change.

Validation commands:

- `pnpm exec vitest run packages/application/src/agent-session-coordinator.test.ts packages/application/src/agent-session-restore.test.ts packages/application/src/agent-session-recovery.test.ts apps/desktop/src/desktop-application.test.ts`
- `pnpm --filter @agentterm/application build`
- `pnpm --filter @agentterm/application typecheck`
- `pnpm --filter @agentterm/desktop typecheck`
