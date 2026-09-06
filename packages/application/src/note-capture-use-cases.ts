import {
  ExecutionArtifactKind,
  createExecutionArtifact,
  type ExecutionArtifact,
} from '@agentterm/domain';

import { ArtifactProvenanceError, EntityNotFoundError } from './errors';
import type {
  AgentSessionRepository,
  ExecutionArtifactRepository,
  TaskRepository,
} from './ports';
import { serializeTaskWorkflow } from './task-workflow-serialization';

/**
 * Inputs shared by `recordBrainstormArtifact` and `recordSweepArtifact`.
 * The user captures a mid-session note through the renderer; the Application
 * layer is responsible only for provenance + persistence.
 */
export interface RecordSessionNoteInput {
  readonly content: string;
  readonly createdAt: number;
  readonly id: string;
  readonly sessionId: string;
  readonly taskId: string;
}

export interface RecordSessionNoteDependencies {
  readonly artifacts: ExecutionArtifactRepository;
  readonly sessions: AgentSessionRepository;
  readonly tasks: TaskRepository;
}

const maximumContentLength = 1_048_576;

function assertValidNoteContent(content: string, heading: string): void {
  if (
    typeof content !== 'string' ||
    content.length > maximumContentLength ||
    content.includes('\0')
  ) {
    throw new TypeError('Session note content is invalid.');
  }
  const normalized = content.replaceAll('\r\n', '\n');
  if (
    !normalized.startsWith(`${heading}\n\n`) ||
    normalized.slice(heading.length + 2).trim() === ''
  ) {
    throw new TypeError(`Session note must contain ${heading} and a body.`);
  }
}

/**
 * Internal helper shared by `recordBrainstormArtifact` and
 * `recordSweepArtifact`. The note is bound to the Task's current phase at
 * capture-time; the artifact kind determines the heading and the persistence
 * contract (dynamic-phase kind with a per-task canonical name).
 */
async function recordSessionNote(
  kind: typeof ExecutionArtifactKind.BRAINSTORM | typeof ExecutionArtifactKind.SWEEP,
  input: RecordSessionNoteInput,
  dependencies: RecordSessionNoteDependencies,
): Promise<ExecutionArtifact> {
  if (typeof input.id !== 'string' || input.id.trim().length === 0) {
    throw new TypeError('Session note id must not be blank.');
  }
  if (typeof input.taskId !== 'string' || input.taskId.trim().length === 0) {
    throw new TypeError('Session note task id must not be blank.');
  }
  if (typeof input.sessionId !== 'string' || input.sessionId.trim().length === 0) {
    throw new TypeError('Session note session id must not be blank.');
  }
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) {
    throw new TypeError('Session note timestamp must be a nonnegative integer.');
  }

  const heading = kind === ExecutionArtifactKind.BRAINSTORM ? '# Brainstorm' : '# Sweep';
  assertValidNoteContent(input.content, heading);

  return serializeTaskWorkflow(input.taskId, async () => {
    const task = await dependencies.tasks.findById(input.taskId);
    if (task === undefined) {
      throw new EntityNotFoundError('Task', input.taskId);
    }
    const session = await dependencies.sessions.findById(input.sessionId);
    if (session === undefined) {
      throw new EntityNotFoundError('AgentSession', input.sessionId);
    }
    if (session.taskId !== task.id) {
      throw new ArtifactProvenanceError(input.id, task.id, session.id);
    }

    // Domain layer creates and validates the artifact. The dynamic-phase
    // contract resolves `phase` from the Task's current phase at capture-time.
    const artifact = createExecutionArtifact({
      content: input.content,
      createdAt: input.createdAt,
      id: input.id,
      kind,
      phase: task.phase,
      sessionId: input.sessionId,
      taskId: input.taskId,
    });
    await dependencies.artifacts.insert(artifact, task.phase);
    return artifact;
  });
}

export async function recordBrainstormArtifact(
  input: RecordSessionNoteInput,
  dependencies: RecordSessionNoteDependencies,
): Promise<ExecutionArtifact> {
  return recordSessionNote(ExecutionArtifactKind.BRAINSTORM, input, dependencies);
}

export async function recordSweepArtifact(
  input: RecordSessionNoteInput,
  dependencies: RecordSessionNoteDependencies,
): Promise<ExecutionArtifact> {
  return recordSessionNote(ExecutionArtifactKind.SWEEP, input, dependencies);
}
