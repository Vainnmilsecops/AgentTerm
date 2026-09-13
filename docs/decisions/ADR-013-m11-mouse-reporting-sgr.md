# M11 — Mouse gesture coordination (Shift+right-click forwards to TUI)

Status: Accepted
Date: 2026-08-23
Owner: AgentTerm desktop renderer
Branch: `main`
Shipped: PR #42 (commit `bf1cf7c`) merged on 2026-08-23; updates the
`useTerminalContextMenu` host-element listener so a bare right-click opens
AgentTerm's menu while `Shift+right-click` lets the event propagate into
xterm's `CoreMouseService`, which translates it into the button-2 sequence
the active TUI asked for. Aligns AgentTerm with the convention used by
`gnome-terminal`, `kitty`, `iTerm2`, `Windows Terminal`, `Alacritty`, and
`WezTerm`.

## Context

`@xterm/xterm@6.0.0` implements mouse forwarding internally: when a
TUI emits `CSI ? 1000h` / `1002h` / `1003h`, xterm encodes the user's
mouse events into the requested protocol (SGR extended preferred over
UTF-8 basic) and writes the bytes to the PTY. TUIs that rely on
this — `vim`, `htop`, `fzf`, `lazygit`, `ranger`, `nnn`, the
Code/Claude CLI's interactive prompts — become clickable without any
renderer-side configuration.

That part already works.

What does **not** work today is **button-2** (right-click) forwarding
when a TUI requests it. AgentTerm's
`useTerminalContextMenu` hook registers a `contextmenu` listener on
the terminal panel and calls `event.preventDefault()` unconditionally,
which stops xterm from translating the right-click into the
button-2 sequence the TUI asked for. Result: the TUI never sees the
right-click, our menu always appears, and the user cannot reach
TUI-specific button-2 actions.

The smallest useful fix is the convention every popular terminal
emulator already uses:

* **Right-click** → show AgentTerm's context menu (the common case,
  works in plain shells, `bash`, `zsh`, `powershell`).
* **Shift+right-click** → forward to the TUI as button-2. This is the
  documented escape hatch in `gnome-terminal`, `kitty`, `iTerm2`,
  `Windows Terminal`, `Alacritty`, and `WezTerm`. Users coming from
  any of those tools expect it to "just work".

This slice stays inside the renderer: xterm already does the protocol
work, our surface already owns the host element, and our context
menu hook already owns the right-click gesture. We just need a
pure decision module plus one tiny behavioural change in the hook.

## Goals

1. `Shift+right-click` forwards the gesture to xterm so the active
   TUI receives a button-2 press/release. Our context menu does **not**
   appear in that case.
2. Plain `right-click` continues to show the AgentTerm context menu,
   matching today's behaviour.
3. Left-button, middle-button, hover, and drag flows are untouched.
4. The new behaviour is encoded in a pure decision module
   (`terminal-context-menu-gesture.ts`) that is unit-tested without
   xterm or React.
5. The context menu UI surfaces a one-line hint that explains the
   Shift+right-click escape hatch.

## Non-goals

- **SGR extended encoder work.** xterm already implements it.
- **Touch / multi-touch.** Desktop only; touch gestures are out of
  scope for this slice.
- **Per-TUI heuristics.** We do not try to detect `vim` vs `htop`.
  The Shift modifier is the only toggle.
- **Settings UI toggle.** Users who want the opposite priority can
  flip the modifier in a future slice; this ADR ships the convention.
- **New IPC channels.** No Application or Domain changes.
- **Visual mouse-mode badge.** A future slice can show a small
  indicator when the active TUI requests button-2 reporting; we keep
  the current empty state.

## Architectural decisions

### AD-1: One pure decision module

`terminal-context-menu-gesture.ts` exposes:

* `ContextMenuGestureKind = 'show-menu' | 'forward-to-tui'`
* `decideContextMenuGesture(event: { shiftKey: boolean; button: number; ctrlKey: boolean }): ContextMenuGestureKind`
* `CONTEXT_MENU_FORWARD_HINT` — a frozen string constant the UI uses
  for the hint line.

Rules:

* `event.shiftKey && event.button === 2` → `forward-to-tui`. Any other
  modifier (Ctrl, Alt, Meta) does **not** flip the gesture — only
  Shift is the documented escape hatch and adding more would surprise
  users with TUIs that already bind Ctrl+right-click.
* `event.button === 2 && !event.shiftKey` → `show-menu`.
* All other buttons (0 = left, 1 = middle) → `show-menu` (we ignore
  them; the existing mousedown dismissal keeps working).

The module is pure: no DOM, no React. The hook consumes the result.

### AD-2: The hook honours the decision

`useTerminalContextMenu`'s `onContextMenu` listener becomes:

```ts
const onContextMenu = (event: MouseEvent): void => {
  const inside = target.contains(event.target as Node);
  if (!inside) return;
  if (decideContextMenuGesture(event) === 'forward-to-tui') {
    // Let xterm encode the click as button-2 for the active TUI.
    return;
  }
  event.preventDefault();
  const selectionText = readWindowSelection();
  setSelection(selectionText);
  setPosition({ x: event.clientX, y: event.clientY });
};
```

We deliberately **do not** call `event.preventDefault()` on the
forward branch. xterm's listener then sees the unmodified `contextmenu`
event, runs its own `MouseService` checks against the TUI's active
mode set, and either forwards button-2 to the PTY or falls back to
its default right-click behaviour (paste from clipboard on most
platforms).

### AD-3: No new methods on TerminalSurface

The fix lives entirely in the hook. We do **not** extend
`TerminalSurface` with `setMouseReporting` or a similar toggle — xterm
already exposes its current mode to its own `MouseService` and our
hook simply steps out of the way for Shift+right-click. The previous
ADR's `setMouseReporting` method is deferred to the slice that adds a
Settings UI toggle for users who want the opposite priority.

### AD-4: Hint text lives in the menu

`TerminalContextMenu` renders a one-line `<li>` with the constant
`CONTEXT_MENU_FORWARD_HINT` after the last action when the menu
opens. The hint is `aria-hidden` on production-quality screen
readers (we do not yet know if a TUI screen reader integration is
necessary) and uses the existing muted `terminal-context-menu__hint`
class we will add to `styles/terminal.css`.

## Scope

### Files added

1. `apps/desktop/src/renderer/terminal-context-menu-gesture.ts` —
   pure decision module + `CONTEXT_MENU_FORWARD_HINT` constant.
2. `apps/desktop/src/renderer/terminal-context-menu-gesture.test.ts`
   — ≥6 cases covering each branch and modifier rule.

### Files modified

1. `apps/desktop/src/renderer/terminal-context-menu.tsx`
   * `onContextMenu` consults `decideContextMenuGesture` and either
     suppresses or forwards the event.
   * `TerminalContextMenu` renders the hint line below the action
     list when `position !== undefined`.
2. `apps/desktop/src/renderer/styles/terminal.css`
   * Adds the `.terminal-context-menu__hint` rule (muted text,
     small padding, top border).

### Files NOT modified

- `apps/desktop/src/main.ts`, `desktop-bridge.ts`,
  `desktop-application.ts`, `desktop-main-handlers.ts` — no IPC
  channels.
- `apps/desktop/src/renderer/xterm-terminal-surface.ts` — no option
  changes. Mouse forwarding is always on in xterm 6.0.0.
- `apps/desktop/src/renderer/terminal-controller.ts` — surface
  interface unchanged.
- `packages/application/**`, `packages/domain/**` — purely a view
  operation.

## Tests

### Unit tests (new)

- `terminal-context-menu-gesture.test.ts` (≥6 cases):
  * `Shift + right-click` → `forward-to-tui`
  * `right-click` (no modifier) → `show-menu`
  * `Ctrl + right-click` → `show-menu` (Ctrl is NOT the escape)
  * `Alt + right-click` → `show-menu`
  * left-button (`button === 0`) → `show-menu` (we never forward
    left clicks)
  * middle-button (`button === 1`) → `show-menu`
  * `CONTEXT_MENU_FORWARD_HINT` is non-empty and stable.

### Component tests (existing)

- The existing `terminal-context-menu.tsx` has no renderer-level
  component test today; adding one for this slice is **not** required
  because the decision module is already unit-tested and the hook's
  `onContextMenu` is a five-line branch on top of it. Manual smoke
  is the verification path for the visual hint.

## Validation plan

1. New decision-module tests pass.
2. `pnpm -F @agentterm/desktop typecheck` clean.
3. `pnpm -F @agentterm/desktop exec vitest run src/renderer/` green.
4. Manual smoke against a plain `bash` (right-click still shows the
   AgentTerm menu, Shift+right-click does not) and against `vim`
   (Shift+right-click in visual-block mode actually highlights the
   rectangle the user dragged over).

## Risks and mitigations

1. **xterm does not actually forward Shift+right-click.** xterm's
   internal MouseService uses the unmodified `mousedown` /
   `mouseup` events to build the SGR sequence. Our hook only
   controls the `contextmenu` event. We will verify by reading
   xterm 6.0.0's `MouseService` source code in this slice and add
   an explicit comment in the code if xterm needs an additional
   nudge. (Verified by the WebFetch above: xterm 6.0.0 binds
   `mousedown` directly and our `preventDefault` on `contextmenu`
   does not stop it — but we will still verify in code.)
2. **Selection-paste conflict.** xterm 6.0.0's default right-click
   on most platforms pastes from the primary selection. After our
   change, a plain right-click still prevents default (AgentTerm
   menu wins), so the default paste behaviour is preserved for
   Shift+right-click only — which matches user expectation.
3. **Hint text noise.** We render a one-line muted hint at the
   bottom of the menu. The hint is short enough to not compete with
   the actions; if telemetry later shows users dislike it, we can
   suppress it.

## Deferred (explicit non-goals)

- `TerminalSurface.setMouseReporting(mode)` for a future Settings UI
  toggle that inverts the priority.
- Touch / multi-touch.
- A visual indicator showing "TUI has requested button-2 reporting".
- Per-pane override of the Shift convention (some power users want
  Ctrl as the escape; we follow the cross-emulator default).