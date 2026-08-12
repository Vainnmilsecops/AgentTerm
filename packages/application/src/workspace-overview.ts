import { AgentSessionStatus, type AgentSession, type Project, type Task } from '@agentterm/domain';

import type { AgentSessionRepository, ProjectCatalog, TaskCatalog } from './ports';
import { canStartTaskExecution } from './task-execution';

export interface WorkspaceTaskOverview {
  readonly activeSession: AgentSessionSummary | undefined;
  readonly canStartExecution: boolean;
  readonly latestSession: AgentSessionSummary | undefined;
  readonly task: Task;
}

export interface AgentSessionSummary {
  readonly agentId: string;
  readonly createdAt: number;
  readonly endedAt: number | undefined;
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
): Promise<AgentWorkspaceOverview> {
  const recentProjects = await projects.listRecent();
  const projectOverviews = await Promise.all(
    recentProjects.map(async (project): Promise<WorkspaceProjectOverview> => {
      const projectTasks = await tasks.listByProjectId(project.id);
      const taskOverviews = await Promise.all(
        projectTasks.map(async (task): Promise<WorkspaceTaskOverview> => {
          const history = await sessions.listByTaskId(task.id);
          const activeSession = findLatestActiveSession(history);
          return Object.freeze({
            activeSession: summarizeSession(activeSession),
            canStartExecution: canStartTaskExecution(task),
            latestSession: summarizeSession(history.at(-1)),
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

function summarizeSession(session: AgentSession | undefined): AgentSessionSummary | undefined {
  if (session === undefined) {
    return undefined;
  }
  return Object.freeze({
    agentId: session.agentId,
    createdAt: session.createdAt,
    endedAt: session.endedAt,
    id: session.id,
    status: session.status,
    taskId: session.taskId,
  });
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
