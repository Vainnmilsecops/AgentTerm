import { createRequire } from 'node:module';

import type {
  AgentSessionRepository,
  LocalProjectLocator,
  ProjectCatalog,
  ProjectRepository,
  TaskRepository,
  TaskWorktreeRepository,
} from '@agentterm/application';

import { migrateSqliteDatabase } from './migrate';
import {
  SqliteProjectRepository,
  SqliteAgentSessionRepository,
  SqliteTaskRepository,
  SqliteTaskWorktreeRepository,
} from './repositories';

type NodeSqliteModule = typeof import('node:sqlite');

// tsup 8 rewrites a static node:sqlite import to the invalid bare specifier "sqlite".
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as NodeSqliteModule;

export interface SqlitePersistence {
  readonly projects: LocalProjectLocator & ProjectCatalog & ProjectRepository;
  readonly sessions: AgentSessionRepository;
  readonly tasks: TaskRepository;
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
  let projects: LocalProjectLocator & ProjectCatalog & ProjectRepository;
  let sessions: AgentSessionRepository;
  let tasks: TaskRepository;
  let worktrees: TaskWorktreeRepository;

  try {
    database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA trusted_schema = OFF;
    `);
    migrateSqliteDatabase(database);
    projects = new SqliteProjectRepository(database);
    sessions = new SqliteAgentSessionRepository(database);
    tasks = new SqliteTaskRepository(database);
    worktrees = new SqliteTaskWorktreeRepository(database);
  } catch (error) {
    database.close();
    throw error;
  }

  let isClosed = false;

  return Object.freeze({
    projects,
    sessions,
    tasks,
    worktrees,
    close(): void {
      if (!isClosed) {
        database.close();
        isClosed = true;
      }
    },
  });
}
