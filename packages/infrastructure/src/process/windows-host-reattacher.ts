import type { AgentSessionHostOwnership, HostReattacher } from '@agentterm/application';

/**
 * Read-only host liveness inspector that drives reattach vs. resume vs. fail-closed.
 *
 * The implementation rejects anything that would spawn, signal, or otherwise mutate
 * the host process. It only reports whether the host pid is still alive and whether
 * the previously recorded ConPTY named pipes are still reachable. The pid-side
 * check uses `process.kill(pid, 0)`, which is the platform-portable "does this pid
 * exist in the current process's permission scope" probe and never sends a signal.
 *
 * Pipe existence is a best-effort sanity check that mitigates the well-known OS
 * pid-reuse race: even if the pid is now bound to a different process, the named
 * pipes we previously recorded will not be present.
 */
export class NodeHostReattacher implements HostReattacher {
  public constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly aliveProbe: (pid: number) => boolean = defaultAliveProbe,
    private readonly pipeProbe: (pipeName: string) => boolean = defaultPipeProbe,
  ) {}

  public async inspect(
    ownership: AgentSessionHostOwnership,
  ): Promise<
    | { readonly kind: 'alive' }
    | { readonly kind: 'dead'; readonly reason: 'PIPE_GONE' | 'PROCESS_GONE' }
  > {
    if (ownership.hostPid <= 0) {
      return { kind: 'dead', reason: 'PROCESS_GONE' };
    }

    if (!this.aliveProbe(ownership.hostPid)) {
      return { kind: 'dead', reason: 'PROCESS_GONE' };
    }

    if (!this.pipeProbe(ownership.conptyInPipeName)) {
      return { kind: 'dead', reason: 'PIPE_GONE' };
    }
    if (!this.pipeProbe(ownership.conptyOutPipeName)) {
      return { kind: 'dead', reason: 'PIPE_GONE' };
    }

    return { kind: 'alive' };
  }
}

function defaultAliveProbe(pid: number): boolean {
  // process.kill(pid, 0) is the documented "is this pid reachable?" probe. It does
  // not send a signal and surfaces ESRCH when the pid is gone. We must opt out of
  // throwing so the orchestrator can read the decision.
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isExpectedError(error)) {
      return false;
    }
    // Anything else (EPERM, etc.) is treated as "the pid is live but unreachable".
    // That is good enough for a liveness hint; the coordinator still must rely on
    // the rest of the pipeline to fail-closed.
    return true;
  }
}

function isExpectedError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === 'ESRCH' || code === 'ENOENT';
}

function defaultPipeProbe(pipeName: string): boolean {
  // The current Windows ConPTY runtime routes streams through node-pty and does
  // not expose the host's anonymous pipes as discoverable Win32 named pipes.
  // Until the runtime is upgraded to use named pipes that survive an Electron
  // main restart, the pipe probe is intentionally deterministic and fail-closed:
  // any persisted ownership record reads as PIPE_GONE and the coordinator falls
  // back to provider-native resume.
  void pipeName;
  return false;
}
