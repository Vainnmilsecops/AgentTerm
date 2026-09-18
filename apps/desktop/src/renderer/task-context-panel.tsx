import { useEffect, useRef, useState } from 'react';
import type { TaskContextAttachment } from '@agentterm/application';
import type { AgentTermDesktopApi } from '../ipc-contract';

function FilePreview({ file }: { readonly file: File }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!['image/png', 'image/jpeg'].includes(file.type)) return;
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return (
    <li style={{ overflowWrap: 'anywhere' }}>
      {file.name} — {file.size.toLocaleString()} bytes ({file.type || 'type checked on import'})
      {url && (
        <img
          src={url}
          alt={`Preview of ${file.name}`}
          style={{ display: 'block', maxWidth: '100%', maxHeight: 120 }}
        />
      )}
    </li>
  );
}

export function TaskContextPanel({
  client,
  taskId,
  sessionId,
}: {
  readonly client: Pick<AgentTermDesktopApi, 'importTaskContext' | 'listTaskContext'>;
  readonly taskId: string;
  readonly sessionId: string | undefined;
}) {
  const [files, setFiles] = useState<readonly File[]>([]);
  const [items, setItems] = useState<readonly TaskContextAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState('Loading attachments…');
  const [revision, setRevision] = useState(0);
  const locked = useRef(false);
  const panel = useRef<HTMLElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    void client.listTaskContext({ taskId }).then(
      (next) => {
        if (!cancelled) {
          setItems(next);
          setStatus(next.length ? `${next.length} stored attachment(s)` : 'No attachments yet.');
        }
      },
      () => {
        if (!cancelled) setError('Could not load attachments. Use Refresh to retry.');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, taskId, revision]);
  const choose = (next: readonly File[]) => {
    if (locked.current || !sessionId) return;
    setError(undefined);
    if (
      !next.length ||
      next.length > 8 ||
      next.some((file) => file.size < 1 || file.size > 8 * 1024 * 1024) ||
      next.reduce((sum, file) => sum + file.size, 0) > 32 * 1024 * 1024
    ) {
      setFiles([]);
      setError('Choose 1–8 nonempty files, at most 8 MiB each and 32 MiB total.');
      return;
    }
    setFiles(next);
  };
  const save = async () => {
    if (locked.current || !sessionId || !files.length) return;
    locked.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const payload = [];
      for (const file of files)
        payload.push({
          name: file.name,
          mime: file.type,
          bytes: new Uint8Array(await file.arrayBuffer()),
        });
      const saved = await client.importTaskContext({ taskId, sessionId, files: payload });
      if (mounted.current) {
        setItems((previous) => [...previous, ...saved]);
        setFiles([]);
        setStatus(`Saved ${saved.length} attachment(s). Nothing was sent to the agent.`);
        panel.current?.focus();
      }
    } catch {
      if (mounted.current)
        setError(
          'Import could not be confirmed. Refresh before retrying. Check file type, name, limits and target session; a private staged copy may remain after a storage failure.',
        );
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section
      ref={panel}
      className="context-card"
      aria-label="Task context attachments"
      tabIndex={0}
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        choose(Array.from(event.dataTransfer.files));
      }}
      onPaste={(event) => {
        if (event.clipboardData.files.length) {
          event.preventDefault();
          event.stopPropagation();
          choose(Array.from(event.clipboardData.files));
        }
      }}
    >
      <strong>Task context attachments</strong>
      <p style={{ overflowWrap: 'anywhere' }}>
        Target task: <code>{taskId}</code>
        <br />
        Session: <code>{sessionId ?? 'Start a session first'}</code>
      </p>
      <p>
        Choose files, drop here, or focus this panel and paste an image. TXT, MD, JSON, PNG, JPEG,
        PDF; 8 MiB/file, 8 files/import, 64 files/task.
      </p>
      <label>
        Choose context files{' '}
        <input
          type="file"
          multiple
          accept=".txt,.md,.json,.png,.jpg,.jpeg,.pdf"
          disabled={busy || !sessionId}
          onChange={(event) => {
            choose(Array.from(event.currentTarget.files ?? []));
            event.currentTarget.value = '';
          }}
        />
      </label>
      {files.length > 0 && (
        <div aria-label="Attachment preview">
          <ul>
            {files.map((file, index) => (
              <FilePreview key={`${file.name}-${index}`} file={file} />
            ))}
          </ul>
          <p>
            Confirm these files for the target above. Files are stored locally, not sent to the
            agent.
          </p>
          <button
            type="button"
            className="secondary-action"
            data-context-confirm
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : 'Confirm and save attachments'}
          </button>
          <button
            type="button"
            className="secondary-action"
            disabled={busy}
            onClick={() => {
              setFiles([]);
              panel.current?.focus();
            }}
          >
            Cancel
          </button>
        </div>
      )}
      <p role="status">{status}</p>
      {error && <p role="alert">{error}</p>}
      <ul>
        {items.map((item) => (
          <li key={item.id} style={{ overflowWrap: 'anywhere' }}>
            {item.name} — {item.mime}, {item.size.toLocaleString()} bytes
            <br />
            Session: {item.sessionId}
            <br />
            <small>SHA-256: {item.digest}</small>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="secondary-action"
        disabled={busy}
        onClick={() => {
          setError(undefined);
          setRevision((value) => value + 1);
        }}
      >
        Refresh
      </button>
      <button
        type="button"
        className="secondary-action"
        disabled
        aria-describedby="context-delivery-unavailable"
      >
        Send to agent
      </button>
      <p id="context-delivery-unavailable">
        Context delivery is not enabled for this adapter. Files stay in AgentTerm storage; no
        terminal input is generated.
      </p>
    </section>
  );
}
