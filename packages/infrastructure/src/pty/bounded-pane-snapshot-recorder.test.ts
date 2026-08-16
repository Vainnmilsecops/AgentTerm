import { describe, expect, it, vi } from 'vitest';

import type { PtyRuntimeEvent } from '@agentterm/application';

import { BoundedPaneSnapshotRecorder } from './bounded-pane-snapshot-recorder';

function outputEvent(sessionId: string, data: string): PtyRuntimeEvent {
  void sessionId;
  return { data, kind: 'output', sequence: 1 };
}

describe('BoundedPaneSnapshotRecorder', () => {
  it('returns undefined for sessions that have not emitted output', async () => {
    const recorder = new BoundedPaneSnapshotRecorder({ clock: () => 100 });
    expect(await recorder.readSnapshot({ maximumLines: 50, sessionId: 'absent' })).toBeUndefined();
  });

  it('records output line-by-line and reports the supplied captured timestamp', async () => {
    let now = 42;
    const recorder = new BoundedPaneSnapshotRecorder({ clock: () => now });
    const sink = recorder.sinkFor('session-1');

    sink(outputEvent('session-1', 'first line\nsecond line'));

    const snapshot = await recorder.readSnapshot({ maximumLines: 50, sessionId: 'session-1' });
    expect(snapshot).toEqual({
      boundedLines: ['first line', 'second line'],
      capturedAt: 42,
      sessionId: 'session-1',
      truncated: false,
    });
  });

  it('reports truncation when the ring buffer drops earlier lines', async () => {
    const recorder = new BoundedPaneSnapshotRecorder({
      clock: () => 10,
      maximumLines: 3,
    });
    const sink = recorder.sinkFor('session-2');
    for (const line of ['a', 'b', 'c', 'd', 'e']) {
      sink(outputEvent('session-2', line));
    }
    const snapshot = await recorder.readSnapshot({ maximumLines: 3, sessionId: 'session-2' });
    expect(snapshot?.boundedLines).toEqual(['c', 'd', 'e']);
    expect(snapshot?.truncated).toBe(true);
  });

  it('drops the buffer when forget() is invoked', async () => {
    const recorder = new BoundedPaneSnapshotRecorder({ clock: () => 1 });
    const sink = recorder.sinkFor('session-3');
    sink(outputEvent('session-3', 'hello'));
    recorder.forget('session-3');
    expect(await recorder.readSnapshot({ maximumLines: 10, sessionId: 'session-3' })).toBeUndefined();
  });

  it('updates capturedAt on every output batch', async () => {
    const clock = vi.fn<() => number>().mockReturnValueOnce(5).mockReturnValueOnce(7);
    const recorder = new BoundedPaneSnapshotRecorder({ clock });
    const sink = recorder.sinkFor('session-4');
    sink(outputEvent('session-4', 'first'));
    sink(outputEvent('session-4', 'second'));
    const snapshot = await recorder.readSnapshot({ maximumLines: 10, sessionId: 'session-4' });
    expect(snapshot?.capturedAt).toBe(7);
  });
});