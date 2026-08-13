import {
  createExecutionArtifact as createDomainExecutionArtifact,
  type CreateExecutionArtifactInput,
  type ExecutionArtifact,
} from '@agentterm/domain';

import { ArtifactProvenanceError, EntityNotFoundError } from './errors';
import type { AgentSessionRepository, ExecutionArtifactRepository, TaskRepository } from './ports';

export async function createExecutionArtifact(
  input: CreateExecutionArtifactInput,
  tasks: TaskRepository,
  sessions: AgentSessionRepository,
  artifacts: ExecutionArtifactRepository,
): Promise<ExecutionArtifact> {
  const artifact = createDomainExecutionArtifact(input);
  const task = await tasks.findById(artifact.taskId);
  if (task === undefined) {
    throw new EntityNotFoundError('Task', artifact.taskId);
  }

  if (artifact.sessionId !== undefined) {
    const session = await sessions.findById(artifact.sessionId);
    if (session === undefined) {
      throw new EntityNotFoundError('AgentSession', artifact.sessionId);
    }
    if (session.taskId !== artifact.taskId) {
      throw new ArtifactProvenanceError(artifact.id, artifact.taskId, session.id);
    }
  }

  await artifacts.insert(artifact, artifact.phase);
  return artifact;
}

export async function getExecutionArtifact(
  id: string,
  artifacts: ExecutionArtifactRepository,
): Promise<ExecutionArtifact> {
  const artifact = await artifacts.findById(id);
  if (artifact === undefined) {
    throw new EntityNotFoundError('ExecutionArtifact', id);
  }
  return artifact;
}

export async function listTaskExecutionArtifacts(
  taskId: string,
  tasks: TaskRepository,
  artifacts: ExecutionArtifactRepository,
): Promise<readonly ExecutionArtifact[]> {
  if ((await tasks.findById(taskId)) === undefined) {
    throw new EntityNotFoundError('Task', taskId);
  }
  return artifacts.listByTaskId(taskId);
}
