---
name: agentterm-git-worktree
description: "Manage AgentTerm Git repositories, base branches, task branches, worktrees, diffs, merges, status, and cleanup; use it for Git-backed task isolation while preserving dirty work, branches, and user code and avoiding destructive recovery shortcuts."
---

# Purpose

Create, reuse, inspect, and remove task worktrees without losing repository data.

# Inputs

- Repository root and current Git status.
- Requested base branch, task branch, and worktree path.
- Persisted worktree metadata and any active process association.

# Required Workflow

Select only the flow requested. Treat status, diff, and inspection requests as read-only.

## Inspect

1. Resolve the repository root and requested scope.
2. Read status, branches, registered worktrees, and the requested diff without mutation.
3. Report dirty state, mismatches, and risks before recommending any operation.

## Create

1. Inspect the repository, status, branches, and registered worktrees.
2. Resolve and verify the intended base branch and revision.
3. Validate the task branch name, path, and collision state.
4. Create or select the branch without overwriting an existing branch.
5. Create the worktree.
6. Verify its branch, path, repository relationship, and status.
7. Persist metadata only after verification; reconcile partial success if persistence fails.

## Retry

1. Inspect the recorded and actual worktree state.
2. Reuse the existing valid worktree by default.
3. Create a replacement only when reuse is impossible and existing work is preserved.

## Cleanup

1. Inspect Git, filesystem, metadata, and dirty state before mutation.
2. Stop or detach active processes safely.
3. Preserve uncommitted work and record how it can be recovered.
4. Preserve the task branch unless explicit policy and authorization allow its removal.
5. Remove only the verified worktree target, then verify repository and metadata state.

# Invariants

- A dirty worktree is user data, not disposable runtime state.
- Branch identity, worktree path, and persisted metadata must refer to the same task isolation.
- Git success and metadata persistence success are separate outcomes that require reconciliation.
- Cleanup is never attempted before inspection.

# Safety Rules

- Never run `git reset --hard` as an automated recovery or cleanup step.
- Never force-delete a branch or delete a dirty worktree.
- Never overwrite user code, discard uncommitted changes, or assume an untracked path is safe to remove.
- Resolve and verify the exact repository and worktree paths before removal.

# Validation

- Use integration tests with a temporary real Git repository and real worktrees.
- Cover branch/path collisions, dirty state, retry reuse, active-process cleanup, and Git-success/metadata-failure cases.
- Inspect `git status` and `git worktree list` after create and cleanup operations.

# Expected Output

Report the repository, base and task branches, worktree path, dirty state, operation performed, metadata result, validation, and any preserved recovery path.
