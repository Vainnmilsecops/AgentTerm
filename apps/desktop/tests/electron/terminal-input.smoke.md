# M1 Real Electron Smoke Checklist

> Run these checks against `pnpm --filter @agentterm/desktop start` from
> `D:\Core\AgentTerm` after the rebuild. Each item has a reproducible action
> and the expected observable outcome.

## 1. Restore build baseline

```bash
# from D:\Core\AgentTerm
pnpm install
pnpm --filter @agentterm/desktop build
pnpm --filter @agentterm/desktop typecheck
npx vitest run apps/desktop/src/renderer/terminal-keyboard-controller.test.ts
npx vitest run apps/desktop/src/renderer/terminal-paste-controller.test.ts
npx vitest run apps/desktop/src/renderer/terminal-context-menu.test.ts
npx vitest run apps/desktop/src/renderer/terminal-input-glue.test.ts
npx vitest run apps/desktop/src/renderer/terminal-controller.test.ts
```

All six suites must report zero failures. Any failure blocks the smoke run.

## 2. Launch Electron and open a Task with an active Session

```bash
pnpm --filter @agentterm/desktop start
```

Then: open a Project → create a Task → start execution → wait for the
terminal pane to attach to the Agent Session.

## 3. Keyboard shortcuts

| # | Action | Expected |
|---|--------|----------|
| 3.1 | Drag-select text in the pane, press `Ctrl+C` | Selection copied to clipboard; pane does not receive ETX. No message shown. |
| 3.2 | Cleared selection, press `Ctrl+C` | Pane receives `ETX` (process interrupt). Clipboard unchanged. |
| 3.3 | Drag-select text, press `Ctrl+Shift+C` | Selection copied even if `Ctrl+C` would have sent ETX. |
| 3.4 | Press `Ctrl+V` | Pane receives pasted text via `terminal.paste()`. |
| 3.5 | Press `Ctrl+Shift+V` | Same as 3.4. |
| 3.6 | Press `Ctrl+Insert` | Selection copied. |
| 3.7 | Press `Ctrl+Shift+Insert` | Pane receives pasted text. |
| 3.8 | Open Vietnamese/EVKey IME, compose "tieees", press `Ctrl+C` | Pane does NOT receive ETX; clipboard unchanged. |

## 4. Paste thresholds

| # | Action | Expected |
|---|--------|----------|
| 4.1 | Paste 1 line of 8 KiB text | Pane receives text directly via `terminal.paste()`. No confirm dialog. |
| 4.2 | Paste 1 line of 9 KiB text | Inline confirm dialog appears with line count and byte size. |
| 4.3 | Click `Send` in 4.2 confirm | Pane receives text. Dialog disappears. |
| 4.4 | Click `Cancel` in 4.2 confirm | Dialog disappears. Pane receives nothing. |
| 4.5 | Paste 4 lines of 30 bytes | Confirm dialog appears (4 lines > 1). |
| 4.6 | Paste 1 MiB + 1 byte | Inline error "Paste rejected — over 1 MiB paste limit." appears. No confirm dialog. |
| 4.7 | Paste multi-line UTF-8 (Vietnamese + emoji) | Confirm dialog shows correct UTF-8 byte length, not character count. |

## 5. Write serialization

Issue several keystrokes rapidly while the runtime is slow. The pane must
process each PTY write in FIFO order. To validate manually:

1. Run `cat` in the pane.
2. Type `a`, `b`, `c` quickly.
3. The remote shell must echo `a`, `b`, `c` in that order.

## 6. Failure propagation

Simulate a write failure by ending the Agent Session while the pane is
attached:

1. Stop the Agent Session via the command palette or external kill.
2. The pane header must show `Terminal input unavailable.` for a write
   attempt (or `Paste failed — terminal input unavailable.` for a paste).
3. The status dot must transition to `failed`.

## 7. Right-click menu

| # | Action | Expected |
|---|--------|----------|
| 7.1 | Right-click empty pane | Menu opens with `Copy` disabled, `Paste` and `Select all` enabled. |
| 7.2 | Drag-select text, right-click | Menu opens with `Copy` enabled. |
| 7.3 | Click `Copy` | Selection copied to clipboard. Menu closes. |
| 7.4 | Click `Paste` | Clipboard text is dispatched to `terminal.paste()`. |
| 7.5 | Click `Select all` | All terminal contents selected. |
| 7.6 | Press `Escape` while menu open | Menu closes. |

## 8. Split-pane isolation

1. Open two panes pointing to two different sessions.
2. Focus pane 1, paste 1 KiB text → confirm dialog mentions pane 1 session.
3. Cancel dialog, focus pane 2, paste same text → confirm dialog mentions
   pane 2 session. Pane 1 must not have received the text.

## 9. Regression check

Run the full `pnpm --filter @agentterm/desktop typecheck` and the broader
test suite to ensure no existing behaviour was broken.

```bash
npx vitest run
```

Expected: all non-new tests still pass; new tests pass.

## 10. Failure reporting

If any check fails, capture the exact UI text, the runtime event log, and
the failing test output. Do not paste clipboard text into logs; redact
domain-specific values.
