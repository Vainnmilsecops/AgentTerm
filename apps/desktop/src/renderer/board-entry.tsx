import {
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";

import type { AgentWorkspaceOverview } from "@agentterm/application";

import {
  BOARD_PHASE_ORDER,
  decodeBoardFocusHash,
  encodeBoardFocusHash,
  initialBoardFocus,
  projectColumnSizes,
  reduceBoardKeyboard,
  resolveBoardKeyboardKey,
  resolveFocusedTaskId,
  type BoardFocus,
  type BoardKeyboardCommand,
} from "./board-keyboard";
import {
  decideBoardTerminalAction,
  type BoardTerminalShortcutOutcome,
} from "./board-terminal-shortcut";
import {
  BoardView,
  projectOverviewToBoard,
} from "./board-view";
import type { AgentWorkspaceClient } from "./workspace-controller";

/**
 * Standalone Board entry point used by the Electron `/board` route.
 *
 * M2 keeps the renderer presentation-only: the entry mounts `BoardView` against
 * the same `AgentWorkspaceClient` exposed by the preload script as the existing
 * `/workspace` route, so the Kanban surface shares the `loadWorkspace` read model
 * without introducing new IPC handlers.
 *
 * Keyboard navigation (h/l/j/k, Enter, Ctrl+f) is wired here so the entry
 * owns the single keydown listener for the board window.
 */

export interface BoardEntryProps {
  readonly client: AgentWorkspaceClient;
  readonly onActivateTask?: (taskId: string) => void;
}

export function BoardEntry({
  client,
  onActivateTask,
}: BoardEntryProps): ReactNode {
  const [overview, setOverview] = useState<AgentWorkspaceOverview | undefined>(
    undefined,
  );
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await client.loadWorkspace();
        if (!cancelled) {
          setOverview(next);
        }
      } catch {
        if (!cancelled) {
          setError("Workspace data could not be loaded.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  if (error !== undefined) {
    return <p data-board-error="">{error}</p>;
  }
  if (overview === undefined) {
    return <p data-board-loading="">Loading workspace…</p>;
  }
  return (
    <BoardEntryWithOverview
      overview={overview}
      {...(onActivateTask === undefined ? {} : { onActivateTask })}
    />
  );
}

interface BoardEntryWithOverviewProps {
  readonly overview: AgentWorkspaceOverview;
  readonly onActivateTask?: (taskId: string) => void;
}

function BoardEntryWithOverview({
  overview,
  onActivateTask,
}: BoardEntryWithOverviewProps): ReactNode {
  const columns = useMemo(() => projectOverviewToBoard(overview), [overview]);
  const columnSizes = useMemo(() => projectColumnSizes(columns), [columns]);
  const [focus, setFocus] = useState<BoardFocus>(() =>
    initialFocusFor(columnSizes),
  );
  const [terminalNotice, setTerminalNotice] = useState<
    BoardTerminalShortcutOutcome | undefined
  >(undefined);

  // Persist focus across reloads by encoding in `#focus=<column>:<row>`.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const next = `#${encodeBoardFocusHash(focus)}`;
    if (window.location.hash !== next) {
      window.history.replaceState(null, "", next);
    }
  }, [focus]);

  const handleActivateFocused = useCallback(() => {
    const taskId = resolveFocusedTaskId(focus, columns);
    if (taskId === undefined) return;
    if (onActivateTask !== undefined) {
      onActivateTask(taskId);
    }
  }, [focus, columns, onActivateTask]);

  const handleOpenTerminal = useCallback(() => {
    const outcome = decideBoardTerminalAction(focus, columns);
    setTerminalNotice(outcome);
    // Auto-clear the notice after a short delay so the user sees it without
    // having to dismiss it manually; the underlying IPC integration is the
    // follow-up plan per M2.3 "if too invasive, defer".
    if (typeof window !== "undefined") {
      window.setTimeout(() => {
        setTerminalNotice(undefined);
      }, 4_000);
    }
  }, [focus, columns]);

  // Dispatch a keyboard command by reading the latest column sizes from the
  // closure. The callback re-binds whenever `columnSizes` changes so the
  // reducer always clamps to the current layout.
  const dispatch = useCallback(
    (command: Exclude<BoardKeyboardCommand, "UNKNOWN">) => {
      setFocus((current) => applyCommand(current, command, columnSizes));
    },
    [columnSizes],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const listener = (event: KeyboardEvent) => {
      const command = resolveBoardKeyboardKey({
        ctrlKey: event.ctrlKey,
        key: event.key,
        target: event.target as Element | null,
      });
      if (command === null || command === "UNKNOWN") return;
      event.preventDefault();
      switch (command) {
        case "MOVE_LEFT":
          dispatch("MOVE_LEFT");
          return;
        case "MOVE_RIGHT":
          dispatch("MOVE_RIGHT");
          return;
        case "MOVE_UP":
          dispatch("MOVE_UP");
          return;
        case "MOVE_DOWN":
          dispatch("MOVE_DOWN");
          return;
        case "ACTIVATE":
          handleActivateFocused();
          return;
        case "OPEN_TERMINAL":
          handleOpenTerminal();
          return;
      }
    };
    window.addEventListener("keydown", listener);
    return () => {
      window.removeEventListener("keydown", listener);
    };
  }, [dispatch, handleActivateFocused, handleOpenTerminal]);

  return (
    <div data-board-window-root="">
      <BoardView
        focus={focus}
        overview={overview}
        {...(onActivateTask === undefined ? {} : { onActivateTask })}
      />
      <p
        data-board-help=""
        style={{ fontSize: "0.85em", opacity: 0.7, padding: "0.5em" }}
      >
        h/l columns · j/k rows · Enter activate · Ctrl+f open terminal
      </p>
      {terminalNotice === undefined ? null : (
        <p
          data-board-terminal-notice={terminalNotice.kind}
          role="status"
          style={{ fontSize: "0.85em", padding: "0.5em" }}
        >
          {terminalNotice.kind === "no-task-focused"
            ? "No Task is focused."
            : `Open the main AgentTerm window to follow the live terminal for Task ${terminalNotice.taskId}.`}
        </p>
      )}
    </div>
  );
}

/**
 * Maps a {@link BoardKeyboardCommand} to a reducer action and runs the pure
 * reducer with the latest column sizes. Centralized here so the keydown
 * listener and the unit tests share the same path.
 */
function applyCommand(
  focus: BoardFocus,
  command: Exclude<BoardKeyboardCommand, "UNKNOWN">,
  columnSizes: readonly number[],
): BoardFocus {
  switch (command) {
    case "MOVE_LEFT":
      return reduceBoardKeyboard(focus, { kind: "MOVE_LEFT" }, columnSizes);
    case "MOVE_RIGHT":
      return reduceBoardKeyboard(focus, { kind: "MOVE_RIGHT" }, columnSizes);
    case "MOVE_UP":
      return reduceBoardKeyboard(focus, { kind: "MOVE_UP" }, columnSizes);
    case "MOVE_DOWN":
      return reduceBoardKeyboard(focus, { kind: "MOVE_DOWN" }, columnSizes);
    case "ACTIVATE":
    case "OPEN_TERMINAL":
      // These commands are routed to handlers, not the reducer.
      return focus;
  }
}

function initialFocusFor(columnSizes: readonly number[]): BoardFocus {
  if (typeof window !== "undefined") {
    const fromHash = decodeBoardFocusHash(window.location.hash);
    if (fromHash !== undefined) {
      // Clamp the decoded focus to the current column sizes; the entry then
      // applies the rowIndex only if the new column has enough tasks.
      const base = reduceBoardKeyboard(
        initialBoardFocus,
        {
          columns: columnSizes.length,
          kind: "RESET",
          columnIndex: fromHash.columnIndex,
        },
        columnSizes,
      );
      const columnRows = columnSizes[base.columnIndex] ?? 0;
      const row = columnRows > 0 ? Math.min(fromHash.rowIndex, columnRows - 1) : 0;
      return Object.freeze({ columnIndex: base.columnIndex, rowIndex: row });
    }
  }
  return reduceBoardKeyboard(
    initialBoardFocus,
    { columns: columnSizes.length, kind: "RESET" },
    columnSizes,
  );
}

declare global {
  interface Window {
    readonly agenttermWorkspace?: AgentWorkspaceClient;
  }
}

export function mountBoardEntry(rootId: string): void {
  const rootElement = document.getElementById(rootId);
  if (rootElement === null) {
    throw new Error(`Board entry root #${rootId} was not found.`);
  }
  const client = window.agenttermWorkspace;
  if (client === undefined) {
    rootElement.textContent =
      "AgentTerm board entry is unavailable without a workspace client.";
    return;
  }
  createRoot(rootElement).render(
    <StrictMode>
      <BoardEntry client={client} />
    </StrictMode>,
  );
}

export { BOARD_PHASE_ORDER, applyCommand };
