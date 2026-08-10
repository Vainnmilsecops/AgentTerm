# ADR-004 — Local Project Identity

- Status: Accepted
- Date: 2026-08-11

## Decision

Keep the Domain `Project` independent of filesystem and Git details. Application owns the local
Project discovery and catalog ports; Infrastructure validates the selected directory, inspects Git,
canonicalizes the working-tree root, and persists local-root metadata.

Define one local repository identity from the canonical Git top-level path:

1. require an absolute input path;
2. resolve it with native `realpath` and verify it is an accessible directory;
3. run structured, non-shell Git inspection and obtain `--show-toplevel`;
4. canonicalize the Git root again and verify the selected directory is inside it;
5. prefix the normalized native-realpath root with its platform, preserving the filesystem-resolved
   casing so distinct repositories in a case-sensitive Windows directory do not collide;
6. derive the opaque Project ID as SHA-256 of that identity.

The directory basename is display data only. Remote URLs and folder names are not identities.
Separate local clones are separate Projects, and existing linked worktrees remain separate local
roots until AgentTerm explicitly implements Worktree semantics.

Persist the association in the one-to-one `project_roots` table. Its unique path identity is the
final duplicate guard, while a monotonic open order supports deterministic recent-project listing
without introducing a Clock port. Existing v1 Projects remain valid, but migration infers no local
root for them; they remain outside recent-local results pending an explicit future reconciliation or
association policy.

## Consequences

- Reopening a nested path, ordinary casing alias, or junction resolves to the same Project without
  replacing the stored name or canonical path. Native-realpath casing remains distinct where the
  filesystem itself is case-sensitive.
- Git and filesystem operations remain read-only during discovery; SQLite records the Project and
  root atomically after successful inspection.
- Repository moves or renames produce a new identity. Mapped-drive versus UNC aliases can still
  produce separate identities for the same physical repository.
- Canonical paths are intentionally persisted local data and must not be logged unnecessarily.
- Git is resolved to a canonical absolute executable before any repository inspection, launched
  from its own directory with the selected root passed through structured `-C` arguments, and given
  a restricted environment. Git variables that can redirect discovery are removed, and
  `safe.directory` is not bypassed.
