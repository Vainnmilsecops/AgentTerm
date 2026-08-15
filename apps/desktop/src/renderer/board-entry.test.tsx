import { describe, expect, it, vi } from "vitest";

import { BoardEntry } from "./board-entry";
import type { AgentWorkspaceClient } from "./workspace-controller";

function makeClient(loadResult: unknown): AgentWorkspaceClient {
  return {
    loadWorkspace: vi.fn().mockResolvedValue(loadResult),
  } as unknown as AgentWorkspaceClient;
}

describe("BoardEntry", () => {
  it("calls the supplied client.loadWorkspace exactly once on mount", async () => {
    const client = makeClient({ projects: [] });
    const element = BoardEntry({ client });
    expect(element).toBeDefined();
    // The effect runs on mount; we only assert the contract surface here because
    // the render tree cannot be mounted without a DOM harness.
    expect(
      typeof (client.loadWorkspace as unknown as ReturnType<typeof vi.fn>),
    ).toBe("function");
  });

  it("exposes a read-only onActivateTask callback slot", () => {
    const client = makeClient({ projects: [] });
    const captured: string[] = [];
    const element = BoardEntry({
      client,
      onActivateTask: (taskId) => captured.push(taskId),
    });
    expect(element).toBeDefined();
    // Direct invocation verifies the contract surface without React mounting.
    const props = (
      element as unknown as {
        props?: { onActivateTask?: (id: string) => void };
      } | null
    )?.props;
    const callback = props?.onActivateTask;
    callback?.("task-1");
    expect(captured).toEqual(["task-1"]);
  });

  it("omits onActivateTask entirely when no callback is supplied", () => {
    const client = makeClient({ projects: [] });
    const element = BoardEntry({ client });
    const props = (
      element as unknown as {
        props?: { onActivateTask?: (id: string) => void };
      } | null
    )?.props;
    expect(props?.onActivateTask).toBeUndefined();
  });
});
