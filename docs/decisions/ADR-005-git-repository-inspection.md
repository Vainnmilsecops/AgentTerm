# ADR-005 — Git Repository Inspection

- Status: Accepted
- Date: 2026-08-11

## Decision

Application owns one read-only `GitRepositoryInspector` port that returns one aggregated repository
observation. The result contains the canonical working-tree root, a discriminated attached,
detached, or unborn HEAD, an optional base-branch suggestion with provenance, and structured staged,
unstaged, untracked, and conflicted paths. It does not expose raw commands or porcelain output.

Infrastructure implements the port with the Git CLI. It shares executable resolution, path
validation, canonical-root discovery, environment restriction, and error mapping with local Project
discovery. Commands use structured arguments, an absolute executable, no shell, no pager, no
optional locks, no lazy fetches, and local machine-readable output. Inspection never fetches, checks
out, resets, or issues any other mutating Git operation. Missing promised objects fail inspection
instead of contacting a promisor remote.

Resolve the suggested base entirely from local refs in this order:

1. a valid local `refs/remotes/origin/HEAD` symbolic target;
2. committed local `main`;
3. committed local `master`;
4. the attached committed current branch;
5. no suggestion.

The source and full ref are retained so a later use case can decide how to use the suggestion.
Current-branch detection uses `symbolic-ref`, not the ambiguous porcelain `(detached)` label.

Require Git 2.45 or newer, set `GIT_NO_LAZY_FETCH=1`, and force `core.fsmonitor=false` for status
inspection. Status also forces untracked files, disables rename detection, and requests complete
submodule consideration so local repository configuration cannot silently redefine those snapshot
semantics.

## Consequences

- Consumers receive one stable, testable contract instead of coordinating multiple Git command
  ports. The adapter uses multiple read commands, so an external process mutating the repository
  concurrently can make the observation stale; callers must not treat it as a transaction or lock.
- Non-working directories are a normal discriminated result; invalid paths, unavailable/unsupported
  Git, and malformed or failed inspection are typed boundary errors without raw stderr.
- Base selection is deterministic and offline. A local remote-tracking ref is last-known state, not a
  claim about the current remote.
- Git status may still execute repository-configured clean or process filters. There is no narrow
  generic override for every named filter, so inspection remains a user-trust boundary until a
  restricted worker or equivalent process isolation is designed.
- Rename pairs are intentionally represented as ordinary staged/unstaged paths. A future workflow
  that needs rename semantics must extend the port deliberately.
