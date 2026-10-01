import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrateSqliteDatabase } from './migrate';
import { SqliteTaskActivityReader } from './task-activity-reader';

describe('SqliteTaskActivityReader', () => {
  let database: DatabaseSync;
  let reader: SqliteTaskActivityReader;

  beforeEach(() => {
    database = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
    migrateSqliteDatabase(database);
    database.exec(`
      INSERT INTO projects(id, name) VALUES ('project-1', 'Project');
      INSERT INTO tasks(id, project_id, title, phase) VALUES
        ('task-1', 'project-1', 'Timeline', 'RUNNING'),
        ('task-2', 'project-1', 'Other', 'RUNNING');
    `);
    reader = new SqliteTaskActivityReader(database);
  });

  afterEach(() => database.close());

  it('loads at most 20 events per page in stable order without reading another Task', async () => {
    const insert = database.prepare(`
      INSERT INTO task_transition_audit
        (id, task_id, from_phase, to_phase, trigger_kind, artifact_id, created_at)
      VALUES (?, ?, 'BACKLOG', 'PLANNING', 'manual', NULL, ?)
    `);
    for (let index = 1; index <= 25; index += 1) {
      insert.run(`transition-${index.toString().padStart(2, '0')}`, 'task-1', 1_000);
    }
    insert.run('foreign', 'task-2', 2_000);

    const first = await reader.listPage({ taskId: 'task-1', filter: 'ALL' });
    expect(first.items).toHaveLength(20);
    expect(first.items[0]).toMatchObject({ id: 'phase:transition-25', kind: 'PHASE_TRANSITION' });
    expect(first.items[19]).toMatchObject({ id: 'phase:transition-06' });
    expect(first.nextCursor).toEqual({ occurredAt: 1_000, id: 'phase:transition-06' });
    if (first.nextCursor === undefined) throw new Error('Expected another page.');
    insert.run('newer-after-first-page', 'task-1', 3_000);
    const second = await reader.listPage({
      taskId: 'task-1',
      filter: 'ALL',
      cursor: first.nextCursor,
    });
    expect(second.items.map((item) => item.id)).toEqual([
      'phase:transition-05',
      'phase:transition-04',
      'phase:transition-03',
      'phase:transition-02',
      'phase:transition-01',
    ]);
    expect(second.nextCursor).toBeUndefined();
  });

  it('applies the evidence filter in SQLite before paging', async () => {
    database.exec(`
      INSERT INTO agent_sessions
        (id, task_id, agent_id, ordinal, status, created_at, history_sequence)
      VALUES ('session-1', 'task-1', 'codex', 1, 'STARTING', 100, 1);
      INSERT INTO agent_session_events
        (session_id, sequence, kind, status, occurred_at)
      VALUES ('session-1', 1, 'START_REQUESTED', 'STARTING', 100);
      INSERT INTO task_transition_audit
        (id, task_id, from_phase, to_phase, trigger_kind, created_at)
      VALUES ('transition-1', 'task-1', 'BACKLOG', 'PLANNING', 'manual', 200);
    `);
    const sessions = await reader.listPage({ taskId: 'task-1', filter: 'SESSION' });
    expect(sessions.items).toEqual([
      expect.objectContaining({ id: 'session:session-1:1', attempt: 1, agentId: 'codex' }),
    ]);
    expect(sessions.nextCursor).toBeUndefined();
  });

  it('projects every evidence kind without returning content, output, paths or provider identities', async () => {
    const sha = 'a'.repeat(40);
    database
      .prepare(
        `
      INSERT INTO agent_sessions
        (id, task_id, agent_id, ordinal, status, created_at, history_sequence, provider_session_id)
      VALUES (?, 'task-1', 'gemini', ?, 'STARTING', ?, 1, 'private-conversation')
    `,
      )
      .run('session-1', 1, 10);
    database
      .prepare(
        `
      INSERT INTO agent_sessions
        (id, task_id, agent_id, ordinal, status, created_at, history_sequence, provider_session_id)
      VALUES (?, 'task-1', 'gemini', ?, 'STARTING', ?, 1, 'private-conversation')
    `,
      )
      .run('session-2', 2, 20);
    database.exec(`
      INSERT INTO agent_session_events (session_id, sequence, kind, status, occurred_at)
      VALUES ('session-1', 1, 'START_REQUESTED', 'STARTING', 10),
             ('session-2', 1, 'START_REQUESTED', 'STARTING', 20);
      INSERT INTO execution_artifacts
        (id, task_id, session_id, ordinal, kind, phase, canonical_name, format,
         schema_version, validation, content, created_at)
      VALUES ('artifact-1', 'task-1', 'session-2', 1, 'plan', 'PLANNING',
        'planning/plan.md', 'markdown', 1, 'VALID', 'SECRET-CONTENT', 30);
      INSERT INTO task_reviews
        (id, task_id, ordinal, status, requested_at, decided_at, decision_note,
         code_schema_version, worktree_path_identity, branch_name, base_commit_id,
         head_commit_id, code_state_fingerprint, changes_total, changes_truncated)
      VALUES ('review-1', 'task-1', 1, 'CHANGES_REQUESTED', 50, 60, 'SECRET-NOTE',
        1, 'C:/private', 'branch', '${sha}', '${sha}', '${'b'.repeat(64)}', 0, 0);
      INSERT INTO task_pull_requests
        (task_id, provider, repository_owner, repository_name, base_branch, head_branch,
         pull_request_number, url, title, head_commit_id, status, draft, created_at, updated_at)
      VALUES ('task-1', 'github', 'org', 'repo', 'main', 'feature', 42,
        'https://github.com/org/repo/pull/42', 'SECRET-TITLE', '${sha}', 'OPEN', 1, 70, 71);
    `);
    database
      .prepare(
        `
      INSERT INTO quality_gate_runs
        (id, task_id, ordinal, gate_id, gate_kind, executable_path, arguments_json,
         timeout_ms, worktree_path_identity, worktree_path, worktree_branch_name,
         worktree_base_commit_id, worktree_head_commit_id, status, started_at)
      VALUES ('gate-1', 'task-1', 1, 'lint', 'LINT', 'C:/SECRET-EXECUTABLE', '[]',
        1000, 'C:/private', 'C:/private', 'feature', ?, ?, 'RUNNING', 40)
    `,
      )
      .run(sha, sha);

    const page = await reader.listPage({ taskId: 'task-1', filter: 'ALL' });
    expect(page.items.map((item) => item.kind)).toEqual([
      'PULL_REQUEST_SNAPSHOT',
      'REVIEW_DECIDED',
      'REVIEW_REQUESTED',
      'QUALITY_GATE',
      'ARTIFACT',
      'SESSION_STARTED',
      'SESSION_STARTED',
    ]);
    expect(page.items).toContainEqual(
      expect.objectContaining({
        kind: 'SESSION_STARTED',
        sessionId: 'session-2',
        attempt: 2,
        continuedFromSessionId: 'session-1',
      }),
    );
    expect(page.items).toContainEqual(
      expect.objectContaining({
        kind: 'QUALITY_GATE',
        runId: 'gate-1',
        status: 'RUNNING',
      }),
    );
    for (const [filter, kinds] of [
      ['SESSION', ['SESSION_STARTED', 'SESSION_STARTED']],
      ['ARTIFACT', ['ARTIFACT']],
      ['QUALITY_GATE', ['QUALITY_GATE']],
      ['REVIEW', ['REVIEW_DECIDED', 'REVIEW_REQUESTED']],
      ['PULL_REQUEST', ['PULL_REQUEST_SNAPSHOT']],
    ] as const) {
      const filtered = await reader.listPage({ taskId: 'task-1', filter });
      expect(filtered.items.map((item) => item.kind)).toEqual(kinds);
    }
    expect(JSON.stringify(page)).not.toMatch(/SECRET|C:\/private|private-conversation/);
  });

  it('rejects a malformed page cursor before querying', async () => {
    await expect(
      reader.listPage({
        taskId: 'task-1',
        filter: 'ALL',
        cursor: { occurredAt: 100, id: 'p'.repeat(540) },
      }),
    ).resolves.toMatchObject({ items: [] });
    await expect(
      reader.listPage({
        taskId: 'task-1',
        filter: 'ALL',
        cursor: { occurredAt: -1, id: 'phase:forged' },
      }),
    ).rejects.toThrow('Invalid Task activity cursor.');
  });
});
