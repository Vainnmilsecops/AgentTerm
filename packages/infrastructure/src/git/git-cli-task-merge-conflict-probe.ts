/**
 * Implementation of the `TaskMergeConflictProbe` Application port.
 *
 * The class is a thin adapter over `GitCli.mergeTreeConflictProbe`. It
 * owns the Git invocation boundary (argv + bounds + error sanitization)
 * and emits the same `MergeConflictProbe` typed result the Application
 * use case already expects.
 *
 * The probe never:
 * - mutates the persisted primary Worktree;
 * - performs a real `git merge` or `git rebase`;
 * - runs from outside the persisted Worktree root;
 * - reaches the renderer (the renderer never imports this file).
 */
import type {
  MergeConflictFile,
  MergeConflictProbe,
  ProbeTaskMergeConflictsInput,
  TaskMergeConflictProbe,
} from '@agentterm/application';

import { GitCli } from './git-cli';

const EMPTY_FILE_LIST: readonly MergeConflictFile[] = Object.freeze([]);

export interface GitCliTaskMergeConflictProbeOptions {
  /** Optional override for the default 32-hunk cap per conflicted file. */
  readonly maxHunksPerFile?: number;
}

export class GitCliTaskMergeConflictProbe implements TaskMergeConflictProbe {
  public constructor(
    private readonly cli: GitCli = new GitCli(),
    private readonly options: GitCliTaskMergeConflictProbeOptions = {},
  ) {}

  public async probeMergeConflicts(
    input: ProbeTaskMergeConflictsInput,
  ): Promise<MergeConflictProbe> {
    const result = await this.cli.mergeTreeConflictProbe(
      input.worktreePath,
      input.baseRef,
      input.headRef,
      this.options,
    );
    if (result.kind === 'clean') {
      return Object.freeze({
        baseRef: result.baseRef,
        headRef: result.headRef,
        kind: 'clean' as const,
      });
    }
    if (result.kind === 'conflicts') {
      const files: readonly MergeConflictFile[] = result.files.map((file) =>
        Object.freeze({
          hunks: Object.freeze([...file.hunks]),
          path: file.path,
        }),
      );
      return Object.freeze({
        baseRef: result.baseRef,
        files: files.length === 0 ? EMPTY_FILE_LIST : Object.freeze([...files]),
        headRef: result.headRef,
        kind: 'conflicts' as const,
      });
    }
    return Object.freeze({
      kind: 'unavailable' as const,
      reason: result.reason,
    });
  }
}
