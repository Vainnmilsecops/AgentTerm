import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  completeQualityGateRun,
  createAgentSession,
  decideTaskReview,
  createExecutionArtifact,
  createProject,
  createQualityGate,
  createTask,
  ExecutionArtifactKind,
  QualityGateKind,
  recordAgentSessionEvent,
  startQualityGateRun,
  startTaskReview,
  TaskPhase,
  transitionTask,
  type Task,
  type TaskReview,
} from '@agentterm/domain';

import { openSqlitePersistence, SqlitePersistenceError } from './index';

const baseCommitId = '1'.repeat(40);
const headCommitId = '2'.repeat(40);
const worktreePathIdentity = 'win32:d:\\agentterm-worktrees\\task-1';
const noSessionRevisions = Object.freeze([]);

async function withTemporaryDatabase(run: (databasePath: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'agentterm-task-review-'));
  const databasePath = join(directory, 'agentterm.db');
  try {
    await run(databasePath);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function atPhase(task: Task, target: 'RUNNING' | 'REVIEW' | 'DONE'): Task {
  let current = task;
  for (const phase of [TaskPhase.PLANNING, TaskPhase.RUNNING, TaskPhase.REVIEW, TaskPhase.DONE]) {
    if (current.phase === target) {
      return current;
    }
    current = transitionTask(current, phase);
  }
  return current;
}

async function seedReviewInputs(databasePath: string): Promise<TaskReview> {
  const persistence = openSqlitePersistence(databasePath);
  try {
    await persistence.projects.insert(createProject({ id: 'project-1', name: 'AgentTerm' }));
    const task = atPhase(
      createTask({ id: 'task-1', projectId: 'project-1', title: 'Review persistence' }),
      TaskPhase.RUNNING,
    );
    await persistence.tasks.insert(task);
    await persistence.worktrees.insertReservation({
      baseCommitId,
      baseRefName: 'refs/heads/main',
      branchName: 'agentterm/task-1',
      pathIdentity: worktreePathIdentity,
      repositoryRootPath: 'D:\\repo',
      taskId: task.id,
      worktreePath: 'D:\\AgentTerm Worktrees\\task-1',
    });
    await persistence.worktrees.transitionState(task.id, 'PROVISIONING', 'PRESENT');

    const artifact = createExecutionArtifact({
      content: '# Execution Summary\n\nImplementation evidence.',
      createdAt: 20,
      id: 'artifact-1',
      kind: ExecutionArtifactKind.EXECUTION_SUMMARY,
      taskId: task.id,
    });
    await persistence.artifacts.insert(artifact);

    const gate = createQualityGate({
      command: { arguments: ['test'], executablePath: 'C:\\node.exe' },
      id: 'test',
      kind: QualityGateKind.TEST,
      timeoutMs: 1_000,
    });
    const runningGate = startQualityGateRun({
      gate,
      id: 'gate-run-1',
      startedAt: 30,
      taskId: task.id,
      worktree: {
        baseCommitId,
        branchName: 'agentterm/task-1',
        headCommitIdAtStart: headCommitId,
        pathIdentity: worktreePathIdentity,
        worktreePath: 'D:\\AgentTerm Worktrees\\task-1',
      },
    });
    const passedGate = completeQualityGateRun(runningGate, {
      exitCode: 0,
      finishedAt: 40,
      kind: 'exited',
      output: {
        reference: 'quality-gate-output:gate-run-1',
        text: 'passed',
        truncated: false,
      },
    });
    await persistence.qualityGateRuns.insert(runningGate);
    await persistence.qualityGateRuns.finalize(passedGate, 'RUNNING');

    return startTaskReview({
      artifacts: [
        {
          createdAt: artifact.createdAt,
          id: artifact.id,
          kind: artifact.kind,
          phase: artifact.phase,
          sessionId: artifact.sessionId,
        },
      ],
      codeState: Object.freeze({
        baseCommitId,
        branchName: 'agentterm/task-1',
        changes: Object.freeze({
          committed: Object.freeze(['packages/domain/src/task.ts']),
          conflicted: Object.freeze([]),
          staged: Object.freeze([]),
          total: 2,
          truncated: false,
          unstaged: Object.freeze(['docs/CURRENT_STATE.md']),
          untracked: Object.freeze([]),
        }),
        fingerprint: 'a'.repeat(64),
        headCommitId,
        schemaVersion: 1,
        worktreePathIdentity,
      }),
      id: 'review-1',
      qualityGates: [
        {
          association: 'HEAD_MATCH_ONLY' as const,
          baseCommitId: passedGate.worktree.baseCommitId,
          branchName: passedGate.worktree.branchName,
          finishedAt: passedGate.finishedAt,
          gateId: passedGate.gate.id,
          headCommitIdAtStart: passedGate.worktree.headCommitIdAtStart,
          id: passedGate.id,
          kind: passedGate.gate.kind,
          observedStatus: passedGate.status,
          startedAt: passedGate.startedAt,
          worktreePathIdentity: passedGate.worktree.pathIdentity,
        },
      ],
      requestedAt: 50,
      taskId: task.id,
    });
  } finally {
    persistence.close();
  }
}

function terminalReview(
  review: TaskReview,
  status: 'APPROVED' | 'CHANGES_REQUESTED',
  decidedAt: number,
): TaskReview {
  return decideTaskReview(review, {
    decidedAt,
    decisionNote: status === 'APPROVED' ? 'Accepted by the user.' : 'Please address findings.',
    status,
  });
}

function taskWithPhase(task: Task, phase: 'DONE' | 'RUNNING'): Task {
  return transitionTask(task, phase);
}

describe('SQLite Task Review persistence', () => {
  it('admits the first structured attempt in-place for a legacy REVIEW Task', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const pending = await seedReviewInputs(databasePath);
      const persistence = openSqlitePersistence(databasePath);
      try {
        const running = (await persistence.tasks.findById(pending.taskId))!;
        const reviewTask = transitionTask(running, TaskPhase.REVIEW);
        await persistence.tasks.update(reviewTask, TaskPhase.RUNNING);

        await persistence.reviews.begin(pending, TaskPhase.REVIEW, reviewTask, noSessionRevisions);

        await expect(persistence.tasks.findById(pending.taskId)).resolves.toEqual(reviewTask);
        await expect(persistence.reviews.listByTaskId(pending.taskId)).resolves.toEqual([pending]);
      } finally {
        persistence.close();
      }
    });
  });

  it('preserves an exact empty evidence history', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const persistence = openSqlitePersistence(databasePath);
      try {
        await persistence.projects.insert(createProject({ id: 'project-1', name: 'AgentTerm' }));
        const runningTask = atPhase(
          createTask({ id: 'task-1', projectId: 'project-1', title: 'Empty review context' }),
          TaskPhase.RUNNING,
        );
        await persistence.tasks.insert(runningTask);
        await persistence.worktrees.insertReservation({
          baseCommitId,
          baseRefName: 'refs/heads/main',
          branchName: 'agentterm/task-1',
          pathIdentity: worktreePathIdentity,
          repositoryRootPath: 'D:\\repo',
          taskId: runningTask.id,
          worktreePath: 'D:\\AgentTerm Worktrees\\task-1',
        });
        await persistence.worktrees.transitionState(runningTask.id, 'PROVISIONING', 'PRESENT');
        const pending = startTaskReview({
          artifacts: [],
          codeState: {
            baseCommitId,
            branchName: 'agentterm/task-1',
            changes: {
              committed: [],
              conflicted: [],
              staged: [],
              total: 0,
              truncated: false,
              unstaged: [],
              untracked: [],
            },
            fingerprint: 'b'.repeat(64),
            headCommitId,
            schemaVersion: 1,
            worktreePathIdentity,
          },
          id: 'review-empty',
          qualityGates: [],
          requestedAt: 50,
          taskId: runningTask.id,
        });

        await persistence.reviews.begin(
          pending,
          TaskPhase.RUNNING,
          transitionTask(runningTask, TaskPhase.REVIEW),
          noSessionRevisions,
        );

        await expect(persistence.reviews.listByTaskId(runningTask.id)).resolves.toEqual([pending]);
      } finally {
        persistence.close();
      }
    });
  });

  it('atomically inserts a PENDING review with exact evidence and moves RUNNING to REVIEW', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const pending = await seedReviewInputs(databasePath);
      const persistence = openSqlitePersistence(databasePath);
      try {
        const runningTask = (await persistence.tasks.findById(pending.taskId))!;
        const reviewTask = transitionTask(runningTask, TaskPhase.REVIEW);
        await persistence.reviews.begin(pending, TaskPhase.RUNNING, reviewTask, noSessionRevisions);

        expect(reviewTask.phase).toBe(TaskPhase.REVIEW);
        await expect(persistence.tasks.findById(pending.taskId)).resolves.toEqual(reviewTask);
        await expect(persistence.reviews.findById(pending.id)).resolves.toEqual(pending);
        await expect(persistence.reviews.listByTaskId(pending.taskId)).resolves.toEqual([pending]);
      } finally {
        persistence.close();
      }

      const reopened = openSqlitePersistence(databasePath);
      try {
        await expect(reopened.reviews.findById(pending.id)).resolves.toEqual(pending);
      } finally {
        reopened.close();
      }
    });
  });

  it('atomically approves the exact PENDING review and moves REVIEW to DONE', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const pending = await seedReviewInputs(databasePath);
      const persistence = openSqlitePersistence(databasePath);
      try {
        const runningTask = (await persistence.tasks.findById(pending.taskId))!;
        const reviewTask = transitionTask(runningTask, TaskPhase.REVIEW);
        await persistence.reviews.begin(pending, TaskPhase.RUNNING, reviewTask, noSessionRevisions);
        const approved = terminalReview(pending, 'APPROVED', 60);
        const doneTask = taskWithPhase(reviewTask, TaskPhase.DONE);

        await expect(
          persistence.reviews.decide(approved, 'PENDING', TaskPhase.REVIEW, doneTask),
        ).resolves.toBeUndefined();
        await expect(persistence.reviews.findById(pending.id)).resolves.toEqual(approved);
        await expect(persistence.tasks.findById(pending.taskId)).resolves.toEqual(doneTask);
      } finally {
        persistence.close();
      }
    });
  });

  it('preserves request-changes history and appends a new review attempt', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const first = await seedReviewInputs(databasePath);
      const persistence = openSqlitePersistence(databasePath);
      try {
        const initialRunningTask = (await persistence.tasks.findById(first.taskId))!;
        const reviewTask = transitionTask(initialRunningTask, TaskPhase.REVIEW);
        await persistence.reviews.begin(first, TaskPhase.RUNNING, reviewTask, noSessionRevisions);
        const changesRequested = terminalReview(first, 'CHANGES_REQUESTED', 60);
        const runningTask = taskWithPhase(reviewTask, TaskPhase.RUNNING);
        await persistence.reviews.decide(
          changesRequested,
          'PENDING',
          TaskPhase.REVIEW,
          runningTask,
        );

        const second = Object.freeze({ ...first, id: 'review-2', requestedAt: 70 });
        const secondReviewTask = transitionTask(runningTask, TaskPhase.REVIEW);
        await persistence.reviews.begin(
          second,
          TaskPhase.RUNNING,
          secondReviewTask,
          noSessionRevisions,
        );

        await expect(persistence.reviews.listByTaskId(first.taskId)).resolves.toEqual([
          changesRequested,
          second,
        ]);
        await expect(persistence.reviews.listRecentByTaskId(first.taskId, 1)).resolves.toEqual([
          second,
        ]);
        await expect(persistence.reviews.listRecentByTaskId(first.taskId, 0)).rejects.toThrow(
          TypeError,
        );
        await expect(persistence.reviews.listByTaskId(first.taskId)).resolves.toEqual([
          changesRequested,
          second,
        ]);
      } finally {
        persistence.close();
      }
    });
  });

  it('rolls back review creation and phase change for stale evidence snapshots', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const pending = await seedReviewInputs(databasePath);
      const persistence = openSqlitePersistence(databasePath);
      try {
        const stale = Object.freeze({
          ...pending,
          artifacts: Object.freeze([Object.freeze({ ...pending.artifacts[0]!, createdAt: 21 })]),
        });

        await expect(
          persistence.reviews.begin(
            stale,
            TaskPhase.RUNNING,
            transitionTask((await persistence.tasks.findById(pending.taskId))!, TaskPhase.REVIEW),
            noSessionRevisions,
          ),
        ).rejects.toBeInstanceOf(SqlitePersistenceError);
        await expect(persistence.reviews.listByTaskId(pending.taskId)).resolves.toEqual([]);
        await expect(persistence.tasks.findById(pending.taskId)).resolves.toMatchObject({
          phase: TaskPhase.RUNNING,
        });
      } finally {
        persistence.close();
      }
    });
  });

  it('rolls back when Quality Gate terminal evidence changed after review context was assembled', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const pending = await seedReviewInputs(databasePath);
      const persistence = openSqlitePersistence(databasePath);
      try {
        const stale = startTaskReview({
          artifacts: pending.artifacts,
          codeState: pending.codeState,
          id: 'review-stale-gate',
          qualityGates: pending.qualityGates.map((gate) => ({
            ...gate,
            finishedAt: undefined,
            observedStatus: 'RUNNING' as const,
          })),
          requestedAt: pending.requestedAt,
          taskId: pending.taskId,
        });
        const runningTask = (await persistence.tasks.findById(pending.taskId))!;

        await expect(
          persistence.reviews.begin(
            stale,
            TaskPhase.RUNNING,
            transitionTask(runningTask, TaskPhase.REVIEW),
            noSessionRevisions,
          ),
        ).rejects.toBeInstanceOf(SqlitePersistenceError);
        await expect(persistence.reviews.listByTaskId(pending.taskId)).resolves.toEqual([]);
        await expect(persistence.tasks.findById(pending.taskId)).resolves.toEqual(runningTask);
      } finally {
        persistence.close();
      }
    });
  });

  it.each(['Artifact', 'Quality Gate'] as const)(
    'rolls back when an unreferenced %s is appended after review context assembly',
    async (kind) => {
      await withTemporaryDatabase(async (databasePath) => {
        const pending = await seedReviewInputs(databasePath);
        const persistence = openSqlitePersistence(databasePath);
        try {
          if (kind === 'Artifact') {
            await persistence.artifacts.insert(
              createExecutionArtifact({
                content: '# Execution Summary\n\nConcurrent evidence.',
                createdAt: 55,
                id: 'artifact-concurrent',
                kind: ExecutionArtifactKind.EXECUTION_SUMMARY,
                taskId: pending.taskId,
              }),
            );
          } else {
            await persistence.qualityGateRuns.insert(
              startQualityGateRun({
                gate: createQualityGate({
                  command: { arguments: ['lint'], executablePath: 'C:\\node.exe' },
                  id: 'lint',
                  kind: QualityGateKind.LINT,
                  timeoutMs: 1_000,
                }),
                id: 'gate-run-concurrent',
                startedAt: 55,
                taskId: pending.taskId,
                worktree: {
                  baseCommitId,
                  branchName: 'agentterm/task-1',
                  headCommitIdAtStart: headCommitId,
                  pathIdentity: worktreePathIdentity,
                  worktreePath: 'D:\\AgentTerm Worktrees\\task-1',
                },
              }),
            );
          }
          const runningTask = (await persistence.tasks.findById(pending.taskId))!;

          await expect(
            persistence.reviews.begin(
              pending,
              TaskPhase.RUNNING,
              transitionTask(runningTask, TaskPhase.REVIEW),
              noSessionRevisions,
            ),
          ).rejects.toBeInstanceOf(SqlitePersistenceError);
          await expect(persistence.reviews.listByTaskId(pending.taskId)).resolves.toEqual([]);
          await expect(persistence.tasks.findById(pending.taskId)).resolves.toEqual(runningTask);
        } finally {
          persistence.close();
        }
      });
    },
  );

  it('rejects evidence reordered away from immutable insertion history', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const pending = await seedReviewInputs(databasePath);
      const persistence = openSqlitePersistence(databasePath);
      try {
        const concurrent = createExecutionArtifact({
          content: '# Execution Summary\n\nSecond evidence.',
          createdAt: 45,
          id: 'artifact-second',
          kind: ExecutionArtifactKind.EXECUTION_SUMMARY,
          taskId: pending.taskId,
        });
        await persistence.artifacts.insert(concurrent);
        const reordered = startTaskReview({
          artifacts: [
            {
              createdAt: concurrent.createdAt,
              id: concurrent.id,
              kind: concurrent.kind,
              phase: concurrent.phase,
              sessionId: concurrent.sessionId,
            },
            ...pending.artifacts,
          ],
          codeState: pending.codeState,
          id: 'review-reordered',
          qualityGates: pending.qualityGates,
          requestedAt: pending.requestedAt,
          taskId: pending.taskId,
        });
        const runningTask = (await persistence.tasks.findById(pending.taskId))!;

        await expect(
          persistence.reviews.begin(
            reordered,
            TaskPhase.RUNNING,
            transitionTask(runningTask, TaskPhase.REVIEW),
            noSessionRevisions,
          ),
        ).rejects.toBeInstanceOf(SqlitePersistenceError);
        await expect(persistence.reviews.listByTaskId(pending.taskId)).resolves.toEqual([]);
        await expect(persistence.tasks.findById(pending.taskId)).resolves.toEqual(runningTask);
      } finally {
        persistence.close();
      }
    });
  });

  it('blocks review creation while an active Session exists without changing either history', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const pending = await seedReviewInputs(databasePath);
      const persistence = openSqlitePersistence(databasePath);
      try {
        const session = createAgentSession({
          agentId: 'codex',
          createdAt: 45,
          id: 'session-active',
          taskId: pending.taskId,
        });
        await persistence.sessions.insert(session);

        await expect(
          persistence.reviews.begin(
            pending,
            TaskPhase.RUNNING,
            transitionTask((await persistence.tasks.findById(pending.taskId))!, TaskPhase.REVIEW),
            noSessionRevisions,
          ),
        ).rejects.toBeInstanceOf(SqlitePersistenceError);
        await expect(persistence.reviews.listByTaskId(pending.taskId)).resolves.toEqual([]);
        await expect(persistence.sessions.findById(session.id)).resolves.toEqual(session);
        await expect(persistence.tasks.findById(pending.taskId)).resolves.toMatchObject({
          phase: TaskPhase.RUNNING,
        });
      } finally {
        persistence.close();
      }
    });
  });

  it('blocks a runtime-failed Session until durable process-exit evidence arrives', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const pending = await seedReviewInputs(databasePath);
      const persistence = openSqlitePersistence(databasePath);
      try {
        const starting = createAgentSession({
          agentId: 'codex',
          createdAt: 41,
          id: 'session-runtime-failed',
          taskId: pending.taskId,
        });
        const working = recordAgentSessionEvent(starting, {
          kind: 'STATUS_REPORTED',
          occurredAt: 42,
          runtimeSequence: 1,
          source: 'RUNTIME',
          status: 'WORKING',
        });
        const failed = recordAgentSessionEvent(working, {
          code: 'RUNTIME_FAILURE',
          fatal: true,
          kind: 'RUNTIME_FAILED',
          occurredAt: 43,
          runtimeSequence: 2,
          stage: 'RUNTIME',
        });
        await persistence.sessions.insert(starting);
        await persistence.sessions.append(working, 1);
        await persistence.sessions.append(failed, 2);
        const reviewTask = transitionTask(
          (await persistence.tasks.findById(pending.taskId))!,
          TaskPhase.REVIEW,
        );

        await expect(
          persistence.reviews.begin(pending, TaskPhase.RUNNING, reviewTask, [
            { historySequence: failed.history.length, id: failed.id },
          ]),
        ).rejects.toBeInstanceOf(SqlitePersistenceError);

        const exited = recordAgentSessionEvent(failed, {
          exitCode: 1,
          kind: 'PROCESS_EXITED',
          occurredAt: 44,
          reason: 'PROCESS_EXIT',
          runtimeSequence: 3,
        });
        await persistence.sessions.append(exited, 3);
        await expect(
          persistence.reviews.begin(pending, TaskPhase.RUNNING, reviewTask, [
            { historySequence: exited.history.length, id: exited.id },
          ]),
        ).resolves.toBeUndefined();
      } finally {
        persistence.close();
      }
    });
  });

  it('rejects a Session attempt that started and exited after Review context capture', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const pending = await seedReviewInputs(databasePath);
      const persistence = openSqlitePersistence(databasePath);
      try {
        const session = createAgentSession({
          agentId: 'codex',
          createdAt: 41,
          id: 'session-fast-writer',
          taskId: pending.taskId,
        });
        await persistence.sessions.insert(session);
        await persistence.sessions.append(
          recordAgentSessionEvent(session, {
            exitCode: 0,
            kind: 'PROCESS_EXITED',
            occurredAt: 42,
            reason: 'PROCESS_EXIT',
            runtimeSequence: 1,
          }),
          1,
        );
        const reviewTask = transitionTask(
          (await persistence.tasks.findById(pending.taskId))!,
          TaskPhase.REVIEW,
        );

        await expect(
          persistence.reviews.begin(pending, TaskPhase.RUNNING, reviewTask, []),
        ).rejects.toBeInstanceOf(SqlitePersistenceError);
        await expect(persistence.reviews.listByTaskId(pending.taskId)).resolves.toEqual([]);
        await expect(persistence.tasks.findById(pending.taskId)).resolves.toMatchObject({
          phase: TaskPhase.RUNNING,
        });
      } finally {
        persistence.close();
      }
    });
  });

  it('accepts a failed Session when restart reconciliation recorded ownership loss', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const pending = await seedReviewInputs(databasePath);
      const persistence = openSqlitePersistence(databasePath);
      try {
        const starting = createAgentSession({
          agentId: 'codex',
          createdAt: 41,
          id: 'session-runtime-ownership-lost',
          taskId: pending.taskId,
        });
        const failed = recordAgentSessionEvent(starting, {
          code: 'RUNTIME_OWNERSHIP_LOST',
          fatal: true,
          kind: 'RUNTIME_FAILED',
          occurredAt: 42,
          runtimeSequence: 1,
          stage: 'RUNTIME',
        });
        await persistence.sessions.insert(starting);
        await persistence.sessions.append(failed, 1);
        const reviewTask = transitionTask(
          (await persistence.tasks.findById(pending.taskId))!,
          TaskPhase.REVIEW,
        );

        await expect(
          persistence.reviews.begin(pending, TaskPhase.RUNNING, reviewTask, [
            { historySequence: failed.history.length, id: failed.id },
          ]),
        ).resolves.toBeUndefined();
      } finally {
        persistence.close();
      }
    });
  });

  it('blocks Review admission while a Quality Gate process is still represented as RUNNING', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const pending = await seedReviewInputs(databasePath);
      const persistence = openSqlitePersistence(databasePath);
      try {
        const secondGate = startQualityGateRun({
          gate: createQualityGate({
            command: { arguments: ['lint'], executablePath: 'C:\\node.exe' },
            id: 'lint',
            kind: QualityGateKind.LINT,
            timeoutMs: 1_000,
          }),
          id: 'gate-run-active',
          startedAt: 45,
          taskId: pending.taskId,
          worktree: {
            baseCommitId,
            branchName: pending.codeState.branchName,
            headCommitIdAtStart: headCommitId,
            pathIdentity: worktreePathIdentity,
            worktreePath: 'D:\\AgentTerm Worktrees\\task-1',
          },
        });
        await persistence.qualityGateRuns.insert(secondGate);
        const withRunningGate = startTaskReview({
          artifacts: pending.artifacts,
          codeState: pending.codeState,
          id: pending.id,
          qualityGates: [
            ...pending.qualityGates,
            {
              association: 'HEAD_MATCH_ONLY',
              baseCommitId,
              branchName: pending.codeState.branchName,
              finishedAt: undefined,
              gateId: secondGate.gate.id,
              headCommitIdAtStart: headCommitId,
              id: secondGate.id,
              kind: secondGate.gate.kind,
              observedStatus: secondGate.status,
              startedAt: secondGate.startedAt,
              worktreePathIdentity,
            },
          ],
          requestedAt: pending.requestedAt,
          taskId: pending.taskId,
        });

        await expect(
          persistence.reviews.begin(
            withRunningGate,
            TaskPhase.RUNNING,
            transitionTask((await persistence.tasks.findById(pending.taskId))!, TaskPhase.REVIEW),
            noSessionRevisions,
          ),
        ).rejects.toBeInstanceOf(SqlitePersistenceError);
        await expect(persistence.reviews.listByTaskId(pending.taskId)).resolves.toEqual([]);
        await expect(persistence.tasks.findById(pending.taskId)).resolves.toMatchObject({
          phase: TaskPhase.RUNNING,
        });
      } finally {
        persistence.close();
      }
    });
  });

  it('rolls back when the persisted primary Worktree no longer matches the code snapshot', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const pending = await seedReviewInputs(databasePath);
      const persistence = openSqlitePersistence(databasePath);
      try {
        await persistence.worktrees.transitionState(pending.taskId, 'PRESENT', 'REMOVING');
        const runningTask = (await persistence.tasks.findById(pending.taskId))!;

        await expect(
          persistence.reviews.begin(
            pending,
            TaskPhase.RUNNING,
            transitionTask(runningTask, TaskPhase.REVIEW),
            noSessionRevisions,
          ),
        ).rejects.toBeInstanceOf(SqlitePersistenceError);
        await expect(persistence.reviews.listByTaskId(pending.taskId)).resolves.toEqual([]);
        await expect(persistence.tasks.findById(pending.taskId)).resolves.toEqual(runningTask);
      } finally {
        persistence.close();
      }
    });
  });

  it('rejects a new active Session once the Task has atomically entered REVIEW', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const pending = await seedReviewInputs(databasePath);
      const persistence = openSqlitePersistence(databasePath);
      try {
        await persistence.reviews.begin(
          pending,
          TaskPhase.RUNNING,
          transitionTask((await persistence.tasks.findById(pending.taskId))!, TaskPhase.REVIEW),
          noSessionRevisions,
        );

        await expect(
          persistence.sessions.insert(
            createAgentSession({
              agentId: 'codex',
              createdAt: 55,
              id: 'late-session',
              taskId: pending.taskId,
            }),
          ),
        ).rejects.toBeInstanceOf(SqlitePersistenceError);
        await expect(persistence.sessions.findById('late-session')).resolves.toBeUndefined();
        await expect(persistence.tasks.findById(pending.taskId)).resolves.toMatchObject({
          phase: TaskPhase.REVIEW,
        });
      } finally {
        persistence.close();
      }
    });
  });

  it('makes an exact decision retry idempotent and rejects conflicting concurrent evidence', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const pending = await seedReviewInputs(databasePath);
      const firstConnection = openSqlitePersistence(databasePath);
      const secondConnection = openSqlitePersistence(databasePath);
      try {
        const runningTask = (await firstConnection.tasks.findById(pending.taskId))!;
        const reviewTask = transitionTask(runningTask, TaskPhase.REVIEW);
        await firstConnection.reviews.begin(
          pending,
          TaskPhase.RUNNING,
          reviewTask,
          noSessionRevisions,
        );
        const approved = terminalReview(pending, 'APPROVED', 60);
        const doneTask = taskWithPhase(reviewTask, TaskPhase.DONE);
        const conflicting = terminalReview(pending, 'CHANGES_REQUESTED', 61);

        const results = await Promise.allSettled([
          firstConnection.reviews.decide(approved, 'PENDING', TaskPhase.REVIEW, doneTask),
          secondConnection.reviews.decide(
            conflicting,
            'PENDING',
            TaskPhase.REVIEW,
            taskWithPhase(reviewTask, TaskPhase.RUNNING),
          ),
        ]);

        expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
        await expect(
          firstConnection.reviews.decide(approved, 'PENDING', TaskPhase.REVIEW, doneTask),
        ).resolves.toBeUndefined();
        await expect(firstConnection.reviews.findById(pending.id)).resolves.toEqual(approved);
        await expect(firstConnection.tasks.findById(pending.taskId)).resolves.toEqual(doneTask);
      } finally {
        secondConnection.close();
        firstConnection.close();
      }
    });
  });
});
