# AgentTerm Third-Party Skills Registry

Reviewed on 2026-08-10. All installed skills are vendored project-locally and pinned to exact upstream commits. Updating is manual: inspect the new upstream revision, dependencies, references, license, and security-sensitive instructions before replacing files or changing the recorded commit.

## Installed

### systematic-debugging

- Name: `systematic-debugging`
- Capability: Generic root-cause-first debugging discipline.
- Source repository: `https://github.com/obra/superpowers`
- Source path: `skills/systematic-debugging/`
- Upstream commit: `44c9b2d6e889982ac18c27d05a19fefe335194e1`
- Reviewed date: 2026-08-10
- License: MIT; upstream repository license vendored as `LICENSE`.
- Installed path: `.agents/skills/systematic-debugging/`
- Supporting files: `root-cause-tracing.md`, `defense-in-depth.md`, `condition-based-waiting.md`, `condition-based-waiting-example.ts`, `find-polluter.sh`, `LICENSE`.
- Scripts/executables: `find-polluter.sh` is an upstream Bash helper that enumerates tests and invokes `npm test`; it was reviewed and vendored because a supporting reference links to it. It was not executed. The TypeScript file is an illustrative source example, not an installed runtime dependency.
- Security observations: No download, upload, package-install, force-push, reset, branch-deletion, or recursive-deletion workflow was found in the installed files. One generic diagnostic example inspects an environment variable with `env | grep IDENTITY`; AgentTerm secret-redaction and minimal-environment rules take precedence, so agents must not expose credential values. The Bash helper accepts paths/patterns and runs repository tests, so it must be treated as optional reviewed guidance rather than an automatic command.
- Why installed: Establishes an evidence-first debugging loop before fixes.
- AgentTerm skills it complements: `agentterm-debug-recovery`, `agentterm-testing`, and affected runtime/domain skills.
- Update policy: Manual re-audit and commit repin only; no auto-update.

### test-driven-development

- Name: `test-driven-development`
- Capability: Red -> Green -> Refactor behavior development.
- Source repository: `https://github.com/obra/superpowers`
- Source path: `skills/test-driven-development/`
- Upstream commit: `44c9b2d6e889982ac18c27d05a19fefe335194e1`
- Reviewed date: 2026-08-10
- License: MIT; upstream repository license vendored as `LICENSE`.
- Installed path: `.agents/skills/test-driven-development/`
- Supporting files: `writing-good-tests.md`, `LICENSE`.
- Scripts/executables: None.
- Security observations: No network, credential, shell, Git, or package-install instructions were found. Its strict instruction to delete implementation written before a failing test never authorizes discarding user work; `AGENTS.md` and AgentTerm Git/data-preservation rules take precedence.
- Why installed: Makes important behavior and bug fixes test-first.
- AgentTerm skills it complements: `agentterm-testing` and `agentterm-feature`.
- Update policy: Manual re-audit and commit repin only; no auto-update.

### verification-before-completion

- Name: `verification-before-completion`
- Capability: Fresh evidence before claims that work is done, fixed, passing, or ready.
- Source repository: `https://github.com/obra/superpowers`
- Source path: `skills/verification-before-completion/`
- Upstream commit: `44c9b2d6e889982ac18c27d05a19fefe335194e1`
- Reviewed date: 2026-08-10
- License: MIT; upstream repository license vendored as `LICENSE`.
- Installed path: `.agents/skills/verification-before-completion/`
- Supporting files: `LICENSE`.
- Scripts/executables: None.
- Security observations: No network, credential, destructive Git/filesystem, or package-install instructions were found. It mentions commit/PR timing but does not authorize those actions.
- Why installed: Prevents unsupported success claims during vibe coding.
- AgentTerm skills it complements: `agentterm-testing`, `agentterm-quality-gate`, and `agentterm-review`.
- Update policy: Manual re-audit and commit repin only; no auto-update.

### codebase-design

- Name: `codebase-design`
- Capability: Vocabulary and principles for deep modules, small interfaces, seams, adapters, locality, and leverage.
- Source repository: `https://github.com/mattpocock/skills`
- Source path: `skills/engineering/codebase-design/`
- Upstream commit: `84fdeffd12f2ee307994d1eb6feb48173b6e0502`
- Reviewed date: 2026-08-10
- License: MIT; upstream repository license vendored as `LICENSE`.
- Installed path: `.agents/skills/codebase-design/`
- Supporting files: `DEEPENING.md`, `DESIGN-IT-TWICE.md`, `LICENSE`.
- Scripts/executables: None.
- Security observations: No network, credential, shell, package-install, or destructive Git instructions were found. `DEEPENING.md` recommends deleting superseded tests and `DESIGN-IT-TWICE.md` describes parallel sub-agents; neither overrides AgentTerm test-preservation, scope, or delegation controls.
- Why installed: Adds precise design language without replacing project architecture policy.
- AgentTerm skills it complements: `agentterm-architecture` and `agentterm-testing`.
- Update policy: Manual re-audit and commit repin only; no auto-update.

### frontend-design

- Name: `frontend-design`
- Capability: Intentional, distinctive frontend visual design for the marketing website.
- Source repository: `https://github.com/anthropics/skills`
- Source path: `skills/frontend-design/`
- Upstream commit: `f17010c9bb483898c1d9c9f42dde2b3a98889434`
- Reviewed date: 2026-08-10
- License: Apache License 2.0; per-skill `LICENSE.txt` is vendored unchanged.
- Installed path: `.agents/skills/frontend-design/`
- Supporting files: `LICENSE.txt`.
- Scripts/executables: None.
- Security observations: No network, credential, shell, package-install, or destructive Git/filesystem instructions were found. Its broad UI trigger is narrowed by project routing to the marketing website only.
- Why installed: Supports a future distinctive AgentTerm landing site without affecting desktop terminal UX.
- AgentTerm skills it complements: `agentterm-website`.
- Update policy: Manual re-audit and commit repin only; no auto-update.

## Deferred

### writing-plans

- Source repository: `https://github.com/obra/superpowers`
- Source path reviewed: `skills/writing-plans/`
- Commit reviewed: `44c9b2d6e889982ac18c27d05a19fefe335194e1`
- Status: Deferred; not installed.
- Reason: AgentTerm already has `agentterm-feature`, `agentterm-architecture`, and `agentterm-session-handoff`. The upstream workflow assumes additional Superpowers skills including `using-git-worktrees`, `executing-plans`, and `subagent-driven-development`, prescribes its own plan location and frequent commits, and would pull in a broader framework that duplicates or conflicts with AgentTerm-owned workflows.

## Rejected

No audited candidate was rejected in this review. The five targeted skills passed the scoped provenance, license, dependency, and instruction review with the precedence constraints documented above.
