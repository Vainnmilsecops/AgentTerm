import { AgentSessionStatus, TaskPhase, type AgentSession, type Task } from '@agentterm/domain';

import { describe, expect, it } from 'vitest';

import { EntityNotFoundError, SendMergeConflictResolutionPromptError } from './errors';
import type {
  AgentSessionRepository,
  MergeConflictFile,
  MergeConflictProbe,
  ProbeTaskMergeConflictsInput,
  TaskMergeConflictProbe,
  TaskRepository,
  TaskWorktree,
  TaskWorktreeLifecycleState,
  TaskWorktreeRecord,
  TaskWorktreeRepository,
} from './ports';
import {
  checkTaskMergeConflicts,
  sendMergeConflictResolutionTaskPrompt,
  type CheckTaskMergeConflictsDependencies,
  type SendMergeConflictResolutionDependencies,
} from './task-merge-conflict-use-cases';

const reviewTask: Task = {
  brief: 'Review flow',
  id: 'task-review',
  phase: TaskPhase.REVIEW,
  projectId: 'project-1',
  title: 'Review',
};

const runningTask: Task = {
  brief: 'Running flow',
  id: 'task-running',
  phase: TaskPhase.RUNNING,
  projectId: 'project-1',
  title: 'Running',
};

const worktreeBase: TaskWorktree = {
  baseCommitId: 'base-commit',
  baseRefName: 'refs/heads/main',
  branchName: 'task-review',
  pathIdentity: 'task-review',
  repositoryRootPath: '/repos/repo',
  taskId: 'task-review',
  worktreePath: '/repos/worktree',
};

const worktreeRecord: TaskWorktreeRecord = {
  ...worktreeBase,
  lifecycleState: 'PRESENT' satisfies TaskWorktreeLifecycleState,
};

class InMemoryTaskRepository implements TaskRepository {
  private readonly byId = new Map<string, Task>([['task-review', reviewTask]]);

  public async findById(id: string): Promise<Task | undefined> {
    return this.byId.get(id);
  }

  public async insert(): Promise<void> {}

  public async update(): Promise<void> {}
}

class InMemoryWorktreeRepository implements TaskWorktreeRepository {
  public nextRecord: TaskWorktreeRecord | undefined = worktreeRecord;

  public async findByTaskId(): Promise<TaskWorktreeRecord | undefined> {
    return this.nextRecord;
  }

  public async insertReservation(): Promise<TaskWorktreeRecord> {
    throw new Error('Worktree reservation not expected in merge-conflict tests.');
  }

  public async transitionState(): Promise<TaskWorktreeRecord> {
    throw new Error('Worktree transition not expected in merge-conflict tests.');
  }
}

class InMemorySessionRepository implements AgentSessionRepository {
  public readonly sessions = new Map<string, AgentSession>();

  public async findById(): Promise<AgentSession | undefined> {
    return undefined;
  }

  public async insert(): Promise<void> {}

  public async append(): Promise<void> {}

  public async updateOwnership(): Promise<void> {}

  public async listActive(): Promise<readonly AgentSession[]> {
    return [];
  }

  public async listByTaskId(taskId: string): Promise<readonly AgentSession[]> {
    return Object.freeze([...this.sessions.values()].filter((entry) => entry.taskId === taskId));
  }
}

class FakeProbe implements TaskMergeConflictProbe {
  public lastInput: ProbeTaskMergeConflictsInput | undefined;
  public nextResult: MergeConflictProbe;

  public constructor(nextResult: MergeConflictProbe) {
    this.nextResult = nextResult;
  }

  public async probeMergeConflicts(
    input: ProbeTaskMergeConflictsInput,
  ): Promise<MergeConflictProbe> {
    this.lastInput = input;
    return this.nextResult;
  }
}

function makeProbeDeps(probe: TaskMergeConflictProbe): CheckTaskMergeConflictsDependencies {
  return {
    git: probe,
    tasks: new InMemoryTaskRepository(),
    worktrees: new InMemoryWorktreeRepository(),
  };
}

function makeSessionRepo(entries: ReadonlyMap<string, AgentSessionStatus>): AgentSessionRepository {
  const repo = new InMemorySessionRepository();
  for (const [sessionId, status] of entries.entries()) {
    const session: AgentSession = {
      agentId: 'codex',
      createdAt: 0,
      endedAt: undefined,
      history: Object.freeze([]),
      hostOwnership: undefined,
      id: sessionId,
      providerSessionId: undefined,
      status,
      taskId: reviewTask.id,
    };
    repo.sessions.set(sessionId, session);
  }
  return repo;
}

const sessionDeps = (
  sessions: AgentSessionRepository,
): SendMergeConflictResolutionDependencies => ({
  sessions,
  tasks: new InMemoryTaskRepository(),
});

describe('checkTaskMergeConflicts', () => {
  it('returns TASK_NOT_FOUND when the Task no longer exists', async () => {
    const probe = new FakeProbe({ kind: 'unavailable', reason: 'GIT_INSPECTION_FAILED' });
    const result = await checkTaskMergeConflicts({ taskId: 'missing' }, makeProbeDeps(probe));
    expect(result.kind).toBe('unavailable');
    if (result.kind !== 'unavailable') return;
    expect(result.reason).toBe('TASK_NOT_FOUND');
  });

  it('returns WORKTREE_NOT_READY when the Worktree is not persisted', async () => {
    const probe = new FakeProbe({ kind: 'unavailable', reason: 'GIT_INSPECTION_FAILED' });
    const worktrees = new InMemoryWorktreeRepository();
    worktrees.nextRecord = undefined;
    const result = await checkTaskMergeConflicts(
      { taskId: reviewTask.id },
      { git: probe, tasks: new InMemoryTaskRepository(), worktrees },
    );
    expect(result.kind).toBe('unavailable');
    if (result.kind !== 'unavailable') return;
    expect(result.reason).toBe('WORKTREE_NOT_READY');
  });

  it('returns a clean probe verbatim', async () => {
    const probe = new FakeProbe({
      baseRef: 'refs/heads/main',
      headRef: 'HEAD',
      kind: 'clean',
    });
    const result = await checkTaskMergeConflicts({ taskId: 'task-review' }, makeProbeDeps(probe));
    expect(result.kind).toBe('clean');
    expect(probe.lastInput?.baseRef).toBe('refs/heads/main');
    expect(probe.lastInput?.headRef).toBe('HEAD');
  });

  it('returns a conflicts probe with the parsed files', async () => {
    const files: readonly MergeConflictFile[] = Object.freeze([
      Object.freeze({ hunks: Object.freeze(['+line-a']), path: 'src/a.ts' }),
    ]);
    const probe = new FakeProbe({
      baseRef: 'refs/heads/main',
      files,
      headRef: 'HEAD',
      kind: 'conflicts',
    });
    const result = await checkTaskMergeConflicts({ taskId: 'task-review' }, makeProbeDeps(probe));
    expect(result.kind).toBe('conflicts');
    if (result.kind !== 'conflicts') return;
    expect(result.conflicts.map((file) => file.path)).toEqual(['src/a.ts']);
  });

  it('surfaces the Git unavailable reason verbatim', async () => {
    const probe = new FakeProbe({ kind: 'unavailable', reason: 'NO_BASE_REF' });
    const result = await checkTaskMergeConflicts({ taskId: 'task-review' }, makeProbeDeps(probe));
    expect(result.kind).toBe('unavailable');
    if (result.kind !== 'unavailable') return;
    expect(result.reason).toBe('NO_BASE_REF');
  });
});

describe('sendMergeConflictResolutionTaskPrompt', () => {
  it('throws EntityNotFoundError when the Task has been removed', async () => {
    const deps = sessionDeps(makeSessionRepo(new Map()));
    await expect(
      sendMergeConflictResolutionTaskPrompt({ sessionId: 'sess-1', taskId: 'missing' }, deps),
    ).rejects.toBeInstanceOf(EntityNotFoundError);
  });

  it('refuses a Task that is not in REVIEW', async () => {
    const deps: SendMergeConflictResolutionDependencies = {
      sessions: makeSessionRepo(new Map([['sess-1', AgentSessionStatus.IDLE]])),
      tasks: {
        findById: async (id: string): Promise<Task | undefined> =>
          id === runningTask.id ? runningTask : undefined,
        insert: async () => undefined,
        update: async () => undefined,
      },
    };
    await expect(
      sendMergeConflictResolutionTaskPrompt({ sessionId: 'sess-1', taskId: runningTask.id }, deps),
    ).rejects.toBeInstanceOf(SendMergeConflictResolutionPromptError);
  });

  it('refuses when the active Session is WORKING', async () => {
    const deps = sessionDeps(makeSessionRepo(new Map([['sess-1', AgentSessionStatus.WORKING]])));
    await expect(
      sendMergeConflictResolutionTaskPrompt({ sessionId: 'sess-1', taskId: reviewTask.id }, deps),
    ).rejects.toBeInstanceOf(SendMergeConflictResolutionPromptError);
  });

  it('returns the slash-command bytes when the Task + Session are eligible', async () => {
    const deps = sessionDeps(makeSessionRepo(new Map([['sess-1', AgentSessionStatus.IDLE]])));
    const result = await sendMergeConflictResolutionTaskPrompt(
      { sessionId: 'sess-1', taskId: reviewTask.id },
      deps,
    );
    expect(result.bytes).toBe('/agtx:merge-conflicts\r');
    expect(result.sessionId).toBe('sess-1');
    expect(result.taskId).toBe(reviewTask.id);
  });

  it('also accepts WAITING_INPUT sessions', async () => {
    const deps = sessionDeps(
      makeSessionRepo(new Map([['sess-1', AgentSessionStatus.WAITING_INPUT]])),
    );
    const result = await sendMergeConflictResolutionTaskPrompt(
      { sessionId: 'sess-1', taskId: reviewTask.id },
      deps,
    );
    expect(result.bytes).toBe('/agtx:merge-conflicts\r');
  });

  it('refuses when the active session id does not match the persisted one', async () => {
    const deps = sessionDeps(makeSessionRepo(new Map([['sess-other', AgentSessionStatus.IDLE]])));
    await expect(
      sendMergeConflictResolutionTaskPrompt({ sessionId: 'sess-1', taskId: reviewTask.id }, deps),
    ).rejects.toBeInstanceOf(SendMergeConflictResolutionPromptError);
  });
});
