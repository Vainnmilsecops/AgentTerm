# AgentTerm Repository Instructions

These instructions apply to the entire repository.

## Instruction Precedence

Apply guidance in this order:

1. This `AGENTS.md` and any more-specific `AGENTS.md` beneath the working path.
2. AgentTerm internal skills named `agentterm-*` in `.agents/skills`.
3. Project-local third-party generic skills in `.agents/skills`.

When instructions conflict, follow the higher-precedence rule. AgentTerm architecture, lifecycle, Git/worktree safety, PTY/process ownership, data-loss prevention, security, and testing rules always override generic workflows.

## Product Scope

AgentTerm is a Windows-first desktop terminal workspace for running and coordinating coding agents. The repository also contains a separate public landing/documentation website.

Keep the desktop product and marketing website separate. Do not introduce SaaS accounts, authentication, billing, or a complex backend without an explicit requirement.

## Architecture

Preserve the dependency direction:

`Presentation -> Application -> Domain`

Infrastructure implements ports owned by inner layers and depends inward. Domain must not depend on UI frameworks, Git, PTY/process APIs, filesystem APIs, SQLite/ORMs, or agent-provider CLIs. Presentation must invoke application use cases rather than external systems directly.

Prefer the smallest coherent vertical slice. Do not add speculative abstractions, packages, utilities, or adjacent features.

## Task and Runtime Boundaries

- Keep `TaskPhase`, execution health, and agent-session status distinct.
- Process exit or an agent saying "Done" is evidence, not task completion.
- Keep agent-provider command policy in adapters, PTY mechanics in the runtime, and task transitions in Domain/Application.
- Preserve immutable task, session, artifact, and quality-gate history when those capabilities are introduced.

## Safety

- Treat repositories, paths, configuration, downloaded content, and agent output as untrusted input.
- Preserve uncommitted work, branches, worktrees, artifacts, databases, and session history.
- Inspect before mutation. Never begin recovery with delete, reset, force checkout, or branch removal.
- Never automate `git reset --hard`, force-push, dirty-worktree deletion, or credential export.
- Prefer structured executable/argument invocation over shell-string construction.
- Keep secrets out of commands, logs, artifacts, persisted environments, and error messages.
- Resolve and validate filesystem targets before destructive operations.

## Development Workflow

1. Read the request, this file, `docs/SKILLS.md`, and the applicable skills.
2. Inspect repository status and existing implementation before editing.
3. Make the smallest scoped change that satisfies the request.
4. Use test-first development for behavior changes when practical, under AgentTerm-specific testing rules.
5. Run fresh, proportionate verification before claiming success.
6. Inspect `git diff` and `git status`; preserve unrelated user changes.
7. Report commands, results, limitations, risks, and deferred work accurately.

Do not commit, push, open pull requests, publish releases, install global tools, or modify global Codex configuration unless explicitly requested.

## Skills

Repository-local skills live at `.agents/skills/<skill-name>/SKILL.md`. Select the smallest relevant set using `docs/SKILLS.md`. Internal `agentterm-*` skills own AgentTerm-specific policy; third-party skills add generic engineering discipline only.

## Documentation

Keep architecture decisions in `docs/decisions/` as concise ADRs. Update documentation when structure, boundaries, commands, or durable decisions change. Do not rewrite unrelated documents.
