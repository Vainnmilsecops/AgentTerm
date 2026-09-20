import type {
  AgentCatalog,
  AgentSessionRepository,
  GitTaskWorktreeLifecycle,
  TaskWorktreeRepository,
  QualityGateRunRepository,
} from './ports';
import {
  TaskContextError,
  type TaskContextAttachment,
  type TaskContextRepository,
} from './task-context';
import { serializeTaskWorkflow } from './task-workflow-serialization';
import { serializeTaskWorktreeOperation } from './task-worktree-use-cases';

export interface TaskContextExporter {
  exportToWorktree(record: TaskContextAttachment, worktreePath: string): Promise<string>;
}
export interface TaskContextHandoffDependencies {
  readonly agents: AgentCatalog;
  readonly sessions: Pick<AgentSessionRepository, 'findById' | 'listByTaskId'>;
  readonly repository: Pick<TaskContextRepository, 'listByTaskId'>;
  readonly worktrees: Pick<TaskWorktreeRepository, 'findByTaskId'>;
  readonly qualityGateRuns: Pick<QualityGateRunRepository, 'listByTaskId'>;
  readonly git: GitTaskWorktreeLifecycle;
  readonly exporter: TaskContextExporter;
}
export interface TaskContextHandoff {
  readonly sessionId: string;
  readonly agentName: string;
  readonly prompt: string;
  readonly relativePaths: readonly string[];
}
export interface TaskContextHandoffRequest {
  readonly taskId: string;
  readonly sessionId: string;
  readonly attachmentIds: readonly string[];
  readonly confirmWorktreeCopy: true;
}
export interface TaskContextHandoffReadiness {
  readonly canPrepare: boolean;
  readonly reason: string;
}
export async function inspectTaskContextHandoff(
  input: { readonly taskId: string; readonly sessionId: string },
  deps: TaskContextHandoffDependencies,
): Promise<TaskContextHandoffReadiness> {
  const session = await deps.sessions.findById(input.sessionId);
  if (
    !session ||
    session.taskId !== input.taskId ||
    !['WORKING', 'IDLE', 'WAITING_INPUT'].includes(session.status)
  )
    return { canPrepare: false, reason: 'Select a live session belonging to this task.' };
  if ((await deps.sessions.listByTaskId(input.taskId)).at(-1)?.id !== session.id)
    return {
      canPrepare: false,
      reason: 'A newer session exists. Select it before preparing context.',
    };
  const adapter = deps.agents.findById(session.agentId);
  const available = await adapter?.inspect();
  if (
    available?.kind !== 'available' ||
    !available.capabilities.includes('FILE_CONTEXT') ||
    !adapter?.buildContextPrompt
  )
    return {
      canPrepare: false,
      reason: 'The installed adapter does not support text-file context handoff.',
    };
  return {
    canPrepare: true,
    reason:
      'Text handoff supported. Only TXT/MD/JSON up to 64 KiB each; manual submission required.',
  };
}
export async function prepareTaskContextHandoff(
  input: TaskContextHandoffRequest,
  deps: TaskContextHandoffDependencies,
): Promise<TaskContextHandoff> {
  if (
    input.confirmWorktreeCopy !== true ||
    input.attachmentIds.length < 1 ||
    input.attachmentIds.length > 8 ||
    new Set(input.attachmentIds).size !== input.attachmentIds.length
  )
    throw new TaskContextError('LIMIT');
  return serializeTaskWorkflow(input.taskId, () =>
    serializeTaskWorktreeOperation(input.taskId, async () => {
      if (!(await inspectTaskContextHandoff(input, deps)).canPrepare)
        throw new TaskContextError('TARGET');
      if (
        (await deps.qualityGateRuns.listByTaskId(input.taskId)).some(
          (run) => run.status === 'RUNNING',
        )
      )
        throw new TaskContextError('TARGET');
      const all = await deps.repository.listByTaskId(input.taskId);
      const records = input.attachmentIds.map((id) => all.find((record) => record.id === id));
      if (
        records.some(
          (record) =>
            !record ||
            record.taskId !== input.taskId ||
            record.size > 65536 ||
            !['text/plain', 'text/markdown', 'application/json'].includes(record.mime),
        )
      )
        throw new TaskContextError('TYPE');
      // Source session is immutable provenance, not the handoff destination.
      // Verify all sources before the first export; never reassign stored records.
      for (const sourceId of new Set(records.map((record) => record!.sessionId))) {
        const source = await deps.sessions.findById(sourceId);
        if (!source || source.id !== sourceId || source.taskId !== input.taskId)
          throw new TaskContextError('TARGET');
      }
      const worktree = await deps.worktrees.findByTaskId(input.taskId);
      if (worktree?.lifecycleState !== 'PRESENT') throw new TaskContextError('TARGET');
      const inspection = await deps.git.inspect({
        taskId: input.taskId,
        recordedWorktree: worktree,
        repositoryRootPath: worktree.repositoryRootPath,
      });
      if (inspection.kind !== 'present') throw new TaskContextError('TARGET');
      const session = await deps.sessions.findById(input.sessionId);
      const adapter = session && deps.agents.findById(session.agentId);
      if (!adapter?.buildContextPrompt) throw new TaskContextError('TARGET');
      const files = [];
      for (const record of records) {
        const relativePath = await deps.exporter.exportToWorktree(
          record!,
          inspection.worktree.worktreePath,
        );
        files.push({ relativePath, mime: record!.mime });
      }
      return {
        sessionId: input.sessionId,
        agentName: adapter.identity.displayName,
        prompt: adapter.buildContextPrompt(files),
        relativePaths: files.map((file) => file.relativePath),
      };
    }),
  );
}
