import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { createProject, createTask, type TaskPullRequest } from '@agentterm/application';

import { openSqlitePersistence } from './index';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('SQLite Pull Request persistence', () => {
  it('persists and refreshes one PR identity without storing body, command, or credentials', async () => {
    const databasePath = await createFixture();
    const persistence = openSqlitePersistence(databasePath);
    const opened = pullRequest();
    const merged = Object.freeze({
      ...opened,
      baseBranch: 'release',
      checks: Object.freeze({
        failureCount: 0,
        pendingCount: 0,
        state: 'SUCCESS' as const,
        successCount: 3,
        totalCount: 3,
      }),
      headCommitId: 'c'.repeat(40),
      lastSyncedAt: (opened.lastSyncedAt ?? 0) + 100,
      reviewState: 'APPROVED' as const,
      status: 'MERGED' as const,
      title: 'Updated PR title',
      updatedAt: opened.updatedAt + 100,
    });

    try {
      await persistence.pullRequests.record(opened);
      await persistence.pullRequests.record(merged);
      await persistence.pullRequests.record(merged);
      await expect(persistence.pullRequests.listByTaskId(opened.taskId)).resolves.toEqual([merged]);
    } finally {
      persistence.close();
    }

    const reopened = openSqlitePersistence(databasePath);
    try {
      await expect(reopened.pullRequests.listByTaskId(opened.taskId)).resolves.toEqual([merged]);
    } finally {
      reopened.close();
    }

    const raw = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const columns = raw.prepare('PRAGMA table_info(task_pull_requests)').all();
      expect(columns.map(({ name }) => name)).toEqual([
        'task_id',
        'provider',
        'repository_owner',
        'repository_name',
        'base_branch',
        'head_branch',
        'pull_request_number',
        'url',
        'title',
        'head_commit_id',
        'status',
        'draft',
        'created_at',
        'updated_at',
        'review_state',
        'check_state',
        'check_total_count',
        'check_success_count',
        'check_failure_count',
        'check_pending_count',
        'last_synced_at',
      ]);
      expect(JSON.stringify(columns)).not.toMatch(/token|credential|body|command|environment/iu);
      expect(
        raw
          .prepare(
            `SELECT ordinal, base_branch, status, review_state, check_state, last_synced_at
             FROM task_pull_request_sync_history
             WHERE task_id = ?
             ORDER BY ordinal`,
          )
          .all(opened.taskId),
      ).toEqual([
        {
          check_state: 'UNKNOWN',
          base_branch: 'main',
          last_synced_at: opened.lastSyncedAt,
          ordinal: 1,
          review_state: 'UNKNOWN',
          status: 'OPEN',
        },
        {
          check_state: 'SUCCESS',
          base_branch: 'release',
          last_synced_at: merged.lastSyncedAt,
          ordinal: 2,
          review_state: 'APPROVED',
          status: 'MERGED',
        },
      ]);
    } finally {
      raw.close();
    }
  });

  it('preserves distinct base/head identities and ignores an older remote refresh', async () => {
    const databasePath = await createFixture();
    const persistence = openSqlitePersistence(databasePath);
    const current = pullRequest();
    const older = Object.freeze({
      ...current,
      lastSyncedAt: (current.lastSyncedAt ?? 1) - 1,
      status: 'CLOSED' as const,
      updatedAt: current.createdAt + 1,
    });
    const release = Object.freeze({
      ...current,
      baseBranch: 'release',
      number: 43,
      updatedAt: current.updatedAt + 1,
      url: 'https://github.com/agentterm/AgentTerm/pull/43',
    });

    try {
      await persistence.pullRequests.record(current);
      await persistence.pullRequests.record(older);
      await persistence.pullRequests.record(release);
      await expect(persistence.pullRequests.listByTaskId(current.taskId)).resolves.toEqual([
        current,
        release,
      ]);
    } finally {
      persistence.close();
    }

    const raw = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        raw
          .prepare(
            `SELECT base_branch, status, last_synced_at
             FROM task_pull_request_sync_history
             WHERE task_id = ?
             ORDER BY base_branch, ordinal`,
          )
          .all(current.taskId),
      ).toEqual([
        {
          base_branch: 'main',
          last_synced_at: current.lastSyncedAt,
          status: 'OPEN',
        },
        {
          base_branch: 'release',
          last_synced_at: release.lastSyncedAt,
          status: 'OPEN',
        },
      ]);
    } finally {
      raw.close();
    }
  });

  it('rejects malformed status, URL, commit, and duplicate repository PR numbers', async () => {
    const databasePath = await createFixture();
    const persistence = openSqlitePersistence(databasePath);
    const value = pullRequest();
    try {
      await persistence.pullRequests.record(value);
      for (const malformed of [
        { ...value, status: 'UNKNOWN' },
        { ...value, url: 'https://example.com/pull/42' },
        { ...value, headCommitId: 'not-a-commit' },
      ]) {
        await expect(
          persistence.pullRequests.record(malformed as TaskPullRequest),
        ).rejects.toThrow();
      }
      await expect(
        persistence.pullRequests.record({
          ...value,
          baseBranch: 'release',
          headBranch: 'agentterm/task/other',
          taskId: 'task-pr-2',
        }),
      ).rejects.toThrow();
      await expect(persistence.pullRequests.listByTaskId(value.taskId)).resolves.toEqual([value]);
    } finally {
      persistence.close();
    }
  });
});

function pullRequest(): TaskPullRequest {
  return Object.freeze({
    baseBranch: 'main',
    checks: Object.freeze({
      failureCount: 0,
      pendingCount: 0,
      state: 'UNKNOWN',
      successCount: 0,
      totalCount: 0,
    }),
    createdAt: 1_800_000_000_000,
    draft: false,
    headBranch: 'agentterm/task/pr-flow',
    headCommitId: 'b'.repeat(40),
    lastSyncedAt: 1_800_000_000_200,
    number: 42,
    provider: 'github',
    repositoryName: 'AgentTerm',
    repositoryOwner: 'agentterm',
    reviewState: 'UNKNOWN',
    status: 'OPEN',
    taskId: 'task-pr',
    title: 'Add explicit PR flow',
    updatedAt: 1_800_000_000_100,
    url: 'https://github.com/agentterm/AgentTerm/pull/42',
  });
}

async function createFixture(): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'agentterm-pull-request-'));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, 'agentterm.db');
  const persistence = openSqlitePersistence(databasePath);
  try {
    await createProject({ id: 'project-1', name: 'Project' }, persistence.projects);
    await createTask(
      { id: 'task-pr', projectId: 'project-1', title: 'PR Task' },
      persistence.projects,
      persistence.tasks,
    );
    await createTask(
      { id: 'task-pr-2', projectId: 'project-1', title: 'Other PR Task' },
      persistence.projects,
      persistence.tasks,
    );
  } finally {
    persistence.close();
  }
  return databasePath;
}
