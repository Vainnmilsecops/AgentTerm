# AgentTerm Agent Skills

AgentTerm keeps repository-scoped Codex workflows in `.agents/skills/<skill-name>/SKILL.md`. Codex loads each skill's `name` and `description` for routing, then reads its body only after the skill is selected.

Launch Codex anywhere inside the Git repository. Use `/skills` to inspect available skills, mention a skill explicitly as `$agentterm-feature`, or rely on implicit matching from the request. Codex normally detects file changes automatically; restart Codex if a new or updated skill does not appear.

## Selection Rules

- Choose the smallest set that fully covers the work.
- Use a domain or runtime skill for ownership-specific invariants; do not ask the general feature skill to replace it.
- Add `agentterm-testing` when behavior changes need evidence.
- Add `agentterm-security` when work crosses a trust boundary or invokes powerful local capabilities.
- Keep independent review separate from implementation unless the user explicitly asks for fixes.

## Routing

### Architecture or Cross-Layer Refactor

`agentterm-architecture` + `agentterm-feature` when implementing behavior + the relevant ownership skill + `agentterm-testing`

### Normal Feature

`agentterm-feature` + the relevant domain or runtime skill + `agentterm-testing`

### Task Lifecycle

`agentterm-feature` + `agentterm-task-workflow` + `agentterm-testing`

### Git Worktree

`agentterm-feature` + `agentterm-git-worktree` + `agentterm-testing` + `agentterm-security` when trust boundaries or destructive operations are involved

### PTY

`agentterm-feature` + `agentterm-pty-runtime` + `agentterm-session-lifecycle` + `agentterm-testing`

### Coding Agent Integration

`agentterm-feature` + `agentterm-agent-adapter` + `agentterm-session-lifecycle` + `agentterm-security` + `agentterm-testing`

### Persistence

`agentterm-persistence` + `agentterm-testing`

### Terminal UI

`agentterm-feature` + `agentterm-terminal-ux` + `agentterm-testing`

### Artifact Workflow

`agentterm-artifacts` + `agentterm-task-workflow`

### Quality Gate

`agentterm-quality-gate` + `agentterm-testing`

### Bug or Crash

`agentterm-debug-recovery` + the affected runtime or domain skill + `agentterm-testing`

### Review

`agentterm-review`

### Windows Release

`agentterm-windows-packaging` + `agentterm-security` + `agentterm-testing`

### Website

`agentterm-website`

### End of a Large Session

`agentterm-session-handoff`

## Ownership Boundaries

| Concern | Owning skill | Boundary |
| --- | --- | --- |
| Business task phase | `agentterm-task-workflow` | Process and session events cannot declare a task done. |
| Execution health | `agentterm-task-workflow` | Application updates health from explicit evidence; health is not a task phase or session status. |
| Agent session history and status | `agentterm-session-lifecycle` | A new session appends history; it does not replace task lifecycle. |
| Terminal process and I/O | `agentterm-pty-runtime` | Emit runtime events; do not implement task policy. |
| Agent-specific commands | `agentterm-agent-adapter` | Keep provider details behind the adapter abstraction. |
| Phase outputs and readiness evidence | `agentterm-artifacts` | An artifact is evidence, not an automatic phase transition. |
| Validation run records | `agentterm-quality-gate` | A passing run informs readiness; the application use case decides transitions. |
| Desktop workspace UX | `agentterm-terminal-ux` | Do not apply website or infrastructure assumptions. |
| Public marketing surface | `agentterm-website` | Do not apply this skill to the desktop product. |

## Precedence

Apply instructions in this order:

1. Project instructions and the applicable `AGENTS.md` files.
2. AgentTerm internal skills in `.agents/skills`.
3. Future third-party generic skills.

When workflows conflict, follow the higher-precedence instruction. AgentTerm-specific safety invariants always override a generic third-party workflow. Stop and surface the conflict if satisfying both is impossible.

## Maintaining Skills

Keep every skill focused and instruction-only unless a deterministic reusable resource is genuinely required. Use lowercase, hyphenated directory names that match the frontmatter `name`; keep frontmatter limited to `name` and a trigger-rich `description`. Avoid copying shared rules across skills. Validate all skills and inspect `/skills` after additions or renames.
