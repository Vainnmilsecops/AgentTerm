import type { Project, Task } from '@agentterm/domain';

export interface ProjectRepository {
  findById(id: string): Promise<Project | undefined>;
  /** Inserts a new Project and must not replace an existing identity. */
  insert(project: Project): Promise<void>;
}

export interface TaskRepository {
  findById(id: string): Promise<Task | undefined>;
  /** Inserts a new Task and must not replace an existing identity. */
  insert(task: Task): Promise<void>;
  /** Replaces an existing Task and must not create a missing identity. */
  update(task: Task): Promise<void>;
}
