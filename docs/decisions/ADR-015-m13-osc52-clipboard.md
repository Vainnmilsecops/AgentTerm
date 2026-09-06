# M13 — OSC 52 clipboard read/write integration

Status: Accepted
Date: 2026-08-23
Owner: AgentTerm desktop renderer + domain
Branch: `cursor/m13-osc52-clipboard`
Shipped: PR #42 (commit `015506b`) merged on 2026-08-23

## Context

M1–M12 give AgentTerm a full Windows terminal: mouse forwarding
(M11), per-pane mode badge (M12), in-terminal search (M10),
bracketed paste (M7), URL and worktree hyperlinks (M8–M9). One
piece of the modern terminal experience is still missing: TUIs
that try to read or write the system clipboard over OSC 52
(`ESC ] 52 ; c ; <base64> BEL`) have no way to reach the user's
clipboard.

This matters for `helix`, `kakoune`, `neovim` (with
`unnamedplus`/`unnamedclip` shell option in some configs),
modern `fzf` (Ctrl-Y to copy), `lf`, `broot`, `gh dash`, and
similar TUIs. Today those applications fall back to no-op or
prompt the user. Worse, some TUIs that *detect* OSC 52 and then
silently fail look broken to the user.

xterm.js 6.0.0 ships native OSC 52 handling through
`@xterm/addon-clipboard`. The addon:

* Registers an OSC 52 handler on `terminal.parser`.
* Calls a `ClipboardProvider` to read/write the system clipboard.
* Has its own default `Base64` codec that uses `js-base64`
  (UTF-8 safe).

The addon is **off by default** for security — it only activates
when the terminal option `allowClipboardAccess` is `true`. That
gates the entire feature behind a user opt-in, which is exactly
the boundary we want.

## Goals

1. Honor OSC 52 read/write when the user opts in.
2. Persist the preference so it survives restarts.
3. Expose the preference in the Settings panel with a clear
   warning that TUIs will be able to read and write the system
   clipboard.
4. Use the upstream addon's UTF-8-safe codec so non-ASCII
   payloads (CJK, emoji, Vietnamese) round-trip correctly.
5. Keep the opt-in off by default.

## Non-goals

- **Selection-aware paste**. xterm.js already implements OSC 52
  selection multiplexing (`c=clipboard`, `p=primary`). We rely on
  its default behaviour; no custom routing.
- **Custom clipboard backend**. `BrowserClipboardProvider` already
  does what we need. A `MockClipboardProvider` may exist for
  tests, but production uses the browser API.
- **Reading clipboard on demand without an OSC 52 trigger**.
  Addon behaviour only — we do not pre-read or sync.
- **Per-pane override.** The setting is global; per-pane is a
  future slice if there is demand.
- **Settings UI for the mouse-priority toggle**. Still deferred
  per ADR-013.

## Architectural decisions

### AD-1: Surface owns the addon, controller stays unchanged

`XtermTerminalSurface` already loads `FitAddon` and `SearchAddon`.
We add a third addon (`ClipboardAddon`) loaded conditionally when
the user has opted in. The `TerminalSurface` interface does not
grow: the addon is a renderer-internal concern and the controller
does not need to know whether OSC 52 is wired up.

### AD-2: Pin `@xterm/addon-clipboard@0.2.0`

`0.2.0` is the last stable release that ships `js-base64`
internally. `0.3.0-beta.x` removes the dependency and falls back
to raw `btoa`/`atob`, which corrupts UTF-8 payloads
([xtermjs/xterm.js#6000](https://github.com/xtermjs/xterm.js/issues/6000)).
We pin to `0.2.0`.

### AD-2a: The trust boundary is "addon loaded" — not a Terminal option

In `0.3.0+` xterm.js exposes `Terminal({ allowClipboardAccess })`
so the OSC 52 handler only fires when the option is true. In
`0.2.0` there is no such option: the OSC 52 handler is
**always** registered once `ClipboardAddon.activate(terminal)`
runs. The trust boundary is therefore *whether we load the
addon at all*. We make `XtermTerminalSurface` accept an
`allowClipboardAccess` constructor option; if false, the addon
is not instantiated and the handler is never registered.

### AD-3: Domain owns the preference

Add a new boolean `allowClipboardReadWrite` to
`ApplicationSettings` (Domain) with default `false`. It flows
through `ApplicationSettingsView` (Application) and
`UpdateApplicationSettingsInput` (Application). Persistence,
validation, and revision control all reuse the existing settings
machinery. No new IPC channels.

### AD-4: Off by default

The default value is `false`. Existing users see no behaviour
change until they enable the toggle. The Settings panel labels
the toggle clearly:

> "Allow TUIs to read and write the system clipboard via OSC 52.
> Disabled by default."

### AD-5: No renderer-side permission prompt

The user toggles the preference once in Settings; TUIs are then
trusted for the lifetime of the session. We do **not** prompt
the user on every TUI invocation. The boundary is "user trusts
the TUIs that run in AgentTerm" — the same trust level they have
for the PTY itself.

## Scope

### Files added

1. `docs/decisions/ADR-015-m13-osc52-clipboard.md` (this file).

### Files modified

1. `apps/desktop/package.json` — add
   `@xterm/addon-clipboard@0.2.0`.
2. `packages/domain/src/application-settings.ts` — add field,
   validation, default, invalid-reason. Schema version bump from
   1 to 2.
3. `packages/domain/src/application-settings.test.ts` — new
   field round-trips, default is `false`, invalid reason is
   raised when the value is not boolean.
4. `packages/application/src/application-settings.ts` — include
   the new field in `loadApplicationSettings` and
   `updateApplicationSettings`.
5. `apps/desktop/src/renderer/xterm-terminal-surface.ts` —
   accept an `allowClipboardAccess` constructor option and load
   the addon when true.
6. `apps/desktop/src/renderer/terminal-renderer.tsx` — read the
   preference from `view.settings.allowClipboardReadWrite` and
   pass it to the surface.
7. `apps/desktop/src/renderer/settings-panel.tsx` — checkbox
   for the new preference.
8. `apps/desktop/src/renderer/settings-panel.test.tsx` (if it
   exists; otherwise inline test) — toggling the checkbox sends
   the new field to `onSave`.

### Files NOT modified

- `TerminalSurface` interface (the surface stays the same shape
  from the controller's perspective).
- `TerminalController` — no new methods.
- `apps/desktop/src/main.ts`, `desktop-bridge.ts`,
  `desktop-application.ts`, `desktop-main-handlers.ts` — no IPC
  changes (the existing settings IPC carries the new field).
- IPC contract documents — the channel shape is unchanged.

## Tests

### Unit tests

- `application-settings.test.ts` (Domain):
  * default value is `false`
  * validation rejects non-boolean values
  * round-trip through `createApplicationSettings({...})`
- `application-settings.test.ts` (Application):
  * `loadApplicationSettings` returns the new field
  * `updateApplicationSettings` accepts the new field and bumps
    revision

### Component tests

- Existing 335 renderer tests still pass.

### Manual smoke

- Enable the toggle in Settings, open a pane, run a TUI that
  emits `OSC 52 ; c ; ? ST` to request clipboard read — the
  TUI receives the current clipboard contents.
- Copy text in any other app, paste via OSC 52 into a TUI — it
  appears.
- Disabled by default — verify by toggling off and reproducing
  the request; the TUI receives no bytes.

## Validation plan

1. New domain + application tests pass.
2. `pnpm -F @agentterm/desktop typecheck` clean.
3. `pnpm -F @agentterm/desktop exec vitest run src/renderer/`
   green.
4. Manual smoke (Settings toggle, OSC 52 read/write with a
   real TUI).

## Risks and mitigations

1. **Clipboard exfiltration.** A TUI can read whatever the user
   has on their clipboard the moment they paste anything into
   AgentTerm. Mitigation: the toggle is off by default and the
   Settings UI labels it as a trust boundary. We document this
   in the ADR and the Settings tooltip.
2. **UTF-8 corruption.** Already mitigated by pinning
   `@xterm/addon-clipboard@0.2.0` (which uses `js-base64`).
   The ADR calls out the upstream regression explicitly.
3. **Schema migration.** Bumping `schemaVersion` from 1 to 2
   invalidates existing persisted settings. Per Domain tests,
   `createApplicationSettings` accepts the previous `schemaVersion:
   1` input for backward compat and migrates `allowClipboardReadWrite`
   to its default `false`. Existing users keep their settings;
   they simply see the new toggle at its default value.

## Deferred (explicit non-goals)

- Custom clipboard backend (e.g. for headless tests).
- Per-pane override.
- Per-TUI allow-list.
- Settings UI for the mouse-priority toggle (ADR-013).