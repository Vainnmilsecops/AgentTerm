import { createRequire } from 'node:module';

import type {
  AgentSessionRepository,
  ApplicationSettingsRepository,
  ExecutionArtifactRepository,
  TaskPlanningArtifactRepository,
  LocalProjectLocator,
  ProjectCatalog,
  ProjectRepository,
  PullRequestRepository,
  QualityGateRunRepository,
  TaskRepository,
  TaskPlanningRepository,
  TaskReviewRepository,
  TaskCatalog,
  TaskDependencyRepository,
  TaskWorktreeRepository,
} from '@agentterm/application';

import { migrateSqliteDatabase } from './migrate';
import {
  SqliteProjectRepository,
  SqliteApplicationSettingsRepository,
  SqlitePullRequestRepository,
  SqliteAgentSessionRepository,
  SqliteExecutionArtifactRepository,
  SqliteQualityGateRunRepository,
  SqliteTaskRepository,
  SqliteTaskDependencyRepository,
  SqliteTaskReviewRepository,
  SqliteTaskWorktreeRepository,
} from './repositories';

type NodeSqliteModule = typeof import('node:sqlite');

// tsup 8 rewrites a static node:sqlite import to the invalid bare specifier "sqlite".
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as NodeSqliteModule;

export interface SqlitePersistence {
  readonly artifacts: ExecutionArtifactRepository & TaskPlanningArtifactRepository;
  readonly projects: LocalProjectLocator & ProjectCatalog & ProjectRepository;
  readonly pullRequests: PullRequestRepository;
  readonly qualityGateRuns: QualityGateRunRepository;
  readonly sessions: AgentSessionRepository;
  readonly settings: ApplicationSettingsRepository;
  readonly tasks: TaskCatalog & TaskPlanningRepository & TaskRepository;
  readonly taskDependencies: TaskDependencyRepository;
  readonly reviews: TaskReviewRepository;
  readonly worktrees: TaskWorktreeRepository;
  close(): void;
}

export function openSqlitePersistence(databasePath: string): SqlitePersistence {
  if (databasePath.trim().length === 0) {
    throw new TypeError('SQLite database path must not be blank.');
  }

  const database = new DatabaseSync(databasePath, {
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
  });
  let artifacts: ExecutionArtifactRepository & TaskPlanningArtifactRepository;
  let projects: LocalProjectLocator & ProjectCatalog & ProjectRepository;
  let pullRequests: PullRequestRepository;
  let qualityGateRuns: QualityGateRunRepository;
  let sessions: AgentSessionRepository;
  let settings: ApplicationSettingsRepository;
  let tasks: TaskCatalog & TaskPlanningRepository & TaskRepository;
  let taskDependencies: TaskDependencyRepository;
  let reviews: TaskReviewRepository;
  let worktrees: TaskWorktreeRepository;

  try {
    database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA trusted_schema = OFF;
    `);
    migrateSqliteDatabase(database);
    artifacts = new SqliteExecutionArtifactRepository(database);
    projects = new SqliteProjectRepository(database);
    pullRequests = new SqlitePullRequestRepository(database);
    qualityGateRuns = new SqliteQualityGateRunRepository(database);
    sessions = new SqliteAgentSessionRepository(database);
    settings = new SqliteApplicationSettingsRepository(database);
    tasks = new SqliteTaskRepository(database);
    taskDependencies = new SqliteTaskDependencyRepository(database);
    reviews = new SqliteTaskReviewRepository(database);
    worktrees = new SqliteTaskWorktreeRepository(database);
  } catch (error) {
    database.close();
    throw error;
  }

  let isClosed = false;

  return Object.freeze({
    artifacts,
    projects,
    pullRequests,
    qualityGateRuns,
    sessions,
    settings,
    tasks,
    taskDependencies,
    reviews,
    worktrees,
    close(): void {
      if (!isClosed) {
        database.close();
        isClosed = true;
      }
    },
  });
}
