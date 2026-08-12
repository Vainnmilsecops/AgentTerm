import { projectsAndTasksMigration } from './0001-projects-and-tasks';
import { projectRootsMigration } from './0002-project-roots';
import { taskWorktreesMigration } from './0003-task-worktrees';
import { agentSessionsMigration } from './0004-agent-sessions';
import { qualityGateRunsMigration } from './0005-quality-gate-runs';

export interface SqliteMigration {
  readonly name: string;
  readonly sql: string;
  readonly version: number;
}

export const sqliteMigrations: readonly SqliteMigration[] = [
  projectsAndTasksMigration,
  projectRootsMigration,
  taskWorktreesMigration,
  agentSessionsMigration,
  qualityGateRunsMigration,
];
