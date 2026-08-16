import { ExecutionArtifactKind, TaskPhase, createExecutionArtifact, type ExecutionArtifact } from '@agentterm/domain';
import { describe, expect, it } from 'vitest';

import { TaskResearchPhaseError } from './errors';
import { assertCanEnterPlanning, canEnterPlanning } from './can-enter-planning';
import type { ExecutionArtifactRepository } from './ports';

class FakeArtifacts implements ExecutionArtifactRepository {
  public readonly values: readonly ExecutionArtifact[];
  public constructor(values: readonly ExecutionArtifact[] = []) {
    this.values = values;
  }
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
  public async insert(): Promise<never> {
    throw new Error('not used');
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

function researchArtifact(taskId: string, createdAt: number): ExecutionArtifact {
  return createExecutionArtifact({
    content: '# Research\n\nFindings go here.',
    createdAt,
    id: `artifact-${taskId}-${createdAt}`,
    kind: ExecutionArtifactKind.RESEARCH,
    taskId,
  });
}

describe('canEnterPlanning', () => {
  it('blocks tasks that are not in BACKLOG', async () => {
    const artifacts = new FakeArtifacts([researchArtifact('task-1', 1)]);
    const result = await canEnterPlanning({
      artifacts,
      taskId: 'task-1',
      taskPhase: TaskPhase.PLANNING,
    });
    expect(result.failure).toBe('TASK_NOT_IN_BACKLOG');
  });

  it('blocks tasks without any Research artifact', async () => {
    const artifacts = new FakeArtifacts();
    const result = await canEnterPlanning({
      artifacts,
      taskId: 'task-1',
      taskPhase: TaskPhase.BACKLOG,
    });
    expect(result.failure).toBe('ARTIFACT_MISSING');
  });

  it('admits tasks with a valid Research artifact', async () => {
    const artifacts = new FakeArtifacts([researchArtifact('task-1', 5)]);
    const result = await canEnterPlanning({
      artifacts,
      taskId: 'task-1',
      taskPhase: TaskPhase.BACKLOG,
    });
    expect(result.failure).toBeUndefined();
  });

  it('returns the most recent Research artifact when multiple exist', async () => {
    const artifacts = new FakeArtifacts([
      researchArtifact('task-1', 1),
      researchArtifact('task-1', 7),
      researchArtifact('task-1', 4),
    ]);
    const result = await canEnterPlanning({
      artifacts,
      taskId: 'task-1',
      taskPhase: TaskPhase.BACKLOG,
    });
    expect(result.failure).toBeUndefined();
  });

  it('throws TaskResearchPhaseError when the rule fails', async () => {
    const artifacts = new FakeArtifacts();
    await expect(
      assertCanEnterPlanning({
        artifacts,
        taskId: 'task-1',
        taskPhase: TaskPhase.BACKLOG,
      }),
    ).rejects.toBeInstanceOf(TaskResearchPhaseError);
  });
});