import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';

import type { WorkspaceProjectOverview, WorkspaceTaskOverview } from '@agentterm/application';

const boardColumns = Object.freeze([
  Object.freeze({ label: 'Backlog', phase: 'BACKLOG' as const }),
  Object.freeze({ label: 'Planning', phase: 'PLANNING' as const }),
  Object.freeze({ label: 'Running', phase: 'RUNNING' as const }),
  Object.freeze({ label: 'Review', phase: 'REVIEW' as const }),
  Object.freeze({ label: 'Done', phase: 'DONE' as const }),
]);

export interface WorkspaceProjectBoardProps {
  readonly onSelectTask: (taskId: string) => void;
  readonly project: WorkspaceProjectOverview;
  readonly selectedTaskId: string;
}

export function WorkspaceProjectBoard({
  onSelectTask,
  project,
  selectedTaskId,
}: WorkspaceProjectBoardProps) {
  const orderedTasks = useMemo(
    () =>
      boardColumns.flatMap((column) =>
        project.tasks.filter(({ task }) => task.phase === column.phase),
      ),
    [project.tasks],
  );
  const [focusedTaskId, setFocusedTaskId] = useState(selectedTaskId);

  useEffect(() => setFocusedTaskId(selectedTaskId), [selectedTaskId]);

  const moveFocus = (currentTaskId: string, direction: -1 | 1 | 'first' | 'last'): void => {
    const currentIndex = orderedTasks.findIndex(({ task }) => task.id === currentTaskId);
    if (currentIndex < 0 || orderedTasks.length === 0) return;
    const nextIndex =
      direction === 'first'
        ? 0
        : direction === 'last'
          ? orderedTasks.length - 1
          : (currentIndex + direction + orderedTasks.length) % orderedTasks.length;
    const nextTaskId = orderedTasks[nextIndex]?.task.id;
    if (nextTaskId === undefined) return;
    setFocusedTaskId(nextTaskId);
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(nextTaskId)}"]`)?.focus();
    });
  };

  return (
    <section aria-label="Project board" className="project-board">
      {boardColumns.map((column) => {
        const tasks = project.tasks.filter(({ task }) => task.phase === column.phase);
        const activeRuntime = tasks.some(({ activeSession }) =>
          activeSession === undefined
            ? false
            : ['STARTING', 'WORKING', 'WAITING_INPUT'].includes(activeSession.status),
        );
        return (
          <section
            aria-label={`${column.label} Tasks`}
            className="project-board__column"
            data-board-phase={column.phase}
            key={column.phase}
          >
            <header className="project-board__column-header">
              <h3>
                <span
                  aria-hidden="true"
                  className={`phase-dot phase-dot--${column.phase.toLowerCase()}${
                    activeRuntime ? ' phase-running--active' : ''
                  }`}
                />
                {column.label}
              </h3>
              <span className="project-board__count" aria-label={taskCountLabel(tasks.length)}>
                {tasks.length}
              </span>
            </header>
            {tasks.length === 0 ? (
              <p className="project-board__empty">No Tasks in {column.label.toLowerCase()}.</p>
            ) : (
              <ol className="project-board__cards">
                {tasks.map((entry) => (
                  <li key={entry.task.id}>
                    <TaskBoardCard
                      entry={entry}
                      focused={entry.task.id === focusedTaskId}
                      onFocus={() => setFocusedTaskId(entry.task.id)}
                      onMoveFocus={(delta) => moveFocus(entry.task.id, delta)}
                      onSelect={() => onSelectTask(entry.task.id)}
                      selected={entry.task.id === selectedTaskId}
                    />
                  </li>
                ))}
              </ol>
            )}
          </section>
        );
      })}
    </section>
  );
}

function taskCountLabel(count: number): string {
  return `${String(count)} ${count === 1 ? 'Task' : 'Tasks'}`;
}

function TaskBoardCard({
  entry,
  focused,
  onFocus,
  onMoveFocus,
  onSelect,
  selected,
}: {
  readonly entry: WorkspaceTaskOverview;
  readonly focused: boolean;
  readonly onFocus: () => void;
  readonly onMoveFocus: (direction: -1 | 1 | 'first' | 'last') => void;
  readonly onSelect: () => void;
  readonly selected: boolean;
}) {
  const session = entry.activeSession ?? entry.latestSession;
  const branch = entry.latestReview?.codeState.branchName;
  const sessionStatus = session?.status ?? 'NONE';
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      onMoveFocus(1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      onMoveFocus(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      onMoveFocus('first');
    } else if (event.key === 'End') {
      event.preventDefault();
      onMoveFocus('last');
    }
  };
  return (
    <button
      {...(selected ? { 'aria-current': 'true' as const } : {})}
      className="task-board-card"
      data-session-status={sessionStatus}
      data-task-id={entry.task.id}
      data-task-phase={entry.task.phase}
      onClick={onSelect}
      onFocus={onFocus}
      onKeyDown={handleKeyDown}
      tabIndex={focused ? 0 : -1}
      type="button"
    >
      <span className="task-board-card__meta">
        <span
          className={`task-board-card__status task-board-card__status--${entry.task.phase.toLowerCase()}`}
        >
          Task phase: {entry.task.phase}
        </span>
        <span>{entry.task.id}</span>
      </span>
      <strong>{entry.task.title}</strong>
      <span className="task-board-card__brief">
        {entry.task.brief ?? 'No persisted Task brief.'}
      </span>
      {branch === undefined ? null : (
        <code className="task-board-card__branch" title={branch}>
          {branch}
        </code>
      )}
      <span className="task-board-card__footer">
        <span
          className={`task-board-card__runtime task-board-card__runtime--${sessionStatus.toLowerCase()}`}
        >
          Session: {session === undefined ? 'No session' : `${session.status} · ${session.agentId}`}
        </span>
        {entry.blocked ? (
          <span className="task-board-card__blocked">Blocked by dependency</span>
        ) : null}
        <span>
          {entry.dependencies.length === 0
            ? 'No dependencies'
            : `${String(entry.dependencies.length)} dependencies`}
        </span>
      </span>
    </button>
  );
}
