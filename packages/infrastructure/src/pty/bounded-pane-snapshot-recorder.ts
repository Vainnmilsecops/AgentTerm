import type {
  AgentPaneSnapshot,
  AgentPaneSnapshotProvider,
  PtyRuntimeEvent,
} from '@agentterm/application';

const DEFAULT_MAX_LINES = 800;

export interface BoundedPaneSnapshotRecorderOptions {
  readonly clock?: () => number;
  readonly maximumLines?: number;
}

/**
 * Captures bounded recent output for every PTY session so the read-only MCP
 * server can answer `read-pane-content` without re-running the agent. The
 * recorder keeps only the last N lines (default 800) per session and never
 * forwards input back to the runtime.
 */
export class BoundedPaneSnapshotRecorder implements AgentPaneSnapshotProvider {
  private readonly buffers = new Map<string, string[]>();
  private readonly capturedAt = new Map<string, number>();
  private readonly clock: () => number;
  private readonly maximumLines: number;

  public constructor(options: BoundedPaneSnapshotRecorderOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.maximumLines = options.maximumLines ?? DEFAULT_MAX_LINES;
  }

  /** Returns a PtyRuntimeEventSink bound to this recorder for the given session. */
  public sinkFor(sessionId: string): (event: PtyRuntimeEvent) => void {
    return (event: PtyRuntimeEvent): void => {
      if (event.kind !== 'output') return;
      this.append(sessionId, event.data);
    };
  }  public async readSnapshot(input: {
    readonly maximumLines: number;
    readonly sessionId: string;
  }): Promise<AgentPaneSnapshot | undefined> {
    const buffer = this.buffers.get(input.sessionId);
    if (buffer === undefined || buffer.length === 0) {
      return undefined;
    }
    const limit = Math.max(1, Math.min(input.maximumLines, this.maximumLines));
    const truncatedByRetention = buffer.length >= this.maximumLines;
    const truncatedByRequest = buffer.length > limit;
    const truncated = truncatedByRetention || truncatedByRequest;
    const boundedLines = truncated ? buffer.slice(-limit) : buffer.slice();
    return Object.freeze({
      boundedLines: Object.freeze(boundedLines),
      capturedAt: this.capturedAt.get(input.sessionId) ?? this.clock(),
      sessionId: input.sessionId,
      truncated,
    });
  }

  public forget(sessionId: string): void {
    this.buffers.delete(sessionId);
    this.capturedAt.delete(sessionId);
  }

  private append(sessionId: string, data: string): void {
    const lines = data.split(/\r?\n/u);
    let buffer = this.buffers.get(sessionId) ?? [];
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    if (lines.length === 0) return;
    buffer = buffer.concat(lines);
    if (buffer.length > this.maximumLines) {
      buffer = buffer.slice(buffer.length - this.maximumLines);
    }
    this.buffers.set(sessionId, buffer);
    this.capturedAt.set(sessionId, this.clock());
  }
}