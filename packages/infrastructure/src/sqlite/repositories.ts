import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';

import {
  type AgentSessionRepository,
  AgentSessionActiveConflictError,
  ApplicationSettingsConflictError,
  type ApplicationSettingsRepository,
  EntityNotFoundError,
  EntityAlreadyExistsError,
  type ExecutionArtifactRepository,
  type LocalProject,
  type LocalProjectLocator,
  type ProjectCatalog,
  type ProjectRepository,
  type PullRequestRepository,
  type QualityGateRunRepository,
  type RecordProjectOpenInput,
  type TaskRepository,
  type TaskCatalog,
  TaskDependencyProjectMismatchError,
  type TaskDependencyRepository,
  type TaskPlanningRepository,
  type TaskPlanningSessionRevision,
  type TaskReviewRepository,
  type TaskReviewSessionRevision,
  type TaskPullRequest,
  TaskWorktreeMetadataConflictError,
  type TaskWorktree,
  type TaskWorktreeLifecycleState,
  type TaskWorktreeRecord,
  type TaskWorktreeRepository,
} from '@agentterm/application';
import {
  createApplicationSettings,
  createExecutionArtifact,
  createTaskDependency,
  decideTaskReview,
  InvalidTaskDependencyError,
  QualityGateRunStatus,
  startTaskReview,
  startQualityGateRun,
  TaskPhase,
  TaskReviewEvidenceLimits,
  TaskReviewStatus,
  transitionTask,
  type AgentSession,
  type AgentSessionHostOwnership,
  type ApplicationSettings,
  type AgentSessionEvent,
  type ExecutionArtifact,
  type Project,
  type QualityGateRun,
  type Task,
  type TaskDependency,
  type TaskReview,
} from '@agentterm/domain';

import { SqlitePersistenceError } from './errors';
import {
  mapAgentSessionRows,
  mapExecutionArtifactRow,
  mapLocalProjectRow,
  mapProjectRow,
  mapQualityGateRunRow,
  mapTaskRow,
  mapTaskReviewRows,
  mapTaskReviewArtifactEvidenceSourceRow,
  mapTaskReviewQualityGateEvidenceSourceRow,
  mapTaskWorktreeRow,
} from './mapping';

const primaryKeyConstraintCode = 1555;
const uniqueConstraintCode = 2067;

function serializeHostOwnership(ownership: AgentSessionHostOwnership): string {
  return JSON.stringify({
    conptyInPipeName: ownership.conptyInPipeName,
    conptyOutPipeName: ownership.conptyOutPipeName,
    hostPid: ownership.hostPid,
    startedAt: ownership.startedAt,
  });
}

export class SqliteApplicationSettingsRepository implements ApplicationSettingsRepository {
  private readonly readExecutablesStatement: StatementSync;
  private readonly readSettingsStatement: StatementSync;
  private readonly updateSettingsStatement: StatementSync;
  private readonly deleteExecutablesStatement: StatementSync;
  private readonly insertExecutableStatement: StatementSync;

  public constructor(private readonly database: DatabaseSync) {
    this.readSettingsStatement = database.prepare(
      `SELECT schema_version, revision, default_agent_id, terminal_font_size
       FROM application_settings WHERE singleton_id = 1`,
    );
    this.readExecutablesStatement = database.prepare(
      `SELECT agent_id, executable_path FROM agent_executable_settings
       WHERE settings_id = 1 ORDER BY agent_id`,
    );
    this.updateSettingsStatement = database.prepare(
      `UPDATE application_settings
       SET schema_version = ?, revision = ?, default_agent_id = ?, terminal_font_size = ?
       WHERE singleton_id = 1 AND revision = ?`,
    );
    this.deleteExecutablesStatement = database.prepare(
      'DELETE FROM agent_executable_settings WHERE settings_id = 1',
    );
    this.insertExecutableStatement = database.prepare(
      `INSERT INTO agent_executable_settings (settings_id, agent_id, executable_path)
       VALUES (1, ?, ?)`,
    );
  }

  public async get(): Promise<ApplicationSettings> {
    const row = this.readSettingsStatement.get();
    if (row === undefined) {
      throw new SqlitePersistenceError('Application Settings singleton is missing.');
    }
    const executableRows = this.readExecutablesStatement.all();
    try {
      return createApplicationSettings({
        agentExecutables: executableRows.map((executableRow) => ({
          agentId: readSettingsText(executableRow.agent_id),
          executablePath: readSettingsText(executableRow.executable_path),
        })),
        defaultAgentId: readSettingsText(row.default_agent_id),
        revision: readSettingsInteger(row.revision),
        schemaVersion: readSettingsSchemaVersion(row.schema_version),
        terminalFontSize: readSettingsInteger(row.terminal_font_size),
      });
    } catch (error) {
      throw new SqlitePersistenceError('Application Settings data is invalid.', { cause: error });
    }
  }

  public async update(settings: ApplicationSettings, expectedRevision: number): Promise<void> {
    if (settings.revision !== expectedRevision + 1) {
      throw new TypeError('Application Settings update must advance the revision exactly once.');
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const updated = this.updateSettingsStatement.run(
        settings.schemaVersion,
        settings.revision,
        settings.defaultAgentId,
        settings.terminalFontSize,
        expectedRevision,
      );
      if (updated.changes !== 1 && updated.changes !== 1n) {
        throw new ApplicationSettingsConflictError();
      }
      this.deleteExecutablesStatement.run();
      for (const executable of settings.agentExecutables) {
        this.insertExecutableStatement.run(executable.agentId, executable.executablePath);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      if (error instanceof ApplicationSettingsConflictError) {
        throw error;
      }
      throw new SqlitePersistenceError('Application Settings could not be persisted.', {
        cause: error,
      });
    }
  }
}

export class SqliteProjectRepository
  implements LocalProjectLocator, ProjectCatalog, ProjectRepository
{
  private readonly database: DatabaseSync;
  private readonly findByIdStatement: StatementSync;
  private readonly findByPathIdentityStatement: StatementSync;
  private readonly findLocalByIdStatement: StatementSync;
  private readonly insertStatement: StatementSync;
  private readonly insertRootStatement: StatementSync;
  private readonly listRecentStatement: StatementSync;
  private readonly nextOpenedOrderStatement: StatementSync;
  private readonly touchRootStatement: StatementSync;

  public constructor(database: DatabaseSync) {
    this.database = database;
    this.findByIdStatement = database.prepare('SELECT id, name FROM projects WHERE id = ?');
    this.findLocalByIdStatement = database.prepare(
      `SELECT projects.id, projects.name, project_roots.canonical_path
       FROM project_roots
       INNER JOIN projects ON projects.id = project_roots.project_id
       WHERE projects.id = ?`,
    );
    this.findByPathIdentityStatement = database.prepare(
      `SELECT projects.id, projects.name, project_roots.canonical_path
       FROM project_roots
       INNER JOIN projects ON projects.id = project_roots.project_id
       WHERE project_roots.path_identity = ?`,
    );
    this.insertStatement = database.prepare('INSERT INTO projects (id, name) VALUES (?, ?)');
    this.insertRootStatement = database.prepare(
      `INSERT INTO project_roots (
         project_id,
         canonical_path,
         path_identity,
         last_opened_order
       ) VALUES (?, ?, ?, ?)`,
    );
    this.listRecentStatement = database.prepare(
      `SELECT projects.id, projects.name, project_roots.canonical_path
       FROM project_roots
       INNER JOIN projects ON projects.id = project_roots.project_id
       ORDER BY project_roots.last_opened_order DESC, projects.id`,
    );
    this.nextOpenedOrderStatement = database.prepare(
      `SELECT COALESCE(MAX(last_opened_order), 0) + 1 AS next_order
       FROM project_roots`,
    );
    this.touchRootStatement = database.prepare(
      `UPDATE project_roots
       SET last_opened_order = ?
       WHERE project_id = ?`,
    );
  }

  public async findById(id: string): Promise<Project | undefined> {
    const row = this.findByIdStatement.get(id);
    return row === undefined ? undefined : mapProjectRow(row);
  }

  public async findLocalById(id: string): Promise<LocalProject | undefined> {
    const row = this.findLocalByIdStatement.get(id);
    return row === undefined ? undefined : mapLocalProjectRow(row);
  }

  public async insert(project: Project): Promise<void> {
    try {
      this.insertStatement.run(project.id, project.name);
    } catch (error) {
      if (isSqliteErrorCode(error, primaryKeyConstraintCode)) {
        throw new EntityAlreadyExistsError('Project', project.id);
      }

      throw error;
    }
  }

  public async recordOpen(input: RecordProjectOpenInput): Promise<LocalProject> {
    this.database.exec('BEGIN IMMEDIATE');

    try {
      const existingRoot = this.findByPathIdentityStatement.get(input.pathIdentity);
      const nextOpenedOrder = this.readNextOpenedOrder();

      if (existingRoot === undefined) {
        if (this.findByIdStatement.get(input.project.id) === undefined) {
          this.insertStatement.run(input.project.id, input.project.name);
        }

        this.insertRootStatement.run(
          input.project.id,
          input.rootPath,
          input.pathIdentity,
          nextOpenedOrder,
        );
      } else {
        const existingProject = mapLocalProjectRow(existingRoot);
        this.touchRootStatement.run(nextOpenedOrder, existingProject.id);
      }

      const storedRoot = this.findByPathIdentityStatement.get(input.pathIdentity);

      if (storedRoot === undefined) {
        throw new SqlitePersistenceError('Recorded Project root could not be read back.');
      }

      const localProject = mapLocalProjectRow(storedRoot);
      this.database.exec('COMMIT');
      return localProject;
    } catch (error) {
      this.database.exec('ROLLBACK');

      if (error instanceof SqlitePersistenceError) {
        throw error;
      }

      throw new SqlitePersistenceError('Failed to record Project open.', { cause: error });
    }
  }

  public async listRecent(): Promise<readonly LocalProject[]> {
    return this.listRecentStatement.all().map(mapLocalProjectRow);
  }

  private readNextOpenedOrder(): number {
    const row = this.nextOpenedOrderStatement.get();
    const nextOpenedOrder = row?.next_order;

    if (
      typeof nextOpenedOrder !== 'number' ||
      !Number.isSafeInteger(nextOpenedOrder) ||
      nextOpenedOrder <= 0
    ) {
      throw new SqlitePersistenceError('Could not allocate the next Project open order.');
    }

    return nextOpenedOrder;
  }
}

export class SqliteTaskRepository implements TaskCatalog, TaskPlanningRepository, TaskRepository {
  private readonly activeSessionByTaskIdStatement: StatementSync;
  private readonly artifactByIdStatement: StatementSync;
  private readonly database: DatabaseSync;
  private readonly findByIdStatement: StatementSync;
  private readonly insertStatement: StatementSync;
  private readonly listByProjectIdStatement: StatementSync;
  private readonly updateStatement: StatementSync;
  private readonly latestPlanByTaskIdStatement: StatementSync;
  private readonly sessionHistoryByTaskIdStatement: StatementSync;

  public constructor(database: DatabaseSync) {
    this.database = database;
    this.findByIdStatement = database.prepare(
      'SELECT id, project_id, title, brief, phase FROM tasks WHERE id = ?',
    );
    this.insertStatement = database.prepare(
      'INSERT INTO tasks (id, project_id, title, brief, phase) VALUES (?, ?, ?, ?, ?)',
    );
    this.listByProjectIdStatement = database.prepare(
      'SELECT id, project_id, title, brief, phase FROM tasks WHERE project_id = ? ORDER BY id',
    );
    this.updateStatement = database.prepare(
      'UPDATE tasks SET project_id = ?, title = ?, brief = ?, phase = ? WHERE id = ? AND phase = ?',
    );
    this.artifactByIdStatement = database.prepare(
      `SELECT id, task_id, session_id, ordinal, kind, phase, canonical_name,
              format, schema_version, validation, content, created_at
       FROM execution_artifacts WHERE id = ?`,
    );
    this.latestPlanByTaskIdStatement = database.prepare(
      `SELECT id FROM execution_artifacts
       WHERE task_id = ? AND kind = 'plan'
       ORDER BY ordinal DESC LIMIT 1`,
    );
    this.activeSessionByTaskIdStatement = database.prepare(
      `SELECT session.id FROM agent_sessions AS session
       WHERE session.task_id = ? AND ${unsettledAgentSessionWriterSql('session')}
       LIMIT 1`,
    );
    this.sessionHistoryByTaskIdStatement = database.prepare(
      `SELECT id, history_sequence FROM agent_sessions WHERE task_id = ? ORDER BY ordinal`,
    );
  }

  public async findById(id: string): Promise<Task | undefined> {
    const row = this.findByIdStatement.get(id);
    return row === undefined ? undefined : mapTaskRow(row);
  }

  public async insert(task: Task): Promise<void> {
    try {
      this.insertStatement.run(task.id, task.projectId, task.title, task.brief ?? null, task.phase);
    } catch (error) {
      if (
        isSqliteErrorCode(error, primaryKeyConstraintCode) ||
        isSqliteErrorCode(error, uniqueConstraintCode)
      ) {
        throw new EntityAlreadyExistsError('Task', task.id);
      }

      throw error;
    }
  }

  public async listByProjectId(projectId: string): Promise<readonly Task[]> {
    return this.listByProjectIdStatement.all(projectId).map(mapTaskRow);
  }

  public async update(task: Task, expectedPhase: Task['phase']): Promise<void> {
    const result = this.updateStatement.run(
      task.projectId,
      task.title,
      task.brief ?? null,
      task.phase,
      task.id,
      expectedPhase,
    );

    if (result.changes === 0 || result.changes === 0n) {
      throw new SqlitePersistenceError(`Cannot update missing or stale Task ${task.id}.`);
    }
  }

  public async acceptPlan(
    plan: ExecutionArtifact,
    nextTask: Task,
    expectedSessionRevisions: readonly TaskPlanningSessionRevision[],
  ): Promise<void> {
    assertExecutionArtifactContract(plan);
    if (
      plan.kind !== 'plan' ||
      plan.phase !== TaskPhase.PLANNING ||
      plan.sessionId === undefined ||
      plan.taskId !== nextTask.id ||
      nextTask.phase !== TaskPhase.RUNNING
    ) {
      throw new SqlitePersistenceError('Task Plan acceptance evidence is invalid.');
    }

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const taskRow = this.findByIdStatement.get(plan.taskId);
      if (taskRow === undefined) {
        throw new SqlitePersistenceError('Task Plan acceptance Task is missing.');
      }
      const storedTask = mapTaskRow(taskRow);
      let expectedNextTask: Task;
      try {
        expectedNextTask = transitionTask(storedTask, TaskPhase.RUNNING);
      } catch (error) {
        throw new SqlitePersistenceError('Task Plan acceptance phase is stale.', { cause: error });
      }
      if (!sameTask(expectedNextTask, nextTask)) {
        throw new SqlitePersistenceError('Task Plan acceptance next Task is stale.');
      }
      if (this.activeSessionByTaskIdStatement.get(plan.taskId) !== undefined) {
        throw new SqlitePersistenceError(
          'Task Plan cannot be accepted while an Agent Session is active.',
        );
      }
      assertExactSessionRevisions(
        this.sessionHistoryByTaskIdStatement.all(plan.taskId),
        expectedSessionRevisions,
      );
      const storedPlanRow = this.artifactByIdStatement.get(plan.id);
      if (
        storedPlanRow === undefined ||
        JSON.stringify(mapExecutionArtifactRow(storedPlanRow)) !== JSON.stringify(plan) ||
        this.latestPlanByTaskIdStatement.get(plan.taskId)?.id !== plan.id
      ) {
        throw new SqlitePersistenceError('Task Plan is not the exact latest persisted Plan.');
      }
      const result = this.updateStatement.run(
        nextTask.projectId,
        nextTask.title,
        nextTask.brief ?? null,
        nextTask.phase,
        nextTask.id,
        TaskPhase.PLANNING,
      );
      if (result.changes === 0 || result.changes === 0n) {
        throw new SqlitePersistenceError('Task Plan acceptance phase update is stale.');
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      if (error instanceof SqlitePersistenceError) throw error;
      throw new SqlitePersistenceError('Failed to accept Task Plan.', { cause: error });
    }
  }
}

export class SqliteTaskDependencyRepository implements TaskDependencyRepository {
  private readonly cycleStatement: StatementSync;
  private readonly database: DatabaseSync;
  private readonly deleteStatement: StatementSync;
  private readonly findTaskStatement: StatementSync;
  private readonly insertStatement: StatementSync;
  private readonly listByProjectIdStatement: StatementSync;
  private readonly listByTaskIdStatement: StatementSync;

  public constructor(database: DatabaseSync) {
    this.database = database;
    this.findTaskStatement = database.prepare('SELECT id, project_id FROM tasks WHERE id = ?');
    this.insertStatement = database.prepare(
      `INSERT INTO task_dependencies (task_id, dependency_task_id, project_id)
       VALUES (?, ?, ?)`,
    );
    this.deleteStatement = database.prepare(
      'DELETE FROM task_dependencies WHERE task_id = ? AND dependency_task_id = ?',
    );
    this.listByTaskIdStatement = database.prepare(
      `SELECT task_id, dependency_task_id FROM task_dependencies
       WHERE task_id = ? ORDER BY dependency_task_id`,
    );
    this.listByProjectIdStatement = database.prepare(
      `SELECT task_id, dependency_task_id FROM task_dependencies
       WHERE project_id = ? ORDER BY task_id, dependency_task_id`,
    );
    this.cycleStatement = database.prepare(
      `WITH RECURSIVE reachable(task_id) AS (
         SELECT dependency_task_id FROM task_dependencies WHERE task_id = ?
         UNION
         SELECT dependency.dependency_task_id
         FROM task_dependencies AS dependency
         INNER JOIN reachable ON dependency.task_id = reachable.task_id
       )
       SELECT 1 AS found FROM reachable WHERE task_id = ? LIMIT 1`,
    );
  }

  public async add(input: TaskDependency): Promise<void> {
    const dependency = createTaskDependency(input);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const task = this.findTaskStatement.get(dependency.taskId);
      const requiredTask = this.findTaskStatement.get(dependency.dependencyTaskId);
      if (task === undefined) throw new EntityNotFoundError('Task', dependency.taskId);
      if (requiredTask === undefined) {
        throw new EntityNotFoundError('Task', dependency.dependencyTaskId);
      }
      const projectId = task.project_id;
      const requiredProjectId = requiredTask.project_id;
      if (typeof projectId !== 'string' || typeof requiredProjectId !== 'string') {
        throw new SqlitePersistenceError('Task dependency Project identity is invalid.');
      }
      if (projectId !== requiredProjectId) {
        throw new TaskDependencyProjectMismatchError(
          dependency.taskId,
          dependency.dependencyTaskId,
        );
      }
      if (
        this.listByTaskIdStatement
          .all(dependency.taskId)
          .some((row) => row.dependency_task_id === dependency.dependencyTaskId)
      ) {
        throw new InvalidTaskDependencyError('DUPLICATE');
      }
      if (this.cycleStatement.get(dependency.dependencyTaskId, dependency.taskId) !== undefined) {
        throw new InvalidTaskDependencyError('CYCLE');
      }
      this.insertStatement.run(dependency.taskId, dependency.dependencyTaskId, projectId);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      if (
        error instanceof EntityNotFoundError ||
        error instanceof InvalidTaskDependencyError ||
        error instanceof TaskDependencyProjectMismatchError
      ) {
        throw error;
      }
      throw new SqlitePersistenceError('Failed to add Task dependency.', { cause: error });
    }
  }

  public async remove(dependency: TaskDependency): Promise<boolean> {
    const validated = createTaskDependency(dependency);
    const result = this.deleteStatement.run(validated.taskId, validated.dependencyTaskId);
    return result.changes !== 0 && result.changes !== 0n;
  }

  public async listByTaskId(taskId: string): Promise<readonly TaskDependency[]> {
    return this.listByTaskIdStatement.all(taskId).map(mapTaskDependencyRow);
  }

  public async listByProjectId(projectId: string): Promise<readonly TaskDependency[]> {
    return this.listByProjectIdStatement.all(projectId).map(mapTaskDependencyRow);
  }
}

export class SqlitePullRequestRepository implements PullRequestRepository {
  private readonly database: DatabaseSync;
  private readonly findBranchStatement: StatementSync;
  private readonly findPullRequestStatement: StatementSync;
  private readonly insertHistoryStatement: StatementSync;
  private readonly listByTaskIdStatement: StatementSync;
  private readonly nextHistoryOrdinalStatement: StatementSync;
  private readonly recordStatement: StatementSync;
  private readonly updateStatement: StatementSync;

  public constructor(database: DatabaseSync) {
    this.database = database;
    const selection = `
      task_id, provider, repository_owner, repository_name, base_branch, head_branch,
      pull_request_number, url, title, head_commit_id, status, draft, created_at, updated_at,
      review_state, check_state, check_total_count, check_success_count, check_failure_count,
      check_pending_count, last_synced_at`;
    this.listByTaskIdStatement = database.prepare(
      `SELECT ${selection}
       FROM task_pull_requests
       WHERE task_id = ?
       ORDER BY COALESCE(last_synced_at, updated_at), pull_request_number`,
    );
    this.findBranchStatement = database.prepare(
      `SELECT ${selection}
       FROM task_pull_requests
       WHERE task_id = ? AND provider = ? AND repository_owner = ? AND repository_name = ?
         AND base_branch = ? AND head_branch = ?`,
    );
    this.findPullRequestStatement = database.prepare(
      `SELECT ${selection}
       FROM task_pull_requests
       WHERE task_id = ? AND provider = ? AND repository_owner = ? AND repository_name = ?
         AND pull_request_number = ?`,
    );
    this.recordStatement = database.prepare(
      `INSERT INTO task_pull_requests (
         task_id, provider, repository_owner, repository_name, base_branch, head_branch,
         pull_request_number, url, title, head_commit_id, status, draft, created_at, updated_at,
         review_state, check_state, check_total_count, check_success_count, check_failure_count,
         check_pending_count, last_synced_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.updateStatement = database.prepare(
      `UPDATE task_pull_requests SET
         base_branch = ?, head_branch = ?, pull_request_number = ?, url = ?, title = ?,
         head_commit_id = ?, status = ?, draft = ?,
         created_at = ?, updated_at = ?, review_state = ?, check_state = ?,
         check_total_count = ?, check_success_count = ?, check_failure_count = ?,
         check_pending_count = ?, last_synced_at = ?
       WHERE task_id = ? AND provider = ? AND repository_owner = ? AND repository_name = ?
         AND base_branch = ? AND head_branch = ?`,
    );
    this.nextHistoryOrdinalStatement = database.prepare(
      `SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal
       FROM task_pull_request_sync_history
       WHERE task_id = ? AND provider = ? AND repository_owner = ? AND repository_name = ?
         AND pull_request_number = ?`,
    );
    this.insertHistoryStatement = database.prepare(
      `INSERT INTO task_pull_request_sync_history (
         task_id, provider, repository_owner, repository_name, base_branch, head_branch, ordinal,
         pull_request_number, url, title, head_commit_id, status, draft, created_at, updated_at,
         review_state, check_state, check_total_count, check_success_count, check_failure_count,
         check_pending_count, last_synced_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  public async listByTaskId(taskId: string): Promise<readonly TaskPullRequest[]> {
    return this.listByTaskIdStatement.all(taskId).map(mapTaskPullRequestRow);
  }

  public async record(pullRequest: TaskPullRequest): Promise<void> {
    assertTaskPullRequestMetadata(pullRequest);
    try {
      this.database.exec('BEGIN IMMEDIATE');
      const branchIdentity = pullRequestBranchIdentityParameters(pullRequest);
      const remoteIdentity = pullRequestRemoteIdentityParameters(pullRequest);
      const row =
        this.findPullRequestStatement.get(...remoteIdentity) ??
        this.findBranchStatement.get(...branchIdentity);
      const current = row === undefined ? undefined : mapTaskPullRequestRow(row);
      if (current !== undefined && sameTaskPullRequest(current, pullRequest)) {
        this.database.exec('COMMIT');
        return;
      }
      if (current !== undefined && !isNewerPullRequestSnapshot(current, pullRequest)) {
        this.database.exec('COMMIT');
        return;
      }
      if (current === undefined) {
        this.recordStatement.run(...pullRequestPersistenceParameters(pullRequest));
      } else {
        this.updateStatement.run(
          pullRequest.baseBranch,
          pullRequest.headBranch,
          ...pullRequestMutableParameters(pullRequest),
          ...pullRequestBranchIdentityParameters(current),
        );
      }
      const ordinalRow = this.nextHistoryOrdinalStatement.get(...remoteIdentity);
      const ordinal = ordinalRow?.ordinal;
      if (typeof ordinal !== 'number' && typeof ordinal !== 'bigint') {
        throw new Error('Pull Request sync history ordinal is invalid.');
      }
      this.insertHistoryStatement.run(
        ...remoteIdentity.slice(0, 4),
        pullRequest.baseBranch,
        pullRequest.headBranch,
        ordinal,
        pullRequest.number,
        ...pullRequestMutableParameters(pullRequest).slice(1),
      );
      this.database.exec('COMMIT');
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw new SqlitePersistenceError('Failed to persist Pull Request metadata.', {
        cause: error,
      });
    }
  }
}

export class SqliteTaskWorktreeRepository implements TaskWorktreeRepository {
  private readonly findByTaskIdStatement: StatementSync;
  private readonly insertStatement: StatementSync;
  private readonly transitionStateStatement: StatementSync;

  public constructor(database: DatabaseSync) {
    this.findByTaskIdStatement = database.prepare(
      `SELECT
         task_id,
         repository_root_path,
         worktree_path,
         path_identity,
         branch_name,
         base_ref_name,
         base_commit_id,
         lifecycle_state
       FROM task_worktrees
       WHERE task_id = ?`,
    );
    this.insertStatement = database.prepare(
      `INSERT INTO task_worktrees (
         task_id,
         repository_root_path,
         worktree_path,
         path_identity,
         branch_name,
         base_ref_name,
         base_commit_id,
         lifecycle_state
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PROVISIONING')
       RETURNING
         task_id,
         repository_root_path,
         worktree_path,
         path_identity,
         branch_name,
         base_ref_name,
         base_commit_id,
         lifecycle_state`,
    );
    this.transitionStateStatement = database.prepare(
      `UPDATE task_worktrees
       SET lifecycle_state = ?
       WHERE task_id = ? AND lifecycle_state = ?
       RETURNING
         task_id,
         repository_root_path,
         worktree_path,
         path_identity,
         branch_name,
         base_ref_name,
         base_commit_id,
         lifecycle_state`,
    );
  }

  public async findByTaskId(taskId: string): Promise<TaskWorktreeRecord | undefined> {
    const row = this.findByTaskIdStatement.get(taskId);
    return row === undefined ? undefined : mapTaskWorktreeRow(row);
  }

  public async insertReservation(worktree: TaskWorktree): Promise<TaskWorktreeRecord> {
    if (!isGitObjectId(worktree.baseCommitId)) {
      throw new SqlitePersistenceError('Task Worktree base commit id is invalid.');
    }

    let row: ReturnType<StatementSync['get']>;

    try {
      row = this.insertStatement.get(
        worktree.taskId,
        worktree.repositoryRootPath,
        worktree.worktreePath,
        worktree.pathIdentity,
        worktree.branchName,
        worktree.baseRefName,
        worktree.baseCommitId,
      );
    } catch (error) {
      if (isSqliteMetadataConflictError(error)) {
        throw new TaskWorktreeMetadataConflictError(worktree.taskId, { cause: error });
      }

      throw new SqlitePersistenceError('Failed to reserve Task Worktree metadata.', {
        cause: error,
      });
    }

    if (row === undefined) {
      throw new SqlitePersistenceError('Task Worktree reservation was not returned after insert.');
    }

    return mapTaskWorktreeRow(row);
  }

  public async transitionState(
    taskId: string,
    expectedState: TaskWorktreeLifecycleState,
    nextState: TaskWorktreeLifecycleState,
  ): Promise<TaskWorktreeRecord> {
    let row: ReturnType<StatementSync['get']>;

    try {
      row = this.transitionStateStatement.get(nextState, taskId, expectedState);
    } catch (error) {
      throw new SqlitePersistenceError('Failed to transition Task Worktree metadata.', {
        cause: error,
      });
    }

    if (row === undefined) {
      throw new TaskWorktreeMetadataConflictError(taskId);
    }

    return mapTaskWorktreeRow(row);
  }
}

export class SqliteQualityGateRunRepository implements QualityGateRunRepository {
  private readonly database: DatabaseSync;
  private readonly finalizeStatement: StatementSync;
  private readonly findByIdStatement: StatementSync;
  private readonly insertStatement: StatementSync;
  private readonly listByTaskIdStatement: StatementSync;
  private readonly listRecentByTaskIdStatement: StatementSync;
  private readonly nextOrdinalStatement: StatementSync;
  private readonly reviewEvidenceByTaskIdStatement: StatementSync;
  private readonly reviewEvidenceSummaryByTaskIdStatement: StatementSync;
  private readonly taskPhaseByIdStatement: StatementSync;

  public constructor(database: DatabaseSync) {
    this.database = database;
    const selectedColumns = `
      id, task_id, ordinal, gate_id, gate_kind, executable_path, arguments_json,
      timeout_ms, worktree_path_identity, worktree_path, worktree_branch_name,
      worktree_base_commit_id, worktree_head_commit_id, status, started_at,
      finished_at, duration_ms, exit_code,
      failure_category, output_reference, output_text, output_truncated`;
    this.findByIdStatement = database.prepare(
      `SELECT ${selectedColumns} FROM quality_gate_runs WHERE id = ?`,
    );
    this.listByTaskIdStatement = database.prepare(
      `SELECT ${selectedColumns}
       FROM quality_gate_runs WHERE task_id = ? ORDER BY ordinal`,
    );
    this.listRecentByTaskIdStatement = database.prepare(
      `WITH recent AS (
         SELECT id FROM quality_gate_runs
         WHERE task_id = ?
         ORDER BY ordinal DESC
         LIMIT ?
       )
       SELECT ${selectedColumns}
       FROM quality_gate_runs
       WHERE id IN (SELECT id FROM recent)
       ORDER BY ordinal`,
    );
    this.reviewEvidenceSummaryByTaskIdStatement = database.prepare(
      `SELECT COUNT(*) AS total_count,
              COALESCE(MAX(CASE WHEN status = 'RUNNING' THEN 1 ELSE 0 END), 0) AS has_running
       FROM quality_gate_runs
       WHERE task_id = ?`,
    );
    this.reviewEvidenceByTaskIdStatement = database.prepare(
      `SELECT id AS quality_gate_run_id, gate_id, gate_kind AS kind,
              status AS observed_status, worktree_path_identity,
              worktree_branch_name AS branch_name, worktree_base_commit_id AS base_commit_id,
              worktree_head_commit_id AS head_commit_id_at_start, started_at, finished_at
       FROM quality_gate_runs
       WHERE task_id = ?
       ORDER BY ordinal
       LIMIT ?`,
    );
    this.nextOrdinalStatement = database.prepare(
      `SELECT COALESCE(MAX(ordinal), 0) + 1 AS next_ordinal
       FROM quality_gate_runs WHERE task_id = ?`,
    );
    this.taskPhaseByIdStatement = database.prepare('SELECT phase FROM tasks WHERE id = ?');
    this.insertStatement = database.prepare(
      `INSERT INTO quality_gate_runs (
         id, task_id, ordinal, gate_id, gate_kind, executable_path, arguments_json,
         timeout_ms, worktree_path_identity, worktree_path, worktree_branch_name,
         worktree_base_commit_id, worktree_head_commit_id, status, started_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?)`,
    );
    this.finalizeStatement = database.prepare(
      `UPDATE quality_gate_runs
       SET status = ?, finished_at = ?, duration_ms = ?, exit_code = ?, failure_category = ?,
           output_reference = ?, output_text = ?, output_truncated = ?
       WHERE id = ? AND status = ?`,
    );
  }

  public async findById(id: string): Promise<QualityGateRun | undefined> {
    const row = this.findByIdStatement.get(id);
    return row === undefined ? undefined : mapQualityGateRunRow(row);
  }

  public async listByTaskId(taskId: string): Promise<readonly QualityGateRun[]> {
    return this.listByTaskIdStatement.all(taskId).map(mapQualityGateRunRow);
  }

  public async listRecentByTaskId(
    taskId: string,
    limit: number,
  ): Promise<readonly QualityGateRun[]> {
    assertPositiveHistoryLimit(limit, 'Quality Gate Run');
    return this.listRecentByTaskIdStatement.all(taskId, limit).map(mapQualityGateRunRow);
  }

  public async readReviewEvidenceByTaskId(taskId: string, limit: number) {
    assertNonnegativeHistoryLimit(limit, 'Quality Gate Run Review evidence');
    const summary = this.reviewEvidenceSummaryByTaskIdStatement.get(taskId);
    const totalCount = readHistoryCount(summary, 'Quality Gate Run');
    const hasRunning = readHistoryBoolean(summary, 'has_running', 'Quality Gate Run');
    return Object.freeze({
      evidence: Object.freeze(
        totalCount > limit
          ? []
          : this.reviewEvidenceByTaskIdStatement
              .all(taskId, limit)
              .map(mapTaskReviewQualityGateEvidenceSourceRow),
      ),
      hasRunning,
      totalCount,
    });
  }

  public async insert(run: QualityGateRun): Promise<void> {
    assertRunningQualityGateRun(run);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (this.findByIdStatement.get(run.id) !== undefined) {
        throw new EntityAlreadyExistsError('QualityGateRun', run.id);
      }
      const taskRow = this.taskPhaseByIdStatement.get(run.taskId);
      if (taskRow?.phase === TaskPhase.REVIEW || taskRow?.phase === TaskPhase.DONE) {
        throw new SqlitePersistenceError(
          'A Quality Gate Run cannot start while its Task is in REVIEW or DONE.',
        );
      }
      const ordinalRow = this.nextOrdinalStatement.get(run.taskId);
      const ordinal = ordinalRow?.next_ordinal;
      if (typeof ordinal !== 'number' || !Number.isSafeInteger(ordinal) || ordinal <= 0) {
        throw new SqlitePersistenceError('Could not allocate the next Quality Gate Run ordinal.');
      }
      this.insertStatement.run(
        run.id,
        run.taskId,
        ordinal,
        run.gate.id,
        run.gate.kind,
        run.gate.command.executablePath,
        JSON.stringify(run.gate.command.arguments),
        run.gate.timeoutMs,
        run.worktree.pathIdentity,
        run.worktree.worktreePath,
        run.worktree.branchName,
        run.worktree.baseCommitId,
        run.worktree.headCommitIdAtStart,
        run.startedAt,
      );
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      if (error instanceof EntityAlreadyExistsError || error instanceof SqlitePersistenceError) {
        throw error;
      }
      if (isSqliteErrorCode(error, primaryKeyConstraintCode)) {
        throw new EntityAlreadyExistsError('QualityGateRun', run.id);
      }
      throw new SqlitePersistenceError('Failed to insert Quality Gate Run.', { cause: error });
    }
  }

  public async finalize(run: QualityGateRun, expectedStatus: 'RUNNING'): Promise<void> {
    if (
      expectedStatus !== QualityGateRunStatus.RUNNING ||
      run.status === QualityGateRunStatus.RUNNING
    ) {
      throw new SqlitePersistenceError('Quality Gate Run finalize evidence is invalid.');
    }

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const storedRow = this.findByIdStatement.get(run.id);
      if (storedRow === undefined) {
        throw new SqlitePersistenceError('Quality Gate Run finalize target is missing.');
      }
      const stored = mapQualityGateRunRow(storedRow);
      if (stored.status !== expectedStatus) {
        if (sameQualityGateRun(stored, run)) {
          this.database.exec('COMMIT');
          return;
        }
        throw new SqlitePersistenceError('Quality Gate Run is already finalized differently.');
      }
      if (!sameQualityGateRunIdentity(stored, run) || run.output === undefined) {
        throw new SqlitePersistenceError(
          'Quality Gate Run terminal evidence does not match its stored identity.',
        );
      }
      const result = this.finalizeStatement.run(
        run.status,
        run.finishedAt ?? null,
        run.durationMs ?? null,
        run.exitCode ?? null,
        run.failureCategory ?? null,
        run.output.reference,
        run.output.text,
        Number(run.output.truncated),
        run.id,
        expectedStatus,
      );
      if (result.changes === 0 || result.changes === 0n) {
        throw new SqlitePersistenceError('Quality Gate Run finalize revision is stale.');
      }
      const finalizedRow = this.findByIdStatement.get(run.id);
      if (
        finalizedRow === undefined ||
        !sameQualityGateRun(mapQualityGateRunRow(finalizedRow), run)
      ) {
        throw new SqlitePersistenceError('Quality Gate Run finalize evidence did not persist.');
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      if (error instanceof SqlitePersistenceError) {
        throw error;
      }
      throw new SqlitePersistenceError('Failed to finalize Quality Gate Run.', { cause: error });
    }
  }
}

export class SqliteTaskReviewRepository implements TaskReviewRepository {
  private readonly activeSessionByTaskIdStatement: StatementSync;
  private readonly artifactByIdentityStatement: StatementSync;
  private readonly artifactHistoryIdsStatement: StatementSync;
  private readonly artifactEvidenceByReviewIdStatement: StatementSync;
  private readonly changedPathsByReviewIdStatement: StatementSync;
  private readonly database: DatabaseSync;
  private readonly decideStatement: StatementSync;
  private readonly findByIdStatement: StatementSync;
  private readonly gateByIdentityStatement: StatementSync;
  private readonly gateHistoryIdsStatement: StatementSync;
  private readonly gateEvidenceByReviewIdStatement: StatementSync;
  private readonly insertArtifactEvidenceStatement: StatementSync;
  private readonly insertChangedPathStatement: StatementSync;
  private readonly insertGateEvidenceStatement: StatementSync;
  private readonly insertReviewStatement: StatementSync;
  private readonly listByTaskIdStatement: StatementSync;
  private readonly listRecentByTaskIdStatement: StatementSync;
  private readonly nextOrdinalStatement: StatementSync;
  private readonly pendingByTaskIdStatement: StatementSync;
  private readonly reviewCountByTaskIdStatement: StatementSync;
  private readonly runningGateByTaskIdStatement: StatementSync;
  private readonly sessionHistoryByTaskIdStatement: StatementSync;
  private readonly taskByIdStatement: StatementSync;
  private readonly transitionTaskStatement: StatementSync;
  private readonly worktreeByTaskIdStatement: StatementSync;

  public constructor(database: DatabaseSync) {
    this.database = database;
    const reviewColumns = `
      id, task_id, ordinal, status, requested_at, decided_at, decision_note,
      code_schema_version, worktree_path_identity, branch_name, base_commit_id,
      head_commit_id, code_state_fingerprint, changes_total, changes_truncated`;
    this.findByIdStatement = database.prepare(
      `SELECT ${reviewColumns} FROM task_reviews WHERE id = ?`,
    );
    this.listByTaskIdStatement = database.prepare(
      `SELECT ${reviewColumns} FROM task_reviews WHERE task_id = ? ORDER BY ordinal`,
    );
    this.listRecentByTaskIdStatement = database.prepare(
      `SELECT ${reviewColumns}
       FROM task_reviews
       WHERE task_id = ?
       ORDER BY ordinal DESC
       LIMIT ?`,
    );
    this.changedPathsByReviewIdStatement = database.prepare(
      `SELECT category, ordinal, path
       FROM task_review_changed_paths
       WHERE review_id = ?
       ORDER BY category, ordinal`,
    );
    this.artifactEvidenceByReviewIdStatement = database.prepare(
      `SELECT ordinal, artifact_id, kind, phase, session_id, created_at
       FROM task_review_artifacts
       WHERE review_id = ?
       ORDER BY ordinal`,
    );
    this.gateEvidenceByReviewIdStatement = database.prepare(
      `SELECT
         ordinal, quality_gate_run_id, gate_id, kind, observed_status,
         worktree_path_identity, branch_name, base_commit_id, head_commit_id_at_start,
         started_at, finished_at, association
       FROM task_review_quality_gates
       WHERE review_id = ?
       ORDER BY ordinal`,
    );
    this.taskByIdStatement = database.prepare(
      'SELECT id, project_id, title, brief, phase FROM tasks WHERE id = ?',
    );
    this.activeSessionByTaskIdStatement = database.prepare(
      `SELECT session.id
       FROM agent_sessions AS session
       WHERE session.task_id = ?
         AND ${unsettledAgentSessionWriterSql('session')}
       LIMIT 1`,
    );
    this.worktreeByTaskIdStatement = database.prepare(
      `SELECT path_identity, branch_name, base_commit_id, lifecycle_state
       FROM task_worktrees WHERE task_id = ?`,
    );
    this.pendingByTaskIdStatement = database.prepare(
      `SELECT id FROM task_reviews WHERE task_id = ? AND status = 'PENDING' LIMIT 1`,
    );
    this.reviewCountByTaskIdStatement = database.prepare(
      'SELECT COUNT(*) AS count FROM task_reviews WHERE task_id = ?',
    );
    this.runningGateByTaskIdStatement = database.prepare(
      `SELECT id FROM quality_gate_runs
       WHERE task_id = ? AND status = 'RUNNING'
       LIMIT 1`,
    );
    this.sessionHistoryByTaskIdStatement = database.prepare(
      `SELECT id, history_sequence
       FROM agent_sessions
       WHERE task_id = ?
       ORDER BY ordinal`,
    );
    this.nextOrdinalStatement = database.prepare(
      `SELECT COALESCE(MAX(ordinal), 0) + 1 AS next_ordinal
       FROM task_reviews WHERE task_id = ?`,
    );
    this.insertReviewStatement = database.prepare(
      `INSERT INTO task_reviews (
         id, task_id, ordinal, status, requested_at, decided_at, decision_note,
         code_schema_version, worktree_path_identity, branch_name, base_commit_id,
         head_commit_id, code_state_fingerprint, changes_total, changes_truncated
       ) VALUES (?, ?, ?, 'PENDING', ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertChangedPathStatement = database.prepare(
      `INSERT INTO task_review_changed_paths (review_id, task_id, category, ordinal, path)
       VALUES (?, ?, ?, ?, ?)`,
    );
    this.insertArtifactEvidenceStatement = database.prepare(
      `INSERT INTO task_review_artifacts (
         review_id, task_id, ordinal, artifact_id, kind, phase, session_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertGateEvidenceStatement = database.prepare(
      `INSERT INTO task_review_quality_gates (
         review_id, task_id, ordinal, quality_gate_run_id, gate_id, kind, observed_status,
         worktree_path_identity, branch_name, base_commit_id, head_commit_id_at_start,
         started_at, finished_at, association
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.transitionTaskStatement = database.prepare(
      'UPDATE tasks SET phase = ? WHERE id = ? AND phase = ?',
    );
    this.decideStatement = database.prepare(
      `UPDATE task_reviews
       SET status = ?, decided_at = ?, decision_note = ?
       WHERE id = ? AND status = ?`,
    );
    this.artifactByIdentityStatement = database.prepare(
      `SELECT id AS artifact_id, session_id, kind, phase, created_at
       FROM execution_artifacts WHERE id = ? AND task_id = ?`,
    );
    this.artifactHistoryIdsStatement = database.prepare(
      `SELECT id FROM execution_artifacts WHERE task_id = ? ORDER BY ordinal`,
    );
    this.gateByIdentityStatement = database.prepare(
      `SELECT id AS quality_gate_run_id, gate_id, gate_kind AS kind,
              status AS observed_status, worktree_path_identity,
              worktree_branch_name AS branch_name, worktree_base_commit_id AS base_commit_id,
              worktree_head_commit_id AS head_commit_id_at_start, started_at, finished_at
       FROM quality_gate_runs WHERE id = ? AND task_id = ?`,
    );
    this.gateHistoryIdsStatement = database.prepare(
      `SELECT id FROM quality_gate_runs WHERE task_id = ? ORDER BY ordinal`,
    );
  }

  public async findById(id: string): Promise<TaskReview | undefined> {
    const row = this.findByIdStatement.get(id);
    return row === undefined ? undefined : this.mapReview(row);
  }

  public async listByTaskId(taskId: string): Promise<readonly TaskReview[]> {
    return this.listByTaskIdStatement.all(taskId).map((row) => this.mapReview(row));
  }

  public async listRecentByTaskId(taskId: string, limit: number): Promise<readonly TaskReview[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new TypeError('Task Review recent-history limit must be a positive safe integer.');
    }
    return this.listRecentByTaskIdStatement
      .all(taskId, limit)
      .reverse()
      .map((row) => this.mapReview(row));
  }

  public async begin(
    review: TaskReview,
    expectedTaskPhase: 'REVIEW' | 'RUNNING',
    nextTask: Task,
    expectedSessionRevisions: readonly TaskReviewSessionRevision[],
  ): Promise<void> {
    assertPendingTaskReview(review);
    if (expectedTaskPhase !== TaskPhase.RUNNING && expectedTaskPhase !== TaskPhase.REVIEW) {
      throw new SqlitePersistenceError('Task Review begin phase is invalid.');
    }

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const storedTask = this.readTaskForReview(review.taskId);
      if (expectedTaskPhase === TaskPhase.RUNNING) {
        assertTaskReviewTransition(storedTask, expectedTaskPhase, nextTask, TaskPhase.REVIEW);
      } else {
        const count = this.reviewCountByTaskIdStatement.get(review.taskId)?.count;
        if (
          storedTask.phase !== TaskPhase.REVIEW ||
          !sameTask(storedTask, nextTask) ||
          count !== 0
        ) {
          throw new SqlitePersistenceError('Legacy Task Review recovery is not eligible.');
        }
      }
      if (this.findByIdStatement.get(review.id) !== undefined) {
        throw new SqlitePersistenceError(`Task Review ${review.id} already exists.`);
      }
      if (this.activeSessionByTaskIdStatement.get(review.taskId) !== undefined) {
        throw new SqlitePersistenceError(
          'Task Review cannot begin while an Agent Session is active.',
        );
      }
      assertExactSessionRevisions(
        this.sessionHistoryByTaskIdStatement.all(review.taskId),
        expectedSessionRevisions,
      );
      if (this.runningGateByTaskIdStatement.get(review.taskId) !== undefined) {
        throw new SqlitePersistenceError(
          'Task Review cannot begin while a Quality Gate Run is active.',
        );
      }
      if (this.pendingByTaskIdStatement.get(review.taskId) !== undefined) {
        throw new SqlitePersistenceError('Task already has a pending Review.');
      }
      this.assertCodeStateMatchesStoredWorktree(review);
      this.assertEvidenceMatchesStorage(review);

      const ordinal = this.nextOrdinalStatement.get(review.taskId)?.next_ordinal;
      if (typeof ordinal !== 'number' || !Number.isSafeInteger(ordinal) || ordinal <= 0) {
        throw new SqlitePersistenceError('Could not allocate the next Task Review ordinal.');
      }
      this.insertReview(review, ordinal);
      this.insertReviewEvidence(review);
      if (expectedTaskPhase === TaskPhase.RUNNING) {
        const transitioned = this.transitionTaskStatement.run(
          nextTask.phase,
          nextTask.id,
          expectedTaskPhase,
        );
        if (transitioned.changes === 0 || transitioned.changes === 0n) {
          throw new SqlitePersistenceError('Task Review begin Task phase is stale.');
        }
      }
      const storedReview = this.findByIdStatement.get(review.id);
      if (storedReview === undefined || !sameTaskReview(this.mapReview(storedReview), review)) {
        throw new SqlitePersistenceError('Task Review begin evidence did not persist.');
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      if (error instanceof SqlitePersistenceError) {
        throw error;
      }
      throw new SqlitePersistenceError('Failed to begin Task Review.', { cause: error });
    }
  }

  public async decide(
    review: TaskReview,
    expectedStatus: 'PENDING',
    expectedTaskPhase: 'REVIEW',
    nextTask: Task,
  ): Promise<void> {
    assertTerminalTaskReview(review);
    if (expectedStatus !== TaskReviewStatus.PENDING || expectedTaskPhase !== TaskPhase.REVIEW) {
      throw new SqlitePersistenceError('Task Review decision revision is invalid.');
    }

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const storedRow = this.findByIdStatement.get(review.id);
      if (storedRow === undefined) {
        throw new SqlitePersistenceError('Task Review decision target is missing.');
      }
      const stored = this.mapReview(storedRow);
      const targetPhase =
        review.status === TaskReviewStatus.APPROVED ? TaskPhase.DONE : TaskPhase.RUNNING;
      const storedTask = this.readTaskForReview(review.taskId);

      if (
        targetPhase === TaskPhase.DONE &&
        this.runningGateByTaskIdStatement.get(review.taskId) !== undefined
      ) {
        throw new SqlitePersistenceError(
          'Task Review cannot be approved while a Quality Gate Run is active.',
        );
      }

      if (stored.status !== expectedStatus) {
        if (sameTaskReview(stored, review) && sameTask(storedTask, nextTask)) {
          this.database.exec('COMMIT');
          return;
        }
        throw new SqlitePersistenceError('Task Review is already decided differently.');
      }
      assertSameTaskReviewIdentity(stored, review);
      assertTaskReviewTransition(storedTask, expectedTaskPhase, nextTask, targetPhase);

      const decided = this.decideStatement.run(
        review.status,
        review.decidedAt ?? null,
        review.decisionNote ?? null,
        review.id,
        expectedStatus,
      );
      if (decided.changes === 0 || decided.changes === 0n) {
        throw new SqlitePersistenceError('Task Review decision revision is stale.');
      }
      const transitioned = this.transitionTaskStatement.run(
        nextTask.phase,
        nextTask.id,
        expectedTaskPhase,
      );
      if (transitioned.changes === 0 || transitioned.changes === 0n) {
        throw new SqlitePersistenceError('Task Review decision Task phase is stale.');
      }
      const finalizedRow = this.findByIdStatement.get(review.id);
      if (finalizedRow === undefined || !sameTaskReview(this.mapReview(finalizedRow), review)) {
        throw new SqlitePersistenceError('Task Review decision evidence did not persist.');
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      if (error instanceof SqlitePersistenceError) {
        throw error;
      }
      throw new SqlitePersistenceError('Failed to decide Task Review.', { cause: error });
    }
  }

  private mapReview(row: ReturnType<StatementSync['get']>): TaskReview {
    if (row === undefined || typeof row.id !== 'string') {
      throw new SqlitePersistenceError('Task Review row is invalid.');
    }
    return mapTaskReviewRows(
      row,
      this.changedPathsByReviewIdStatement.all(row.id),
      this.artifactEvidenceByReviewIdStatement.all(row.id),
      this.gateEvidenceByReviewIdStatement.all(row.id),
    );
  }

  private readTaskForReview(taskId: string): Task {
    const row = this.taskByIdStatement.get(taskId);
    if (row === undefined) {
      throw new SqlitePersistenceError(`Task Review Task ${taskId} is missing.`);
    }
    return mapTaskRow(row);
  }

  private assertEvidenceMatchesStorage(review: TaskReview): void {
    assertExactEvidenceIds(
      this.artifactHistoryIdsStatement.all(review.taskId),
      review.artifacts.map(({ id }) => id),
      'Artifact',
    );
    assertExactEvidenceIds(
      this.gateHistoryIdsStatement.all(review.taskId),
      review.qualityGates.map(({ id }) => id),
      'Quality Gate Run',
    );
    for (const evidence of review.artifacts) {
      const row = this.artifactByIdentityStatement.get(evidence.id, review.taskId);
      if (row === undefined) {
        throw new SqlitePersistenceError(
          `Task Review Artifact evidence ${evidence.id} is missing or belongs to another Task.`,
        );
      }
      const artifact = mapTaskReviewArtifactEvidenceSourceRow(row);
      if (
        artifact.id !== evidence.id ||
        artifact.kind !== evidence.kind ||
        artifact.phase !== evidence.phase ||
        artifact.sessionId !== evidence.sessionId ||
        artifact.createdAt !== evidence.createdAt
      ) {
        throw new SqlitePersistenceError(`Task Review Artifact evidence ${evidence.id} is stale.`);
      }
    }
    for (const evidence of review.qualityGates) {
      const row = this.gateByIdentityStatement.get(evidence.id, review.taskId);
      if (row === undefined) {
        throw new SqlitePersistenceError(
          `Task Review Quality Gate evidence ${evidence.id} is missing or belongs to another Task.`,
        );
      }
      const run = mapTaskReviewQualityGateEvidenceSourceRow(row);
      if (
        run.id !== evidence.id ||
        run.gateId !== evidence.gateId ||
        run.kind !== evidence.kind ||
        run.observedStatus !== evidence.observedStatus ||
        run.worktreePathIdentity !== evidence.worktreePathIdentity ||
        run.branchName !== evidence.branchName ||
        run.baseCommitId !== evidence.baseCommitId ||
        run.headCommitIdAtStart !== evidence.headCommitIdAtStart ||
        run.startedAt !== evidence.startedAt ||
        run.finishedAt !== evidence.finishedAt
      ) {
        throw new SqlitePersistenceError(
          `Task Review Quality Gate evidence ${evidence.id} is stale.`,
        );
      }
    }
  }

  private assertCodeStateMatchesStoredWorktree(review: TaskReview): void {
    const row = this.worktreeByTaskIdStatement.get(review.taskId);
    if (
      row === undefined ||
      row.lifecycle_state !== 'PRESENT' ||
      row.path_identity !== review.codeState.worktreePathIdentity ||
      row.branch_name !== review.codeState.branchName ||
      row.base_commit_id !== review.codeState.baseCommitId
    ) {
      throw new SqlitePersistenceError(
        'Task Review code state does not match the persisted PRESENT Worktree.',
      );
    }
  }

  private insertReview(review: TaskReview, ordinal: number): void {
    this.insertReviewStatement.run(
      review.id,
      review.taskId,
      ordinal,
      review.requestedAt,
      review.codeState.schemaVersion,
      review.codeState.worktreePathIdentity,
      review.codeState.branchName,
      review.codeState.baseCommitId,
      review.codeState.headCommitId,
      review.codeState.fingerprint,
      review.codeState.changes.total,
      Number(review.codeState.changes.truncated),
    );
  }

  private insertReviewEvidence(review: TaskReview): void {
    const changedPathGroups = [
      ['COMMITTED', review.codeState.changes.committed],
      ['CONFLICTED', review.codeState.changes.conflicted],
      ['STAGED', review.codeState.changes.staged],
      ['UNSTAGED', review.codeState.changes.unstaged],
      ['UNTRACKED', review.codeState.changes.untracked],
    ] as const;
    for (const [category, paths] of changedPathGroups) {
      paths.forEach((path, index) => {
        this.insertChangedPathStatement.run(review.id, review.taskId, category, index + 1, path);
      });
    }
    review.artifacts.forEach((evidence, index) => {
      this.insertArtifactEvidenceStatement.run(
        review.id,
        review.taskId,
        index + 1,
        evidence.id,
        evidence.kind,
        evidence.phase,
        evidence.sessionId ?? null,
        evidence.createdAt,
      );
    });
    review.qualityGates.forEach((evidence, index) => {
      this.insertGateEvidenceStatement.run(
        review.id,
        review.taskId,
        index + 1,
        evidence.id,
        evidence.gateId,
        evidence.kind,
        evidence.observedStatus,
        evidence.worktreePathIdentity,
        evidence.branchName,
        evidence.baseCommitId,
        evidence.headCommitIdAtStart,
        evidence.startedAt,
        evidence.finishedAt ?? null,
        evidence.association,
      );
    });
  }
}

export class SqliteAgentSessionRepository implements AgentSessionRepository {
  private readonly database: DatabaseSync;
  private readonly appendSnapshotStatement: StatementSync;
  private readonly eventsBySessionIdStatement: StatementSync;
  private readonly findByIdStatement: StatementSync;
  private readonly incompleteDependencyByTaskIdStatement: StatementSync;
  private readonly insertEventStatement: StatementSync;
  private readonly insertSessionStatement: StatementSync;
  private readonly activeByTaskIdStatement: StatementSync;
  private readonly listActiveStatement: StatementSync;
  private readonly listByTaskIdStatement: StatementSync;
  private readonly nextOrdinalStatement: StatementSync;
  private readonly taskPhaseByIdStatement: StatementSync;
  private readonly updateOwnershipStatement: StatementSync;

  public constructor(database: DatabaseSync) {
    this.database = database;
    this.findByIdStatement = database.prepare(
      `SELECT id, task_id, agent_id, ordinal, status, created_at, ended_at, history_sequence,
              host_ownership, provider_session_id
       FROM agent_sessions WHERE id = ?`,
    );
    this.listByTaskIdStatement = database.prepare(
      `SELECT id, task_id, agent_id, ordinal, status, created_at, ended_at, history_sequence,
              host_ownership, provider_session_id
       FROM agent_sessions WHERE task_id = ? ORDER BY ordinal`,
    );
    this.listActiveStatement = database.prepare(
      `SELECT id, task_id, agent_id, ordinal, status, created_at, ended_at, history_sequence,
              host_ownership, provider_session_id
       FROM agent_sessions AS session
       WHERE ${unsettledAgentSessionWriterSql('session')}
       ORDER BY session.task_id, session.ordinal`,
    );
    this.activeByTaskIdStatement = database.prepare(
      `SELECT session.id FROM agent_sessions AS session
       WHERE session.task_id = ? AND ${unsettledAgentSessionWriterSql('session')}
       LIMIT 1`,
    );
    this.incompleteDependencyByTaskIdStatement = database.prepare(
      `SELECT dependency.dependency_task_id
       FROM task_dependencies AS dependency
       INNER JOIN tasks AS required_task ON required_task.id = dependency.dependency_task_id
       WHERE dependency.task_id = ? AND required_task.phase <> 'DONE'
       ORDER BY dependency.dependency_task_id
       LIMIT 1`,
    );
    this.eventsBySessionIdStatement = database.prepare(
      `SELECT
         session_id, sequence, kind, status, occurred_at, runtime_sequence,
         source, failure_code, fatal, stage, exit_code, exit_reason, signal
       FROM agent_session_events WHERE session_id = ? ORDER BY sequence`,
    );
    this.nextOrdinalStatement = database.prepare(
      `SELECT COALESCE(MAX(ordinal), 0) + 1 AS next_ordinal
       FROM agent_sessions WHERE task_id = ?`,
    );
    this.taskPhaseByIdStatement = database.prepare('SELECT phase FROM tasks WHERE id = ?');
    this.insertSessionStatement = database.prepare(
      `INSERT INTO agent_sessions (
         id, task_id, agent_id, ordinal, status, created_at, ended_at, history_sequence,
         host_ownership, provider_session_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertEventStatement = database.prepare(
      `INSERT INTO agent_session_events (
         session_id, sequence, kind, status, occurred_at, runtime_sequence,
         source, failure_code, fatal, stage, exit_code, exit_reason, signal
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.appendSnapshotStatement = database.prepare(
      `UPDATE agent_sessions
       SET status = ?, ended_at = ?, history_sequence = ?
       WHERE id = ? AND history_sequence = ?`,
    );
    this.updateOwnershipStatement = database.prepare(
      `UPDATE agent_sessions
       SET host_ownership = ?, provider_session_id = ?
       WHERE id = ? AND history_sequence = ?`,
    );
  }

  public async updateOwnership(
    session: AgentSession,
    expectedSequence: number,
    input: {
      hostOwnership: AgentSessionHostOwnership | undefined;
      providerSessionId: string | undefined;
    },
  ): Promise<void> {
    if (!Number.isSafeInteger(expectedSequence) || expectedSequence <= 0) {
      throw new SqlitePersistenceError('Agent Session ownership revision is invalid.');
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const storedRow = this.findByIdStatement.get(session.id);
      if (storedRow === undefined) {
        throw new EntityNotFoundError('AgentSession', session.id);
      }
      const stored = this.mapSession(storedRow);
      if (stored.history.length !== expectedSequence) {
        throw new SqlitePersistenceError('Agent Session ownership revision is stale.');
      }
      const hostOwnershipJson =
        input.hostOwnership === undefined ? null : serializeHostOwnership(input.hostOwnership);
      const result = this.updateOwnershipStatement.run(
        hostOwnershipJson,
        input.providerSessionId ?? null,
        session.id,
        expectedSequence,
      );
      if (result.changes === 0 || result.changes === 0n) {
        throw new SqlitePersistenceError('Agent Session ownership revision is stale.');
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      if (error instanceof SqlitePersistenceError || error instanceof EntityNotFoundError) {
        throw error;
      }
      throw new SqlitePersistenceError('Failed to update Agent Session ownership.', {
        cause: error,
      });
    }
  }

  public async findById(id: string): Promise<AgentSession | undefined> {
    const row = this.findByIdStatement.get(id);
    return row === undefined ? undefined : this.mapSession(row);
  }

  public async listByTaskId(taskId: string): Promise<readonly AgentSession[]> {
    return this.listByTaskIdStatement.all(taskId).map((row) => this.mapSession(row));
  }

  public async listActive(): Promise<readonly AgentSession[]> {
    return this.listActiveStatement.all().map((row) => this.mapSession(row));
  }

  public async insert(
    session: AgentSession,
    expectedTaskPhase: typeof TaskPhase.PLANNING | typeof TaskPhase.RUNNING = TaskPhase.RUNNING,
  ): Promise<void> {
    assertInitialSession(session);
    if (expectedTaskPhase !== TaskPhase.PLANNING && expectedTaskPhase !== TaskPhase.RUNNING) {
      throw new SqlitePersistenceError('Agent Session expected Task phase is invalid.');
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (this.findByIdStatement.get(session.id) !== undefined) {
        throw new EntityAlreadyExistsError('AgentSession', session.id);
      }
      const taskRow = this.taskPhaseByIdStatement.get(session.taskId);
      if (taskRow?.phase !== expectedTaskPhase) {
        throw new SqlitePersistenceError(
          `A new Agent Session requires its Task to remain in ${expectedTaskPhase}.`,
        );
      }
      if (this.incompleteDependencyByTaskIdStatement.get(session.taskId) !== undefined) {
        throw new SqlitePersistenceError(
          'A new Agent Session cannot start with incomplete Task dependencies.',
        );
      }
      if (this.activeByTaskIdStatement.get(session.taskId) !== undefined) {
        throw new AgentSessionActiveConflictError(session.taskId);
      }
      const ordinalRow = this.nextOrdinalStatement.get(session.taskId);
      const ordinal = ordinalRow?.next_ordinal;
      if (typeof ordinal !== 'number' || !Number.isSafeInteger(ordinal) || ordinal <= 0) {
        throw new SqlitePersistenceError('Could not allocate the next Agent Session ordinal.');
      }
      this.insertSessionStatement.run(
        session.id,
        session.taskId,
        session.agentId,
        ordinal,
        session.status,
        session.createdAt,
        session.endedAt ?? null,
        session.history.length,
        session.hostOwnership === undefined ? null : serializeHostOwnership(session.hostOwnership),
        session.providerSessionId ?? null,
      );
      const initialEvent = session.history[0];
      if (initialEvent === undefined) {
        throw new SqlitePersistenceError('New Agent Session history is empty.');
      }
      this.insertEvent(session.id, initialEvent);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      if (
        error instanceof AgentSessionActiveConflictError ||
        error instanceof EntityAlreadyExistsError ||
        error instanceof SqlitePersistenceError
      ) {
        throw error;
      }
      if (isSqliteMetadataConflictError(error)) {
        throw new EntityAlreadyExistsError('AgentSession', session.id);
      }
      throw new SqlitePersistenceError('Failed to insert Agent Session.', { cause: error });
    }
  }

  public async append(session: AgentSession, expectedSequence: number): Promise<void> {
    if (
      !Number.isSafeInteger(expectedSequence) ||
      expectedSequence <= 0 ||
      session.history.length !== expectedSequence + 1
    ) {
      throw new SqlitePersistenceError('Agent Session append revision is invalid.');
    }
    const event = session.history.at(-1);
    if (event === undefined || event.sequence !== session.history.length) {
      throw new SqlitePersistenceError('Agent Session append event is invalid.');
    }

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const storedRow = this.findByIdStatement.get(session.id);
      if (storedRow === undefined) {
        throw new SqlitePersistenceError('Agent Session append target is missing.');
      }
      const stored = this.mapSession(storedRow);
      if (
        stored.id !== session.id ||
        stored.taskId !== session.taskId ||
        stored.agentId !== session.agentId ||
        stored.createdAt !== session.createdAt ||
        stored.history.length !== expectedSequence ||
        !stored.history.every(
          (storedEvent, index) =>
            JSON.stringify(storedEvent) === JSON.stringify(session.history[index]),
        )
      ) {
        throw new SqlitePersistenceError('Agent Session append history does not match storage.');
      }
      const result = this.appendSnapshotStatement.run(
        session.status,
        session.endedAt ?? null,
        session.history.length,
        session.id,
        expectedSequence,
      );
      if (result.changes === 0 || result.changes === 0n) {
        throw new SqlitePersistenceError('Agent Session append revision is stale.');
      }
      this.insertEvent(session.id, event);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      if (error instanceof SqlitePersistenceError) {
        throw error;
      }
      throw new SqlitePersistenceError('Failed to append Agent Session history.', {
        cause: error,
      });
    }
  }

  private mapSession(row: ReturnType<StatementSync['get']>): AgentSession {
    if (row === undefined || typeof row.id !== 'string') {
      throw new SqlitePersistenceError('Agent Session row is invalid.');
    }
    return mapAgentSessionRows(row, this.eventsBySessionIdStatement.all(row.id));
  }

  private insertEvent(sessionId: string, event: AgentSessionEvent): void {
    const values = serializeAgentSessionEvent(event);
    this.insertEventStatement.run(
      sessionId,
      event.sequence,
      event.kind,
      event.status,
      event.occurredAt,
      values.runtimeSequence,
      values.source,
      values.failureCode,
      values.fatal,
      values.stage,
      values.exitCode,
      values.exitReason,
      values.signal,
    );
  }
}

export class SqliteExecutionArtifactRepository implements ExecutionArtifactRepository {
  private readonly database: DatabaseSync;
  private readonly findByIdStatement: StatementSync;
  private readonly findLatestByTaskIdAndKindStatement: StatementSync;
  private readonly insertStatement: StatementSync;
  private readonly listByTaskIdStatement: StatementSync;
  private readonly listRecentByTaskIdStatement: StatementSync;
  private readonly nextOrdinalStatement: StatementSync;
  private readonly reviewEvidenceByTaskIdStatement: StatementSync;
  private readonly reviewEvidenceCountByTaskIdStatement: StatementSync;
  private readonly taskPhaseByIdStatement: StatementSync;

  public constructor(database: DatabaseSync) {
    this.database = database;
    this.findByIdStatement = database.prepare(
      `SELECT id, task_id, session_id, ordinal, kind, phase, canonical_name,
              format, schema_version, validation, content, created_at
       FROM execution_artifacts WHERE id = ?`,
    );
    this.findLatestByTaskIdAndKindStatement = database.prepare(
      `SELECT id, task_id, session_id, ordinal, kind, phase, canonical_name,
              format, schema_version, validation, content, created_at
       FROM execution_artifacts
       WHERE task_id = ? AND kind = ?
       ORDER BY ordinal DESC LIMIT 1`,
    );
    this.taskPhaseByIdStatement = database.prepare('SELECT phase FROM tasks WHERE id = ?');
    this.listByTaskIdStatement = database.prepare(
      `SELECT id, task_id, session_id, ordinal, kind, phase, canonical_name,
              format, schema_version, validation, content, created_at
       FROM execution_artifacts WHERE task_id = ? ORDER BY ordinal`,
    );
    this.listRecentByTaskIdStatement = database.prepare(
      `WITH recent AS (
         SELECT id FROM execution_artifacts
         WHERE task_id = ?
         ORDER BY ordinal DESC
         LIMIT ?
       )
       SELECT id, task_id, session_id, ordinal, kind, phase, canonical_name,
              format, schema_version, validation, content, created_at
       FROM execution_artifacts
       WHERE id IN (SELECT id FROM recent)
       ORDER BY ordinal`,
    );
    this.reviewEvidenceCountByTaskIdStatement = database.prepare(
      'SELECT COUNT(*) AS total_count FROM execution_artifacts WHERE task_id = ?',
    );
    this.reviewEvidenceByTaskIdStatement = database.prepare(
      `SELECT id AS artifact_id, session_id, kind, phase, created_at
       FROM execution_artifacts
       WHERE task_id = ?
       ORDER BY ordinal
       LIMIT ?`,
    );
    this.nextOrdinalStatement = database.prepare(
      `SELECT COALESCE(MAX(ordinal), 0) + 1 AS next_ordinal
       FROM execution_artifacts WHERE task_id = ?`,
    );
    this.insertStatement = database.prepare(
      `INSERT INTO execution_artifacts (
         id, task_id, session_id, ordinal, kind, phase, canonical_name,
         format, schema_version, validation, content, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  public async findById(id: string): Promise<ExecutionArtifact | undefined> {
    const row = this.findByIdStatement.get(id);
    return row === undefined ? undefined : mapExecutionArtifactRow(row);
  }

  public async findLatestByTaskIdAndKind(
    taskId: string,
    kind: ExecutionArtifact['kind'],
  ): Promise<ExecutionArtifact | undefined> {
    const row = this.findLatestByTaskIdAndKindStatement.get(taskId, kind);
    return row === undefined ? undefined : mapExecutionArtifactRow(row);
  }

  public async insert(
    artifact: ExecutionArtifact,
    expectedTaskPhase?: Task['phase'],
  ): Promise<void> {
    assertExecutionArtifactContract(artifact);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (this.findByIdStatement.get(artifact.id) !== undefined) {
        throw new EntityAlreadyExistsError('ExecutionArtifact', artifact.id);
      }
      if (
        expectedTaskPhase !== undefined &&
        this.taskPhaseByIdStatement.get(artifact.taskId)?.phase !== expectedTaskPhase
      ) {
        throw new SqlitePersistenceError(
          `Execution Artifact requires its Task to remain in ${expectedTaskPhase}.`,
        );
      }
      const ordinal = this.nextOrdinalStatement.get(artifact.taskId)?.next_ordinal;
      if (typeof ordinal !== 'number' || !Number.isSafeInteger(ordinal) || ordinal <= 0) {
        throw new SqlitePersistenceError('Could not allocate the next Execution Artifact ordinal.');
      }
      this.insertStatement.run(
        artifact.id,
        artifact.taskId,
        artifact.sessionId ?? null,
        ordinal,
        artifact.kind,
        artifact.phase,
        artifact.canonicalName,
        artifact.format,
        artifact.schemaVersion,
        artifact.validation,
        artifact.content,
        artifact.createdAt,
      );
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      if (error instanceof EntityAlreadyExistsError || error instanceof SqlitePersistenceError) {
        throw error;
      }
      if (isSqliteErrorCode(error, primaryKeyConstraintCode)) {
        throw new EntityAlreadyExistsError('ExecutionArtifact', artifact.id);
      }
      throw new SqlitePersistenceError('Failed to insert Execution Artifact.', { cause: error });
    }
  }

  public async listByTaskId(taskId: string): Promise<readonly ExecutionArtifact[]> {
    return this.listByTaskIdStatement.all(taskId).map(mapExecutionArtifactRow);
  }

  public async listRecentByTaskId(
    taskId: string,
    limit: number,
  ): Promise<readonly ExecutionArtifact[]> {
    assertPositiveHistoryLimit(limit, 'Execution Artifact');
    return this.listRecentByTaskIdStatement.all(taskId, limit).map(mapExecutionArtifactRow);
  }

  public async readReviewEvidenceByTaskId(taskId: string, limit: number) {
    assertNonnegativeHistoryLimit(limit, 'Execution Artifact Review evidence');
    const totalCount = readHistoryCount(
      this.reviewEvidenceCountByTaskIdStatement.get(taskId),
      'Execution Artifact',
    );
    return Object.freeze({
      evidence: Object.freeze(
        totalCount > limit
          ? []
          : this.reviewEvidenceByTaskIdStatement
              .all(taskId, limit)
              .map(mapTaskReviewArtifactEvidenceSourceRow),
      ),
      totalCount,
    });
  }
}

function assertExecutionArtifactContract(artifact: ExecutionArtifact): void {
  const reconstructed = createExecutionArtifact({
    content: artifact.content,
    createdAt: artifact.createdAt,
    id: artifact.id,
    kind: artifact.kind,
    ...(artifact.sessionId === undefined ? {} : { sessionId: artifact.sessionId }),
    taskId: artifact.taskId,
  });
  if (
    reconstructed.canonicalName !== artifact.canonicalName ||
    reconstructed.phase !== artifact.phase ||
    reconstructed.format !== artifact.format ||
    reconstructed.schemaVersion !== artifact.schemaVersion ||
    reconstructed.validation !== artifact.validation
  ) {
    throw new SqlitePersistenceError('Execution Artifact does not match its Domain contract.');
  }
}

function assertPendingTaskReview(review: TaskReview): void {
  try {
    const reconstructed = startTaskReview({
      artifacts: review.artifacts,
      codeState: review.codeState,
      id: review.id,
      qualityGates: review.qualityGates,
      requestedAt: review.requestedAt,
      taskId: review.taskId,
    });
    if (!sameTaskReview(reconstructed, review)) {
      throw new TypeError('snapshot mismatch');
    }
    assertTaskReviewStorageBounds(reconstructed);
  } catch (error) {
    throw new SqlitePersistenceError('New Task Review must be a valid PENDING snapshot.', {
      cause: error,
    });
  }
}

function assertTerminalTaskReview(review: TaskReview): void {
  try {
    if (
      review.status !== TaskReviewStatus.APPROVED &&
      review.status !== TaskReviewStatus.CHANGES_REQUESTED
    ) {
      throw new TypeError('invalid decision status');
    }
    const pending = startTaskReview({
      artifacts: review.artifacts,
      codeState: review.codeState,
      id: review.id,
      qualityGates: review.qualityGates,
      requestedAt: review.requestedAt,
      taskId: review.taskId,
    });
    if (review.decidedAt === undefined) {
      throw new TypeError('missing decision timestamp');
    }
    const reconstructed = decideTaskReview(pending, {
      decidedAt: review.decidedAt,
      ...(review.decisionNote === undefined ? {} : { decisionNote: review.decisionNote }),
      status: review.status,
    });
    if (!sameTaskReview(reconstructed, review)) {
      throw new TypeError('snapshot mismatch');
    }
    assertTaskReviewStorageBounds(reconstructed);
  } catch (error) {
    throw new SqlitePersistenceError('Task Review decision evidence is invalid.', {
      cause: error,
    });
  }
}

function assertTaskReviewStorageBounds(review: TaskReview): void {
  const visiblePaths = [
    ...review.codeState.changes.committed,
    ...review.codeState.changes.conflicted,
    ...review.codeState.changes.staged,
    ...review.codeState.changes.unstaged,
    ...review.codeState.changes.untracked,
  ];
  if (visiblePaths.length > 200 || visiblePaths.some((path) => path.length > 32_768)) {
    throw new TypeError('Task Review changed-path evidence exceeds its storage bound.');
  }
  if (review.decisionNote !== undefined && review.decisionNote.length > 65_536) {
    throw new TypeError('Task Review decision note exceeds its storage bound.');
  }
  if (
    review.artifacts.length > TaskReviewEvidenceLimits.ARTIFACTS ||
    review.qualityGates.length > TaskReviewEvidenceLimits.QUALITY_GATES
  ) {
    throw new TypeError('Task Review evidence associations exceed their storage bound.');
  }
}

function assertSameTaskReviewIdentity(stored: TaskReview, candidate: TaskReview): void {
  const candidatePending = startTaskReview({
    artifacts: candidate.artifacts,
    codeState: candidate.codeState,
    id: candidate.id,
    qualityGates: candidate.qualityGates,
    requestedAt: candidate.requestedAt,
    taskId: candidate.taskId,
  });
  if (!sameTaskReview(stored, candidatePending)) {
    throw new SqlitePersistenceError(
      'Task Review decision evidence does not match its stored identity.',
    );
  }
}

function assertTaskReviewTransition(
  storedTask: Task,
  expectedPhase: 'REVIEW' | 'RUNNING',
  nextTask: Task,
  targetPhase: 'DONE' | 'REVIEW' | 'RUNNING',
): void {
  if (storedTask.phase !== expectedPhase) {
    throw new SqlitePersistenceError('Task Review Task phase is stale.');
  }
  let expectedTask: Task;
  try {
    expectedTask = transitionTask(storedTask, targetPhase);
  } catch (error) {
    throw new SqlitePersistenceError('Task Review Task transition is invalid.', { cause: error });
  }
  if (!sameTask(expectedTask, nextTask)) {
    throw new SqlitePersistenceError('Task Review next Task does not match the stored Task.');
  }
}

function sameTask(left: Task, right: Task): boolean {
  return (
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.title === right.title &&
    left.brief === right.brief &&
    left.phase === right.phase
  );
}

function sameTaskReview(left: TaskReview, right: TaskReview): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertExactEvidenceIds(
  rows: readonly ReturnType<StatementSync['get']>[],
  expectedIds: readonly string[],
  entity: string,
): void {
  const storedIds = rows.map((row) => {
    if (row === undefined || typeof row.id !== 'string') {
      throw new SqlitePersistenceError(`Task Review ${entity} history contains an invalid row.`);
    }
    return row.id;
  });
  if (
    storedIds.length !== expectedIds.length ||
    !storedIds.every((id, index) => id === expectedIds[index])
  ) {
    throw new SqlitePersistenceError(
      `Task Review ${entity} evidence is not the exact history at the requested snapshot.`,
    );
  }
}

function assertExactSessionRevisions(
  rows: readonly ReturnType<StatementSync['get']>[],
  expected: readonly TaskReviewSessionRevision[],
): void {
  if (!Array.isArray(expected)) {
    throw new SqlitePersistenceError('Task Review Session revision snapshot is invalid.');
  }
  const stored = rows.map((row): TaskReviewSessionRevision => {
    if (
      row === undefined ||
      typeof row.id !== 'string' ||
      typeof row.history_sequence !== 'number' ||
      !Number.isSafeInteger(row.history_sequence) ||
      row.history_sequence <= 0
    ) {
      throw new SqlitePersistenceError('Task Review Session history contains an invalid row.');
    }
    return { historySequence: row.history_sequence, id: row.id };
  });
  const validExpected = expected.every(
    ({ historySequence, id }) =>
      typeof id === 'string' &&
      id.trim().length > 0 &&
      !id.includes('\0') &&
      Number.isSafeInteger(historySequence) &&
      historySequence > 0,
  );
  if (
    !validExpected ||
    stored.length !== expected.length ||
    !stored.every(
      (revision, index) =>
        revision.id === expected[index]?.id &&
        revision.historySequence === expected[index]?.historySequence,
    )
  ) {
    throw new SqlitePersistenceError(
      'Task Review Session evidence is not the exact history at the requested snapshot.',
    );
  }
}

function assertInitialSession(session: AgentSession): void {
  if (
    session.status !== 'STARTING' ||
    session.endedAt !== undefined ||
    session.history.length !== 1 ||
    session.history[0]?.kind !== 'START_REQUESTED'
  ) {
    throw new SqlitePersistenceError('New Agent Session must contain only STARTING history.');
  }
}

function assertRunningQualityGateRun(run: QualityGateRun): void {
  let reconstructed: QualityGateRun;
  try {
    reconstructed = startQualityGateRun({
      gate: run.gate,
      id: run.id,
      startedAt: run.startedAt,
      taskId: run.taskId,
      worktree: run.worktree,
    });
  } catch (error) {
    throw new SqlitePersistenceError('New Quality Gate Run identity is invalid.', {
      cause: error,
    });
  }
  if (!sameQualityGateRun(reconstructed, run)) {
    throw new SqlitePersistenceError(
      'New Quality Gate Run must be RUNNING without terminal evidence.',
    );
  }
}

function sameQualityGateRun(left: QualityGateRun, right: QualityGateRun): boolean {
  return (
    sameQualityGateRunIdentity(left, right) &&
    left.status === right.status &&
    left.finishedAt === right.finishedAt &&
    left.durationMs === right.durationMs &&
    left.exitCode === right.exitCode &&
    left.failureCategory === right.failureCategory &&
    ((left.output === undefined && right.output === undefined) ||
      (left.output !== undefined &&
        right.output !== undefined &&
        left.output.reference === right.output.reference &&
        left.output.text === right.output.text &&
        left.output.truncated === right.output.truncated))
  );
}

function sameQualityGateRunIdentity(left: QualityGateRun, right: QualityGateRun): boolean {
  return (
    left.id === right.id &&
    left.taskId === right.taskId &&
    left.startedAt === right.startedAt &&
    left.gate.id === right.gate.id &&
    left.gate.kind === right.gate.kind &&
    left.gate.command.executablePath === right.gate.command.executablePath &&
    left.gate.timeoutMs === right.gate.timeoutMs &&
    left.gate.command.arguments.length === right.gate.command.arguments.length &&
    left.gate.command.arguments.every(
      (argument, index) => argument === right.gate.command.arguments[index],
    ) &&
    left.worktree.pathIdentity === right.worktree.pathIdentity &&
    left.worktree.worktreePath === right.worktree.worktreePath &&
    left.worktree.branchName === right.worktree.branchName &&
    left.worktree.baseCommitId === right.worktree.baseCommitId &&
    left.worktree.headCommitIdAtStart === right.worktree.headCommitIdAtStart
  );
}

interface SerializedAgentSessionEvent {
  readonly exitCode: number | null;
  readonly exitReason: string | null;
  readonly failureCode: string | null;
  readonly fatal: number | null;
  readonly runtimeSequence: number | null;
  readonly signal: number | null;
  readonly source: string | null;
  readonly stage: string | null;
}

function serializeAgentSessionEvent(event: AgentSessionEvent): SerializedAgentSessionEvent {
  return {
    exitCode: event.kind === 'PROCESS_EXITED' ? event.exitCode : null,
    exitReason: event.kind === 'PROCESS_EXITED' ? event.reason : null,
    failureCode: event.kind === 'RUNTIME_FAILED' ? event.code : null,
    fatal: event.kind === 'RUNTIME_FAILED' ? Number(event.fatal) : null,
    runtimeSequence:
      'runtimeSequence' in event && event.runtimeSequence !== undefined
        ? event.runtimeSequence
        : null,
    signal: event.kind === 'PROCESS_EXITED' ? (event.signal ?? null) : null,
    source: event.kind === 'STATUS_REPORTED' ? event.source : null,
    stage: event.kind === 'RUNTIME_FAILED' ? event.stage : null,
  };
}

function assertPositiveHistoryLimit(limit: number, entity: string): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new TypeError(`${entity} recent-history limit must be a positive safe integer.`);
  }
}

function assertNonnegativeHistoryLimit(limit: number, entity: string): void {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError(`${entity} limit must be a nonnegative safe integer.`);
  }
}

function readHistoryCount(row: ReturnType<StatementSync['get']>, entity: string): number {
  const value = row?.total_count;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SqlitePersistenceError(`${entity} history count is invalid.`);
  }
  return value;
}

function readHistoryBoolean(
  row: ReturnType<StatementSync['get']>,
  column: string,
  entity: string,
): boolean {
  const value = row?.[column];
  if (value !== 0 && value !== 1) {
    throw new SqlitePersistenceError(`${entity} history flag is invalid.`);
  }
  return value === 1;
}

function isSqliteErrorCode(error: unknown, code: number): boolean {
  return (
    error instanceof Error &&
    'errcode' in error &&
    typeof error.errcode === 'number' &&
    error.errcode === code
  );
}

function readSettingsText(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('Expected Application Settings text.');
  }
  return value;
}

function readSettingsInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError('Expected Application Settings integer.');
  }
  return value;
}

function readSettingsSchemaVersion(value: unknown): 1 {
  if (value !== 1) {
    throw new TypeError('Unsupported Application Settings schema version.');
  }
  return value;
}

function mapTaskDependencyRow(row: Record<string, unknown>): TaskDependency {
  const taskId = row.task_id;
  const dependencyTaskId = row.dependency_task_id;
  if (typeof taskId !== 'string' || typeof dependencyTaskId !== 'string') {
    throw new SqlitePersistenceError('Task dependency row is invalid.');
  }
  try {
    return createTaskDependency({ dependencyTaskId, taskId });
  } catch (error) {
    throw new SqlitePersistenceError('Task dependency row is invalid.', { cause: error });
  }
}

function mapTaskPullRequestRow(row: Record<string, unknown>): TaskPullRequest {
  const draft = row.draft;
  if (draft !== 0 && draft !== 0n && draft !== 1 && draft !== 1n) {
    throw new SqlitePersistenceError('Pull Request metadata is invalid.');
  }
  const pullRequest = {
    baseBranch: row.base_branch,
    checks: Object.freeze({
      failureCount: row.check_failure_count,
      pendingCount: row.check_pending_count,
      state: row.check_state,
      successCount: row.check_success_count,
      totalCount: row.check_total_count,
    }),
    createdAt: row.created_at,
    draft: draft === 1 || draft === 1n,
    headBranch: row.head_branch,
    headCommitId: row.head_commit_id,
    lastSyncedAt: row.last_synced_at === null ? undefined : row.last_synced_at,
    number: row.pull_request_number,
    provider: row.provider,
    repositoryName: row.repository_name,
    repositoryOwner: row.repository_owner,
    reviewState: row.review_state,
    status: row.status,
    taskId: row.task_id,
    title: row.title,
    updatedAt: row.updated_at,
    url: row.url,
  } as TaskPullRequest;
  assertTaskPullRequestMetadata(pullRequest);
  return Object.freeze(pullRequest);
}

function assertTaskPullRequestMetadata(pullRequest: TaskPullRequest): void {
  const repositoryPart = /^[A-Za-z0-9_.-]{1,255}$/u;
  const validText = (value: unknown, maximum: number): value is string =>
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    !value.includes('\0');
  const checks = pullRequest.checks;
  const checkCountsValid =
    typeof checks === 'object' &&
    checks !== null &&
    Number.isSafeInteger(checks.totalCount) &&
    checks.totalCount >= 0 &&
    checks.totalCount <= 2_000 &&
    Number.isSafeInteger(checks.successCount) &&
    checks.successCount >= 0 &&
    Number.isSafeInteger(checks.failureCount) &&
    checks.failureCount >= 0 &&
    Number.isSafeInteger(checks.pendingCount) &&
    checks.pendingCount >= 0 &&
    checks.totalCount === checks.successCount + checks.failureCount + checks.pendingCount &&
    ['FAILURE', 'NONE', 'PENDING', 'SUCCESS', 'UNKNOWN'].includes(checks.state) &&
    ((checks.state === 'UNKNOWN' && checks.totalCount === 0) ||
      (checks.state === 'NONE' && checks.totalCount === 0) ||
      (checks.state === 'FAILURE' && checks.failureCount > 0) ||
      (checks.state === 'PENDING' && checks.failureCount === 0 && checks.pendingCount > 0) ||
      (checks.state === 'SUCCESS' &&
        checks.totalCount > 0 &&
        checks.failureCount === 0 &&
        checks.pendingCount === 0));
  if (
    pullRequest.provider !== 'github' ||
    !validText(pullRequest.taskId, 32_768) ||
    typeof pullRequest.repositoryOwner !== 'string' ||
    !repositoryPart.test(pullRequest.repositoryOwner) ||
    typeof pullRequest.repositoryName !== 'string' ||
    !repositoryPart.test(pullRequest.repositoryName) ||
    !validText(pullRequest.baseBranch, 1_024) ||
    !validText(pullRequest.headBranch, 1_024) ||
    !Number.isSafeInteger(pullRequest.number) ||
    pullRequest.number <= 0 ||
    pullRequest.url !==
      `https://github.com/${pullRequest.repositoryOwner}/${pullRequest.repositoryName}/pull/${pullRequest.number}` ||
    !validText(pullRequest.title, 1_024) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(pullRequest.headCommitId) ||
    !['OPEN', 'CLOSED', 'MERGED'].includes(pullRequest.status) ||
    !['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'NONE', 'UNKNOWN'].includes(
      pullRequest.reviewState,
    ) ||
    !checkCountsValid ||
    typeof pullRequest.draft !== 'boolean' ||
    !Number.isSafeInteger(pullRequest.createdAt) ||
    pullRequest.createdAt < 0 ||
    !Number.isSafeInteger(pullRequest.updatedAt) ||
    pullRequest.updatedAt < pullRequest.createdAt ||
    (pullRequest.lastSyncedAt !== undefined &&
      (!Number.isSafeInteger(pullRequest.lastSyncedAt) ||
        pullRequest.lastSyncedAt < 0 ||
        pullRequest.lastSyncedAt > 8_640_000_000_000_000))
  ) {
    throw new SqlitePersistenceError('Pull Request metadata is invalid.');
  }
}

function pullRequestBranchIdentityParameters(
  pullRequest: TaskPullRequest,
): readonly SQLInputValue[] {
  return [
    pullRequest.taskId,
    pullRequest.provider,
    pullRequest.repositoryOwner,
    pullRequest.repositoryName,
    pullRequest.baseBranch,
    pullRequest.headBranch,
  ];
}

function pullRequestRemoteIdentityParameters(
  pullRequest: TaskPullRequest,
): readonly SQLInputValue[] {
  return [
    pullRequest.taskId,
    pullRequest.provider,
    pullRequest.repositoryOwner,
    pullRequest.repositoryName,
    pullRequest.number,
  ];
}

function pullRequestMutableParameters(pullRequest: TaskPullRequest): readonly SQLInputValue[] {
  return [
    pullRequest.number,
    pullRequest.url,
    pullRequest.title,
    pullRequest.headCommitId,
    pullRequest.status,
    Number(pullRequest.draft),
    pullRequest.createdAt,
    pullRequest.updatedAt,
    pullRequest.reviewState,
    pullRequest.checks.state,
    pullRequest.checks.totalCount,
    pullRequest.checks.successCount,
    pullRequest.checks.failureCount,
    pullRequest.checks.pendingCount,
    pullRequest.lastSyncedAt ?? null,
  ];
}

function pullRequestPersistenceParameters(pullRequest: TaskPullRequest): readonly SQLInputValue[] {
  return [
    ...pullRequestBranchIdentityParameters(pullRequest),
    ...pullRequestMutableParameters(pullRequest),
  ];
}

function isNewerPullRequestSnapshot(current: TaskPullRequest, candidate: TaskPullRequest): boolean {
  if (candidate.lastSyncedAt === undefined) return false;
  return current.lastSyncedAt === undefined || candidate.lastSyncedAt >= current.lastSyncedAt;
}

function sameTaskPullRequest(left: TaskPullRequest, right: TaskPullRequest): boolean {
  return (
    left.taskId === right.taskId &&
    left.provider === right.provider &&
    left.repositoryOwner === right.repositoryOwner &&
    left.repositoryName === right.repositoryName &&
    left.baseBranch === right.baseBranch &&
    left.headBranch === right.headBranch &&
    left.number === right.number &&
    left.url === right.url &&
    left.title === right.title &&
    left.headCommitId === right.headCommitId &&
    left.status === right.status &&
    left.draft === right.draft &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.reviewState === right.reviewState &&
    left.checks.state === right.checks.state &&
    left.checks.totalCount === right.checks.totalCount &&
    left.checks.successCount === right.checks.successCount &&
    left.checks.failureCount === right.checks.failureCount &&
    left.checks.pendingCount === right.checks.pendingCount &&
    left.lastSyncedAt === right.lastSyncedAt
  );
}

function isSqliteMetadataConflictError(error: unknown): boolean {
  return (
    isSqliteErrorCode(error, primaryKeyConstraintCode) ||
    isSqliteErrorCode(error, uniqueConstraintCode)
  );
}

function isGitObjectId(value: string): boolean {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(value);
}

function unsettledAgentSessionWriterSql(alias: string): string {
  return `(
    ${alias}.status IN ('STARTING', 'WORKING', 'IDLE', 'WAITING_INPUT')
    OR (
      ${alias}.status = 'FAILED'
      AND NOT EXISTS (
        SELECT 1 FROM agent_session_events AS event
        WHERE event.session_id = ${alias}.id AND event.kind = 'PROCESS_EXITED'
      )
      AND NOT EXISTS (
        SELECT 1 FROM agent_session_events AS event
        WHERE event.session_id = ${alias}.id
          AND event.kind = 'RUNTIME_FAILED'
          AND event.fatal = 1
          AND (
            event.stage = 'START'
            OR event.failure_code = 'RUNTIME_OWNERSHIP_LOST'
          )
      )
    )
  )`;
}
