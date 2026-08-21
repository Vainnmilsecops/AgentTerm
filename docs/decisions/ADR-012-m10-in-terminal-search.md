# M10 — In-terminal search (Ctrl+Shift+F)

Status: Proposed
Date: 2026-08-22
Owner: AgentTerm desktop renderer
Branch: `cursor/terminal-context-menu-agent-actions`

## Context

`M7` (bracketed paste), `M8` (focus restoration), and `M9` (URL + worktree-file hyperlinks) all shipped on this branch. The terminal pane supports pasting, focusing, navigating, and clicking links. It does not yet support **searching**: a developer scrolling through agent output cannot jump to a particular log line, error, or symbol without re-running the agent.

`@xterm/xterm` ships an official companion addon, `@xterm/addon-search`, that walks the buffer and highlights matches. Wrapping it behind a renderer-owned UI overlay (open / close / next / previous / case-sensitivity) is the smallest vertical slice that delivers the feature without changing Domain, Application, or Infrastructure. The renderer already owns the keyboard pipeline (`use-terminal-input`, `terminal-input-glue`, `terminal-keyboard-controller`) so we extend it in the same place where `Ctrl+Shift+P` opens the command palette.

The scope deliberately stays inside the renderer. Search is a *view* operation: it never asks the PTY to re-emit output, never reaches into Domain, and never crosses the IPC boundary. The plan therefore avoids new Application ports and new IPC channels.

## Goals

1. `Ctrl+Shift+F` opens a search bar docked to the bottom of every active terminal pane.
2. The search bar accepts regex or plain text (toggle), case-sensitive or insensitive (toggle), and exposes Next / Previous / Close actions.
3. `Enter` triggers Next; `Shift+Enter` triggers Previous; `Escape` closes the bar.
4. Closing the bar clears all match highlights and restores focus to the xterm surface.
5. Search state is local to one pane; opening another pane's search does not affect the first.
6. Hidden / detached panes do not display a search bar even if their state is `attached`.
7. The keyboard handler in `terminal-keyboard-controller` recognizes `Ctrl+Shift+F` only when xterm is focused (consistent with the existing `Ctrl+Shift+P` / `Ctrl+Shift+C` / `Ctrl+Insert` rules).

## Non-goals

- **Cross-pane / cross-tab search.** One search bar per pane is enough for the first slice. Multi-buffer search is a separate ADR.
- **Search history persistence.** Re-opening the search bar starts empty. Per-pane history can come later once we see what users actually type.
- **Searching inactive tabs.** The plan honours `active`; opening a search bar in a hidden tab would silently scan a buffer the user cannot see. The keyboard handler refuses to open search for a non-active pane.
- **Async / debounced search.** `@xterm/addon-search` already returns synchronously; we do not need a debounce layer.
- **Search across previously-attached sessions.** Re-attachment deliberately does not replay output (per CURRENT_STATE.md); search of historical output is out of scope.
- **A11y investment beyond what xterm already provides.** We do not yet know if the search bar needs screen-reader announcements; ship with semantic markup first, add `aria-live` after user feedback.

## Architectural decisions

### AD-1: Use the official `@xterm/addon-search` addon

The addon is small (≈ 6 KiB minified), has no Node-side dependencies, and exposes the exact API we need:
- `findNext(term, options)` — returns `boolean`
- `findPrevious(term, options)` — returns `boolean`
- `clearDecorations()` — clears highlights

We add it as a runtime dependency of `@agentterm/desktop` (not a devDependency) because it ships in the renderer bundle.

### AD-2: Search state lives in a new pure module

`apps/desktop/src/renderer/terminal-search-state.ts` exposes:
- `SearchMode = 'literal' | 'regex'`
- `SearchOptions = { readonly caseSensitive: boolean; readonly mode: SearchMode; readonly term: string }`
- `decideSearchAction(input): SearchAction` — pure reducer that takes the previous state plus a `SearchEvent` (`OPEN | CLOSE | SET_TERM | SET_MODE | SET_CASE | NEXT | PREVIOUS | CLEAR`) and returns the next state plus a list of imperative effects (`focusSearchInput`, `clearDecorations`, etc.) that the React layer executes.

This keeps the rule logic testable in isolation. The React component is a thin effect-driven shell.

### AD-3: One search bar per `TerminalRenderer`

The bar lives inside the same React component that owns the xterm surface, gated on `state === 'connected' || state === 'empty' || state === 'exited'` (i.e. once the surface has been mounted). It positions absolutely over the terminal viewport, bottom-left, with a width that never exceeds the pane width.

When the bar is open, the xterm `attachCustomKeyEventHandler` returns `false` for keystrokes that target the bar (`Escape`, characters typed into the search input). When the bar is closed, the handler returns `true` for everything, restoring the default xterm behaviour.

### AD-4: Keyboard chord lives in the existing controller

`terminal-keyboard-controller.ts` already maps `Ctrl+Shift+P` (palette) and `Ctrl+Shift+C` (copy). We extend it with one new decision: `Ctrl+Shift+F` returns a new `TerminalActionKind.SEARCH_OPEN` when xterm is focused and no terminal paste confirmation is visible. The handler route is added to `terminal-input-glue.ts` so the call flows through `useTerminalInput` exactly like every other action.

### AD-5: No new IPC channel

Search reads from xterm's in-memory buffer. The main process owns no search state. There is no trust boundary to cross; renderer-only feature.

## Scope

### Files added

1. `apps/desktop/src/renderer/terminal-search-state.ts`
   - Pure reducer (`decideSearchAction`), type exports, helper `parseSearchTerm` that turns a user string into either a plain string (literal mode) or a `RegExp` (regex mode), with safe error reporting for invalid regex.
2. `apps/desktop/src/renderer/terminal-search-state.test.ts`
   - ≥ 12 table-driven cases covering every event transition, regex error reporting, and case-sensitivity toggle.
3. `apps/desktop/src/renderer/terminal-search-bar.tsx`
   - Functional component `<TerminalSearchBar>` that renders the input, the case / mode toggles, the Next / Previous / Close buttons. Subscribes to its parent's state via a controlled `value` / `onChange` contract; imperative effects (`focusInput`, `clearDecorations`) come back through a `useImperativeHandle` ref.

### Files modified

1. `apps/desktop/package.json`
   - Add `"@xterm/addon-search": "0.16.0"` (or the version compatible with `@xterm/xterm@6.0.0` — verify before pinning).
2. `apps/desktop/src/renderer/xterm-terminal-surface.ts`
   - Lazy-instantiate the search addon once per surface. Expose a new `TerminalSurface` method `findSearch(options): boolean`, `findSearchPrevious(options): boolean`, and `clearSearch(): void` that forward to the addon.
   - Extend `TerminalSurface` interface in `terminal-controller.ts` with the same three methods.
3. `apps/desktop/src/renderer/terminal-controller.ts`
   - Forward `findSearch`, `findSearchPrevious`, `clearSearch` to the underlying surface via `forwardToSurface(...)` helper. No new public state.
4. `apps/desktop/src/renderer/terminal-keyboard-controller.ts`
   - Add a new `TerminalActionKind.SEARCH_OPEN` constant. Extend the decision table: `Ctrl+Shift+F` while xterm is focused and no paste confirmation is visible returns `SEARCH_OPEN`.
5. `apps/desktop/src/renderer/terminal-input-glue.ts`
   - Route `SEARCH_OPEN` through `dispatchOpenSearch` which calls a new `controller.openSearch()` method.
6. `apps/desktop/src/renderer/use-terminal-input.ts`
   - Add an `openSearch()` callback and expose it on `UseTerminalInputResult`.
7. `apps/desktop/src/renderer/terminal-renderer.tsx`
   - Render `<TerminalSearchBar>` gated on the new local state.
   - Wire `openSearch` to the keyboard chord.
   - Update the existing `attachCustomKeyEventHandler` so keystrokes that target the search bar are not forwarded to xterm.
8. `apps/desktop/src/renderer/workspace-terminals.tsx`
   - No signature changes (search is pane-local).
9. `apps/desktop/src/renderer/agent-workspace.tsx`
   - Optional: surface a `Ctrl+Shift+F` mnemonic hint in the command palette `find` section if it already exists; otherwise skip (the keyboard chord is documented in the `TerminalRenderer` empty state).

### Files NOT modified

- `apps/desktop/src/main.ts` and `desktop-main-handlers.ts` — no IPC channel added.
- `apps/desktop/src/desktop-application.ts` and `desktop-bridge.ts` — no new client method.
- `packages/application/**` and `packages/domain/**` — search is a pure view operation.
- `apps/desktop/src/renderer/terminal-context-menu.tsx` — we deliberately keep context-menu actions out of the search feature; adding a "Find" item to the context menu is a small follow-up.

## Tests

### Unit tests

- `apps/desktop/src/renderer/terminal-search-state.test.ts` (new): ≥ 12 cases covering all transitions, regex compilation errors, mode / case toggles, "no matches" terminal states.
- `apps/desktop/src/renderer/terminal-keyboard-controller.test.ts` (extended): two new rows for `Ctrl+Shift+F` in focused / unfocused panes, and one row confirming the chord is ignored while the paste confirmation dialog is visible.
- `apps/desktop/src/renderer/terminal-input-glue.test.ts` (extended): one new case asserting `SEARCH_OPEN` triggers `controller.openSearch()` exactly once.

### Component tests

- `apps/desktop/src/renderer/terminal-renderer.test.tsx` (new or extended if it already exists): three new cases:
  1. Pressing `Ctrl+Shift+F` while xterm is focused renders the search bar.
  2. Typing into the bar and pressing `Enter` calls `findSearch` on the surface exactly once.
  3. Pressing `Escape` while the bar is focused hides it and clears decorations.

  If `terminal-renderer.test.tsx` does not exist, add it with these three cases plus a smoke test that the existing layout still renders.

### Integration verification

- `pnpm -F @agentterm/desktop typecheck` — must pass.
- `pnpm -F @agentterm/desktop test` — must pass (excluding the pre-existing `scripts/visual-layout-audit-lib.test.cjs` failure).
- Manual smoke: open a Codex / Claude agent session, run a command that produces > 50 lines of output, press `Ctrl+Shift+F`, type `error`, press `Enter`, verify the highlight moves. Press `Escape`, verify the highlight clears and focus returns to xterm.

## Validation plan

1. Vitest suite green; the new state reducer is fully covered by table-driven tests.
2. Typecheck clean (`exactOptionalPropertyTypes` preserved — `onClose` and other optional props follow the existing conditional-spread pattern).
3. Renderer manual smoke against an attached session.
4. No new IPC channel (`apps/desktop/src/ipc-contract.ts` unchanged).

## Risks and mitigations

1. **Invalid regex crashes the bar.** Mitigation: `parseSearchTerm` returns `{ kind: 'invalid-regex', message }` on `SyntaxError`; the bar renders a small inline error rather than throwing, and `findSearch` is not called until the term parses cleanly.
2. **Search interferes with bracketed paste confirmation.** Mitigation: the keyboard controller refuses `Ctrl+Shift+F` while a paste confirmation dialog is visible (mirrors the existing palette rule).
3. **Search interferes with link click.** Mitigation: only `Ctrl+Shift+F` opens the bar; xterm's own Ctrl+Click path is untouched. When the bar is open, the renderer keeps the search input as the active focus target.
4. **Add-on bundle size.** `@xterm/addon-search` is small and tree-shaken via the existing Vite config; we measure the bundle delta before merging and surface it in the commit message.
5. **Two panes / two bars.** Each `TerminalRenderer` owns its own bar; they do not share state. The keyboard chord only affects the pane that owns the focused xterm surface.

## Deferred (explicit non-goals)

- A separate "Find in workspace" command that walks every pane in the active tab.
- Per-session search history persisted across restarts.
- Search inside scrollback lines that have already been trimmed by the 5,000-line scrollback limit. The official addon searches exactly what xterm has buffered; we do not extend it.
- A11y-first keyboard navigation inside the search bar beyond the default `<input>` semantics. A future slice can add `aria-live` announcements for match counts.