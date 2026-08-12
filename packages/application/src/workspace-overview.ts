import {
  AgentSessionStatus,
  type AgentSession,
  type ExecutionArtifact,
  type Project,
  type QualityGateRun,
  type Task,
} from '@agentterm/domain';

import type {
  AgentSessionRepository,
  ExecutionArtifactRepository,
  ProjectCatalog,
  QualityGateRunRepository,
  TaskCatalog,
} from './ports';
import { canStartTaskExecution } from './task-execution';

const maximumWorkspaceGateRuns = 20;
const maximumWorkspaceGateOutputCharacters = 4_096;

export interface WorkspaceTaskOverview {
  readonly activeSession: AgentSessionSummary | undefined;
  readonly artifacts: readonly ExecutionArtifact[];
  readonly canRetryExecution: boolean;
  readonly canStartExecution: boolean;
  readonly latestSession: AgentSessionSummary | undefined;
  readonly previousSession: AgentSessionSummary | undefined;
  readonly qualityGateRuns: readonly QualityGateRunSummary[];
  readonly task: Task;
}

export interface QualityGateRunSummary {
  readonly durationMs: number | undefined;
  readonly exitCode: number | undefined;
  readonly failureCategory: QualityGateRun['failureCategory'];
  readonly finishedAt: number | undefined;
  readonly gateId: string;
  readonly id: string;
  readonly kind: QualityGateRun['gate']['kind'];
  readonly output:
    | {
        readonly text: string;
        readonly truncated: boolean;
      }
    | undefined;
  readonly startedAt: number;
  readonly status: QualityGateRun['status'];
  readonly taskId: string;
}

export interface AgentSessionSummary {
  readonly agentId: string;
  readonly createdAt: number;
  readonly endedAt: number | undefined;
  readonly failureCode: string | undefined;
  readonly id: string;
  readonly status: AgentSession['status'];
  readonly taskId: string;
}

export interface WorkspaceProjectOverview {
  readonly project: Project;
  readonly tasks: readonly WorkspaceTaskOverview[];
}

export interface AgentWorkspaceOverview {
  readonly projects: readonly WorkspaceProjectOverview[];
}

export async function loadAgentWorkspace(
  projects: ProjectCatalog,
  tasks: TaskCatalog,
  sessions: AgentSessionRepository,
  artifacts: ExecutionArtifactRepository,
  qualityGateRuns: QualityGateRunRepository,
): Promise<AgentWorkspaceOverview> {
  const recentProjects = await projects.listRecent();
  const projectOverviews = await Promise.all(
    recentProjects.map(async (project): Promise<WorkspaceProjectOverview> => {
      const projectTasks = await tasks.listByProjectId(project.id);
      const taskOverviews = await Promise.all(
        projectTasks.map(async (task): Promise<WorkspaceTaskOverview> => {
          const [history, artifactHistory, gateHistory] = await Promise.all([
            sessions.listByTaskId(task.id),
            artifacts.listByTaskId(task.id),
            qualityGateRuns.listByTaskId(task.id),
          ]);
          const activeSession = findLatestActiveSession(history);
          const latestSession = history.at(-1);
          const phaseAllowsExecution = canStartTaskExecution(task);
          return Object.freeze({
            activeSession: summarizeSession(activeSession),
            artifacts: Object.freeze([...artifactHistory]),
            canRetryExecution:
              phaseAllowsExecution && activeSession === undefined && isTerminal(latestSession),
            canStartExecution:
              phaseAllowsExecution && activeSession === undefined && latestSession === undefined,
            latestSession: summarizeSession(latestSession),
            previousSession: summarizeSession(history.at(-2)),
            qualityGateRuns: Object.freeze(
              gateHistory.slice(-maximumWorkspaceGateRuns).map(summarizeQualityGateRun),
            ),
            task,
          });
        }),
      );
      return Object.freeze({
        project: Object.freeze({ id: project.id, name: project.name }),
        tasks: Object.freeze(taskOverviews),
      });
    }),
  );

  return Object.freeze({ projects: Object.freeze(projectOverviews) });
}

function summarizeQualityGateRun(run: QualityGateRun): QualityGateRunSummary {
  const outputCharacters = run.output === undefined ? undefined : Array.from(run.output.text);
  const outputText = outputCharacters?.slice(0, maximumWorkspaceGateOutputCharacters).join('');
  return Object.freeze({
    durationMs: run.durationMs,
    exitCode: run.exitCode,
    failureCategory: run.failureCategory,
    finishedAt: run.finishedAt,
    gateId: run.gate.id,
    id: run.id,
    kind: run.gate.kind,
    output:
      run.output === undefined
        ? undefined
        : Object.freeze({
            text: outputText ?? '',
            truncated:
              run.output.truncated ||
              (outputCharacters?.length ?? 0) > maximumWorkspaceGateOutputCharacters,
          }),
    startedAt: run.startedAt,
    status: run.status,
    taskId: run.taskId,
  });
}

function isTerminal(session: AgentSession | undefined): boolean {
  return (
    session?.status === AgentSessionStatus.EXITED || session?.status === AgentSessionStatus.FAILED
  );
}

function summarizeSession(session: AgentSession | undefined): AgentSessionSummary | undefined {
  if (session === undefined) {
    return undefined;
  }
  const fatalFailure = findLatestFatalFailure(session);
  return Object.freeze({
    agentId: session.agentId,
    createdAt: session.createdAt,
    endedAt: session.endedAt,
    failureCode: fatalFailure?.code,
    id: session.id,
    status: session.status,
    taskId: session.taskId,
  });
}

function findLatestFatalFailure(
  session: AgentSession,
): Extract<AgentSession['history'][number], { kind: 'RUNTIME_FAILED' }> | undefined {
  for (let index = session.history.length - 1; index >= 0; index -= 1) {
    const event = session.history[index];
    if (event?.kind === 'RUNTIME_FAILED' && event.fatal) {
      return event;
    }
  }
  return undefined;
}

function findLatestActiveSession(sessions: readonly AgentSession[]): AgentSession | undefined {
  for (let index = sessions.length - 1; index >= 0; index -= 1) {
    const session = sessions[index];
    if (
      session !== undefined &&
      session.status !== AgentSessionStatus.EXITED &&
      session.status !== AgentSessionStatus.FAILED
    ) {
      return session;
    }
  }
  return undefined;
}
