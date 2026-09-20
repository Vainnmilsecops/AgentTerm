import { useEffect, useRef, useState } from 'react';
import type {
  TaskContextAttachment,
  TaskContextHandoff,
  TaskContextHandoffReadiness,
} from '@agentterm/application';
import type { AgentTermDesktopApi } from '../ipc-contract';

export function ContextHandoffPanel({
  client,
  taskId,
  sessionId,
  items,
}: {
  readonly client: Pick<AgentTermDesktopApi, 'inspectContextHandoff' | 'prepareContextHandoff'>;
  readonly taskId: string;
  readonly sessionId: string;
  readonly items: readonly TaskContextAttachment[];
}) {
  const [readiness, setReadiness] = useState<TaskContextHandoffReadiness>();
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TaskContextHandoff>();
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const locked = useRef(false);
  const mounted = useRef(true);
  const prompt = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setReadiness(undefined);
    setResult(undefined);
    void client.inspectContextHandoff({ taskId, sessionId }).then(
      (value) => {
        if (!cancelled) setReadiness(value);
      },
      () => {
        if (!cancelled) setError('Could not inspect context support. Refresh to retry.');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, taskId, sessionId, revision]);
  useEffect(() => {
    if (result) {
      prompt.current?.focus();
      prompt.current?.select();
    }
  }, [result]);
  const prepare = async () => {
    if (locked.current || !consent || !selected.length || !readiness?.canPrepare) return;
    locked.current = true;
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      const value = await client.prepareContextHandoff({
        taskId,
        sessionId,
        attachmentIds: selected,
        confirmWorktreeCopy: true,
      });
      if (mounted.current) setResult(value);
    } catch {
      if (mounted.current)
        setError(
          'Handoff preparation could not be confirmed. Check the session, file integrity and worktree. Some copies may remain; no prompt was submitted.',
        );
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <div aria-label="Text context handoff">
      <strong>Prepare text handoff</strong>
      <p role="status">{readiness?.reason ?? 'Checking adapter support…'}</p>
      {readiness?.canPrepare && (
        <>
          <fieldset disabled={busy}>
            <legend>Select up to 8 text files, 64 KiB each</legend>
            {items.map((item) => {
              const eligible =
                item.taskId === taskId &&
                item.size <= 65536 &&
                ['text/plain', 'text/markdown', 'application/json'].includes(item.mime);
              return (
                <label key={item.id} style={{ display: 'block', overflowWrap: 'anywhere' }}>
                  <input
                    type="checkbox"
                    data-context-handoff-select
                    disabled={!eligible}
                    checked={selected.includes(item.id)}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setResult(undefined);
                      setConsent(false);
                      setSelected((previous) =>
                        checked ? [...previous, item.id] : previous.filter((id) => id !== item.id),
                      );
                    }}
                  />
                  {item.name}
                  {!eligible ? ' — unsupported type, size or task' : ''}
                  <small style={{ display: 'block', overflowWrap: 'anywhere' }}>
                    Imported in session: <code>{item.sessionId}</code>
                    {item.sessionId !== sessionId
                      ? ' — reusing saved context; source unchanged'
                      : ''}
                  </small>
                </label>
              );
            })}
          </fieldset>
          <label>
            <input
              type="checkbox"
              data-context-handoff-consent
              disabled={busy}
              checked={consent}
              onChange={(event) => setConsent(event.currentTarget.checked)}
            />
            I approve copying the selected files, including any from prior sessions, into this task
            worktree for session <code style={{ overflowWrap: 'anywhere' }}>{sessionId}</code>.
            Original import history stays unchanged. Copies can appear in Git status and be
            committed. Submitting the prompt shares their contents with the target agent provider.
          </label>
          <button
            type="button"
            className="secondary-action"
            data-context-handoff-prepare
            disabled={busy || !consent || selected.length < 1 || selected.length > 8}
            onClick={() => void prepare()}
          >
            {busy ? 'Preparing…' : 'Prepare prompt (no auto-send)'}
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {result && (
        <>
          <p>
            Prepared for {result.agentName}, session <code>{result.sessionId}</code>. Nothing
            submitted.
          </p>
          <label>
            Prompt to copy manually
            <textarea
              ref={prompt}
              readOnly
              value={result.prompt}
              style={{ width: '100%', minHeight: 90 }}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <p>
            Copy with Ctrl+C, verify the intended agent is at its normal prompt in this task
            worktree (not shell mode), then paste and review before Enter. Check the CLI confirms
            every file was read; ignore rules and token limits may skip content. Do not commit
            private context copies.
          </p>
        </>
      )}
      <button
        type="button"
        className="secondary-action"
        disabled={busy}
        onClick={() => {
          setError(undefined);
          setRevision((value) => value + 1);
        }}
      >
        Refresh handoff support
      </button>
    </div>
  );
}
