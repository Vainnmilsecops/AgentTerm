import { describe, expect, it } from "vitest";

import {
  TaskPhase,
  type AgentSessionSummary,
  type AgentWorkspaceOverview,
  type WorkspaceTaskOverview,
} from "@agentterm/application";

import {
  BOARD_COLUMNS,
  BoardView,
  projectOverviewToBoard,
  type BoardColumnProjection,
  type BoardViewProps,
} from "./board-view";

function projectFixture(): Record<string, unknown> {
  return {
    id: "project-1",
    name: "AgentTerm",
    rootPath: "C:/work/AgentTerm",
  };
}

function emptySessionSummary(): AgentSessionSummary {
  return {
    agentId: "agent-1",
    createdAt: 0,
    endedAt: undefined,
    failureCode: undefined,
    id: "session-1",
    status: "idle" as AgentSessionSummary["status"],
    taskId: "task-1",
  };
}

function emptyTask(
  phase: TaskPhase,
  id: string,
  title: string,
): WorkspaceTaskOverview {
  const task = {
    blockedReason: undefined,
    createdAt: 0,
    description: "",
    id,
    phase,
    projectId: "project-1",
    title,
    updatedAt: 0,
    worktreeId: undefined,
  };
  return {
    activeSession: undefined,
    artifacts: [],
    blocked: false,
    canAcceptPlan: false,
    canApproveReview: false,
    canBeginPlanning: false,
    canRequestChanges: false,
    canRequestReview: false,
    canRetryExecution: false,
    canRevisePlan: false,
    canRunQualityGate: false,
    canStartExecution: false,
    canStartPlanning: false,
    dependencies: [],
    latestPlan: undefined,
    latestReview: undefined,
    latestSession: undefined,
    previousSession: undefined,
    qualityGateRuns: [],
    reviewHistory: [],
    task: task as unknown as WorkspaceTaskOverview["task"],
    workflowPlugin: undefined,
  };
}

function overviewWithSessions(
  tasks: readonly WorkspaceTaskOverview[],
  withSessions: ReadonlyMap<string, AgentSessionSummary>,
): AgentWorkspaceOverview {
  const decorated = tasks.map((entry) => {
    const session = withSessions.get(entry.task.id);
    return session === undefined
      ? entry
      : { ...entry, activeSession: session, latestSession: session };
  });
  return {
    agents: [],
    projects: [
      {
        project:
          projectFixture() as unknown as AgentWorkspaceOverview["projects"][number]["project"],
        tasks: decorated,
      },
    ],
  };
}

describe("projectOverviewToBoard", () => {
  it("emits one projection per canonical column in stable order", () => {
    const projections: readonly BoardColumnProjection[] =
      projectOverviewToBoard(overviewWithSessions([], new Map()));
    expect(projections.map(({ column }) => column.id)).toEqual([
      TaskPhase.BACKLOG,
      TaskPhase.PLANNING,
      TaskPhase.RUNNING,
      TaskPhase.REVIEW,
      TaskPhase.DONE,
    ]);
    expect(BOARD_COLUMNS).toHaveLength(5);
  });

  it("places every Task in exactly one column based on its phase", () => {
    const projections = projectOverviewToBoard(
      overviewWithSessions(
        [
          emptyTask(TaskPhase.BACKLOG, "task-a", "Audit backlog"),
          emptyTask(TaskPhase.PLANNING, "task-b", "Draft plan"),
          emptyTask(TaskPhase.RUNNING, "task-c", "Implement"),
          emptyTask(TaskPhase.REVIEW, "task-d", "Verify"),
          emptyTask(TaskPhase.DONE, "task-e", "Ship"),
          emptyTask(TaskPhase.DONE, "task-f", "Archive"),
        ],
        new Map(),
      ),
    );

    const totalTasks = projections.reduce(
      (sum, projection) => sum + projection.tasks.length,
      0,
    );
    expect(totalTasks).toBe(6);

    const findByPhase = (phase: TaskPhase) =>
      projections.find(({ column }) => column.id === phase);
    expect(
      findByPhase(TaskPhase.BACKLOG)?.tasks.map((task) => task.task.id),
    ).toEqual(["task-a"]);
    expect(
      findByPhase(TaskPhase.PLANNING)?.tasks.map((task) => task.task.id),
    ).toEqual(["task-b"]);
    expect(
      findByPhase(TaskPhase.RUNNING)?.tasks.map((task) => task.task.id),
    ).toEqual(["task-c"]);
    expect(
      findByPhase(TaskPhase.REVIEW)?.tasks.map((task) => task.task.id),
    ).toEqual(["task-d"]);
    expect(
      findByPhase(TaskPhase.DONE)?.tasks.map((task) => task.task.id),
    ).toEqual(["task-f", "task-e"]);
  });

  it("sorts cards by title within a column for deterministic ordering", () => {
    const projections = projectOverviewToBoard(
      overviewWithSessions(
        [
          emptyTask(TaskPhase.RUNNING, "task-z", "Zeta"),
          emptyTask(TaskPhase.RUNNING, "task-a", "Alpha"),
          emptyTask(TaskPhase.RUNNING, "task-m", "Mu"),
        ],
        new Map(),
      ),
    );
    const running = projections.find(
      ({ column }) => column.id === TaskPhase.RUNNING,
    );
    expect(running?.tasks.map((task) => task.task.title)).toEqual([
      "Alpha",
      "Mu",
      "Zeta",
    ]);
  });

  it("keeps Tasks from projects independent in the column projection", () => {
    const secondProject = {
      ...projectFixture(),
      id: "project-2",
      name: "Other",
    };
    const overview: AgentWorkspaceOverview = {
      agents: [],
      projects: [
        {
          project:
            projectFixture() as unknown as AgentWorkspaceOverview["projects"][number]["project"],
          tasks: [emptyTask(TaskPhase.DONE, "task-1", "First")],
        },
        {
          project:
            secondProject as unknown as AgentWorkspaceOverview["projects"][number]["project"],
          tasks: [emptyTask(TaskPhase.DONE, "task-2", "Second")],
        },
      ],
    };
    const projections = projectOverviewToBoard(overview);
    const done = projections.find(({ column }) => column.id === TaskPhase.DONE);
    expect(done?.tasks.map((task) => task.task.id).sort()).toEqual([
      "task-1",
      "task-2",
    ]);
  });

  it("preserves an active session summary on the card projection", () => {
    const session = emptySessionSummary();
    const projections = projectOverviewToBoard(
      overviewWithSessions(
        [emptyTask(TaskPhase.RUNNING, "task-1", "Implement")],
        new Map([["task-1", session]]),
      ),
    );
    const running = projections.find(
      ({ column }) => column.id === TaskPhase.RUNNING,
    );
    expect(running?.tasks[0]?.activeSession?.id).toBe("session-1");
  });

  it("propagates the WorkflowPlugin projection from the workspace overview to the card", () => {
    const baseTask = emptyTask(TaskPhase.BACKLOG, "task-bound", "Bound Task");
    const taskWithPlugin: WorkspaceTaskOverview = {
      ...baseTask,
      workflowPlugin: Object.freeze({
        activePhaseId: "planning",
        phaseAgentId: "gemini",
        pluginId: "agtx",
        pluginName: "agtx",
      }),
    };
    const overview: AgentWorkspaceOverview = {
      agents: [],
      projects: [
        {
          project:
            projectFixture() as unknown as AgentWorkspaceOverview["projects"][number]["project"],
          tasks: [taskWithPlugin],
        },
      ],
    };

    const projections = projectOverviewToBoard(overview);
    const backlog = projections.find(
      ({ column }) => column.id === TaskPhase.BACKLOG,
    );
    expect(backlog?.tasks[0]?.workflowPlugin).toEqual({
      activePhaseId: "planning",
      phaseAgentId: "gemini",
      pluginId: "agtx",
      pluginName: "agtx",
    });
  });
});

describe("BoardView contract", () => {
  it("exposes a typed onActivateTask callback that the renderer can opt into", () => {
    const captured: string[] = [];
    const props: BoardViewProps = {
      onActivateTask: (taskId) => captured.push(taskId),
      overview: overviewWithSessions([], new Map()),
    };
    expect(typeof props.onActivateTask).toBe("function");
    props.onActivateTask?.("task-1");
    expect(captured).toEqual(["task-1"]);
  });

  it("treats an absent onActivateTask as a read-only surface", () => {
    const props: BoardViewProps = {
      overview: overviewWithSessions([], new Map()),
    };
    expect(props.onActivateTask).toBeUndefined();
    expect(BoardView).toBeDefined();
  });
});
