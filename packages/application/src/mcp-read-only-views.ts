import type {
  AgentPaneSnapshotProvider,
  AgentSessionSummaryReader,
  LocalProject,
  ProjectCatalog,
  TaskCatalog,
  TaskRepository,
  TaskReviewRepository,
} from './ports';
import type { Task, TaskReview as DomainTaskReview } from '@agentterm/domain';
import type { AgentSessionSummary } from './workspace-overview';

export interface McpProjectListingEntry {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
}

export interface McpTaskListingEntry {
  readonly id: string;
  readonly phase: Task['phase'];
  readonly projectId: string;
  readonly title: string;
}

export interface McpTaskDetail {
  readonly id: string;
  readonly phase: Task['phase'];
  readonly projectId: string;
  readonly title: string;
  readonly brief: string | undefined;
  readonly recentSessions: readonly AgentSessionSummary[];
  readonly latestReview:
    | Pick<DomainTaskReview, 'id' | 'status' | 'requestedAt'>
    | undefined;
}

export interface McpPaneContentEntry {
  readonly boundedLines: readonly string[];
  readonly capturedAt: number;
  readonly sessionId: string;
  readonly truncated: boolean;
}

export interface McpReadOnlyViewDependencies {
  readonly paneSnapshots: AgentPaneSnapshotProvider;
  readonly projects: ProjectCatalog;
  readonly reviews: TaskReviewRepository;
  readonly sessions: AgentSessionSummaryReader;
  readonly tasks: TaskCatalog;
  readonly taskRepository: TaskRepository;
}

export const MAX_MCP_PANE_LINES = 200;
export const MAX_MCP_PROJECT_LIMIT = 50;
export const MAX_MCP_TASK_LIMIT = 200;

export async function listMcpProjects(
  dependencies: Pick<McpReadOnlyViewDependencies, 'projects'>,
  options: { readonly limit?: number } = {},
): Promise<readonly McpProjectListingEntry[]> {
  const limit = clampLimit(options.limit, MAX_MCP_PROJECT_LIMIT);
  const projects = await dependencies.projects.listRecent();
  const entries: McpProjectListingEntry[] = [];
  for (const project of projects.slice(0, limit)) {
    entries.push(toProjectEntry(project));
  }
  return entries;
}

export async function listMcpTasks(
  dependencies: Pick<McpReadOnlyViewDependencies, 'projects' | 'tasks'>,
  input: { readonly projectId?: string; readonly limit?: number },
): Promise<readonly McpTaskListingEntry[]> {
  const limit = clampLimit(input.limit, MAX_MCP_TASK_LIMIT);
  if (input.projectId !== undefined) {
    const tasks = await dependencies.tasks.listByProjectId(input.projectId);
    return tasks.slice(0, limit).map(toTaskEntry);
  }
  const projects = await dependencies.projects.listRecent();
  const entries: McpTaskListingEntry[] = [];
  for (const project of projects) {
    if (entries.length >= limit) {
      break;
    }
    const tasks = await dependencies.tasks.listByProjectId(project.id);
    for (const task of tasks) {
      if (entries.length >= limit) {
        break;
      }
      entries.push(toTaskEntry(task));
    }
  }
  return entries;
}

export async function readMcpTask(
  dependencies: Pick<McpReadOnlyViewDependencies, 'reviews' | 'sessions' | 'taskRepository'>,
  input: { readonly taskId: string },
): Promise<McpTaskDetail | undefined> {
  const task = await dependencies.taskRepository.findById(input.taskId);
  if (task === undefined) {
    return undefined;
  }
  const sessions = await dependencies.sessions.listByTaskId(task.id);
  const reviews = await dependencies.reviews.listRecentByTaskId(task.id, 1);
  const latest = reviews[0];
  return {
    brief: task.brief,
    id: task.id,
    latestReview:
      latest === undefined
        ? undefined
        : {
            id: latest.id,
            requestedAt: latest.requestedAt,
            status: latest.status,
          },
    phase: task.phase,
    projectId: task.projectId,
    recentSessions: sessions.slice(-5),
    title: task.title,
  };
}

export async function readMcpPaneContent(
  dependencies: Pick<McpReadOnlyViewDependencies, 'paneSnapshots'>,
  input: { readonly maximumLines?: number; readonly sessionId: string },
): Promise<McpPaneContentEntry | undefined> {
  const maximumLines = clampLimit(input.maximumLines, MAX_MCP_PANE_LINES);
  const snapshot = await dependencies.paneSnapshots.readSnapshot({
    maximumLines,
    sessionId: input.sessionId,
  });
  if (snapshot === undefined) {
    return undefined;
  }
  return {
    boundedLines: snapshot.boundedLines,
    capturedAt: snapshot.capturedAt,
    sessionId: snapshot.sessionId,
    truncated: snapshot.truncated,
  };
}

function toProjectEntry(project: LocalProject): McpProjectListingEntry {
  return {
    id: project.id,
    name: project.name,
    rootPath: project.rootPath,
  };
}

function toTaskEntry(task: Task): McpTaskListingEntry {
  return {
    id: task.id,
    phase: task.phase,
    projectId: task.projectId,
    title: task.title,
  };
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(value), fallback * 4);
}