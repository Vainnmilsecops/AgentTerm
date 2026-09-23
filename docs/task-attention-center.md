# Task attention center

The desktop **Needs attention** button summarizes actionable evidence across all
projects in the loaded workspace snapshot. It is available in the main workspace
and the standalone board. This builds on agtx's multi-project board concept
without introducing autonomous phase decisions or reading agent output heuristically.

## Evidence rules

- One entry per non-DONE task, with multiple reasons beneath it. The count is
  tasks, not events or notifications; refreshing does not append duplicates.
- Session failure: the latest session is FAILED and belongs to the task. A newer
  active session suppresses older failure evidence. EXITED, IDLE, and
  WAITING_INPUT alone are not interpreted as failure or approval requests.
- Gate failure: latest observed attempt **per gate** is FAILED, TIMED_OUT,
  LAUNCH_FAILED, or INFRASTRUCTURE_FAILED. A later passing/running attempt replaces
  that gate's failure, not failures of other gates. Repository ordinal order wins
  over wall-clock timestamps, including after clock rollback.
- Plan awaiting acceptance: PLANNING plus the existing `canAcceptPlan` projection
  and the exact latest plan. A plan's existence alone is insufficient.
- Review awaiting decision: REVIEW plus the actual latest PENDING review.
- Dependency blocked: the existing workspace `blocked` projection is true.
- Failure evidence sorts before human decisions, then dependency blockers, with
  stable timestamp/identity tie-breaking. Session/artifact/review/gate evidence
  supplies its own timestamp; dependencies do not have an event timestamp in this
  projection and explicitly display **Time unavailable**.

## Interaction

Open with the header button, using pointer or normal Tab/Enter navigation. The
native modal dialog keeps focus inside; Close/Escape restores the trigger. IME
composition does not dismiss it. Workspace/board shortcuts cannot trigger actions
behind the dialog. Refresh is single-flight, retains keyboard focus and preserves
the last snapshot on failure. Errors are visible and retryable.

Open task selects the exact task/project and opens its inspector in the main
workspace. From the standalone board it delegates to `openMainWindowForTask`
with `selectTask: true` and `focusTerminal: false`. No background agent is started,
no terminal input is sent, and no task transition is invoked by attention actions.

## Architecture and limits

`deriveTaskAttention` is a pure Application projection over `AgentWorkspaceOverview`.
Presentation renders its result and invokes existing refresh/navigation callbacks.
No new IPC channel, database table, history rewrite, infrastructure port, provider
policy, subscription, or timer is introduced. Titles and gate identifiers render
as literal React text. Existing design tokens support light/dark themes.

This is **snapshot evidence**, not a live health monitor. Data updates with normal
workspace reloads or explicit Refresh; no automatic polling is added. Gate history
is bounded by the existing workspace contract (20 recent runs per task), so older
gates outside that window are not classified. A zero count is not proof of full
health or readiness. Existing action use cases still revalidate before mutation.

Windows notifications, snooze/dismiss persistence, detection of permission prompts,
and automatic recovery/approval/merge remain out of scope.

## Verification

- `corepack pnpm exec vitest run --maxWorkers=2 packages/application/src apps/desktop/src tests/architecture`
- `corepack pnpm --filter @agentterm/application typecheck`
- `corepack pnpm --filter @agentterm/desktop typecheck`
- `corepack pnpm --filter @agentterm/desktop... build`
- `node apps/desktop/scripts/input-reliability-smoke.mjs --task-attention`

The Electron smoke uses the real attention dialog, workspace view and board with
controlled read/navigation callbacks. It covers literal Unicode, cross-project
navigation, no task mutations, Escape/IME, keyboard focus, shortcut isolation,
single-flight refresh, safe failures, retained data, and empty states. It does not
launch paid agents or assert complete accessibility certification.

Verified on 2026-09-23: 80 suites / 949 tests passed, Application/Desktop
typechecks and scoped ESLint passed. All four Electron smoke modes passed
(attention, context, recovery, terminal input). The first broader run caught the
new stylesheet missing from the explicit CSS contract; the contract now includes
the new module. The focused Electron test reproduced and verified the fix for
Refresh losing keyboard focus when disabled.

The shell has Corepack but no standalone `pnpm` command. The recursive build
successfully built dependencies, then stopped at the desktop script's nested
`pnpm` invocation. Running the equivalent desktop steps explicitly succeeded:

- `corepack pnpm --filter @agentterm/desktop run build:main`
- `corepack pnpm --filter @agentterm/desktop run build:renderer`

Existing Vite bundle/config and bare-import warnings remain. No global tools or
machine settings were changed, and no full visual/accessibility audit was run.
