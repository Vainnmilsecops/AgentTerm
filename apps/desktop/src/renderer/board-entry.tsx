import { StrictMode, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import type { AgentWorkspaceOverview } from "@agentterm/application";

import { BoardView } from "./board-view";
import type { AgentWorkspaceClient } from "./workspace-controller";

/**
 * Standalone Board entry point used by the Electron `/board` route.
 *
 * M2 keeps the renderer presentation-only: the entry mounts `BoardView` against
 * the same `AgentWorkspaceClient` exposed by the preload script as the existing
 * `/workspace` route, so the Kanban surface shares the `loadWorkspace` read model
 * without introducing new IPC handlers.
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
    <BoardView
      overview={overview}
      {...(onActivateTask === undefined ? {} : { onActivateTask })}
    />
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
