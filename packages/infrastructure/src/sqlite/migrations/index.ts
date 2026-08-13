import { projectsAndTasksMigration } from './0001-projects-and-tasks';
import { projectRootsMigration } from './0002-project-roots';
import { taskWorktreesMigration } from './0003-task-worktrees';
import { agentSessionsMigration } from './0004-agent-sessions';
import { executionArtifactsMigration } from './0005-execution-artifacts';
import { qualityGateRunsMigration } from './0006-quality-gate-runs';
import { taskReviewsMigration } from './0007-task-reviews';
import { taskDependenciesMigration } from './0008-task-dependencies';

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
  executionArtifactsMigration,
  qualityGateRunsMigration,
  taskReviewsMigration,
  taskDependenciesMigration,
];
