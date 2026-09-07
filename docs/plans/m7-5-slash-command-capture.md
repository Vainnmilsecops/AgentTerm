# Plan — M7.5: Slash-command trigger for brainstorm / sweep capture

Status: Ready for review (vertical-slice plan)
Owner: Renderer (Presentation)
Depends on: PR #49 (M7 shipped), ADR-018 AD-1, ADR-011 (terminal input pipeline), ADR-016 (renderer workflow).

## 1. Goal

Let a user typing `/agtx:brainstorm` (or `/agtx:sweep`) on a focused terminal pane — followed by `Enter` — open a keyboard-first multi-line capture overlay that records a `BRAINSTORM` or `SWEEP` artifact through the existing M7 pipeline. Normal agent keystrokes, including paths and chat text that *contain* the token mid-line, must continue to flow through the PTY unchanged.

## 2. Scope

**In scope**

- Slash-command detection at the xterm `Enter` boundary inside the renderer input pipeline.
- A new `SessionNoteCaptureOverlay` component (multi-line textarea, Ctrl+Enter submit, Esc cancel, validation preview, server-error display).
- A renderer-only `noteCapture` state field on `AgentWorkspaceView` plus an `onSlashTrigger` callback.
- Removal of the M7 `window.prompt` collector from `agent-workspace.tsx`.
- Status feedback after submit via the existing `TerminalInputFeedback` (`info` level).

**Out of scope**

- Slash-command autocomplete, command history, palette integration of slash text.
- Provider-specific commands, MCP surface changes, plugin-level hooks.
- New Application use case, new IPC channel, renderer-chosen arbitrary paths, persisted / SaaS auth.

## 3. Decisions

**D1 — Detect in `terminal-input-glue`, not the controller.**
Hook the existing `decideKeyOutcome` flow by tracking the *current line* of xterm input via the controller's `surface.onInput` subscription already wired in `TerminalController.mount` (see `apps/desktop/src/renderer/terminal-controller.ts` around the `inputSubscription` callback and the `enqueueWrite` path). On Enter (`\r` or `\n`), test the tracked line against an exact-match regex anchored at line start. Non-matching lines — including leading or trailing whitespace, mid-line `/agtx:`, and path inputs that contain `/agtx:brainstorm` — fall through to the existing PTY write path unchanged. The detector lives in a new pure function (`detectSlashCommand(line)`) co-located with `decideKeyOutcome` in `terminal-keyboard-controller.ts` so it stays a renderer-only, side-effect-free decision table. When the detector returns an action, the input glue suppresses forwarding the matched line (drops the pending bytes) and emits the action through `TerminalInputFeedback` (info) plus a callback to open the overlay. Implementation hook point: extend `terminal-input-glue.ts` (new helper `detectSlashCommand` + a `TerminalActionKind` value) without changing `terminal-controller.ts`'s public surface.

**D2 — Capture overlay, not `window.prompt`.**
Re-create `apps/desktop/src/renderer/session-note-capture-overlay.tsx` as a React overlay (modal-friendly, `role="dialog"`, `aria-modal="true"`, focus trap returning focus to the terminal on close). Multi-line `<textarea>`; `Ctrl+Enter` triggers submit, `Esc` triggers cancel. Validation preview shows the eventual `# Brainstorm` / `# Sweep` heading, body length, NUL-byte guard, and the existing 8 KiB content budget from the IPC contract. The overlay surfaces server errors from the controller's `captureSelectedBrainstormNote` / `captureSelectedSweepNote` rejections without crashing the workspace.

**D3 — Renderer-only trigger; Application unchanged.**
No new Application use case, no new IPC channel. The slash command opens the overlay; the overlay submit calls `controller.captureSelectedBrainstormNote({ content, id })` / `captureSelectedSweepNote({ content, id })` already exposed by `WorkspaceController` (see `apps/desktop/src/renderer/workspace-controller.ts`). Existing channels `agentterm:artifact:brainstorm:record` and `agentterm:artifact:sweep:record` carry the submission. Domain rules, IPC contract, SQLite migration, and Application use cases are untouched.

Exact-match regex (anchored, single-line token, optional single trailing space):

```text
^\/agtx:(brainstorm|sweep)\s?$
```

## 4. Milestone breakdown

Each milestone compiles, lints, and passes targeted tests before the next.

1. **M7.5.1 — Renderer state only.** Add `noteCapture: { kind: 'brainstorm' | 'sweep'; busy: boolean; error: string | undefined } | undefined` to `AgentWorkspaceView`. No behaviour change; existing `window.prompt` path still active. Tests: extend `agent-workspace.test.tsx` with a snapshot asserting `noteCapture` is `undefined` on mount.
2. **M7.5.2 — Re-create `SessionNoteCaptureOverlay`.** New file `apps/desktop/src/renderer/session-note-capture-overlay.tsx` plus `session-note-capture-overlay.test.tsx`. Tests cover: heading preview, NUL-byte guard (`\u0000`), length cap rejection at the contract budget, `Ctrl+Enter` submit, `Esc` cancel, focus-trap restores focus to the previously focused terminal on close.
3. **M7.5.3 — Slash-command detector.** Add `detectSlashCommand(line)` to `terminal-keyboard-controller.ts` and an integration point in `terminal-input-glue.ts` that tracks the current line buffer, suppressing forward on match and emitting the action kind. Tests: table-driven (`/agtx:brainstorm`, `/agtx:sweep`, leading whitespace `   /agtx:brainstorm`, trailing whitespace `x`, trailing chars `/agtx:brainstorm!`, mid-line `echo /agtx:brainstorm`, case `/AGTX:BRAINSTORM`, empty, unknown token).
4. **M7.5.4 — Wire detector → overlay → submit.** When the detector fires, the input glue calls a renderer-provided callback; `AgentWorkspaceView` opens `noteCapture`. Submit reuses `controller.captureSelectedBrainstormNote` / `captureSelectedSweepNote`; on success clear state and push an `info` `TerminalInputFeedback` ("Brainstorm note captured" / "Sweep note captured"). On failure set `noteCapture.error` from the controller's structured rejection (sanitized). Tests: store-level dispatch test for both kinds; integration smoke uses the existing `sqlite-note-capture-persistence.integration.test.ts` unchanged.
5. **M7.5.5 — Remove `window.prompt` collector.** Delete `promptForBrainstormNote`, `promptForSweepNote`, and `promptForSessionNote` from `apps/desktop/src/renderer/agent-workspace.tsx`. Update `agent-workspace.test.tsx` to expect overlay dispatch. The palette and `Alt+Shift+B` / `Alt+Shift+W` shortcuts now open the overlay directly.
6. **M7.5.6 — Documentation refresh.** After ship: append an "M7.5 — Slash-command trigger" sub-section under "Recently Shipped" in `docs/CURRENT_STATE.md`. Update ADR-018 AD-1 status note from "deferred" to "implemented" referencing the new PR. Remove the M7.5 deferred item from `docs/CURRENT_STATE.md` Blockers (the input-pipeline false-positive concern is now resolved).

## 5. Files touched

**Renderer (changes):**

- `apps/desktop/src/renderer/terminal-input-glue.ts` — track current line buffer; suppress PTY forward on slash match; emit `BRAINSTORM_OPEN` / `SWEEP_OPEN` actions.
- `apps/desktop/src/renderer/terminal-keyboard-controller.ts` — add pure `detectSlashCommand(line)` decision helper.
- `apps/desktop/src/renderer/agent-workspace.tsx` — add `noteCapture` state, mount overlay, route `onCaptureBrainstormNote` / `onCaptureSweepNote` to overlay submit; remove `promptForBrainstormNote` / `promptForSweepNote` / `promptForSessionNote`; palette commands open overlay.
- `apps/desktop/src/renderer/session-note-capture-overlay.tsx` *(new)* — overlay component.
- `apps/desktop/src/renderer/session-note-capture-overlay.test.tsx` *(new)*.
- `apps/desktop/src/renderer/terminal-input-glue.test.ts` *(new or extended)* — table-driven detector tests.
- `apps/desktop/src/renderer/agent-workspace.test.tsx` — update for overlay state.
- `apps/desktop/src/renderer/workspace-controller.test.ts` — coverage for overlay-driven submit path.

**Domain / Application / Infrastructure:** **no change.** `recordBrainstormArtifact`, `recordSweepArtifact`, SQLite migration 0021, and IPC channels `agentterm:artifact:brainstorm:record` / `agentterm:artifact:sweep:record` are reused as-is.

**Documentation:**

- `docs/CURRENT_STATE.md` — append "M7.5" to "Recently Shipped"; remove the M7.5 deferred item from Blockers.
- `docs/decisions/ADR-018-m7-brainstorm-sweep-capture.md` — change AD-1 status note from "deferred" to "implemented" referencing the new PR.

## 6. Tests

**Unit / component**

- `terminal-input-glue.test.ts` — `detectSlashCommand` table cases: exact match brainstorm, exact match sweep, leading whitespace, trailing whitespace, mid-line occurrence, case mismatch, empty input, unknown token, `/agtx:brainstorm!` (extra trailing char), `echo /agtx:brainstorm`.
- `session-note-capture-overlay.test.tsx` — heading preview renders, NUL-byte rejection, length-cap rejection, `Ctrl+Enter` calls submit, `Esc` calls cancel, focus returns to terminal on close.
- `agent-workspace.test.tsx` — overlay state transitions `undefined → brainstorm → undefined` on success; `undefined → brainstorm → undefined (error)` on rejection.
- `workspace-controller.test.ts` — overlay-driven submit path invokes the existing M7 controller methods.

**Integration smoke (reuse, no change):**

- `apps/desktop/tests/integration/sqlite-note-capture-persistence.integration.test.ts` — round-trip via the existing IPC channel after the slash-command path triggers capture.

## 7. Validation

Per slice, then full:

- `pnpm --filter agentterm-desktop typecheck`
- `pnpm --filter agentterm-desktop lint`
- `pnpm --filter agentterm-desktop test` (vitest targeted)
- `pnpm test` (root, full)

Three Windows-only tests are known-flaky and unrelated to this change: `git-cli-repo-inspector`, `git-task-change-inspector`, `git-task-review-code-inspector`. Re-run individually if they fail during `pnpm test`; ignore during the targeted run.

## 8. Risks

- **False-positive intercept.** A user typing a path or chat line that exactly equals `/agtx:brainstorm` would be intercepted. Mitigation: regex is anchored, requires the entire line to match the token (optional single trailing space only). Any additional character falls through.
- **Lost input bytes.** A matched line could be forwarded to the PTY. Mitigation: the input glue suppresses the pending write when the detector matches; only the post-match bytes (none, since the line was a single token) flow through.
- **Overlay focus stealing.** Mitigation: overlay is modal with `role="dialog"` + `aria-modal="true"` and returns focus to the previously focused terminal pane on cancel/submit/error.
- **Dead `window.prompt` path.** Mitigation: M7.5.5 deletes `promptForBrainstormNote`, `promptForSweepNote`, and `promptForSessionNote` together with their tests.
- **No capture when no session is attached.** The existing controller methods reject when the selected Task lacks an active session; overlay surfaces that error via `noteCapture.error`.

## 9. Out of scope (deferred)

- Slash-command autocomplete, command history, palette text integration.
- Provider-specific commands and MCP surface changes.
- Plugin-level hooks or workflow-plugin slash tokens.
- Persisting user-defined slash tokens.

Plan file: `d:\Core\AgentTerm\docs\plans\m7-5-slash-command-capture.md`
