# AgentTerm Agent Skills

AgentTerm keeps repository-scoped Codex workflows in `.agents/skills/<skill-name>/SKILL.md`. Codex loads each skill's `name` and `description` for routing, then reads its body only after the skill is selected.

Launch Codex anywhere inside the Git repository. Use `/skills` to inspect available skills, mention a skill explicitly as `$agentterm-feature`, or rely on implicit matching from the request. Codex normally detects file changes automatically; restart Codex if a new or updated skill does not appear.

## Selection Rules

- Choose the smallest set that fully covers the work.
- Use a domain or runtime skill for ownership-specific invariants; do not ask the general feature skill to replace it.
- Add `agentterm-testing` when behavior changes need evidence.
- Add `agentterm-security` when work crosses a trust boundary or invokes powerful local capabilities.
- Keep independent review separate from implementation unless the user explicitly asks for fixes.
- Treat third-party skills as generic discipline only. `AGENTS.md` and `agentterm-*` skills remain authoritative for AgentTerm architecture, lifecycle, recovery, Git/worktree safety, security, and testing.

## Routing

### Implement Feature

`agentterm-feature` + the relevant domain or runtime skill + `test-driven-development` + `agentterm-testing` + `verification-before-completion`

### Debug Bug

`systematic-debugging` + `agentterm-debug-recovery` + the affected runtime or domain skill + `agentterm-testing` + `verification-before-completion`

### Architecture / New Module

`agentterm-architecture` + `codebase-design`

### Task Lifecycle

`agentterm-feature` + `agentterm-task-workflow` + `agentterm-testing`

### Git Worktree

`agentterm-git-worktree` + `agentterm-security` + `agentterm-testing`

Do not use a generic Git workflow to override AgentTerm Git and worktree safety.

### PTY

`agentterm-feature` + `agentterm-pty-runtime` + `agentterm-session-lifecycle` + `agentterm-testing`

### Coding Agent Integration

`agentterm-feature` + `agentterm-agent-adapter` + `agentterm-session-lifecycle` + `agentterm-security` + `agentterm-testing`

### Persistence

`agentterm-persistence` + `agentterm-testing`

### Terminal Desktop UX

`agentterm-terminal-ux`

Do not use `frontend-design` for the desktop terminal workspace.

### Artifact Workflow

`agentterm-artifacts` + `agentterm-task-workflow`

### Quality Gate

`agentterm-quality-gate` + `agentterm-testing`

### Review

`agentterm-review`

### Windows Release

`agentterm-windows-packaging` + `agentterm-security` + `agentterm-testing`

### Landing Website

`agentterm-website` + `frontend-design`

### Before Claiming Completion

Always use `verification-before-completion` and pair its fresh command evidence with AgentTerm quality-gate and testing rules when applicable.

### End Session

`agentterm-session-handoff`

## Ownership Boundaries

| Concern                              | Owning skill                  | Boundary                                                                                         |
| ------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------ |
| Business task phase                  | `agentterm-task-workflow`     | Process and session events cannot declare a task done.                                           |
| Execution health                     | `agentterm-task-workflow`     | Application updates health from explicit evidence; health is not a task phase or session status. |
| Agent session history and status     | `agentterm-session-lifecycle` | A new session appends history; it does not replace task lifecycle.                               |
| Terminal process and I/O             | `agentterm-pty-runtime`       | Emit runtime events; do not implement task policy.                                               |
| Agent-specific commands              | `agentterm-agent-adapter`     | Keep provider details behind the adapter abstraction.                                            |
| Phase outputs and readiness evidence | `agentterm-artifacts`         | An artifact is evidence, not an automatic phase transition.                                      |
| Validation run records               | `agentterm-quality-gate`      | A passing run informs readiness; the application use case decides transitions.                   |
| Desktop workspace UX                 | `agentterm-terminal-ux`       | Do not apply website or infrastructure assumptions.                                              |
| Public marketing surface             | `agentterm-website`           | Do not apply this skill to the desktop product.                                                  |

## Precedence

Apply instructions in this order:

1. Project instructions and the applicable `AGENTS.md` files.
2. AgentTerm internal skills in `.agents/skills`.
3. Future third-party generic skills.

When workflows conflict, follow the higher-precedence instruction. AgentTerm-specific safety invariants always override a generic third-party workflow. Stop and surface the conflict if satisfying both is impossible.

## Third-Party Skills

Third-party provenance, pinned revisions, files, licenses, and security observations are recorded in `docs/THIRD_PARTY_SKILLS.md`.

### systematic-debugging

Source: `obra/superpowers`

Purpose: Generic root-cause-first debugging.

Pairs with: `agentterm-debug-recovery`.

Do not override: AgentTerm recovery, Git/worktree, process, credential, or data-loss safety rules.

### test-driven-development

Source: `obra/superpowers`

Purpose: Red -> Green -> Refactor development discipline.

Pairs with: `agentterm-testing`.

Do not override: AgentTerm behavior-focused test strategy, isolation, integration coverage, cleanup, or user-data preservation rules.

### verification-before-completion

Source: `obra/superpowers`

Purpose: Require fresh command evidence before success claims.

Pairs with: `agentterm-testing`, `agentterm-quality-gate`, and `agentterm-review`.

Do not override: Task readiness and completion remain Application/Domain decisions.

### codebase-design

Source: `mattpocock/skills`

Purpose: Shared vocabulary for modules, interfaces, seams, adapters, depth, locality, and leverage.

Pairs with: `agentterm-architecture`.

Do not override: AgentTerm's `Presentation -> Application -> Domain` direction or Infrastructure adapter ownership.

### frontend-design

Source: `anthropics/skills`

Purpose: Distinctive visual design for the future AgentTerm landing website only.

Pairs with: `agentterm-website`.

Do not use for: Terminal panes, PTY interaction, task sidebar behavior, agent-session UX, or desktop keyboard workflows; those belong to `agentterm-terminal-ux`.

## Maintaining Skills

Keep every skill focused and instruction-only unless a deterministic reusable resource is genuinely required. Use lowercase, hyphenated directory names that match the frontmatter `name`; keep frontmatter limited to `name` and a trigger-rich `description`. Avoid copying shared rules across skills. Validate all skills and inspect `/skills` after additions or renames.
