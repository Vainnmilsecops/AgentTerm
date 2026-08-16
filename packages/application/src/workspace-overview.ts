import {
  AgentSessionStatus,
  ExecutionArtifactKind,
  TaskPhase,
  TaskReviewEvidenceLimits,
  TaskReviewStatus,
  type AgentSession,
  type ExecutionArtifact,
  type Project,
  type QualityGateRun,
  type Task,
  type TaskReview,
  type WorkflowPlugin,
} from '@agentterm/domain';

import type {
  AgentCatalog,
  AgentSessionRepository,
  ApplicationSettingsRepository,
  ProjectCatalog,
  QualityGateRunRepository,
  TaskCatalog,
  TaskDependencyRepository,
  TaskPlanningArtifactRepository,
  TaskReviewRepository,
  WorkflowPluginBindingRepository,
  WorkflowPluginConfigurator,
} from './ports';
import { bindPhaseAgent } from './workflow-plugin-use-cases';
import { listAgentSummaries, type AgentSummary } from './agent-catalog';
import { hasUnsettledTaskCodeWriter } from './agent-session-writer-state';
import { canStartTaskExecution, canStartTaskPlanning } from './task-execution';

const maximumWorkspaceGateRuns = 20;
const maximumWorkspaceArtifacts = 20;
const maximumWorkspaceGateOutputCharacters = 4_096;
const maximumWorkspaceReviewAttempts = 20;
const maximumWorkspaceReviewChangedPaths = 50;

export interface WorkspaceTaskOverview {
  readonly activeSession: AgentSessionSummary | undefined;
  readonly artifacts: readonly ExecutionArtifact[];
  readonly canBeginPlanning: boolean;
  readonly canApproveReview: boolean;
  readonly canAcceptPlan: boolean;
  readonly canRequestChanges: boolean;
  readonly canRequestReview: boolean;
  readonly canRetryExecution: boolean;
  readonly canRevisePlan: boolean;
  readonly canRunQualityGate: boolean;
  readonly canStartExecution: boolean;
  readonly canStartPlanning: boolean;
  readonly blocked: boolean;
  readonly dependencies: readonly TaskDependencySummary[];
  readonly latestSession: AgentSessionSummary | undefined;
  readonly latestReview: TaskReviewSummary | undefined;
  readonly latestPlan: ExecutionArtifact | undefined;
  readonly previousSession: AgentSessionSummary | undefined;
  readonly qualityGateRuns: readonly QualityGateRunSummary[];
  readonly reviewHistory: readonly TaskReviewSummary[];
  readonly task: Task;
  readonly workflowPlugin: WorkflowPluginProjection | undefined;
}

export interface WorkflowPluginProjection {
  readonly activePhaseId: string;
  readonly phaseAgentId: string | undefined;
  readonly pluginId: string;
  readonly pluginName: string;
}

export interface TaskDependencySummary {
  readonly id: string;
  readonly phase: Task['phase'];
  readonly satisfied: boolean;
  readonly title: string;
}

export type TaskReviewFreshness = 'HISTORICAL_SNAPSHOT' | 'REVALIDATE_ON_APPROVAL';

export interface TaskReviewSummary {
  readonly artifacts: readonly TaskReviewArtifactSummary[];
  readonly codeState: TaskReviewCodeStateSummary;
  readonly decidedAt: number | undefined;
  readonly decisionNote: string | undefined;
  /** Pending evidence must be recaptured and compared before approval. */
  readonly freshness: TaskReviewFreshness;
  readonly id: string;
  readonly qualityGates: readonly TaskReviewQualityGateSummary[];
  readonly requestedAt: number;
  readonly status: TaskReview['status'];
  readonly taskId: string;
}

export interface TaskReviewCodeStateSummary {
  readonly baseCommitId: string;
  readonly branchName: string;
  readonly changes: TaskReviewChangesSummary;
  readonly fingerprint: string;
  readonly headCommitId: string;
  readonly schemaVersion: 1;
}

export interface TaskReviewChangesSummary {
  readonly committed: readonly string[];
  readonly conflicted: readonly string[];
  readonly staged: readonly string[];
  readonly total: number;
  readonly truncated: boolean;
  readonly unstaged: readonly string[];
  readonly untracked: readonly string[];
}

export interface TaskReviewArtifactSummary {
  readonly createdAt: number;
  readonly id: string;
  readonly kind: TaskReview['artifacts'][number]['kind'];
  readonly phase: TaskReview['artifacts'][number]['phase'];
  readonly sessionId: string | undefined;
}

export interface TaskReviewQualityGateSummary {
  readonly association: TaskReview['qualityGates'][number]['association'];
  readonly baseCommitId: string;
  readonly branchName: string;
  readonly finishedAt: number | undefined;
  readonly gateId: string;
  readonly headCommitIdAtStart: string;
  readonly id: string;
  readonly kind: TaskReview['qualityGates'][number]['kind'];
  readonly observedStatus: TaskReview['qualityGates'][number]['observedStatus'];
  readonly startedAt: number;
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
  readonly agents: readonly AgentSummary[];
  readonly projects: readonly WorkspaceProjectOverview[];
}

export interface LoadAgentWorkspacePluginDeps {
  readonly agents: AgentCatalog;
  readonly applicationSettings: ApplicationSettingsRepository;
  readonly configurator: WorkflowPluginConfigurator;
  readonly pluginBindings: WorkflowPluginBindingRepository;
}

export async function loadAgentWorkspace(
  projects: ProjectCatalog,
  tasks: TaskCatalog,
  sessions: AgentSessionRepository,
  artifacts: TaskPlanningArtifactRepository,
  qualityGateRuns: QualityGateRunRepository,
  reviews: TaskReviewRepository,
  agents: AgentCatalog,
  taskDependencies: TaskDependencyRepository,
  pluginDeps?: LoadAgentWorkspacePluginDeps,
): Promise<AgentWorkspaceOverview> {
  const pluginCache = pluginDeps ? new PluginProjectionCache(pluginDeps) : undefined;
  const agentSummaries = await listAgentSummaries(agents);
  const recentProjects = await projects.listRecent();
  const projectOverviews = await Promise.all(
    recentProjects.map(async (project): Promise<WorkspaceProjectOverview> => {
      const projectTasks = await tasks.listByProjectId(project.id);
      const taskOverviews = await Promise.all(
        projectTasks.map(async (task): Promise<WorkspaceTaskOverview> => {
          const [
            history,
            artifactHistory,
            artifactEvidence,
            gateHistory,
            gateEvidence,
            reviewAttempts,
            dependencyEdges,
          ] = await Promise.all([
            sessions.listByTaskId(task.id),
            artifacts.listRecentByTaskId(task.id, maximumWorkspaceArtifacts),
            artifacts.readReviewEvidenceByTaskId(task.id, 0),
            qualityGateRuns.listRecentByTaskId(task.id, maximumWorkspaceGateRuns),
            qualityGateRuns.readReviewEvidenceByTaskId(task.id, 0),
            reviews.listRecentByTaskId(task.id, maximumWorkspaceReviewAttempts),
            taskDependencies.listByTaskId(task.id),
          ]);
          const dependencySummaries = Object.freeze(
            dependencyEdges.map(({ dependencyTaskId }): TaskDependencySummary => {
              const dependency = projectTasks.find(({ id }) => id === dependencyTaskId);
              if (dependency === undefined || dependency.projectId !== task.projectId) {
                throw new Error('Task dependency state is inconsistent with its Project.');
              }
              return Object.freeze({
                id: dependency.id,
                phase: dependency.phase,
                satisfied: dependency.phase === TaskPhase.DONE,
                title: dependency.title,
              });
            }),
          );
          const blocked = dependencySummaries.some(({ satisfied }) => !satisfied);
          const latestPlan = await artifacts.findLatestByTaskIdAndKind(
            task.id,
            ExecutionArtifactKind.PLAN,
          );
          const activeSession = findLatestActiveSession(history);
          const latestSession = history.at(-1);
          const latestReviewAttempt = reviewAttempts.at(-1);
          const reviewHistory = Object.freeze(
            reviewAttempts.slice().reverse().map(summarizeTaskReview),
          );
          const phaseAllowsExecution = canStartTaskExecution(task);
          const phaseAllowsPlanning = canStartTaskPlanning(task);
          const hasUnsettledReviewWriter = history.some(hasUnsettledTaskCodeWriter);
          const hasRunningGate = gateEvidence.hasRunning;
          const reviewEvidenceIsBounded =
            artifactEvidence.totalCount <= TaskReviewEvidenceLimits.ARTIFACTS &&
            gateEvidence.totalCount <= TaskReviewEvidenceLimits.QUALITY_GATES;
          const hasPendingReview =
            task.phase === TaskPhase.REVIEW &&
            latestReviewAttempt?.status === TaskReviewStatus.PENDING;
          const workflowPlugin = pluginCache
            ? await pluginCache.resolve(task.id)
            : undefined;
          return Object.freeze({
            activeSession: summarizeSession(activeSession),
            artifacts: Object.freeze([...artifactHistory]),
            blocked,
            canBeginPlanning: task.phase === TaskPhase.BACKLOG,
            canAcceptPlan:
              phaseAllowsPlanning &&
              !hasUnsettledReviewWriter &&
              latestPlan?.sessionId !== undefined &&
              history.some(
                (session) =>
                  session.id === latestPlan.sessionId &&
                  session.taskId === latestPlan.taskId &&
                  isTerminal(session),
              ),
            canApproveReview: hasPendingReview,
            canRequestChanges: hasPendingReview,
            canRequestReview:
              !hasUnsettledReviewWriter &&
              !hasRunningGate &&
              reviewEvidenceIsBounded &&
              (task.phase === TaskPhase.RUNNING ||
                (task.phase === TaskPhase.REVIEW && reviewAttempts.length === 0)),
            canRetryExecution:
              phaseAllowsExecution &&
              !blocked &&
              activeSession === undefined &&
              !hasUnsettledReviewWriter &&
              isTerminal(latestSession) &&
              latestSession !== undefined,
            canRevisePlan:
              phaseAllowsPlanning &&
              !blocked &&
              activeSession === undefined &&
              !hasUnsettledReviewWriter &&
              isTerminal(latestSession),
            canRunQualityGate:
              !hasUnsettledReviewWriter &&
              !hasRunningGate &&
              task.phase !== TaskPhase.REVIEW &&
              task.phase !== TaskPhase.DONE,
            canStartExecution:
              phaseAllowsExecution &&
              !blocked &&
              activeSession === undefined &&
              latestSession === undefined,
            canStartPlanning:
              phaseAllowsPlanning &&
              !blocked &&
              activeSession === undefined &&
              latestSession === undefined,
            dependencies: dependencySummaries,
            latestPlan,
            latestSession: summarizeSession(latestSession),
            latestReview: reviewHistory[0],
            previousSession: summarizeSession(history.at(-2)),
            qualityGateRuns: Object.freeze(gateHistory.map(summarizeQualityGateRun)),
            reviewHistory,
            task,
            workflowPlugin,
          });
        }),
      );
      return Object.freeze({
        project: Object.freeze({ id: project.id, name: project.name }),
        tasks: Object.freeze(taskOverviews),
      });
    }),
  );

  return Object.freeze({ agents: agentSummaries, projects: Object.freeze(projectOverviews) });
}

/**
 * Resolves per-Task WorkflowPlugin projections while sharing one cached
 * plugin load across the workspace overview. The renderer never receives a
 * WorkflowPluginBindingRecord, only the safe id/name/phase/agent summary.
 */
class PluginProjectionCache {
  private readonly pluginByPath = new Map<string, WorkflowPlugin>();
  private readonly projections = new Map<string, WorkflowPluginProjection>();

  public constructor(private readonly deps: LoadAgentWorkspacePluginDeps) {}

  public async resolve(taskId: string): Promise<WorkflowPluginProjection | undefined> {
    const cached = this.projections.get(taskId);
    if (cached !== undefined) return cached;
    const binding = await this.deps.pluginBindings.findByTaskId(taskId);
    if (binding === undefined) {
      this.projections.set(taskId, undefined as unknown as WorkflowPluginProjection);
      return undefined;
    }
    const plugin = await this.loadPlugin(binding.sourcePath);
    if (plugin === undefined) {
      this.projections.set(taskId, undefined as unknown as WorkflowPluginProjection);
      return undefined;
    }
    let phaseAgentId: string | undefined;
    try {
      const settings = await this.deps.applicationSettings.get();
      const agent = bindPhaseAgent(
        { phaseId: binding.activePhaseId, plugin, settings },
        this.deps.agents,
      );
      phaseAgentId = agent.id;
    } catch {
      phaseAgentId = undefined;
    }
    const projection = Object.freeze({
      activePhaseId: binding.activePhaseId,
      phaseAgentId,
      pluginId: plugin.id,
      pluginName: plugin.name,
    }) satisfies WorkflowPluginProjection;
    this.projections.set(taskId, projection);
    return projection;
  }

  private async loadPlugin(path: string): Promise<WorkflowPlugin | undefined> {
    const cached = this.pluginByPath.get(path);
    if (cached !== undefined) return cached;
    const loaded = await this.deps.configurator.load({ path });
    if (loaded.failure !== undefined || loaded.value === undefined) return undefined;
    this.pluginByPath.set(path, loaded.value.plugin);
    return loaded.value.plugin;
  }
}

export function summarizeTaskReview(review: TaskReview): TaskReviewSummary {
  return Object.freeze({
    artifacts: Object.freeze(
      review.artifacts.map((artifact) =>
        Object.freeze({
          createdAt: artifact.createdAt,
          id: artifact.id,
          kind: artifact.kind,
          phase: artifact.phase,
          sessionId: artifact.sessionId,
        }),
      ),
    ),
    codeState: Object.freeze({
      baseCommitId: review.codeState.baseCommitId,
      branchName: review.codeState.branchName,
      changes: summarizeReviewChanges(review.codeState.changes),
      fingerprint: review.codeState.fingerprint,
      headCommitId: review.codeState.headCommitId,
      schemaVersion: 1,
    }),
    decidedAt: review.decidedAt,
    decisionNote: review.decisionNote,
    freshness:
      review.status === TaskReviewStatus.PENDING ? 'REVALIDATE_ON_APPROVAL' : 'HISTORICAL_SNAPSHOT',
    id: review.id,
    qualityGates: Object.freeze(
      review.qualityGates.map((run) =>
        Object.freeze({
          association: run.association,
          baseCommitId: run.baseCommitId,
          branchName: run.branchName,
          finishedAt: run.finishedAt,
          gateId: run.gateId,
          headCommitIdAtStart: run.headCommitIdAtStart,
          id: run.id,
          kind: run.kind,
          observedStatus: run.observedStatus,
          startedAt: run.startedAt,
        }),
      ),
    ),
    requestedAt: review.requestedAt,
    status: review.status,
    taskId: review.taskId,
  });
}

function summarizeReviewChanges(
  changes: TaskReview['codeState']['changes'],
): TaskReviewChangesSummary {
  let remaining = maximumWorkspaceReviewChangedPaths;
  let hiddenPath = false;
  const copySafePaths = (paths: readonly string[]): readonly string[] => {
    const visible: string[] = [];
    for (const path of paths) {
      if (!isSafeRepositoryRelativePath(path)) {
        hiddenPath = true;
        continue;
      }
      if (remaining === 0) {
        hiddenPath = true;
        continue;
      }
      visible.push(path);
      remaining -= 1;
    }
    return Object.freeze(visible);
  };

  const committed = copySafePaths(changes.committed);
  const conflicted = copySafePaths(changes.conflicted);
  const staged = copySafePaths(changes.staged);
  const unstaged = copySafePaths(changes.unstaged);
  const untracked = copySafePaths(changes.untracked);

  return Object.freeze({
    committed,
    conflicted,
    staged,
    total: changes.total,
    truncated: changes.truncated || hiddenPath,
    unstaged,
    untracked,
  });
}

function isSafeRepositoryRelativePath(path: string): boolean {
  if (
    typeof path !== 'string' ||
    path.trim().length === 0 ||
    path.includes('\0') ||
    path.startsWith('/') ||
    path.startsWith('\\') ||
    /^[A-Za-z]:/u.test(path)
  ) {
    return false;
  }

  return !path.split(/[\\/]/u).includes('..');
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
