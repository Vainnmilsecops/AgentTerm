import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { EntityAlreadyExistsError } from '@agentterm/application';
import {
  completeQualityGateRun,
  createProject,
  createQualityGate,
  createTask,
  QualityGateKind,
  startQualityGateRun,
  type QualityGateRun,
} from '@agentterm/domain';

import { openSqlitePersistence, SqlitePersistenceError } from './index';

const gate = createQualityGate({
  command: {
    arguments: ['--filter', '@agentterm/domain', 'test'],
    executablePath: 'C:\\Program Files\\nodejs\\node.exe',
  },
  id: 'test',
  kind: QualityGateKind.TEST,
  timeoutMs: 120_000,
});

const worktree = {
  baseCommitId: 'a'.repeat(40),
  branchName: 'agentterm/task/abc123',
  headCommitIdAtStart: 'b'.repeat(40),
  pathIdentity: 'win32:d:\\agentterm worktrees\\task-1',
  worktreePath: 'D:\\AgentTerm Worktrees\\task-1',
};

async function withTemporaryDatabase(run: (databasePath: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'agentterm-quality-gate-'));
  const databasePath = join(directory, 'agentterm.db');
  try {
    await run(databasePath);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

async function seedTask(databasePath: string): Promise<void> {
  const persistence = openSqlitePersistence(databasePath);
  try {
    await persistence.projects.insert(createProject({ id: 'project-1', name: 'AgentTerm' }));
    await persistence.tasks.insert(
      createTask({ id: 'task-1', projectId: 'project-1', title: 'Persist gates' }),
    );
  } finally {
    persistence.close();
  }
}

function runningRun(id: string, startedAt: number): QualityGateRun {
  return startQualityGateRun({ gate, id, startedAt, taskId: 'task-1', worktree });
}

describe('SQLite Quality Gate Run persistence', () => {
  it('round-trips structured command, Worktree provenance, and terminal output across connections', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      await seedTask(databasePath);
      const persistence = openSqlitePersistence(databasePath);
      const running = runningRun('run-1', 1_800_000_000_000);
      const passed = completeQualityGateRun(running, {
        exitCode: 0,
        finishedAt: 1_800_000_000_075,
        kind: 'exited',
        output: {
          reference: 'quality-gate-output:run-1',
          text: 'Kiểm tra hoàn tất ✓',
          truncated: false,
        },
      });

      try {
        await persistence.qualityGateRuns.insert(running);
        await persistence.qualityGateRuns.finalize(passed, 'RUNNING');
      } finally {
        persistence.close();
      }

      const reopened = openSqlitePersistence(databasePath);
      try {
        await expect(reopened.qualityGateRuns.findById('run-1')).resolves.toEqual(passed);
        await expect(reopened.qualityGateRuns.listByTaskId('task-1')).resolves.toEqual([passed]);
        await expect(reopened.tasks.findById('task-1')).resolves.toMatchObject({
          phase: 'BACKLOG',
        });
      } finally {
        reopened.close();
      }
    });
  });

  it('preserves retry history by insertion ordinal even when timestamps move backwards', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      await seedTask(databasePath);
      const persistence = openSqlitePersistence(databasePath);
      try {
        const first = runningRun('run-first', 2_000);
        const failed = completeQualityGateRun(first, {
          exitCode: 2,
          finishedAt: 2_025,
          kind: 'exited',
          output: {
            reference: 'quality-gate-output:run-first',
            text: 'tests failed',
            truncated: false,
          },
        });
        const retry = runningRun('run-retry', 1_000);

        await persistence.qualityGateRuns.insert(first);
        await persistence.qualityGateRuns.finalize(failed, 'RUNNING');
        await persistence.qualityGateRuns.insert(retry);

        await expect(persistence.qualityGateRuns.listByTaskId('task-1')).resolves.toEqual([
          failed,
          retry,
        ]);
        await expect(persistence.qualityGateRuns.insert(first)).rejects.toBeInstanceOf(
          EntityAlreadyExistsError,
        );
      } finally {
        persistence.close();
      }
    });
  });

  it('makes an exact finalize retry idempotent and rejects conflicting terminal evidence', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      await seedTask(databasePath);
      const persistence = openSqlitePersistence(databasePath);
      try {
        const running = runningRun('run-1', 1_000);
        const timedOut = completeQualityGateRun(running, {
          finishedAt: 1_100,
          kind: 'timed-out',
          output: {
            reference: 'quality-gate-output:run-1',
            text: 'partial output',
            truncated: true,
          },
        });
        const conflicting = completeQualityGateRun(running, {
          finishedAt: 1_101,
          kind: 'launch-failed',
          output: {
            reference: 'quality-gate-output:run-conflict',
            text: '',
            truncated: false,
          },
        });

        await persistence.qualityGateRuns.insert(running);
        await persistence.qualityGateRuns.finalize(timedOut, 'RUNNING');
        await expect(
          persistence.qualityGateRuns.finalize(timedOut, 'RUNNING'),
        ).resolves.toBeUndefined();
        await expect(
          persistence.qualityGateRuns.finalize(conflicting, 'RUNNING'),
        ).rejects.toBeInstanceOf(SqlitePersistenceError);
        await expect(persistence.qualityGateRuns.findById('run-1')).resolves.toEqual(timedOut);
      } finally {
        persistence.close();
      }
    });
  });

  it('rejects a terminal insert and keeps RUNNING evidence when oversized output cannot finalize', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      await seedTask(databasePath);
      const persistence = openSqlitePersistence(databasePath);
      try {
        const running = runningRun('run-1', 1_000);
        const passed = completeQualityGateRun(running, {
          exitCode: 0,
          finishedAt: 1_001,
          kind: 'exited',
          output: {
            reference: 'quality-gate-output:run-1',
            text: 'x'.repeat(262_145),
            truncated: true,
          },
        });

        await expect(persistence.qualityGateRuns.insert(passed)).rejects.toBeInstanceOf(
          SqlitePersistenceError,
        );
        await persistence.qualityGateRuns.insert(running);
        await expect(
          persistence.qualityGateRuns.finalize(passed, 'RUNNING'),
        ).rejects.toBeInstanceOf(SqlitePersistenceError);
        await expect(persistence.qualityGateRuns.findById('run-1')).resolves.toEqual(running);
      } finally {
        persistence.close();
      }
    });
  });

  it('enforces the Task relationship and rejects corrupted argument history during mapping', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      await seedTask(databasePath);
      const persistence = openSqlitePersistence(databasePath);
      try {
        await persistence.qualityGateRuns.insert(runningRun('run-1', 1_000));
      } finally {
        persistence.close();
      }

      const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
      try {
        database.exec('PRAGMA ignore_check_constraints = ON');
        database
          .prepare('UPDATE quality_gate_runs SET arguments_json = ? WHERE id = ?')
          .run('["ok", 42]', 'run-1');
        expect(() =>
          database
            .prepare(
              `INSERT INTO quality_gate_runs (
                 id, task_id, ordinal, gate_id, gate_kind, executable_path, arguments_json,
                 timeout_ms, worktree_path_identity, worktree_path, worktree_branch_name,
                 worktree_base_commit_id, worktree_head_commit_id, status, started_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?)`,
            )
            .run(
              'orphan-run',
              'missing-task',
              1,
              'test',
              'TEST',
              'C:\\node.exe',
              '[]',
              1_000,
              'identity',
              'C:\\worktree',
              'agentterm/task/test',
              'b'.repeat(40),
              'c'.repeat(40),
              1_000,
            ),
        ).toThrow();
      } finally {
        database.close();
      }

      const reopened = openSqlitePersistence(databasePath);
      try {
        await expect(reopened.qualityGateRuns.findById('run-1')).rejects.toBeInstanceOf(
          SqlitePersistenceError,
        );
      } finally {
        reopened.close();
      }
    });
  });

  it('rejects an unknown failure category at the storage boundary', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      await seedTask(databasePath);
      const persistence = openSqlitePersistence(databasePath);
      try {
        await persistence.qualityGateRuns.insert(runningRun('run-1', 1_000));
      } finally {
        persistence.close();
      }

      const database = new DatabaseSync(databasePath);
      try {
        expect(() =>
          database
            .prepare(
              `UPDATE quality_gate_runs
               SET status = 'LAUNCH_FAILED', finished_at = 1001, duration_ms = 1,
                   failure_category = 'UNKNOWN', output_reference = 'output:run-1',
                   output_text = '', output_truncated = 0
               WHERE id = 'run-1'`,
            )
            .run(),
        ).toThrow();
      } finally {
        database.close();
      }
    });
  });
});
