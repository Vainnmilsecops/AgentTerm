# M12 — Visual mouse-mode badge (CSI ? 1000h/1002h/1003h detection)

Status: Accepted
Date: 2026-08-23
Owner: AgentTerm desktop renderer
Branch: `main`
Shipped: PR #42 (commit `8adcd59`) merged on 2026-08-23; adds a per-pane
mouse-mode badge in the pane chrome that flips on when the PTY byte stream
emits `CSI ? 1000 h / 1002 h / 1003 h` (and the `1006` SGR extended pairing)
and off when the matching `l` reset is seen. Detects the mode without
reaching into xterm's internal `CoreMouseService`; renderer-only, no IPC,
no Domain change.

## Context

After M11 we ship the convention "right-click shows AgentTerm's
context menu, Shift+right-click forwards button-2 to the active TUI."
That works, but the user has to know the convention to use it. The
other half of the affordance — knowing **when** button-2 forwarding
will actually do something — is missing. Today the user has no
visible signal that the TUI has requested mouse reporting.

xterm.js 6.0.0 implements the actual forwarding internally
(`CoreMouseService`), but that service is internal — there is no
public hook for "the TUI has requested mouse reporting." We can
detect the mode ourselves by watching the byte stream we already
forward from the PTY into xterm. The TUI sets the mode with the
DEC private mode set / reset sequences:

```
CSI ? 1000 h   -> X10 (button-event tracking)
CSI ? 1002 h   -> button-event tracking + motion while a button is held
CSI ? 1003 h   -> any-event tracking (hover, etc.)
CSI ? 1006 h   -> SGR extended encoding (paired with one of the above)
```

Lowercase `l` instead of `h` clears the mode. Some TUIs also
emulate legacy protocols (`1015` for URXVT, `1005` for UTF-8, etc.)
but the four above cover the modern population we care about
(`vim`, `htop`, `lazygit`, `ranger`, `nnn`, `fzf`, `k9s`, `mc`,
`Codex/Claude` interactive prompts).

The smallest useful fix is a per-pane visual badge that flips on
when *any* of those modes are set and off when none are. The badge
sits in the existing pane chrome (the same area that holds the
session title) so it does not introduce new layout work and it does
not fight the terminal grid.

## Goals

1. Each terminal pane shows a tiny badge — the existing dot used
   for connection state, plus a "MOUSE" tooltip — when the TUI
   has requested mouse reporting.
2. The badge flips off again within one frame of the TUI clearing
   the mode (so quitting `vim` returns the pane to "no mouse").
3. The detection is **renderer-only**: no IPC, no Domain change, no
   Application change. The parser lives in `terminal-controller.ts`
   because that is the single funnel for PTY output into xterm.
4. A pure decision module (`terminal-mouse-mode-parser.ts`) carries
   the incremental state machine and is unit-tested without xterm
   or DOM.
5. The badge's tooltip explains the Shift+right-click escape hatch
   the user just learned about (it cross-references the M11 hint).

## Non-goals

- **Reading xterm's internal `CoreMouseService` directly.** It is
  not part of the public API and would break on every xterm bump.
- **Per-pane override of the Shift convention.** Deferred (still
  open from ADR-013).
- **Settings UI toggle for the priority order.** Deferred (still
  open from ADR-013).
- **Touch / multi-touch.** Out of scope.
- **A global "mouse mode active" indicator in the status bar.**
  Per-pane is more honest (some panes may be in `vim`, others in
  `bash`); a status-bar aggregate is a future slice.
- **Tracking modes we never see in the wild.** No support for the
  legacy `1005` / `1015` / `1016h` protocols; if a TUI actually
  needs them we can add a single line later.

## Architectural decisions

### AD-1: Single pure state machine

`terminal-mouse-mode-parser.ts` exposes:

* `MouseProtocol = 'NONE' | 'X10' | 'DRAG' | 'ANY' | 'SGR'`
* `MouseMode = { readonly protocol: MouseProtocol; readonly sgr: boolean }`
* `parseMouseModeChunk(state: MouseMode, chunk: string): MouseMode`
* `MOUSE_MODE_TOOLTIP` — frozen string the UI renders as the badge
  tooltip.

The parser walks the chunk with a small hand-written state machine
(csi → params → final). It recognises the four private-mode set
sequences listed above plus their `l` counterparts. It is total —
no exceptions thrown on malformed bytes.

Initial state: `{ protocol: 'NONE', sgr: false }`.

The state machine is incremental so it can be re-entered with the
previous state; the renderer keeps one parser per
`TerminalController`.

### AD-2: Funnel point stays `TerminalController`

The existing `PtyRuntimeEvent.kind === 'output'` branch in
`terminal-controller.ts` is the single funnel for PTY bytes into
xterm. We add:

```ts
this.mouseMode = parseMouseModeChunk(this.mouseMode, event.data);
this.mouseModeListeners.forEach((l) => l(this.mouseMode));
this.surface.write(event.data);
```

…and a public `onMouseModeChange(listener)` that returns an
unsubscriber. The surface interface does **not** grow; the
controller is the right layer for this signal because it owns the
PTY-to-xterm lifecycle and already routes output events.

### AD-3: TerminalSurface stays unchanged

We considered adding `surface.onMouseModeChange` so the signal
lives next to the rendering. Rejected: `TerminalSurface` is a
thin abstraction over xterm; the mouse-mode signal is a *parser*
output, not a renderer property. Keeping it on
`TerminalController` avoids the temptation to put a parser inside
the surface later.

### AD-4: Badge lives in `TerminalRenderer` chrome

We render `<span className="pane-chrome__mouse-badge">` next to
the existing connection-state dot when `mouseMode.protocol !==
'NONE' || mouseMode.sgr`. The badge is keyboard-focusable
(`tabIndex={0}`) and renders `MOUSE` text plus the existing
`title` attribute = `MOUSE_MODE_TOOLTIP`. It does not steal focus
from xterm on click; pressing it is a no-op today (a future slice
can open a small mode-detail popover).

The badge uses the muted colour already defined for the
connection-state dot so it does not introduce a new visual style.

## Scope

### Files added

1. `apps/desktop/src/renderer/terminal-mouse-mode-parser.ts` —
   pure parser + `MouseMode` + `MouseProtocol` types +
   `MOUSE_MODE_TOOLTIP`.
2. `apps/desktop/src/renderer/terminal-mouse-mode-parser.test.ts`
   — ≥10 cases covering each set/reset pair, mixed chunks,
   malformed bytes, and the tooltip.

### Files modified

1. `apps/desktop/src/renderer/terminal-controller.ts`
   * Holds one `MouseMode` per controller.
   * Updates it on every output event.
   * Adds `onMouseModeChange(listener)` with the standard
     unsubscriber return.
2. `apps/desktop/src/renderer/terminal-renderer.tsx`
   * Subscribes to `controller.onMouseModeChange`.
   * Renders the badge in the pane chrome when the protocol is not
     `NONE` or SGR is on.
3. `apps/desktop/src/renderer/styles/terminal.css`
   * Adds the `.pane-chrome__mouse-badge` rule (small text,
     `border-radius`, muted background, `aria-hidden=false` via
     title attribute).

### Files NOT modified

- `apps/desktop/src/renderer/xterm-terminal-surface.ts` —
  untouched.
- `apps/desktop/src/main.ts`, `desktop-bridge.ts`,
  `desktop-application.ts`, `desktop-main-handlers.ts` — no IPC.
- `packages/application/**`, `packages/domain/**` — purely a
  view operation.
- `apps/desktop/src/renderer/terminal-controller.test.ts` — the
  FakeSurface does not need to grow (we add a separate controller
  test for the listener wiring).

## Tests

### Unit tests (new)

- `terminal-mouse-mode-parser.test.ts` (≥10 cases):
  * `CSI ? 1000 h` → X10
  * `CSI ? 1002 h` → DRAG
  * `CSI ? 1003 h` → ANY
  * `CSI ? 1006 h` → SGR on, protocol unchanged
  * combined `CSI ? 1006 ; 1000 h` → X10 + SGR (note: real TUIs
    emit them in separate `CSI ?` blocks; this verifies the parser
    can also handle a single combined block)
  * reset `CSI ? 1000 l` → back to NONE / SGR unchanged
  * reset all modes → NONE
  * non-DEC private-mode `CSI ? 7 h` (line wrap) → no change
  * malformed `\u001b[? 1000` truncated → no change
  * `MOUSE_MODE_TOOLTIP` is non-empty and mentions Shift

### Integration tests (controller)

- New `terminal-mouse-mode-listener.test.ts`:
  * subscribe, fire two output events, see two listener calls
  * unsubscribe and verify no further calls
  * a controller that never receives an output event never calls
    the listener

### Component tests

- Existing renderer tests still pass; the badge is a small
  conditional render and the parser is the testable core.

## Validation plan

1. New parser tests pass (≥10 cases).
2. New controller listener tests pass.
3. `pnpm -F @agentterm/desktop typecheck` clean.
4. `pnpm -F @agentterm/desktop exec vitest run src/renderer/`
   green.
5. Manual smoke: open a pane, run `vim`, badge appears within
   one frame of `vim` switching to its mouse-friendly UI; quit
   `vim`, badge disappears.

## Risks and mitigations

1. **Parser is too eager and reacts to false positives** (random
   bytes that happen to start with `CSI ? 1000`). Mitigation: the
   matcher only fires on the literal final byte `h` / `l` after
   the mode number, and the parser keeps its current state if the
   sequence is malformed mid-way. The test suite exercises
   truncation explicitly.
2. **Performance cost of running the parser on every byte.** The
   parser is O(chunk length) with a small constant; chunks from
   ConPTY are already batched and capped. We add a counter test
   (1 MB chunk of plain ASCII, parser stays under a few
   microseconds) and document it in the ADR.
3. **Listener leaks when a pane unmounts.** `TerminalController`
   already enforces a `disposed` flag; the listener map is cleared
   in `dispose()`. Verified by the existing
   `terminal-controller.test.ts` shape.

## Deferred (explicit non-goals)

- A small popover showing the precise protocol (X10 / DRAG / ANY
  + SGR on/off) when the user clicks the badge. Future slice.
- Status-bar aggregate ("3 panes in mouse mode").
- Per-pane override of the Shift convention.
- Settings UI toggle for the priority order.
- Touch / multi-touch.