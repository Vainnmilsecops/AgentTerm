import { useEffect, useRef, useState } from 'react';
import type { SessionRecoveryReadiness, SessionRecoveryReason } from '@agentterm/application';
import type { AgentTermDesktopApi } from '../ipc-contract';

const reasons: Record<SessionRecoveryReason, string> = {
  READY: 'Continue the recorded conversation in its existing task worktree.',
  SESSION_NOT_FOUND: 'The previous session is no longer available.',
  ACTIVE_SESSION: 'A session is still active. Stop it before resuming.',
  NEWER_ATTEMPT: 'A newer attempt exists. Select the latest session.',
  PROVIDER_ID_MISSING:
    'No conversation ID was recorded. This session cannot be resumed; Retry starts a new conversation.',
  TASK_PHASE: 'Resume is available during research, planning or execution.',
  GATE_RUNNING: 'Wait for the running quality gate to finish.',
  DEPENDENCY_BLOCKED: 'Complete the task dependencies before resuming.',
  AGENT_UNAVAILABLE: 'The original agent is unavailable. Check its executable in Settings.',
  RESUME_UNSUPPORTED: 'The installed agent does not advertise session resume support.',
  WORKTREE_UNAVAILABLE: 'The original task worktree could not be verified.',
};

export function SessionRecoveryPanel({
  client,
  sessionId,
  onResumed,
}: {
  readonly client: Pick<AgentTermDesktopApi, 'inspectSessionRecovery' | 'resumeAgentSession'>;
  readonly sessionId: string;
  readonly onResumed: () => void;
}) {
  const [readiness, setReadiness] = useState<SessionRecoveryReadiness>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setReadiness(undefined);
    setError(undefined);
    void client.inspectSessionRecovery({ sessionId }).then(
      (next) => {
        if (!cancelled) setReadiness(next);
      },
      () => {
        if (!cancelled) setError('Could not check recovery status. Try again.');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, sessionId, revision]);

  const resume = async (): Promise<void> => {
    if (inFlight.current || readiness?.canResume !== true || readiness.sessionId !== sessionId)
      return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await client.resumeAgentSession({ sessionId });
      if (mounted.current) {
        onResumed();
        setRevision((value) => value + 1);
      }
    } catch {
      if (mounted.current)
        setError(
          'Resume failed. The previous conversation history is preserved. Refresh status before retrying.',
        );
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <section className="context-card" aria-label="Session recovery">
      <strong>Resume conversation</strong>
      <p>
        Previous session: <code>{sessionId}</code>
      </p>
      <p role="status">
        {error ?? (readiness ? reasons[readiness.reason] : 'Checking recovery status…')}
      </p>
      <button
        className="secondary-action"
        type="button"
        disabled={busy || readiness?.canResume !== true}
        onClick={() => void resume()}
      >
        {busy ? 'Resuming…' : 'Resume conversation'}
      </button>
      <button
        className="secondary-action"
        type="button"
        disabled={busy}
        onClick={() => setRevision((value) => value + 1)}
      >
        Refresh status
      </button>
    </section>
  );
}
