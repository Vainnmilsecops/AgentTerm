import { Fragment, useMemo, type ReactNode } from "react";

import {
  TaskPhase,
  type AgentWorkspaceOverview,
  type WorkspaceTaskOverview,
} from "@agentterm/application";

export interface BoardColumn {
  readonly id: TaskPhase;
  readonly title: string;
}

export const BOARD_COLUMNS: readonly BoardColumn[] = Object.freeze([
  { id: TaskPhase.BACKLOG, title: "Backlog" },
  { id: TaskPhase.PLANNING, title: "Planning" },
  { id: TaskPhase.RUNNING, title: "Running" },
  { id: TaskPhase.REVIEW, title: "Review" },
  { id: TaskPhase.DONE, title: "Done" },
]);

export interface BoardViewProps {
  /** Read-only workspace overview; the view never calls the client directly. */
  readonly overview: AgentWorkspaceOverview;
  readonly onActivateTask?: (taskId: string) => void;
}

export interface BoardColumnProjection {
  readonly column: BoardColumn;
  readonly tasks: readonly WorkspaceTaskOverview[];
}

export function projectOverviewToBoard(
  overview: AgentWorkspaceOverview,
): readonly BoardColumnProjection[] {
  return BOARD_COLUMNS.map((column) => {
    const tasks: WorkspaceTaskOverview[] = [];
    for (const project of overview.projects) {
      for (const task of project.tasks) {
        if (task.task.phase === column.id) {
          tasks.push(task);
        }
      }
    }
    tasks.sort((left, right) => compareByTitle(left, right));
    return Object.freeze({ column, tasks: Object.freeze(tasks) });
  });
}

function compareByTitle(
  left: WorkspaceTaskOverview,
  right: WorkspaceTaskOverview,
): number {
  const leftTitle = left.task.title.trim();
  const rightTitle = right.task.title.trim();
  if (leftTitle < rightTitle) return -1;
  if (leftTitle > rightTitle) return 1;
  return 0;
}

export function BoardView({
  overview,
  onActivateTask,
}: BoardViewProps): ReactNode {
  const columns = useMemo(() => projectOverviewToBoard(overview), [overview]);

  return (
    <div
      className="board-view"
      data-board-root=""
      role="region"
      aria-label="Task board"
    >
      {columns.map((column) => (
        <Fragment key={column.column.id}>
          <section
            className="board-view__column"
            data-board-column={column.column.id}
            role="group"
            aria-label={column.column.title}
          >
            <header className="board-view__column-header">
              <h2 className="board-view__column-title">
                {column.column.title}
              </h2>
              <span className="board-view__column-count">
                {column.tasks.length}
              </span>
            </header>
            <ul className="board-view__cards" role="list">
              {column.tasks.map((task) => (
                <li
                  key={task.task.id}
                  className="board-view__card"
                  data-board-card={task.task.id}
                >
                  <button
                    className="board-view__card-action"
                    data-board-card-action={task.task.id}
                    onClick={
                      onActivateTask === undefined
                        ? undefined
                        : () => onActivateTask(task.task.id)
                    }
                    type="button"
                  >
                    <span className="board-view__card-title">
                      {task.task.title}
                    </span>
                    <span className="board-view__card-meta">
                      {task.latestPlan === undefined
                        ? "no plan yet"
                        : "plan ready"}
                      {task.activeSession === undefined
                        ? ""
                        : " · session active"}
                      {task.blocked ? " · blocked" : ""}
                    </span>
                    {task.workflowPlugin !== undefined ? (
                      <span
                        className="board-view__card-plugin"
                        data-board-card-plugin={task.task.id}
                      >
                        plugin: {task.workflowPlugin.pluginName}
                        {task.workflowPlugin.phaseAgentId === undefined
                          ? ""
                          : ` · agent: ${task.workflowPlugin.phaseAgentId}`}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </Fragment>
      ))}
    </div>
  );
}
