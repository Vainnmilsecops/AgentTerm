import { Fragment, useEffect, useMemo, useRef, type ReactNode } from "react";

import {
  TaskPhase,
  type AgentWorkspaceOverview,
  type WorkspaceTaskOverview,
} from "@agentterm/application";

import type { BoardFocus } from "./board-keyboard";

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
  /** Optional focused cell coordinates; when provided, the matching card gets `data-board-focused="true"` and `aria-current="true"`. */
  readonly focus?: BoardFocus;
  readonly onActivateTask?: (taskId: string) => void;
  /** Read-only workspace overview; the view never calls the client directly. */
  readonly overview: AgentWorkspaceOverview;
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
  focus,
  onActivateTask,
  overview,
}: BoardViewProps): ReactNode {
  const columns = useMemo(() => projectOverviewToBoard(overview), [overview]);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Scroll the focused card into view when focus changes. Uses the
  // `data-board-focused` attribute to find the target inside the rendered DOM
  // so the keyboard reducer never needs to know about layout.
  useEffect(() => {
    if (focus === undefined) return;
    const root = rootRef.current;
    if (root === null) return;
    const target = root.querySelector<HTMLElement>('[data-board-focused="true"]');
    if (target === null) return;
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [focus?.columnIndex, focus?.rowIndex]);

  return (
    <div
      ref={rootRef}
      className="board-view"
      data-board-root=""
      data-board-focused-column={focus?.columnIndex ?? -1}
      data-board-focused-row={focus?.rowIndex ?? -1}
      role="region"
      aria-label="Task board"
    >
      {columns.map((column, columnIndex) => (
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
              {column.tasks.map((task, rowIndex) => {
                const isFocused =
                  focus !== undefined &&
                  focus.columnIndex === columnIndex &&
                  focus.rowIndex === rowIndex;
                return (
                  <li
                    key={task.task.id}
                    className="board-view__card"
                    data-board-card={task.task.id}
                    data-board-focused={isFocused ? "true" : undefined}
                    aria-current={isFocused ? "true" : undefined}
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
                );
              })}
            </ul>
          </section>
        </Fragment>
      ))}
    </div>
  );
}
