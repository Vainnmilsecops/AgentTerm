# Terminal input reliability

The renderer serializes writes per attachment, bounds pending UTF-8 input to
2 MiB, and discards queued input when that attachment is detached. A late failure
from an old attachment cannot fail a newly attached session. An input failure
is visible and does not log the input contents.

Paste confirmation is bound to its target session. Only xterm owns bracketed
paste framing and line-ending normalization; the application passes plain text
to `terminal.paste`. Multiline or more than 8 KiB requires confirmation;
more than 1 MiB is rejected. Exactly 1 MiB requires confirmation.

Validation:

- `pnpm exec vitest run apps/desktop/src/renderer`
- `pnpm --filter @agentterm/desktop typecheck`
- `node apps/desktop/scripts/input-reliability-smoke.mjs`

The smoke runs real xterm in an isolated hidden Electron window and checks
Unicode, line normalization, bracketed paste, literal pasted slash commands,
ETX, oversize rejection, pane isolation and selection copy. Its PTY attachment
is an in-memory transport: native process interruption and OS IME interaction
still require the manual Electron checklist. It uses synthetic test text, never
the user's clipboard, repositories or database.
