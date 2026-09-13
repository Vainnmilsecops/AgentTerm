import { Fragment, useEffect, useMemo, useRef, type ReactNode } from "react";

import {
  ExecutionArtifactKindValue as ExecutionArtifactKind,
  TaskPhase,
  type AgentWorkspaceOverview,
  type ExecutionArtifact,
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

export interface BoardArtifactSummary {
  readonly brainstormCount: number;
  readonly executionSummary: boolean;
  readonly plan: boolean;
  readonly research: boolean;
  readonly review: boolean;
  readonly sweepCount: number;
}

/**
 * Pure projection from a Task's artifact list and bound plugin to the
 * per-kind indicator flags the board card renders. The projection is
 * deterministic and never reaches into Domain: it walks
 * `task.artifacts` exactly once and reports the latest occurrence for
 * each stable phase kind (`research` / `plan` / `execution-summary` /
 * `review`) plus running counts for the dynamic kinds (`brainstorm` /
 * `sweep`).
 *
 * Declared-by-plugin gating lives outside this function so the caller
 * can choose which kinds to render even when the Task has the artifact.
 * See {@link summarizeArtifactsForPlugin}.
 */
export function summarizeArtifacts(
  artifacts: readonly ExecutionArtifact[],
): BoardArtifactSummary {
  let research = false;
  let plan = false;
  let executionSummary = false;
  let review = false;
  let brainstormCount = 0;
  let sweepCount = 0;
  for (const artifact of artifacts) {
    switch (artifact.kind) {
      case ExecutionArtifactKind.RESEARCH:
        research = true;
        break;
      case ExecutionArtifactKind.PLAN:
        plan = true;
        break;
      case ExecutionArtifactKind.EXECUTION_SUMMARY:
        executionSummary = true;
        break;
      case ExecutionArtifactKind.REVIEW:
        review = true;
        break;
      case ExecutionArtifactKind.BRAINSTORM:
        brainstormCount += 1;
        break;
      case ExecutionArtifactKind.SWEEP:
        sweepCount += 1;
        break;
      default:
        // Defensive: future kinds should be added here so the board
        // stays honest with the audit trail.
        break;
    }
  }
  return Object.freeze({
    brainstormCount,
    executionSummary,
    plan,
    research,
    review,
    sweepCount,
  });
}

/**
 * Wraps {@link summarizeArtifacts} with declared-by-plugin gating: only
 * the kinds the bound plugin declares in its phase graph render. When
 * no plugin is bound we surface the four stable phase kinds (research
 * / plan / execution-summary / review) so the board still tells the
 * user what audit-trail evidence exists for the Task.
 */
export function summarizeArtifactsForPlugin(
  artifacts: readonly ExecutionArtifact[],
  declaredKinds: readonly string[] | undefined,
): BoardArtifactSummary {
  const summary = summarizeArtifacts(artifacts);
  const declared = new Set(declaredKinds ?? []);
  return Object.freeze({
    brainstormCount: summary.brainstormCount,
    executionSummary:
      declared.size === 0
        ? summary.executionSummary
        : declared.has('execution-summary') && summary.executionSummary,
    plan: declared.size === 0 ? summary.plan : declared.has('plan') && summary.plan,
    research:
      declared.size === 0 ? summary.research : declared.has('research') && summary.research,
    review: declared.size === 0 ? summary.review : declared.has('review') && summary.review,
    sweepCount: summary.sweepCount,
  });
}

function renderArtifactIndicators(
  task: WorkspaceTaskOverview,
  summary: BoardArtifactSummary,
): readonly ReactNode[] {
  const items: ReactNode[] = [];
  if (summary.research) {
    items.push(
      <li
        key="research"
        className="board-view__artifact"
        data-board-artifact-kind="research"
        data-board-task-id={task.task.id}
      >
        research ✓
      </li>,
    );
  }
  if (summary.plan || task.latestPlan !== undefined) {
    items.push(
      <li
        key="plan"
        className="board-view__artifact"
        data-board-artifact-kind="plan"
        data-board-task-id={task.task.id}
      >
        plan ✓
      </li>,
    );
  }
  if (summary.executionSummary) {
    items.push(
      <li
        key="execution-summary"
        className="board-view__artifact"
        data-board-artifact-kind="execution-summary"
        data-board-task-id={task.task.id}
      >
        execution summary ✓
      </li>,
    );
  }
  if (summary.review) {
    items.push(
      <li
        key="review"
        className="board-view__artifact"
        data-board-artifact-kind="review"
        data-board-task-id={task.task.id}
      >
        review ✓
      </li>,
    );
  }
  if (summary.brainstormCount > 0) {
    items.push(
      <li
        key="brainstorm"
        className="board-view__artifact"
        data-board-artifact-kind="brainstorm"
        data-board-task-id={task.task.id}
      >
        brainstorm × {String(summary.brainstormCount)}
      </li>,
    );
  }
  if (summary.sweepCount > 0) {
    items.push(
      <li
        key="sweep"
        className="board-view__artifact"
        data-board-artifact-kind="sweep"
        data-board-task-id={task.task.id}
      >
        sweep × {String(summary.sweepCount)}
      </li>,
    );
  }
  return Object.freeze(items);
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
                      <ul
                        aria-label={`Artifacts for ${task.task.title}`}
                        className="board-view__artifacts"
                        data-board-artifacts={task.task.id}
                      >
                        {renderArtifactIndicators(
                          task,
                          summarizeArtifactsForPlugin(
                            task.artifacts,
                            task.workflowPlugin?.phaseArtifactKinds,
                          ),
                        )}
                      </ul>
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
