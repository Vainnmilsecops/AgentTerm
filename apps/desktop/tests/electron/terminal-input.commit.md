# M1 commit prep — terminal input pipeline

This script is the output of an agent that could not run `git` itself due to a
sandbox policy error on Windows. Run it from an unrestricted PowerShell or
`git bash` at `D:\Core\AgentTerm`.

## 1. Confirm working tree state

```bash
git status --short
git rev-parse --abbrev-ref HEAD
```

Expected:
- Current branch is `main`.
- Working tree contains the new files listed below plus whatever was already
  untracked before this chat.

New files (expected to be staged):

```
apps/desktop/src/renderer/terminal-context-menu.ts
apps/desktop/src/renderer/terminal-context-menu.tsx
apps/desktop/src/renderer/terminal-context-menu.test.ts
apps/desktop/src/renderer/terminal-input-glue.ts
apps/desktop/src/renderer/terminal-input-glue.test.ts
apps/desktop/src/renderer/terminal-keyboard-controller.ts
apps/desktop/src/renderer/terminal-keyboard-controller.test.ts
apps/desktop/src/renderer/terminal-paste-controller.ts
apps/desktop/src/renderer/terminal-paste-controller.test.ts
apps/desktop/src/renderer/use-terminal-input.ts
apps/desktop/tests/electron/terminal-input.smoke.md
```

Modified files (expected to be staged):

```
apps/desktop/src/renderer/terminal-controller.ts
apps/desktop/src/renderer/terminal-controller.test.ts
apps/desktop/src/renderer/terminal-renderer.tsx
apps/desktop/src/renderer/xterm-terminal-surface.ts
```

The agent did **not** touch:
- `pnpm-lock.yaml` (left as-is; it shows as `M` in the snapshot but that
  modification predates this work — confirm via `git diff pnpm-lock.yaml`).
- `apps/desktop/node_modules/**` (all `??` entries there should be ignored).
- Any file in `node_modules/` at the repo root.
- Any file in `packages/*/dist/`.

If anything else shows up in `git status --short`, stop and ask the agent
which files belong to or should be excluded from this commit.

## 2. Create branch and stage

```bash
git checkout -b cursor/terminal-input-pipeline-m1
git add \
  apps/desktop/src/renderer/terminal-context-menu.ts \
  apps/desktop/src/renderer/terminal-context-menu.tsx \
  apps/desktop/src/renderer/terminal-context-menu.test.ts \
  apps/desktop/src/renderer/terminal-input-glue.ts \
  apps/desktop/src/renderer/terminal-input-glue.test.ts \
  apps/desktop/src/renderer/terminal-keyboard-controller.ts \
  apps/desktop/src/renderer/terminal-keyboard-controller.test.ts \
  apps/desktop/src/renderer/terminal-paste-controller.ts \
  apps/desktop/src/renderer/terminal-paste-controller.test.ts \
  apps/desktop/src/renderer/use-terminal-input.ts \
  apps/desktop/tests/electron/terminal-input.smoke.md \
  apps/desktop/src/renderer/terminal-controller.ts \
  apps/desktop/src/renderer/terminal-controller.test.ts \
  apps/desktop/src/renderer/terminal-renderer.tsx \
  apps/desktop/src/renderer/xterm-terminal-surface.ts
```

## 3. Verify staged set

```bash
git status --short
git diff --cached --stat
```

Expected: 15 files, no `pnpm-lock.yaml`, no `node_modules/`, no `dist/`.

## 4. Commit

```bash
git commit -m "$(cat <<'EOF'
M1: terminal input pipeline — Ctrl+C copy/ETX, paste confirm, context menu

Adds the renderer-side input pipeline for the Agent Session terminal:

- terminal-keyboard-controller: pure decision table for Ctrl+C/Ctrl+V/
  Ctrl+Insert and IME composing guard; tested isolated.
- terminal-paste-controller: classifyPaste + evaluatePaste with 8 KiB
  confirm threshold and 1 MiB reject threshold; UTF-8 byte length.
- terminal-context-menu: pure action table + React component + hook for
  the right-click menu.
- terminal-input-glue: pure dispatchPasteText / dispatchConfirmPaste /
  handleKeyEvent / failureToFeedback, exercised by unit tests.
- useTerminalInput: React hook wrapping the glue for the renderer.
- TerminalController: serialized FIFO write queue, pasteText / sendBytes,
  failureSink for paste/write failures, attachCustomKeyEventHandler
  wired into xterm.
- XtermTerminalSurface: paste / selectAll / getSelection / setKeyHandler
  / setContextMenuHandler / hostElement.
- TerminalRenderer: wires keyboard, paste-confirmation dialog, failure
  banner, and context menu into the pane.
- apps/desktop/tests/electron/terminal-input.smoke.md: manual Electron
  smoke checklist.

No terminal input is sent without going through the controller queue,
so order is preserved under bursty typing and back-pressure. Clipboard
text is not logged anywhere; paste errors surface via the banner.

Unverified: no shell access on this machine, so vitest, pnpm, and
git were run by the user. The smoke checklist at
apps/desktop/tests/electron/terminal-input.smoke.md should be exercised
before merging.
EOF
)"
```

## 5. Re-check

```bash
git log --oneline -1
git status
```

Expected: branch `cursor/terminal-input-pipeline-m1`, one commit, clean
working tree (modulo pre-existing untracked files).

## 6. If anything looks wrong

- `git restore --staged <path>` to drop a file.
- `git commit --amend` only if the commit is the last one on this branch
  and you have not pushed (per AGENTS.md amend rules).
- Stop and ask the agent to fix the file rather than guessing.
