# Task context attachments

This is the local intake slice of Task Context Attachments. It follows agtx's
[task-scoped context model](https://github.com/fynnfluegge/agtx), adapted to
AgentTerm's Windows desktop and Application ports. It does not port tmux or
claim that every provider supports file/image context.

## User flow

Select a task with a session. Use **Task context attachments** to choose files,
drop files, or paste images while that panel has focus. Review names, byte sizes,
image previews and the exact Task/Session before confirming. Cancel releases the
pending selection. Imported metadata is shown again after restart.

Supported intake: UTF-8 TXT/MD, JSON, PNG, JPEG, PDF. Limits: 8 MiB per file,
8 files and 32 MiB per import, 64 stored files per task. Empty files are rejected.
Preview is local only; PDFs are not embedded or executed. The desktop CSP permits
blob URLs only for images; script, object and network restrictions are unchanged.

**Automatic sending remains disabled.** The [text handoff](context-handoff.md)
slice adds verified workspace export and Gemini prompt preparation. No PTY input
is generated and no base64 is typed into the terminal. Images/PDFs still cannot
be handed off by this flow.

## Storage and trust boundary

- Browser File input supplies bounded bytes, never an absolute source path.
  Preload and main validate the exact IPC shape and limits. Main checks the
  session belongs to the task; imports serialize per task.
- Infrastructure snapshots bytes, rejects path separators, ADS syntax, reserved
  Windows names, hidden names and unapproved extensions. It checks MIME claims
  against content signatures/structure (PNG/JPEG/PDF), strict UTF-8 and JSON parsing.
  These are type checks, **not malware scanning or full document validation**.
- Files use generated UUID names beneath
  `<AgentTerm data>/task-context/<SHA-256 task id>/`. Original names never become
  filesystem paths. Every destination ancestor is checked for symlinks/junctions;
  files are created exclusively and fsynced. No source file is modified.
- Migration 22 adds append-only metadata: Task, Session, display name, MIME,
  byte size, SHA-256 and creation time. Foreign keys prevent cross-task session
  association; triggers prevent metadata update/delete and enforce task count.
  SQLite stores neither raw file bytes nor source paths. No clipboard contents,
  filenames or file bytes are logged. Files selected by the user may themselves
  contain sensitive material: review the selection before confirming.

## Partial failure and limits

Files are written before the atomic metadata batch. A failed batch publishes no
partial list. Already staged files are retained privately rather than deleting
unverified paths. Staged/orphan files also count toward the physical 64-file cap.
The error explicitly warns that a staged copy may remain. Automatic orphan
reconciliation/deletion and storage quota management are not implemented yet.

The private application data root assumes a trusted local OS account. Portable
Node path checks cannot eliminate a concurrent same-user reparse-point swap;
this is not a sandbox against an attacker controlling that account. Image
previews use Chromium decoding of user-selected content, not trusted content.

## Validation

- `pnpm exec vitest run packages/application/src/task-context.test.ts packages/infrastructure/src/task-context-store.test.ts packages/infrastructure/src/sqlite-task-context.integration.test.ts apps/desktop/src/task-context-ipc.test.ts`
- `pnpm exec vitest run packages/infrastructure/src/sqlite-migrations.integration.test.ts`
- `node apps/desktop/scripts/input-reliability-smoke.mjs --task-context`

Build the desktop before running the Electron smoke so its preload is current.
The Electron smoke uses the desktop's actual CSP and real React/File/clipboard
events with a controlled Application client. It also round-trips Unicode bytes
through the built, isolated preload and Electron IPC with a controlled main handler.
The filesystem/SQLite integration
uses the real import use case. No provider account or paid agent call is used.
