import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  reconcileOrphanQualityGateRuns,
  type ReconcileOrphanQualityGateRunsResult,
} from '@agentterm/application';
import {
  completeQualityGateRun,
  createProject,
  createQualityGate,
  createTask,
  QualityGateKind,
  QualityGateRunStatus,
  startQualityGateRun,
  UNOBSERVED_GATE_OUTPUT_REFERENCE,
  type QualityGateRun,
} from '@agentterm/domain';

import { openSqlitePersistence } from './index';

const gate = createQualityGate({
  command: {
    arguments: ['--filter', '@agentterm/infrastructure', 'test'],
    executablePath: 'C:\\Program Files\\nodejs\\node.exe',
  },
  id: 'restore-gate',
  kind: QualityGateKind.TEST,
  timeoutMs: 120_000,
});

const worktree = {
  baseCommitId: 'a'.repeat(40),
  branchName: 'agentterm/task/restore',
  headCommitIdAtStart: 'b'.repeat(40),
  pathIdentity: 'win32:d:\\agentterm worktrees\\task-restore',
  worktreePath: 'D:\\AgentTerm Worktrees\\task-restore',
};

async function withTemporaryDatabase(run: (databasePath: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'agentterm-quality-gate-restore-'));
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
    await persistence.projects.insert(createProject({ id: 'project-restore', name: 'AgentTerm' }));
    await persistence.tasks.insert(
      createTask({
        id: 'task-restore',
        projectId: 'project-restore',
        title: 'Restore orphans',
      }),
    );
  } finally {
    persistence.close();
  }
}

function runningRun(id: string, startedAt: number): QualityGateRun {
  return startQualityGateRun({
    gate,
    id,
    startedAt,
    taskId: 'task-restore',
    worktree,
  });
}

function passedRun(running: QualityGateRun, finishedAt: number): QualityGateRun {
  return completeQualityGateRun(running, {
    exitCode: 0,
    finishedAt,
    kind: 'exited',
    output: {
      reference: `quality-gate-output:${running.id}`,
      text: 'OK',
      truncated: false,
    },
  });
}

function failedRun(running: QualityGateRun, finishedAt: number): QualityGateRun {
  return completeQualityGateRun(running, {
    exitCode: 2,
    finishedAt,
    kind: 'exited',
    output: {
      reference: `quality-gate-output:${running.id}`,
      text: 'failed',
      truncated: false,
    },
  });
}

describe('Quality Gate orphan reconciliation with SQLite', { timeout: 20_000 }, () => {
  it('finalizes two RUNNING orphans and leaves the PASSED and FAILED rows untouched', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      await seedTask(databasePath);

      const seed = openSqlitePersistence(databasePath);
      try {
        const orphanOlder = runningRun('orphan-older', 1_000);
        const orphanNewer = runningRun('orphan-newer', 2_000);
        const passedRunning = runningRun('settled-passed', 3_000);
        const passed = passedRun(passedRunning, 3_075);
        const failedRunning = runningRun('settled-failed', 4_000);
        const failed = failedRun(failedRunning, 4_060);

        await seed.qualityGateRuns.insert(orphanOlder);
        await seed.qualityGateRuns.insert(orphanNewer);
        await seed.qualityGateRuns.insert(passedRunning);
        await seed.qualityGateRuns.finalize(passed, 'RUNNING');
        await seed.qualityGateRuns.insert(failedRunning);
        await seed.qualityGateRuns.finalize(failed, 'RUNNING');

        // Sanity check: listUnsettled surfaces exactly the two RUNNING rows
        // ordered by startedAt, before reconcile runs.
        await expect(seed.qualityGateRuns.listUnsettled()).resolves.toEqual([
          orphanOlder,
          orphanNewer,
        ]);
      } finally {
        seed.close();
      }

      // Simulate the next desktop process booting, calling the reconcile use
      // case against the same database.
      const reconcile = openSqlitePersistence(databasePath);
      let result: ReconcileOrphanQualityGateRunsResult;
      try {
        result = await reconcileOrphanQualityGateRuns({
          clock: () => 9_000,
          runs: reconcile.qualityGateRuns,
        });
      } finally {
        reconcile.close();
      }

      expect(result.reconciledRunIds).toEqual(['orphan-older', 'orphan-newer']);

      // Verify the final shape persisted to disk.
      const reopened = openSqlitePersistence(databasePath);
      try {
        const reconciledOlder = await reopened.qualityGateRuns.findById('orphan-older');
        const reconciledNewer = await reopened.qualityGateRuns.findById('orphan-newer');
        expect(reconciledOlder).toMatchObject({
          durationMs: 8_000,
          exitCode: undefined,
          failureCategory: 'INFRASTRUCTURE',
          finishedAt: 9_000,
          id: 'orphan-older',
          startedAt: 1_000,
          status: QualityGateRunStatus.INFRASTRUCTURE_FAILED,
        });
        expect(reconciledOlder?.output?.reference).toBe(
          `${UNOBSERVED_GATE_OUTPUT_REFERENCE}:orphan-older`,
        );
        expect(reconciledOlder?.output?.text).toBe('');
        expect(reconciledOlder?.output?.truncated).toBe(false);
        expect(reconciledNewer).toMatchObject({
          durationMs: 7_000,
          failureCategory: 'INFRASTRUCTURE',
          finishedAt: 9_000,
          id: 'orphan-newer',
          startedAt: 2_000,
          status: QualityGateRunStatus.INFRASTRUCTURE_FAILED,
        });

        // The settled rows are not touched.
        expect(await reopened.qualityGateRuns.findById('settled-passed')).toMatchObject({
          status: QualityGateRunStatus.PASSED,
          output: { text: 'OK' },
        });
        expect(await reopened.qualityGateRuns.findById('settled-failed')).toMatchObject({
          status: QualityGateRunStatus.FAILED,
          output: { text: 'failed' },
        });

        // After the reconcile, listUnsettled is empty.
        await expect(reopened.qualityGateRuns.listUnsettled()).resolves.toEqual([]);
      } finally {
        reopened.close();
      }
    });
  });

  it('returns an empty reconcile list when no RUNNING rows exist', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      await seedTask(databasePath);

      const seed = openSqlitePersistence(databasePath);
      try {
        const passedRunning = runningRun('only-passed', 1_000);
        const passed = passedRun(passedRunning, 1_050);
        await seed.qualityGateRuns.insert(passedRunning);
        await seed.qualityGateRuns.finalize(passed, 'RUNNING');
      } finally {
        seed.close();
      }

      const reconcile = openSqlitePersistence(databasePath);
      try {
        const result = await reconcileOrphanQualityGateRuns({
          clock: () => 5_000,
          runs: reconcile.qualityGateRuns,
        });
        expect(result.reconciledRunIds).toEqual([]);
        await expect(reconcile.qualityGateRuns.findById('only-passed')).resolves.toMatchObject({
          status: QualityGateRunStatus.PASSED,
        });
      } finally {
        reconcile.close();
      }
    });
  });
});
