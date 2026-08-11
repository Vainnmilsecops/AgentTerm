import { describe, expect, it } from 'vitest';

import { TaskPhase, type Task } from '@agentterm/domain';

import {
  cleanupTaskWorktree,
  ensureTaskWorktree,
  inspectTaskWorktree,
  type GitTaskWorktreeLifecycle,
  type LocalProject,
  type LocalProjectLocator,
  type TaskRepository,
  type TaskWorktree,
  type TaskWorktreeRecord,
  type TaskWorktreeRepository,
} from './index';

type WorktreeLifecycleState = TaskWorktreeRecord['lifecycleState'];

interface WorktreeStatus {
  readonly conflictedPaths: readonly string[];
  readonly ignoredPaths: readonly string[];
  readonly isDirty: boolean;
  readonly stagedPaths: readonly string[];
  readonly unstagedPaths: readonly string[];
  readonly untrackedPaths: readonly string[];
}

class InMemoryTaskRepository implements TaskRepository {
  private readonly tasks = new Map<string, Task>();

  public constructor(tasks: readonly Task[] = []) {
    for (const task of tasks) {
      this.tasks.set(task.id, task);
    }
  }

  public async findById(id: string): Promise<Task | undefined> {
    return this.tasks.get(id);
  }

  public async insert(task: Task): Promise<void> {
    if (this.tasks.has(task.id)) {
      throw new Error(`Task ${task.id} already exists in the fake repository.`);
    }

    this.tasks.set(task.id, task);
  }

  public async update(task: Task): Promise<void> {
    if (!this.tasks.has(task.id)) {
      throw new Error(`Task ${task.id} is missing from the fake repository.`);
    }

    this.tasks.set(task.id, task);
  }
}

class InMemoryLocalProjectLocator implements LocalProjectLocator {
  private readonly projects = new Map<string, LocalProject>();

  public constructor(projects: readonly LocalProject[] = []) {
    for (const project of projects) {
      this.projects.set(project.id, project);
    }
  }

  public async findLocalById(id: string): Promise<LocalProject | undefined> {
    return this.projects.get(id);
  }
}

class InMemoryTaskWorktreeRepository implements TaskWorktreeRepository {
  private record: TaskWorktreeRecord | undefined;
  private rejectedTransition:
    | {
        readonly expectedState: WorktreeLifecycleState;
        readonly nextState: WorktreeLifecycleState;
      }
    | undefined;

  public constructor(
    record: TaskWorktreeRecord | undefined = undefined,
    private readonly events: string[] | undefined = undefined,
  ) {
    this.record = record;
  }

  public async findByTaskId(taskId: string): Promise<TaskWorktreeRecord | undefined> {
    return this.record?.taskId === taskId ? this.record : undefined;
  }

  public async insertReservation(worktree: TaskWorktree): Promise<TaskWorktreeRecord> {
    if (this.record !== undefined) {
      throw new Error(`Task ${worktree.taskId} already has a primary Worktree.`);
    }

    this.record = Object.freeze({ ...worktree, lifecycleState: 'PROVISIONING' });
    this.events?.push('persistence:PROVISIONING');
    return this.record;
  }

  public async transitionState(
    taskId: string,
    expectedState: WorktreeLifecycleState,
    nextState: WorktreeLifecycleState,
  ): Promise<TaskWorktreeRecord> {
    if (this.record?.taskId !== taskId || this.record.lifecycleState !== expectedState) {
      throw new Error(
        `Cannot transition Task ${taskId} Worktree from ${expectedState} to ${nextState}.`,
      );
    }

    if (
      this.rejectedTransition?.expectedState === expectedState &&
      this.rejectedTransition.nextState === nextState
    ) {
      throw new Error('Simulated Worktree persistence failure.');
    }

    this.record = Object.freeze({ ...this.record, lifecycleState: nextState });
    this.events?.push(`persistence:${expectedState}->${nextState}`);
    return this.record;
  }

  public rejectTransition(
    expectedState: WorktreeLifecycleState,
    nextState: WorktreeLifecycleState,
  ): void {
    this.rejectedTransition = { expectedState, nextState };
  }
}

interface GitLifecycleOptions {
  readonly allowCleanup?: boolean;
  readonly allowEnsure?: boolean;
  readonly allowInspect?: boolean;
  readonly beforeInspect?: () => Promise<void>;
  readonly events?: string[];
  readonly expectedRecordedWorktree?: TaskWorktree;
  readonly present: boolean;
  readonly status?: WorktreeStatus;
}

class InMemoryGitTaskWorktreeLifecycle implements GitTaskWorktreeLifecycle {
  private readonly allowCleanup: boolean;
  private readonly allowEnsure: boolean;
  private readonly allowInspect: boolean;
  private readonly beforeInspect: (() => Promise<void>) | undefined;
  private readonly events: string[] | undefined;
  private readonly expectedRecordedWorktree: TaskWorktree | undefined;
  private present: boolean;
  private readonly status: WorktreeStatus;

  public constructor(
    private readonly worktree: TaskWorktree,
    options: GitLifecycleOptions,
  ) {
    this.allowCleanup = options.allowCleanup ?? true;
    this.allowEnsure = options.allowEnsure ?? true;
    this.allowInspect = options.allowInspect ?? true;
    this.beforeInspect = options.beforeInspect;
    this.events = options.events;
    this.expectedRecordedWorktree = options.expectedRecordedWorktree;
    this.present = options.present;
    this.status = options.status ?? cleanStatus;
  }

  public async inspect(
    input: Parameters<GitTaskWorktreeLifecycle['inspect']>[0],
  ): Promise<Awaited<ReturnType<GitTaskWorktreeLifecycle['inspect']>>> {
    if (!this.allowInspect) {
      throw new Error('Git inspection must not be reached in this scenario.');
    }

    await this.beforeInspect?.();

    if (
      input.taskId !== this.worktree.taskId ||
      input.repositoryRootPath !== this.worktree.repositoryRootPath
    ) {
      throw new Error('Git inspection received the wrong Task or repository root.');
    }

    if (this.expectedRecordedWorktree === undefined) {
      if (input.recordedWorktree !== undefined) {
        throw new Error('Git inspection received unexpected persisted Worktree metadata.');
      }
    } else {
      if (input.recordedWorktree === undefined) {
        throw new Error('Git inspection did not receive persisted Worktree metadata.');
      }

      assertSameWorktree(input.recordedWorktree, this.expectedRecordedWorktree);
    }

    if (!this.present) {
      return { kind: 'missing', worktree: this.worktree };
    }

    return { kind: 'present', status: this.status, worktree: this.worktree };
  }

  public async ensure(
    worktree: TaskWorktree,
  ): Promise<Awaited<ReturnType<GitTaskWorktreeLifecycle['ensure']>>> {
    if (!this.allowEnsure) {
      throw new Error('Git Worktree creation must not be reached in this scenario.');
    }

    assertSameWorktree(worktree, this.worktree);
    const kind = this.present ? 'reused' : 'created';
    this.present = true;
    this.events?.push('git:ensure');
    return { kind, status: this.status, worktree: this.worktree };
  }

  public async cleanup(
    worktree: TaskWorktree,
  ): Promise<Awaited<ReturnType<GitTaskWorktreeLifecycle['cleanup']>>> {
    if (!this.allowCleanup) {
      throw new Error('Git Worktree cleanup must not be reached in this scenario.');
    }

    assertSameWorktree(worktree, this.worktree);
    const kind = this.present ? 'removed' : 'already-missing';
    this.present = false;
    this.events?.push('git:cleanup');
    return { kind, worktree: this.worktree };
  }
}

const task: Task = Object.freeze({
  id: 'task-1',
  phase: TaskPhase.RUNNING,
  projectId: 'project-1',
  title: 'Implement Git Worktree lifecycle',
});

const localProject: LocalProject = Object.freeze({
  id: task.projectId,
  name: 'AgentTerm',
  rootPath: 'D:\\Core\\AgentTerm',
});

const worktree: TaskWorktree = Object.freeze({
  baseCommitId: '0123456789abcdef0123456789abcdef01234567',
  baseRefName: 'refs/heads/main',
  branchName: 'agentterm/task-1-9b55c0cf',
  pathIdentity: 'win32:d:\\core\\agentterm-worktrees\\task-1-9b55c0cf',
  repositoryRootPath: localProject.rootPath,
  taskId: task.id,
  worktreePath: 'D:\\Core\\AgentTerm-worktrees\\task-1-9b55c0cf',
});

const cleanStatus: WorktreeStatus = Object.freeze({
  conflictedPaths: [],
  ignoredPaths: [],
  isDirty: false,
  stagedPaths: [],
  unstagedPaths: [],
  untrackedPaths: [],
});

function worktreeRecord(lifecycleState: WorktreeLifecycleState): TaskWorktreeRecord {
  return Object.freeze({ ...worktree, lifecycleState });
}

function dependencies(record?: TaskWorktreeRecord): {
  readonly localProjects: InMemoryLocalProjectLocator;
  readonly tasks: InMemoryTaskRepository;
  readonly worktrees: InMemoryTaskWorktreeRepository;
} {
  return {
    localProjects: new InMemoryLocalProjectLocator([localProject]),
    tasks: new InMemoryTaskRepository([task]),
    worktrees: new InMemoryTaskWorktreeRepository(record),
  };
}

function unreachableGit(): InMemoryGitTaskWorktreeLifecycle {
  return new InMemoryGitTaskWorktreeLifecycle(worktree, {
    allowCleanup: false,
    allowEnsure: false,
    allowInspect: false,
    present: false,
  });
}

function assertSameWorktree(actual: TaskWorktree, expected: TaskWorktree): void {
  const fields = [
    'baseCommitId',
    'baseRefName',
    'branchName',
    'pathIdentity',
    'repositoryRootPath',
    'taskId',
    'worktreePath',
  ] as const;

  for (const field of fields) {
    if (actual[field] !== expected[field]) {
      throw new Error(`Git lifecycle received mismatched Worktree field ${field}.`);
    }
  }
}

describe('ensureTaskWorktree', () => {
  it('rejects a missing Task before invoking Git', async () => {
    const tasks = new InMemoryTaskRepository();
    const localProjects = new InMemoryLocalProjectLocator([localProject]);
    const worktrees = new InMemoryTaskWorktreeRepository();

    const result = ensureTaskWorktree(
      { taskId: task.id },
      tasks,
      localProjects,
      worktrees,
      unreachableGit(),
    );

    await expect(result).rejects.toMatchObject({
      entity: 'Task',
      id: task.id,
      name: 'EntityNotFoundError',
    });
    await expect(worktrees.findByTaskId(task.id)).resolves.toBeUndefined();
  });

  it('rejects a Task without a local Project before invoking Git', async () => {
    const tasks = new InMemoryTaskRepository([task]);
    const localProjects = new InMemoryLocalProjectLocator();
    const worktrees = new InMemoryTaskWorktreeRepository();

    const result = ensureTaskWorktree(
      { taskId: task.id },
      tasks,
      localProjects,
      worktrees,
      unreachableGit(),
    );

    await expect(result).rejects.toMatchObject({
      name: 'TaskWorktreeLifecycleError',
      reason: 'PROJECT_NOT_LOCAL',
    });
    await expect(worktrees.findByTaskId(task.id)).resolves.toBeUndefined();
  });

  it('persists a reservation before Git creation and finalizes it as PRESENT', async () => {
    const events: string[] = [];
    const tasks = new InMemoryTaskRepository([task]);
    const localProjects = new InMemoryLocalProjectLocator([localProject]);
    const worktrees = new InMemoryTaskWorktreeRepository(undefined, events);
    const git = new InMemoryGitTaskWorktreeLifecycle(worktree, {
      events,
      present: false,
    });

    const result = await ensureTaskWorktree(
      { taskId: task.id },
      tasks,
      localProjects,
      worktrees,
      git,
    );

    expect(result).toEqual({ kind: 'created', status: cleanStatus, worktree });
    await expect(worktrees.findByTaskId(task.id)).resolves.toEqual(worktreeRecord('PRESENT'));
    expect(events).toEqual([
      'persistence:PROVISIONING',
      'git:ensure',
      'persistence:PROVISIONING->PRESENT',
    ]);
  });

  it('reuses an exactly matching PRESENT Worktree without creating another', async () => {
    const persisted = worktreeRecord('PRESENT');
    const { localProjects, tasks, worktrees } = dependencies(persisted);
    const git = new InMemoryGitTaskWorktreeLifecycle(worktree, {
      allowEnsure: false,
      expectedRecordedWorktree: persisted,
      present: true,
    });

    const result = await ensureTaskWorktree(
      { taskId: task.id },
      tasks,
      localProjects,
      worktrees,
      git,
    );

    expect(result).toEqual({ kind: 'reused', status: cleanStatus, worktree });
    await expect(worktrees.findByTaskId(task.id)).resolves.toEqual(persisted);
  });

  it('reconciles a PROVISIONING record when its exact Worktree is already present', async () => {
    const events: string[] = [];
    const persisted = worktreeRecord('PROVISIONING');
    const tasks = new InMemoryTaskRepository([task]);
    const localProjects = new InMemoryLocalProjectLocator([localProject]);
    const worktrees = new InMemoryTaskWorktreeRepository(persisted, events);
    const git = new InMemoryGitTaskWorktreeLifecycle(worktree, {
      allowEnsure: false,
      expectedRecordedWorktree: persisted,
      present: true,
    });

    const result = await ensureTaskWorktree(
      { taskId: task.id },
      tasks,
      localProjects,
      worktrees,
      git,
    );

    expect(result).toEqual({ kind: 'reused', status: cleanStatus, worktree });
    await expect(worktrees.findByTaskId(task.id)).resolves.toEqual(worktreeRecord('PRESENT'));
    expect(events).toEqual(['persistence:PROVISIONING->PRESENT']);
  });

  it('reports a PRESENT Git state when final persistence fails after creation', async () => {
    const events: string[] = [];
    const tasks = new InMemoryTaskRepository([task]);
    const localProjects = new InMemoryLocalProjectLocator([localProject]);
    const worktrees = new InMemoryTaskWorktreeRepository(undefined, events);
    worktrees.rejectTransition('PROVISIONING', 'PRESENT');
    const git = new InMemoryGitTaskWorktreeLifecycle(worktree, {
      events,
      present: false,
    });

    const result = ensureTaskWorktree({ taskId: task.id }, tasks, localProjects, worktrees, git);

    await expect(result).rejects.toMatchObject({
      gitState: 'PRESENT',
      name: 'TaskWorktreePersistenceError',
    });
    await expect(worktrees.findByTaskId(task.id)).resolves.toEqual(worktreeRecord('PROVISIONING'));
    await expect(
      git.inspect({ taskId: task.id, repositoryRootPath: localProject.rootPath }),
    ).resolves.toEqual({ kind: 'present', status: cleanStatus, worktree });
    expect(events).toEqual(['persistence:PROVISIONING', 'git:ensure']);
  });

  it('does not steal a REMOVING checkpoint from concurrent cleanup', async () => {
    const persisted = worktreeRecord('REMOVING');
    const { localProjects, tasks, worktrees } = dependencies(persisted);
    const git = new InMemoryGitTaskWorktreeLifecycle(worktree, {
      allowEnsure: false,
      expectedRecordedWorktree: persisted,
      present: true,
    });

    await expect(
      ensureTaskWorktree({ taskId: task.id }, tasks, localProjects, worktrees, git),
    ).rejects.toMatchObject({
      name: 'TaskWorktreeLifecycleError',
      reason: 'OPERATION_IN_PROGRESS',
    });
    await expect(worktrees.findByTaskId(task.id)).resolves.toEqual(persisted);
  });
});

describe('inspectTaskWorktree', () => {
  it('returns actual Git status together with the persisted lifecycle state', async () => {
    const persisted = worktreeRecord('PRESENT');
    const { localProjects, tasks, worktrees } = dependencies(persisted);
    const status: WorktreeStatus = {
      ...cleanStatus,
      ignoredPaths: ['.cache/'],
      isDirty: true,
      unstagedPaths: ['src/worktree.ts'],
    };
    const git = new InMemoryGitTaskWorktreeLifecycle(worktree, {
      expectedRecordedWorktree: persisted,
      present: true,
      status,
    });

    const result = await inspectTaskWorktree(
      { taskId: task.id },
      tasks,
      localProjects,
      worktrees,
      git,
    );

    expect(result).toEqual({
      actual: { kind: 'present', status, worktree },
      persistedState: 'PRESENT',
    });
  });
});

describe('cleanupTaskWorktree', () => {
  it('serializes ensure and cleanup for the same Task across their Git side effects', async () => {
    const events: string[] = [];
    const persisted = worktreeRecord('PRESENT');
    const tasks = new InMemoryTaskRepository([task]);
    const localProjects = new InMemoryLocalProjectLocator([localProject]);
    const worktrees = new InMemoryTaskWorktreeRepository(persisted, events);
    let releaseFirstInspection: (() => void) | undefined;
    let signalFirstInspection: (() => void) | undefined;
    const firstInspectionStarted = new Promise<void>((resolve) => {
      signalFirstInspection = resolve;
    });
    const firstInspectionGate = new Promise<void>((resolve) => {
      releaseFirstInspection = resolve;
    });
    let inspectionCount = 0;
    const git = new InMemoryGitTaskWorktreeLifecycle(worktree, {
      beforeInspect: async () => {
        inspectionCount += 1;

        if (inspectionCount === 1) {
          signalFirstInspection?.();
          await firstInspectionGate;
        }
      },
      events,
      expectedRecordedWorktree: persisted,
      present: true,
    });

    const ensuring = ensureTaskWorktree({ taskId: task.id }, tasks, localProjects, worktrees, git);
    await firstInspectionStarted;
    const cleaning = cleanupTaskWorktree({ taskId: task.id }, tasks, localProjects, worktrees, git);

    await Promise.resolve();
    expect(inspectionCount).toBe(1);
    releaseFirstInspection?.();

    await expect(ensuring).resolves.toMatchObject({ kind: 'reused' });
    await expect(cleaning).resolves.toMatchObject({ kind: 'removed' });
    expect(events).toEqual([
      'persistence:PRESENT->PROVISIONING',
      'persistence:PROVISIONING->PRESENT',
      'persistence:PRESENT->REMOVING',
      'git:cleanup',
      'persistence:REMOVING->REMOVED',
    ]);
  });

  it('refuses a dirty Worktree before checkpointing REMOVING or invoking cleanup', async () => {
    const events: string[] = [];
    const persisted = worktreeRecord('PRESENT');
    const tasks = new InMemoryTaskRepository([task]);
    const localProjects = new InMemoryLocalProjectLocator([localProject]);
    const worktrees = new InMemoryTaskWorktreeRepository(persisted, events);
    const dirtyStatus: WorktreeStatus = {
      ...cleanStatus,
      isDirty: true,
      untrackedPaths: ['notes.txt'],
    };
    const git = new InMemoryGitTaskWorktreeLifecycle(worktree, {
      allowCleanup: false,
      expectedRecordedWorktree: persisted,
      present: true,
      status: dirtyStatus,
    });

    const result = cleanupTaskWorktree({ taskId: task.id }, tasks, localProjects, worktrees, git);

    await expect(result).rejects.toMatchObject({
      name: 'TaskWorktreeLifecycleError',
      reason: 'DIRTY_WORKTREE',
    });
    await expect(worktrees.findByTaskId(task.id)).resolves.toEqual(persisted);
    expect(events).toEqual([]);
  });

  it('checkpoints REMOVING before Git cleanup and finalizes REMOVED afterward', async () => {
    const events: string[] = [];
    const persisted = worktreeRecord('PRESENT');
    const tasks = new InMemoryTaskRepository([task]);
    const localProjects = new InMemoryLocalProjectLocator([localProject]);
    const worktrees = new InMemoryTaskWorktreeRepository(persisted, events);
    const git = new InMemoryGitTaskWorktreeLifecycle(worktree, {
      events,
      expectedRecordedWorktree: persisted,
      present: true,
    });

    const result = await cleanupTaskWorktree(
      { taskId: task.id },
      tasks,
      localProjects,
      worktrees,
      git,
    );

    expect(result).toEqual({ kind: 'removed', worktree });
    await expect(worktrees.findByTaskId(task.id)).resolves.toEqual(worktreeRecord('REMOVED'));
    expect(events).toEqual([
      'persistence:PRESENT->REMOVING',
      'git:cleanup',
      'persistence:REMOVING->REMOVED',
    ]);
  });

  it('finalizes an absent REMOVING Worktree as REMOVED without another cleanup attempt', async () => {
    const events: string[] = [];
    const persisted = worktreeRecord('REMOVING');
    const tasks = new InMemoryTaskRepository([task]);
    const localProjects = new InMemoryLocalProjectLocator([localProject]);
    const worktrees = new InMemoryTaskWorktreeRepository(persisted, events);
    const git = new InMemoryGitTaskWorktreeLifecycle(worktree, {
      allowCleanup: false,
      expectedRecordedWorktree: persisted,
      present: false,
    });

    const result = await cleanupTaskWorktree(
      { taskId: task.id },
      tasks,
      localProjects,
      worktrees,
      git,
    );

    expect(result).toEqual({ kind: 'already-missing', worktree });
    await expect(worktrees.findByTaskId(task.id)).resolves.toEqual(worktreeRecord('REMOVED'));
    expect(events).toEqual(['persistence:REMOVING->REMOVED']);
  });

  it('does not steal a PROVISIONING checkpoint from concurrent ensure', async () => {
    const persisted = worktreeRecord('PROVISIONING');
    const { localProjects, tasks, worktrees } = dependencies(persisted);
    const git = new InMemoryGitTaskWorktreeLifecycle(worktree, {
      allowCleanup: false,
      expectedRecordedWorktree: persisted,
      present: true,
    });

    await expect(
      cleanupTaskWorktree({ taskId: task.id }, tasks, localProjects, worktrees, git),
    ).rejects.toMatchObject({
      name: 'TaskWorktreeLifecycleError',
      reason: 'OPERATION_IN_PROGRESS',
    });
    await expect(worktrees.findByTaskId(task.id)).resolves.toEqual(persisted);
  });
});
