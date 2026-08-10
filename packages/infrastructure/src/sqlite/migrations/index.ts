import { projectsAndTasksMigration } from './0001-projects-and-tasks';

export interface SqliteMigration {
  readonly name: string;
  readonly sql: string;
  readonly version: number;
}

export const sqliteMigrations: readonly SqliteMigration[] = [projectsAndTasksMigration];
