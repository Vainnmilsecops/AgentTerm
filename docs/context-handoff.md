# Text context handoff

This slice extends local attachments with **preparation**, not automatic delivery.
It preserves agtx's task/worktree context isolation while keeping AgentTerm's
provider command policy in adapters.

## Provider scope

[Gemini's command reference](https://geminicli.com/docs/reference/commands/#at-commands-)
documents `@path` for text files and warns that binary/large files can be skipped
or truncated and git-ignore rules apply. GeminiAdapter therefore exposes
`FILE_CONTEXT` for a discoverable CLI with a parseable version and successful
help probe. This is adapter support for the documented syntax, not an
authenticated runtime guarantee. Unknown-version/failed probes fail closed.

Only TXT/MD/JSON, 64 KiB per file, at most 8 selected files are supported here.
Claude/Codex remain unavailable for this operation; there is no Application/UI
provider-name branching. IMAGE_CONTEXT is not advertised. No CLI was installed,
updated or logged in as part of development; Gemini was not found on this
development shell's PATH. A real authenticated Gemini round trip is still needed.

## Interaction and safety

1. Select attachments associated with the current task for its latest live session.
   Saved TXT/MD/JSON from earlier sessions of the same task can be reused after
   resume, retry or agent switching; no re-import is needed. The installed target
   adapter must still support FILE_CONTEXT. This does not add support to other providers.
2. Explicitly consent to worktree copies and the possibility of sharing their
   contents with the target provider when the prompt is eventually submitted.
   The UI shows the original import session beside every file and names the target
   session in the consent label. Changing the target clears selection, consent and
   the prepared prompt; the user must select and approve again.
3. Application rechecks session ownership, adapter support, selected records,
   quality-gate activity and Git worktree identity under task/worktree locks.
   Each attachment and its source session must belong to this task. Missing or
   foreign source sessions reject the entire selection before any export. A source
   session may have exited; only the destination must be the latest live session.
   No attachment/session metadata is reassigned or duplicated by reuse.
4. Infrastructure reads a bounded snapshot, verifies size and SHA-256, rejects
   symlinks/junctions/hardlinks and copies to generated relative paths:
   `agentterm-context/<attachment UUID>.txt|md|json`.
5. Existing matching copies are reused; changed copies are never overwritten.
   A failure can leave private/worktree copies; nothing is auto-deleted.
6. The adapter generates an explicit file-reference prompt with no newline,
   shell command, absolute path or directory wildcard. UI focuses/selects a
   read-only textarea for manual Ctrl+C. No clipboard API or PTY write is invoked.

**Worktree copies can appear in Git status and can be committed.** Review them
before commits/pushes. We intentionally do not edit ignore files or weaken Gemini
filtering. Existing ignore rules can prevent Gemini reading these files; the user
must check the CLI's file-read result. No promise of complete model ingestion is
made even for a successfully prepared prompt.

Check that the intended session is at Gemini's normal prompt in this worktree,
not shell mode or a permission dialog, before pasting. AgentTerm cannot currently
prove the prompt is empty or that a file was consumed. Thus no automatic Enter,
delivery-success history or Task/session transition is recorded. Imported
metadata/history stays unchanged. Prior same-user filesystem race limitations
still apply; files can change after preparation and before manual submission.

## Verification

- `pnpm exec vitest run packages/application/src/task-context-handoff.test.ts packages/infrastructure/src/task-context-export.test.ts packages/infrastructure/src/gemini-context-prompt.test.ts packages/infrastructure/src/agent-provider-adapters.test.ts apps/desktop/src/task-context-ipc.test.ts`
- `pnpm --filter @agentterm/desktop... build`
- `node apps/desktop/scripts/input-reliability-smoke.mjs --task-context`

The smoke uses real Electron/React and the built isolated preload for IPC,
with controlled handlers and an Application client. Filesystem tests use private
temporary directories, verify content integrity and refuse destination junctions
and overwriting modified exports. They do not claim a provider has read files.

### Session reuse verification (2026-09-20)

- Application tests cover historical-source reuse without metadata changes,
  missing/foreign source sessions, foreign task records, mixed-batch preflight,
  superseded destinations and explicit consent.
- Electron context smoke covers switching to a new session, source disclosure,
  cleared selection/consent/prompt, reusing without importing again and prompt focus.
- Desktop dependency build, Application/Desktop typecheck, changed-file ESLint,
  and all three input-reliability smoke modes passed. The 80-suite regression run
  passed 953 tests. An initial concurrent build/test run hit the existing desktop
  composition test's 5-second timeout; rerunning after the build passed without
  code or timeout changes. The context smoke emitted a GPU teardown warning after
  PASS; no real provider ingestion or full visual audit is claimed.
