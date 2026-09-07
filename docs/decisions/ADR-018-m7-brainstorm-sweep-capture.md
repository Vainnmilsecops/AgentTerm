# ADR-018: M7 — Brainstorm / Sweep in-session capture

Status: Accepted
Date: 2026-09-07
Owner: AgentTerm desktop renderer + application
Depends on: ADR-009 (M3 research artifact contract),
ADR-011 (terminal input pipeline), ADR-016 (renderer workflow).

## Context

ADR-009 deferred "M7 — Brainstorm / Sweep in-session capture" with the
note: *"Requires unifying the brainstorm capture with the existing PTY
input pipeline."* Without M7 the user has no in-session way to capture
an agent's free-form idea (brainstorm) or a finalisation summary (sweep)
that is later reviewable alongside plan / execution summary / review
artifacts.

M6 ships the RESEARCH auto-advance + the renderer `Start research`
button (PRs #45, #47, #48). M5 ships the renderer workflow for
`startTaskResearch`, palette command, mnemonic hint, and a `RESEARCH`
kind in `ArtifactProducer` (PR #44 / ADR-016). The terminal input
pipeline (`terminal-input-glue`, `use-terminal-input`,
`terminal-controller`) is mature and tested (ADR-011). Every required
backend building block for M7 already exists.

User-visible need: while a Research / Planning / Running / Review
agent session is attached to a terminal pane, the user wants to
capture a note **without** forwarding raw keystrokes to the agent and
without leaving the workspace. The captured note must be persisted with
provenance (session, task, timestamp), visible in the existing
`ArtifactHistory`, and never confused with an agent-produced artifact.

## Goals

1. While an agent session is attached, the user opens the workspace
   command palette (or uses the mnemonic shortcut) and runs
   "Capture brainstorm note" or "Capture sweep note". The renderer
   opens a capture overlay that collects a multi-line note.
2. The overlay accepts multi-line content (a `Brainstorm` or `Sweep`
   note), previews it, and submits through a new application use case
   that records a `BRAINSTORM` / `SWEEP` artifact.
3. The captured note shows up in `ArtifactHistory` with a distinct
   eyebrow and `data-artifact-kind` so the reviewer can scan the
   evidence timeline at a glance.
4. The capture is keyboard-only and respects the existing terminal
   keyboard pipeline (Esc cancels, Ctrl+Enter submits).

## Non-goals

- No autonomous sweep orchestration. The sweep note is human-captured.
- No change to `TaskPhase`, `ExecutionHealth`, or `AgentSessionStatus`.
- No new Domain rules around research/plan readiness.
- No new database tables. The artifacts live in the existing
  `execution_artifact` table with new `kind` values.
- No PTY read interception beyond the slash-command token.
- No change to existing agent-input keystrokes — only the leading
  `/agtx:brainstorm` (and `…sweep`) token is intercepted.

## Architectural decisions

### AD-1: Capture trigger lives in renderer-only actions

The renderer exposes two capture paths, both keyboard-first:

- A **palette command** (`task:capture-brainstorm`, `task:capture-sweep`)
  visible when the selected Task has an attached AgentSession.
- A **mnemonic hint** (`Alt+Shift+B` for brainstorm, `Alt+Shift+W` for
  sweep) on the focused terminal pane, mirroring the existing
  `task:start-research` shortcuts.
- A **slash command** (`/agtx:brainstorm` or `/agtx:sweep` + `Enter`) inside
  the xterm buffer. The detector lives inside `TerminalController`:
  a pure `detectSlashCommand(line)` function (exact-match regex
  `/^\/agtx:(brainstorm|sweep)\s?$/`) runs at each line-terminator
  boundary, suppressing PTY forward when the line matches and emitting a
  `SlashCommandEvent` through a `TerminalController.onSlashCommand`
  listener. The `TerminalRenderer` wires the listener to open the
  `SessionNoteCaptureOverlay`. Non-matching lines (including mid-line
  mentions, leading whitespace, or extra trailing characters) flow through
  to the PTY unchanged.

The slash-command detector is renderer-only; no new IPC channel, no
change to Application or Domain. The `SessionNoteCaptureOverlay` replaces
the `window.prompt` collector from M7 with a proper modal (multi-line
textarea, live preview, `Ctrl+Enter` submit, `Esc` cancel, NUL-byte and
length validation).

The decision to keep these actions in Presentation is consistent with
ADR-011 (terminal input pipeline) and ADR-016 (renderer workflow):
presentation owns user-facing triggers, application owns business
validation, the persistence boundary is unchanged.

### AD-2: Capture overlay is a renderer-only component

A new `<BrainstormCaptureOverlay>` is mounted next to the terminal
pane. It is a textarea + preview + submit / cancel controls. It only
appears when an `AgentSession` is attached and the slash command was
triggered. Esc cancels (discards the note), Ctrl+Enter submits.

The overlay is renderer state, not an Application port. Submission
goes through a new IPC channel (`recordBrainstormArtifact`,
`recordSweepArtifact`) which validates the markdown locally before
the IPC round-trip.

### AD-3: Two new artifact kinds share the existing pipeline

We extend `ExecutionArtifactKind` with `BRAINSTORM` and `SWEEP`. Both
kinds reuse the existing `ExecutionArtifactRepository` storage and
validation pipeline:

- `canonicalName`: `brainstorm/{taskId}-{sessionId}-{createdAt}.md`
  and `sweep/{taskId}-{sessionId}-{createdAt}.md`
- `heading`: `# Brainstorm` and `# Sweep`
- `phase`: the Task's current phase at capture-time (read inside the
  use case). The contract still binds a `TaskPhase` value but the
  use case resolves it dynamically instead of statically.
- `validation`: `VALID` once the heading + non-empty body + length
  budget are satisfied, same `assertValidContent` invariant.

We add two narrow use cases — `recordBrainstormArtifact` and
`recordSweepArtifact` — that share a single helper
`serializeNoteArtifact(kind, input, deps)` because the only difference
between them is the `kind` and the slash-command token. They reuse the
existing `serializeTaskWorkflow` lock (the same one RESEARCH uses) to
avoid interleaved writes to the same Task's artifact history.

A `sessionId` is required for these kinds (mid-session capture has no
meaning without one). The use case throws `TypeError` if absent or
blank, matching the existing RESEARCH contract.

### AD-4: Renderer plumbing is small and idiomatic

- New IPC channels in `ipc-contract.ts`:
  - `desktopIpcChannels.recordBrainstormArtifact`
  - `desktopIpcChannels.recordSweepArtifact`
  - Payload: `{ taskId, sessionId, content, createdAt, id }`.
- `desktop-bridge.ts` exposes `recordBrainstormArtifact` and
  `recordSweepArtifact` on `AgentWorkspaceClient`.
- `desktop-application.ts` adds handlers that call the new
  application use cases.
- `workspace-controller.ts` gains `captureBrainstormNote()` and
  `captureSweepNote()` methods. The methods require an attached
  session for the selected Task; otherwise they throw a domain error.
- `workspace-command-palette.ts` exposes "Capture brainstorm note" and
  "Capture sweep note" actions; visibility = same as
  `task:start-research` (Task has an active attached session).
- `mnemonic-hints.ts` adds `Alt+Shift+B` (brainstorm) and `Alt+Shift+W`
  (sweep) for the focused terminal pane. The slash commands remain
  the primary path; the shortcuts are for users who forget the tokens.

### AD-5: `ArtifactHistory` recognises the new kinds

`ArtifactHistory` already tags each card with `data-artifact-kind`
(planned in ADR-016 AD-3). The renderer reads `kind` from the artifact
and renders a kind-specific eyebrow:

- `RESEARCH` → eyebrow "Research"
- `PLAN` → eyebrow "Plan"
- `EXECUTION_SUMMARY` → eyebrow "Execution summary"
- `REVIEW` → eyebrow "Review"
- `BRAINSTORM` → eyebrow "Brainstorm"
- `SWEEP` → eyebrow "Sweep"

A subtle accent colour (derived from existing CSS variables, no new
design tokens) makes brainstorm/sweep cards visually distinct from
phase artifacts without making them look like alerts.

## Milestones

One milestone, shipped as one PR (`chore/m7-brainstorm-sweep`):

### M7-BRAINSTORM-SWEEP — In-session capture

**Scope:**

1. **Domain**
   - Add `BRAINSTORM` and `SWEEP` to `ExecutionArtifactKind`.
   - Add contracts: canonical names, headings, dynamic phase resolver.
   - Extend `createExecutionArtifact` to accept the dynamic phase for
     brainstorm/sweep kinds (a new `phase?: TaskPhase` optional
     input). Other kinds keep their static contract phase.
   - Domain tests for the two new contracts + dynamic phase.

2. **Application**
   - `recordBrainstormArtifact(input, deps)` and
     `recordSweepArtifact(input, deps)` use cases.
   - Both throw on missing/blank `sessionId`, validate length budget,
     share a helper that uses `serializeTaskWorkflow` (matching
     `recordResearchArtifact`).
   - Re-export from `packages/application/src/index.ts`.
   - Application unit tests for happy path, missing session id,
     over-length content, and serialised-lock behaviour.

3. **Infrastructure**
   - No new schema. Existing `execution_artifact` table accepts the
     new kinds because `kind` is stored as `text`.
   - No migration. The same `SqliteExecutionArtifactRepository`
     persists the new artifacts transparently.
   - One targeted persistence round-trip test that confirms the new
     kinds are queryable by `kind` filter.

4. **Desktop**
   - New IPC channels `recordBrainstormArtifact`,
     `recordSweepArtifact` in `ipc-contract.ts`, with payload
     validation that mirrors `createArtifact` (non-blank id, taskId,
     sessionId; length budget on content).
   - `desktop-main-handlers.ts` routes the new channels to the
     desktop application handlers.
   - `desktop-application.ts` exposes two handlers that delegate to
     the new application use cases. The handlers require the desktop
     application to be open.
   - `desktop-bridge.ts` exposes `recordBrainstormArtifact` and
     `recordSweepArtifact`.

5. **Renderer**
   - `terminal-input-glue.ts` gains `BRAINSTORM_OPEN` and `SWEEP_OPEN`
     in `TerminalActionKind`. A new `detectSlashCommand(line)` helper
     inspects the current xterm line buffer and returns the action
     when the line exactly matches `/agtx:brainstorm` or
     `/agtx:sweep` (with optional trailing space). The token is
     cleared from the input line before any forwarding happens so the
     PTY never sees the slash command.
   - `use-terminal-input.ts` exposes `openBrainstormCapture` and
     `openSweepCapture` callbacks that route through the workspace
     controller.
   - `BrainstormCaptureOverlay.tsx` (new): textarea, live preview,
     submit (Ctrl+Enter), cancel (Esc), accessible (`role=dialog`,
     `aria-modal=true`).
   - `ArtifactHistory.tsx` recognises `BRAINSTORM` / `SWEEP` and
     renders the eyebrow accent.
   - `workspace-command-palette.ts` exposes the two new actions with
     visibility tied to having an active session.
   - `mnemonic-hints.ts` adds `Alt+Shift+B` and `Alt+Shift+W` for the
     focused terminal pane.
   - `workspace-controller.ts` adds `captureBrainstormNote()` and
     `captureSweepNote()` that delegate to the bridge and refresh the
     workspace.

6. **Tests**
   - Domain: two contract tests for brainstorm/sweep.
   - Application: `recordBrainstormArtifact` and `recordSweepArtifact`
     happy path + missing session id + over-length content + same-task
     serialised lock.
   - Desktop IPC contract: two new validation rows for
     `recordBrainstormArtifact` and `recordSweepArtifact` (mirror the
     `createArtifact` rows).
   - Renderer: slash-command interceptor table-driven tests (exact
     match, leading whitespace, trailing characters, case sensitivity,
     unknown token, empty input).
   - Renderer: `<BrainstormCaptureOverlay>` submit / cancel / validation
     tests.
   - Renderer: `ArtifactHistory` snapshot for a Task with mixed
     RESEARCH + BRAINSTORM + SWEEP + PLAN + EXECUTION_SUMMARY + REVIEW
     cards.
   - Renderer: palette commands + mnemonic hints table-driven tests.
   - Persistence round-trip integration test for both new kinds.

## Risks

1. **Slash-command false positives.** A user typing a path that starts
   with `/agtx:brainstorm` would be intercepted. Mitigation: the
   detector requires the line to **equal** the token (or token +
   single trailing space). Any additional character causes the bytes
   to flow through to the PTY.
2. **Multi-line capture without a Task context.** A user can trigger
   the slash command even when no Task is selected (terminal is the
   focus but the workspace selection is elsewhere). Mitigation: the
   overlay disables Submit if the controller cannot resolve a Task +
   session pair; the controller rejects with a domain error.
3. **Phase mismatch for brainstorm/sweep.** The dynamic phase resolver
   reads the Task's current phase at capture-time. A note captured
   during PLANNING and viewed later (Task now in REVIEW) shows the
   PLANNING phase. This is intentional: the note is bound to the phase
   in which it was captured, not the latest phase.
4. **Capture overlay competes with terminal paste confirmation.**
   The paste confirmation dialog must take priority. The overlay's
   keyboard controller checks the paste-confirmation-visible state
   and defers opening if a paste is pending.
5. **Storage growth.** Each capture writes an artifact. Mitigation:
   the existing artifact repository has no truncation; brainstorm /
   sweep follow the same rule as RESEARCH. No quota introduced in
   this milestone.

## Validation plan

- Per step: `pnpm --filter @agentterm/domain typecheck`,
  `pnpm --filter @agentterm/application typecheck`,
  `pnpm --filter @agentterm/infrastructure typecheck`,
  `pnpm --filter agentterm-desktop typecheck`,
  `pnpm --filter agentterm-desktop lint`.
- Targeted: `pnpm --filter @agentterm/domain test`,
  `pnpm --filter @agentterm/application test`,
  `pnpm --filter @agentterm/infrastructure test`,
  `pnpm --filter agentterm-desktop test`.
- Full: `pnpm test` at the repo root.
- Manual smoke checklist (committed as
  `apps/desktop/tests/electron/m7-brainstorm-sweep.smoke.md`):
  - Open a Task with an attached Research session.
  - Type `/agtx:brainstorm` then `Enter`; confirm the overlay opens,
    the token is cleared from the terminal, the textarea accepts
    multi-line input, Ctrl+Enter submits, and the new BRAINSTORM card
    appears in `ArtifactHistory`.
  - Esc cancels; the terminal still works.
  - Repeat with `/agtx:sweep` and confirm the SWEEP card.
  - Repeat with leading whitespace before `/agtx:brainstorm`; confirm
    the bytes flow through to the PTY unchanged.
