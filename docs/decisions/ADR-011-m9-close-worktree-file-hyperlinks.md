# M9-Close — Ctrl+click worktree file hyperlinks

Status: Proposed
Date: 2026-08-22
Owner: AgentTerm desktop + application
Branch: `cursor/terminal-context-menu-agent-actions`

## Context

`M9 — Hyperlink provider (Ctrl+click path/URL)` shipped in commit `aed4a0e`
with a deliberate scope split:

- `packages/application/src/terminal-link-resolver.ts` already classifies a
  link text into `external-url`, `worktree-file`, or `none` and validates
  that any absolute path candidate lives inside the persisted primary Task
  Worktree (`OUTSIDE_WORKTREE` rejection).
- `apps/desktop/src/renderer/xterm-link-provider.ts` only registers the URL
  branch; the path branch was deferred behind the comment *"Path resolution
  belongs to the Application use case `resolveTerminalLinkTarget` and
  requires a follow-up IPC channel that exposes Worktree inspection"*.

The renderer therefore sees path candidates highlighted as plain text and
loses the Ctrl+click affordance every developer expects from a terminal
embedded inside a coding workspace.

This plan closes that gap. It stays inside the same milestone envelope: no
new Domain rules, no new Application use cases, no new ports. We add one
narrow IPC channel that re-runs the same `resolveTerminalLinkTarget`
predicate in the main process (so the renderer cannot smuggle an arbitrary
path) and a second xterm `ILinkProvider` that consumes it. Everything
outside the persisted primary Worktree is silently rejected, which keeps the
trust boundary that ADR-009 established.

## Goals

1. Make every absolute path printed by an Agent Session Ctrl+clickable.
2. Re-run the worktree-containment check in the main process before any
   filesystem action.
3. Open the resolved file through `shell.openPath` so the OS picks the
   default handler; never read or buffer the file content in AgentTerm.
4. Stay renderer-light: the new xterm provider reuses the existing
   `resolveTerminalLinkTarget` symbol without duplicating its logic.
5. Keep the existing URL provider untouched and its tests passing.

## Non-goals

- Reading file contents or showing diffs from inside the terminal. That is
  what `listTaskChanges` / `getTaskFileDiff` already own.
- Relative-path resolution (`./foo.ts` after a `cd`). The deferred branch
  in `terminal-link-resolver.ts` already rejects such candidates; no
  improvement here.
- In-app preview. The OS shell handles `.ts`, `.png`, `.json`, etc.
- Symlink/junction traversal. The resolver already normalizes slashes; if
  the candidate starts with `worktreeRoot/`, we trust it and let
  `shell.openPath` resolve the rest.
- Adding a new terminal provider. Both providers live in
  `xterm-link-provider.ts` and reuse one factory.

## Architectural decisions

### AD-1: The renderer never owns a filesystem path

The renderer feeds the controller only the *visible link text* returned by
xterm, plus the active `taskId`. The new IPC request carries the same
shape: `{ absolutePath, taskId }`. The renderer cannot ask the main
process to open anything outside what the resolver has already approved.

### AD-2: The main process is the second validator

`resolveTerminalLinkTarget` is a pure async function. The renderer runs it
inside the link-provider to decide whether to underline a token; the main
process runs the *same* symbol with the *same* dependencies
(`persistence.worktrees`) before invoking `shell.openPath`. If the
renderer and the main process disagree (e.g. the worktree was removed
mid-click), the main result wins and the renderer receives a structured
`DesktopBridgeError('NOT_FOUND', …)` that the link activator silently
swallows.

### AD-3: One IPC channel, one trusted boundary

A new channel `agentterm:terminal:open-worktree-file` accepts a validated
`{ absolutePath, taskId }`. The handler is a thin shell around
`resolveTerminalLinkTarget` followed by `shell.openPath`. It must:

- Run only for authorized senders (existing `authorize` callback).
- Validate the request via `validateDesktopIpcRequest`.
- Call `resolveTerminalLinkTarget` with the same dependencies used by the
  renderer (production composition will inject
  `persistence.worktrees`).
- Return `{ ok: true, value: null }` on success.
- Map a `none` resolver result to `DesktopBridgeError('NOT_FOUND')` so the
  renderer never sees the resolved reason.

### AD-4: One factory, two providers

The existing `registerTerminalLinkProvider` factory is parameterized only
by URL regex today. We add a sibling
`registerWorktreeFileLinkProvider` that:

- Owns its own regex (Windows drive paths and POSIX absolute paths).
- Asks the caller-supplied resolver (`resolveTerminalLinkTarget`) to
  classify every candidate.
- Underlines tokens whose resolver result is `worktree-file`.
- On Ctrl+click, calls a caller-supplied `onActivate(absolutePath)` that
  fires the IPC request.

The renderer wires both providers side by side. URL tokens win over path
tokens only when both match the same `range`; in practice, the two
regexes are disjoint.

### AD-5: `shell.openPath` owns OS interaction

The main process does not call `fs.open`, `fs.readFile`, or any other
Node API. It calls `electron.shell.openPath(absolutePath)` and returns the
OS error string verbatim through a sanitized `OPERATION_FAILED` mapping
when the path cannot be opened.

## Scope

### Files added

1. `apps/desktop/src/renderer/xterm-worktree-file-link-provider.ts`
   - Pure factory `registerWorktreeFileLinkProvider({ terminal, resolve, onActivate })`
   - Single export surface for renderer tests.
2. `apps/desktop/src/renderer/xterm-worktree-file-link-provider.test.ts`
   - Table-driven tests covering:
     - Windows drive path (`C:\agentterm\foo\bar.ts`)
     - POSIX absolute path (`/home/x/worktrees/foo/bar.ts`)
     - URL candidate (`https://example.com/repo/foo.ts`) — must NOT match.
     - Non-absolute candidate — must NOT match.
     - Resolver returns `none` — link not emitted.

### Files modified

1. `apps/desktop/src/renderer/xterm-link-provider.ts`
   - Extract the existing `URL_PATTERN` constant into the file (it
     already exists there) but export a new `REGISTER_TERMINAL_LINK_PROVIDER_URL_PATTERN`
     constant so the test for the worktree-file provider can assert the
     *URL* provider does not consume absolute Windows paths. No behavior
     change to URL handling.
2. `apps/desktop/src/renderer/terminal-renderer.tsx`
   - Mount the new provider alongside the URL provider. Pass a new
     `onOpenWorktreeFile` prop down to the link activator.
3. `apps/desktop/src/renderer/workspace-terminals.tsx`
   - Plumb `onOpenWorktreeFile` through `WorkspaceTerminalsProps`.
4. `apps/desktop/src/renderer/agent-workspace.tsx`
   - Plumb `onOpenWorktreeFile` through `AgentWorkspaceViewProps` and wire
     it to the `desktopBridge.api.openWorktreeFile` call.
5. `apps/desktop/src/ipc-contract.ts`
   - Add channel constant `openWorktreeFile: 'agentterm:terminal:open-worktree-file'`.
   - Add `OpenWorktreeFileRequest = { readonly absolutePath: string; readonly taskId: string }`.
   - Register the request/response in both maps.
   - Add `readAbsolutePath` and `readTaskId` validators that reject `\0`,
     empty strings, and any candidate that contains `..` segments or
     control characters.
6. `apps/desktop/src/desktop-bridge.ts`
   - Expose `openWorktreeFile({ absolutePath, taskId })` on
     `AgentTermDesktopApi` via the new channel.
7. `apps/desktop/src/desktop-bridge.test.ts`
   - Extend the allowlist test to include `openWorktreeFile`.
8. `apps/desktop/src/desktop-main-handlers.ts`
   - Extend `RegisterDesktopIpcHandlersInput` to include a `shell` field
     typed `{ readonly openExternal: (url: string) => Promise<void>; readonly openPath: (absolutePath: string) => Promise<string> }`.
   - Add the dispatch case for the new channel that runs
     `resolveTerminalLinkTarget` against the production dependencies
     (passed as a new optional `resolveTerminalLinkTarget?` seam on the
     handler input — defaults to a thin in-handler shim that calls the
     injected `taskWorktrees`).
   - On success call `input.shell.openPath`; map the returned OS error
     string to `OPERATION_FAILED`.
9. `apps/desktop/src/desktop-main-handlers.test.ts`
   - Update the mock `shell` shape to include `openPath`.
   - New tests:
     - `none/EMPTY` → `NOT_FOUND`.
     - `none/OUTSIDE_WORKTREE` → `NOT_FOUND`.
     - `external-url` (resolver returns it) → `NOT_FOUND` (we never call
       `openPath` on a URL).
     - `worktree-file` → `shell.openPath` called once with the exact
       candidate, response is `null`.
     - `shell.openPath` returns non-empty error string → `OPERATION_FAILED`.
10. `apps/desktop/src/main.ts`
    - Pass `shell` (now `{ openExternal, openPath }`) when registering the
      IPC handlers.
11. `apps/desktop/src/desktop-application.ts`
    - Add an `openWorktreeFile` method that returns
      `{ ok: false, error: { code: 'NOT_FOUND', message: '…' } }` for any
      input so the typed `ProductionDesktopApplication` stays total, even
      though the actual implementation lives in `desktop-main-handlers.ts`.
      Production composition never invokes it; this keeps the interface
      compatible with the existing IPC contract tests.
12. `apps/desktop/src/renderer/workspace-controller.test.ts`
    - Update `FakeWorkspaceClient` to include a mock
      `openWorktreeFile` method that resolves to `undefined`.

### Files NOT modified

- `packages/application/src/terminal-link-resolver.ts` — already covers
  every classification we need.
- `packages/application/src/terminal-link-resolver.test.ts` — already
  covers all the resolver behaviors we rely on; if a gap appears, fix the
  test, not the resolver.
- `apps/desktop/src/main.ts` IPC handler registration is already shaped
  for additive handlers; no orchestrator change.

## Tests

### Unit tests

- `apps/desktop/src/renderer/xterm-worktree-file-link-provider.test.ts`
  (new, table-driven, ≥ 8 cases).
- `apps/desktop/src/desktop-main-handlers.test.ts` (extended, ≥ 5 cases).
- `apps/desktop/src/desktop-bridge.test.ts` (extended allowlist).
- `apps/desktop/src/renderer/workspace-controller.test.ts` (one extra mock).

### Integration tests

- A new test in `apps/desktop/src/terminal-input-pipeline.integration.test.ts`
  (or the closest existing integration file) that:
  1. Creates a real SQLite + Git fixture with a Task that has a
     `PRESENT` Worktree.
  2. Builds a `TerminalLinkResolver`-shaped adapter that wraps
     `resolveTerminalLinkTarget` with the real `persistence.worktrees`.
  3. Confirms a Windows path candidate inside the worktree returns
     `worktree-file` and that a path *outside* the worktree returns
     `OUTSIDE_WORKTREE`.

  If the existing integration test file is unavailable, fall back to
  adding one inline test in `desktop-main-handlers.test.ts` that uses
  the in-memory SQLite.

### Renderer harness tests

- No change. `terminal-renderer.tsx` is already exercised by the existing
  `terminal-renderer.test.tsx`; we extend it with one new test that
  asserts the new `onOpenWorktreeFile` callback fires once on a synthetic
  Ctrl+click event with a Windows path.

## Validation plan

- `pnpm -F @agentterm/desktop typecheck`
- `pnpm -F @agentterm/desktop lint`
- `pnpm -F @agentterm/desktop test`
- `pnpm -F @agentterm/application test`
- `pnpm -F @agentterm/application typecheck`
- Smoke: load the desktop, open a Plan-mode Codex session, watch the
  Codex agent print a path, Ctrl+click it, verify VS Code / Notepad /
  whatever default handler the OS picks opens the file.

## Risks and mitigations

1. **Path injection.** A renderer could send `{ absolutePath: 'C:\\Windows\\System32\\evil.exe', taskId: 'real' }`. Mitigation: the main process runs `resolveTerminalLinkTarget` with the real `persistence.worktrees`, and the validator rejects `..` segments and `\0` bytes. An attacker who controls `taskId` cannot bypass the worktree boundary because the worktree root comes from SQLite, not the request.
2. **Resolver drift.** If the renderer and main process use different versions of `resolveTerminalLinkTarget`, the main process wins. Mitigation: both call the same exported symbol from `@agentterm/application`; we add an assertion in `desktop-main-handlers.test.ts` that the handler imports the symbol and does not redefine it.
3. **`shell.openPath` OS quirks.** On Windows, `shell.openPath` returns an error string for missing files. Mitigation: map any non-empty return to `OPERATION_FAILED`. The user sees the standard Electron error toast.
4. **Concurrent edits.** If the worktree is removed between Ctrl+click and handler dispatch, `findByTaskId` returns `undefined` and the renderer receives `NOT_FOUND`. The renderer silently swallows `NOT_FOUND` for link activation so no toast spam.

## Deferred (explicit non-goals)

- Reading file contents into the renderer. The `getTaskFileDiff` IPC
  already exists for diff inspection.
- Per-extension opening behavior (e.g. always VS Code for `.ts`). That is OS
  configuration; AgentTerm stays a thin shell over `shell.openPath`.
- Multi-Worktree resolution. ADR-006 ships one deterministic primary
  Worktree per Task; future composite worktrees need a separate plan.