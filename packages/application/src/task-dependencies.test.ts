import { describe, expect, it } from 'vitest';

import {
  TaskPhase,
  createTask,
  transitionTask,
  type Task,
  type TaskDependency,
} from '@agentterm/domain';

import {
  addTaskDependency,
  listTaskDependencies,
  readTaskDependencyState,
  removeTaskDependency,
  type TaskDependencyRepository,
  type TaskRepository,
} from './index';

const taskA = createTask({ id: 'task-a', projectId: 'project-1', title: 'Dependent task' });
const taskB = createTask({ id: 'task-b', projectId: 'project-1', title: 'Required task' });
const taskC = createTask({ id: 'task-c', projectId: 'project-1', title: 'Transitive task' });
const otherProjectTask = createTask({
  id: 'task-other',
  projectId: 'project-2',
  title: 'Other Project',
});

describe('Task Dependency use cases', () => {
  it('adds, lists, and removes a same-Project dependency without changing either Task', async () => {
    const tasks = new MemoryTasks([taskA, taskB]);
    const dependencies = new MemoryDependencies();

    const added = await addTaskDependency(
      { dependencyTaskId: taskB.id, taskId: taskA.id },
      tasks,
      dependencies,
    );

    expect(added).toEqual({ dependencyTaskId: 'task-b', taskId: 'task-a' });
    await expect(listTaskDependencies({ taskId: taskA.id }, tasks, dependencies)).resolves.toEqual([
      added,
    ]);
    await expect(
      removeTaskDependency({ dependencyTaskId: taskB.id, taskId: taskA.id }, tasks, dependencies),
    ).resolves.toBe(true);
    await expect(listTaskDependencies({ taskId: taskA.id }, tasks, dependencies)).resolves.toEqual(
      [],
    );
    expect(await tasks.findById(taskA.id)).toEqual(taskA);
    expect(await tasks.findById(taskB.id)).toEqual(taskB);
  });

  it('rejects cross-Project dependencies before persistence', async () => {
    const dependencies = new MemoryDependencies();

    await expect(
      addTaskDependency(
        { dependencyTaskId: otherProjectTask.id, taskId: taskA.id },
        new MemoryTasks([taskA, otherProjectTask]),
        dependencies,
      ),
    ).rejects.toMatchObject({ name: 'TaskDependencyProjectMismatchError' });
    expect(await dependencies.listByProjectId(taskA.projectId)).toEqual([]);
  });

  it('rejects duplicate and transitive-cycle additions', async () => {
    const tasks = new MemoryTasks([taskA, taskB, taskC]);
    const dependencies = new MemoryDependencies();
    await addTaskDependency({ dependencyTaskId: taskB.id, taskId: taskA.id }, tasks, dependencies);
    await addTaskDependency({ dependencyTaskId: taskC.id, taskId: taskB.id }, tasks, dependencies);

    await expect(
      addTaskDependency({ dependencyTaskId: taskB.id, taskId: taskA.id }, tasks, dependencies),
    ).rejects.toMatchObject({ reason: 'DUPLICATE' });
    await expect(
      addTaskDependency({ dependencyTaskId: taskA.id, taskId: taskC.id }, tasks, dependencies),
    ).rejects.toMatchObject({ reason: 'CYCLE' });
  });

  it('is blocked until every required Task reaches explicit DONE', async () => {
    const doneTask = transitionToDone(taskB);
    const tasks = new MemoryTasks([taskA, doneTask, taskC]);
    const dependencies = new MemoryDependencies([
      { dependencyTaskId: doneTask.id, taskId: taskA.id },
      { dependencyTaskId: taskC.id, taskId: taskA.id },
    ]);

    await expect(readTaskDependencyState(taskA.id, tasks, dependencies)).resolves.toEqual({
      blocked: true,
      dependencies: [
        { dependency: doneTask, satisfied: true },
        { dependency: taskC, satisfied: false },
      ],
    });

    tasks.replace(transitionToDone(taskC));
    await expect(readTaskDependencyState(taskA.id, tasks, dependencies)).resolves.toEqual({
      blocked: false,
      dependencies: [
        { dependency: doneTask, satisfied: true },
        { dependency: transitionToDone(taskC), satisfied: true },
      ],
    });
  });
});

class MemoryTasks implements TaskRepository {
  private readonly tasks = new Map<string, Task>();

  public constructor(tasks: readonly Task[]) {
    for (const task of tasks) this.tasks.set(task.id, task);
  }

  public async findById(id: string): Promise<Task | undefined> {
    return this.tasks.get(id);
  }

  public async insert(task: Task): Promise<void> {
    this.tasks.set(task.id, task);
  }

  public async update(task: Task): Promise<void> {
    this.tasks.set(task.id, task);
  }

  public replace(task: Task): void {
    this.tasks.set(task.id, task);
  }
}

class MemoryDependencies implements TaskDependencyRepository {
  private readonly dependencies: TaskDependency[];

  public constructor(dependencies: readonly TaskDependency[] = []) {
    this.dependencies = [...dependencies];
  }

  public async add(dependency: TaskDependency): Promise<void> {
    this.dependencies.push(dependency);
  }

  public async remove(dependency: TaskDependency): Promise<boolean> {
    const index = this.dependencies.findIndex(
      (candidate) =>
        candidate.taskId === dependency.taskId &&
        candidate.dependencyTaskId === dependency.dependencyTaskId,
    );
    if (index < 0) return false;
    this.dependencies.splice(index, 1);
    return true;
  }

  public async listByTaskId(taskId: string): Promise<readonly TaskDependency[]> {
    return this.dependencies.filter((dependency) => dependency.taskId === taskId);
  }

  public async listByProjectId(projectId: string): Promise<readonly TaskDependency[]> {
    const projectTaskIds = new Set(
      [taskA, taskB, taskC, otherProjectTask]
        .filter((task) => task.projectId === projectId)
        .map((task) => task.id),
    );
    return this.dependencies.filter((dependency) => projectTaskIds.has(dependency.taskId));
  }
}

function transitionToDone(task: Task): Task {
  let current = task;
  for (const phase of [TaskPhase.PLANNING, TaskPhase.RUNNING, TaskPhase.REVIEW, TaskPhase.DONE]) {
    current = transitionTask(current, phase);
  }
  return current;
}
