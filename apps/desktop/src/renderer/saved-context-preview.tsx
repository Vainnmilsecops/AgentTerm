import { useEffect, useId, useRef, useState } from 'react';
import type { TaskContextAttachment } from '@agentterm/application';
import type { AgentTermDesktopApi } from '../ipc-contract';

export function SavedContextPreview({
  client,
  item,
}: {
  readonly client: Pick<AgentTermDesktopApi, 'previewTaskContext'>;
  readonly item: TaskContextAttachment;
}) {
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState<string>();
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const button = useRef<HTMLButtonElement>(null);
  const region = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLPreElement>(null);
  const id = useId();
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  useEffect(() => {
    if (text !== undefined && region.current?.contains(document.activeElement))
      content.current?.focus();
  }, [text]);
  const supported =
    item.size > 0 &&
    item.size <= 65536 &&
    ['text/plain', 'text/markdown', 'application/json'].includes(item.mime);
  const close = () => {
    generation.current++;
    setExpanded(false);
    setText(undefined);
    setError(false);
    button.current?.focus();
  };
  const read = async () => {
    const request = ++generation.current;
    setExpanded(true);
    setText(undefined);
    setError(false);
    try {
      const result = await client.previewTaskContext({
        taskId: item.taskId,
        attachmentId: item.id,
      });
      if (request === generation.current) {
        if (result.attachmentId !== item.id) setError(true);
        else setText(result.text);
      }
    } catch {
      if (request === generation.current) setError(true);
    }
  };
  return (
    <div
      ref={region}
      onKeyDown={(event) => {
        if (expanded && event.key === 'Escape') {
          event.stopPropagation();
          event.preventDefault();
          close();
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className="secondary-action"
        data-context-preview-toggle
        aria-expanded={expanded}
        aria-controls={id}
        disabled={!supported}
        onClick={() => (expanded ? close() : void read())}
      >
        {expanded ? 'Close preview' : 'Preview saved text'}
      </button>
      {!supported && <small> Preview available for TXT/MD/JSON up to 64 KiB only.</small>}
      {expanded && (
        <div id={id} aria-label={`Saved preview: ${item.name}`}>
          <p>
            Local read-only preview. Text is shown only after SHA-256 verification. Nothing sent to
            the agent.
          </p>
          {error ? (
            <>
              <p role="alert" data-context-preview-error>
                Preview unavailable. The file may be missing, changed or unsupported. No partial
                content is shown.
              </p>
              <button
                type="button"
                className="secondary-action"
                data-context-preview-retry
                onClick={() => {
                  button.current?.focus();
                  void read();
                }}
              >
                Retry preview
              </button>
            </>
          ) : text === undefined ? (
            <p role="status">Verifying saved text…</p>
          ) : (
            <pre
              ref={content}
              tabIndex={0}
              data-context-preview-text
              aria-label={`Text of ${item.name}`}
              style={{
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                maxHeight: 240,
                overflow: 'auto',
              }}
            >
              {text}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
