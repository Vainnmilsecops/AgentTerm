import {
  ExecutionArtifactKind,
  TaskPhase,
  createExecutionArtifact,
  type ApplicationSettings,
  type ExecutionArtifact,
  type Task,
} from '@agentterm/domain';
import { describe, expect, it } from 'vitest';

import { TaskResearchPhaseError } from './errors';
import { autoAdvanceBacklogTaskAfterResearch } from './research-orchestrator';
import type {
  ApplicationSettingsRepository,
  ExecutionArtifactRepository,
  TaskRepository,
  TaskTransitionLog,
} from './ports';
import type { TaskTransitionAudit } from '@agentterm/domain';

class FakeArtifacts implements ExecutionArtifactRepository {
  public values: ExecutionArtifact[] = [];
  public async findById(id: string): Promise<ExecutionArtifact | undefined> {
    return this.values.find((artifact) => artifact.id === id);
  }
  public async findLatestByTaskIdAndKind(
    taskId: string,
    kind: ExecutionArtifact['kind'],
  ): Promise<ExecutionArtifact | undefined> {
    const matches = this.values.filter(
      (artifact) => artifact.taskId === taskId && artifact.kind === kind,
    );
    if (matches.length === 0) return undefined;
    return matches.reduce((latest, candidate) =>
      candidate.createdAt > latest.createdAt ? candidate : latest,
    );
  }
  public async insert(artifact: ExecutionArtifact): Promise<void> {
    this.values.push(artifact);
  }
  public async listByTaskId(taskId: string): Promise<readonly ExecutionArtifact[]> {
    return this.values.filter((artifact) => artifact.taskId === taskId);
  }
  public async listRecentByTaskId(
    taskId: string,
    limit: number,
  ): Promise<readonly ExecutionArtifact[]> {
    return this.values.filter((artifact) => artifact.taskId === taskId).slice(-limit);
  }
  public async readReviewEvidenceByTaskId() {
    return { evidence: [], totalCount: 0 };
  }
}

class InMemoryTaskRepository implements TaskRepository {
  public readonly tasks = new Map<string, Task>();
  public constructor(seed: readonly Task[] = []) {
    for (const task of seed) {
      this.tasks.set(task.id, task);
    }
  }
  public async findById(id: string): Promise<Task | undefined> {
    return this.tasks.get(id);
  }
  public async insert(task: Task): Promise<void> {
    if (this.tasks.has(task.id)) {
      throw new Error(`Task ${task.id} already exists.`);
    }
    this.tasks.set(task.id, task);
  }
  public async list(): Promise<readonly Task[]> {
    return Array.from(this.tasks.values());
  }
  public async listByProjectId(projectId: string): Promise<readonly Task[]> {
    return Array.from(this.tasks.values()).filter((task) => task.projectId === projectId);
  }
  public async update(task: Task): Promise<void> {
    this.tasks.set(task.id, task);
  }
}

class FakeSettingsRepository implements ApplicationSettingsRepository {
  public current: ApplicationSettings;
  public constructor(settings: Partial<ApplicationSettings> = {}) {
    this.current = {
      agentExecutables: [],
      allowClipboardReadWrite: false,
      defaultAgentId: 'codex',
      mcpServerToken: undefined,
      researchAutoAdvance: false,
      revision: 0,
      schemaVersion: 3,
      terminalFontSize: 14,
      ...settings,
    };
  }
  public async get(): Promise<ApplicationSettings> {
    return this.current;
  }
  public async update(): Promise<never> {
    throw new Error('not used');
  }
}

class FakeTaskTransitionLog implements TaskTransitionLog {
  public readonly rows: TaskTransitionAudit[] = [];
  public async append(audit: TaskTransitionAudit): Promise<void> {
    this.rows.push(audit);
  }
  public async listByTaskId(taskId: string): Promise<readonly TaskTransitionAudit[]> {
    return this.rows.filter((audit) => audit.taskId === taskId);
  }
}

function researchArtifact(taskId: string): ExecutionArtifact {
  return createExecutionArtifact({
    content: '# Research\n\nFindings go here.',
    createdAt: 1_700_000_000_000,
    id: `artifact-${taskId}`,
    kind: ExecutionArtifactKind.RESEARCH,
    taskId,
  });
}

function backlogTask(taskId: string): Task {
  return {
    brief: 'Test',
    id: taskId,
    phase: TaskPhase.BACKLOG,
    projectId: 'project-1',
    title: taskId,
  } as Task;
}

describe('autoAdvanceBacklogTaskAfterResearch', () => {
  it('returns DISABLED when the operator has not opted in', async () => {
    const artifact = researchArtifact('task-1');
    const tasks = new InMemoryTaskRepository([backlogTask('task-1')]);
    const artifacts = new FakeArtifacts();
    await artifacts.insert(artifact);
    const settings = new FakeSettingsRepository({ researchAutoAdvance: false });

    const result = await autoAdvanceBacklogTaskAfterResearch(
      { artifact },
      { artifacts, settings, tasks },
    );

    expect(result).toEqual({ reason: 'DISABLED', transitioned: false });
    expect(tasks.tasks.get('task-1')?.phase).toBe(TaskPhase.BACKLOG);
  });

  it('returns ARTIFACT_INVALID when the supplied artifact is not VALID RESEARCH', async () => {
    const artifact = researchArtifact('task-1');
    // Simulate invalid artifact by mutating the kind to something other than RESEARCH.
    const invalidArtifact: ExecutionArtifact = { ...artifact, kind: ExecutionArtifactKind.PLAN };
    const tasks = new InMemoryTaskRepository([backlogTask('task-1')]);
    const artifacts = new FakeArtifacts();
    await artifacts.insert(artifact);
    const settings = new FakeSettingsRepository({ researchAutoAdvance: true });

    const result = await autoAdvanceBacklogTaskAfterResearch(
      { artifact: invalidArtifact },
      { artifacts, settings, tasks },
    );

    expect(result).toEqual({ reason: 'ARTIFACT_INVALID', transitioned: false });
  });

  it('returns TASK_NOT_FOUND when the artifact references an unknown task', async () => {
    const artifact = researchArtifact('ghost');
    const tasks = new InMemoryTaskRepository();
    const artifacts = new FakeArtifacts();
    await artifacts.insert(artifact);
    const settings = new FakeSettingsRepository({ researchAutoAdvance: true });

    const result = await autoAdvanceBacklogTaskAfterResearch(
      { artifact },
      { artifacts, settings, tasks },
    );

    expect(result).toEqual({ reason: 'TASK_NOT_FOUND', transitioned: false });
  });

  it('returns PHASE_NOT_BACKLOG when the task has already advanced', async () => {
    const artifact = researchArtifact('task-1');
    const advancedTask = { ...backlogTask('task-1'), phase: TaskPhase.PLANNING };
    const tasks = new InMemoryTaskRepository([advancedTask]);
    const artifacts = new FakeArtifacts();
    await artifacts.insert(artifact);
    const settings = new FakeSettingsRepository({ researchAutoAdvance: true });

    const result = await autoAdvanceBacklogTaskAfterResearch(
      { artifact },
      { artifacts, settings, tasks },
    );

    expect(result).toEqual({ reason: 'PHASE_NOT_BACKLOG', transitioned: false });
  });

  it('returns TASK_NOT_READY when the latest RESEARCH artifact is missing', async () => {
    const artifact = researchArtifact('task-1');
    const tasks = new InMemoryTaskRepository([backlogTask('task-1')]);
    const artifacts = new FakeArtifacts();
    // Deliberately do NOT insert the artifact.
    const settings = new FakeSettingsRepository({ researchAutoAdvance: true });

    const result = await autoAdvanceBacklogTaskAfterResearch(
      { artifact },
      { artifacts, settings, tasks },
    );

    expect(result).toEqual({ reason: 'TASK_NOT_READY', transitioned: false });
  });

  it('advances the task and writes an audit row on the happy path', async () => {
    const artifact = researchArtifact('task-1');
    const tasks = new InMemoryTaskRepository([backlogTask('task-1')]);
    const artifacts = new FakeArtifacts();
    await artifacts.insert(artifact);
    const settings = new FakeSettingsRepository({ researchAutoAdvance: true });
    const transitions = new FakeTaskTransitionLog();

    const result = await autoAdvanceBacklogTaskAfterResearch(
      { artifact },
      { artifacts, settings, tasks, transitions },
    );

    expect(result).toEqual({ taskId: 'task-1', transitioned: true });
    expect(tasks.tasks.get('task-1')?.phase).toBe(TaskPhase.PLANNING);
    expect(transitions.rows).toHaveLength(1);
    expect(transitions.rows[0]).toMatchObject({
      artifactId: artifact.id,
      fromPhase: TaskPhase.BACKLOG,
      taskId: 'task-1',
      toPhase: TaskPhase.PLANNING,
      trigger: 'research-auto-advance',
    });
  });

  it('returns CONCURRENT_TRANSITION when the domain throws on a stale artifact', async () => {
    // Insert the artifact first so the orchestrator's belt-and-braces
    // canEnterPlanning check passes. Then simulate a race by deleting the
    // artifact before transitionTask's own canEnterPlanning re-check fires.
    const artifact = researchArtifact('task-1');
    const tasks = new InMemoryTaskRepository([backlogTask('task-1')]);
    const artifacts = new FakeArtifacts();
    await artifacts.insert(artifact);

    let raceTriggered = false;
    const racingArtifacts: ExecutionArtifactRepository = {
      findById: (id) => artifacts.findById(id),
      findLatestByTaskIdAndKind: async (taskId, kind) => {
        const latest = await artifacts.findLatestByTaskIdAndKind(taskId, kind);
        if (latest !== undefined && !raceTriggered) {
          raceTriggered = true;
          // Empty the artifacts so transitionTask's canEnterPlanning re-check
          // throws TaskResearchPhaseError(ARTIFACT_MISSING).
          artifacts.values = [];
        }
        return latest;
      },
      insert: (a) => artifacts.insert(a),
      listByTaskId: (taskId) => artifacts.listByTaskId(taskId),
      listRecentByTaskId: (taskId, limit) => artifacts.listRecentByTaskId(taskId, limit),
      readReviewEvidenceByTaskId: () => artifacts.readReviewEvidenceByTaskId(),
    };

    const settings = new FakeSettingsRepository({ researchAutoAdvance: true });

    const result = await autoAdvanceBacklogTaskAfterResearch(
      { artifact },
      { artifacts: racingArtifacts, settings, tasks },
    );

    expect(result).toEqual({ reason: 'CONCURRENT_TRANSITION', transitioned: false });
    expect(tasks.tasks.get('task-1')?.phase).toBe(TaskPhase.BACKLOG);
    // Confirm TaskResearchPhaseError is exported for the orchestrator's catch block.
    expect(TaskResearchPhaseError).toBeDefined();
  });
});
