# ADR Housekeeping v2 — Promote M9-Close / M10 / M11 / M12 / M4 / M5 / ADR-009 status drift

## Context

The current `docs/CURRENT_STATE.md` and ADR statuses lag behind
implementation:

| Milestone | Implementation PR / commit | Status in `CURRENT_STATE.md` | Status in source ADR |
| --- | --- | --- | --- |
| M4 — Minimal MCP server (read tools) | PR #36 (`5b56731`) | not listed | ADR-009 still `Proposed — awaiting scope confirmation` |
| M5 — Per-phase agent switching end to end | PR #43 (`595eedc`) | not listed | ADR-009 still `Proposed — awaiting scope confirmation` |
| M9-Close — Ctrl+click worktree file hyperlinks | PR #41 (`389cd0e`) | not listed | ADR-011 still `Proposed` |
| M10 — In-terminal search (Ctrl+Shift+F) | commit `d96d48c` | not listed | ADR-012 still `Proposed` |
| M11 — Shift+right-click forwards to TUI | commit `bf1cf7c` | not listed | ADR-013 still `Proposed` |
| M12 — Visual mouse-mode badge | commit `8adcd59` | not listed | ADR-014 still `Proposed` |

The previous housekeeping PR (`chore(docs): promote ADR-015/016/017 to
Accepted`, PR #46) only captured three milestones. The remaining five
ADRs and their evidence are missing.

In addition, the master ADR-009 still says *Proposed — awaiting scope
confirmation* even though every in-scope sub-milestone except M8 has
shipped. The "Next Step" section of `CURRENT_STATE.md` still talks about
M1 as the next milestone, which is misleading for future agents.

This plan closes those documentation gaps in a single docs-only PR that
ships no code and no behavior change. It mirrors the discipline of PR #46
so a future agent reading either the ADRs or `CURRENT_STATE.md` sees a
honest, current picture.

## Goal

1. Promote ADR-011, ADR-012, ADR-013, ADR-014 from `Proposed` to
   `Accepted` with the merged PR / commit evidence and a one-line
   `Shipped:` reference (matching the format ADR-015 uses).
2. Promote ADR-009 from `Proposed — awaiting scope confirmation` to
   `Accepted (M1 + M2 + M2.5 + M3 + M3.1 + M4 + M5 + M6 + M7 + M7.5 +
   M9-Close + M10 + M11 + M12 implemented; M8 deferred to a future
   ADR)`.
3. Add one bullet per milestone to `CURRENT_STATE.md` "Recently
   Shipped" with the matching PR / commit.
4. Rewrite the stale "Next Step" section to reflect the actual
   remaining work (M8 auto merge-conflict resolution + any future
   ADR) instead of M1 / M2.

## Non-goals

- No new code. No new tests. No Domain / Application / Infrastructure
  changes. The renderer and main process are untouched.
- No refactor of existing ADR text beyond the Status header and the
  shipped evidence block.
- No retroactive renumbering of milestones or ADRs.
- No new ADR for M8. The deferred status already lives in ADR-009 §
  *Deferred*; this plan simply confirms M8 is still deferred and
  rewrites the *Next Step* paragraph to match.

## Architectural decisions

### AD-1: Status promotion follows the existing pattern

Each ADR gets one added line, e.g.:

```markdown
Status: Accepted
…
Shipped: PR #41 (commit `389cd0e`) merged on 2026-08-22
```

ADR-009 is a master plan with multiple sub-milestones, so it gets a
structured acceptance summary that lists every shipped milestone plus a
`M8 deferred` note. This matches the pattern ADR-010 already uses for
its own multi-milestone acceptance.

### AD-2: CURRENT_STATE entries reuse the `**MN — title** (ADR-XXX)`
template

Each milestone gets one bullet in the "Recently Shipped" list with:

- The milestone ID and short title.
- The ADR reference.
- The shipping PR / commit and date.

We deliberately do not add a long description because the ADR itself is
the canonical reference; `CURRENT_STATE.md` is the index.

### AD-3: "Next Step" rewrite preserves AgentTerm invariants

The new paragraph must not promise specific milestones; it points at
ADR-009 § *Deferred* (M8) and any subsequent ADR that explicitly opens
the next work. We do not introduce speculative roadmap content here.

## Scope

### Files modified

1. `docs/decisions/ADR-009-agtx-port-plan.md`
   - Header `Status: Proposed — awaiting scope confirmation` →
     `Status: Accepted (M1 + M2 + M2.5 + M3 + M3.1 + M4 + M5 + M6 + M7
     + M7.5 + M9-Close + M10 + M11 + M12 implemented; M8 deferred)`.
   - Add `Shipped:` summary block listing PR / commit evidence per
     milestone (sources from `git log --all --oneline` + the per-ADR
     ADR file already records the PR/commit).
   - Update the "Mapping to current AgentTerm surface" table to mark
     each row as `Shipped` and reference the milestone ID. Keep the
     `Auto merge-conflict` row at `Deferred (M8)`.
2. `docs/decisions/ADR-011-m9-close-worktree-file-hyperlinks.md`
   - `Status: Proposed` → `Status: Accepted`.
   - Add `Shipped: PR #41 (commit \`389cd0e\`) merged on 2026-08-22`.
3. `docs/decisions/ADR-012-m10-in-terminal-search.md`
   - `Status: Proposed` → `Status: Accepted`.
   - Add `Shipped: PR #41 (commit \`d96d48c\`)` (committed on the same
     branch before the merge commit).
4. `docs/decisions/ADR-013-m11-mouse-reporting-sgr.md`
   - `Status: Proposed` → `Status: Accepted`.
   - Add `Shipped: PR #41 (commit \`bf1cf7c\`)`.
5. `docs/decisions/ADR-014-m12-mouse-mode-badge.md`
   - `Status: Proposed` → `Status: Accepted`.
   - Add `Shipped: PR #41 (commit \`8adcd59\`)`.
6. `docs/CURRENT_STATE.md`
   - Bump `Updated:` line to today's date.
   - Add six bullets under "Recently Shipped" (one per milestone).
   - Rewrite the "Next Step" paragraph to reflect that M1–M7.5 and
     M9-Close–M12 all shipped; the next unshipped item is M8 (auto
     merge-conflict resolution), which currently lives in
     ADR-009 § *Deferred* and is intentionally out of scope until a
     separate ADR scopes it.

### Files NOT modified

- Any source file under `apps/`, `packages/`, `docs/decisions/ADR-001`
  through `ADR-008`, `docs/decisions/ADR-015` through `ADR-018`, or
  `docs/plans/*`. None of those documents or files are touched.
- `docs/SKILLS.md` — already reflects the correct routing.

## Validation plan

This is a docs-only PR. We still run verification because
`CURRENT_STATE.md` is consulted by both humans and future agents.

- `pnpm -F @agentterm/desktop typecheck` — must remain green.
- `pnpm -F @agentterm/desktop test` — must remain green.
- `git diff --stat` — only `.md` files in `docs/` change.
- Manual: walk every modified file end to end; confirm each `Status:`
  and `Shipped:` block reads honestly.

## Risks

1. **Stale merge dates**. The shipped-evidence block cites a merged PR
   or commit. If a milestone landed on a feature branch and was merged
   via a later PR, we prefer the merge PR number because that is what
   the team will search for. Cross-check with `git log --all --grep` to
   avoid claiming a PR that does not exist.
2. **Accidentally claiming M8**. ADR-009 § *Deferred* is the source of
   truth. We do not promote M8; we only confirm it remains deferred.
3. **Style drift**. Each ADR has its own header style. We follow the
   existing `Shipped: PR #X (commit Y) merged on DATE` pattern from
   ADR-015, ADR-016, ADR-017, ADR-018 rather than inventing a new one.
4. **"Next Step" over-promising**. We do not pre-announce M8 work; we
   only point to ADR-009 § *Deferred* as the canonical reference.

## Out of scope

- New milestone definitions.
- New ADRs for M8 or any future work.
- Renaming or rebinding of any existing milestones.
- Any code, schema, or test changes.
