import { useEffect, useState, type FormEvent } from 'react';

import type {
  ApplicationSettingsView,
  UpdateApplicationSettingsInput,
} from '@agentterm/application';

export interface SettingsPanelProps {
  readonly error: string | undefined;
  readonly onSave: (input: UpdateApplicationSettingsInput) => void;
  readonly saving: boolean;
  readonly view: ApplicationSettingsView;
}

export function SettingsPanel({ error, onSave, saving, view }: SettingsPanelProps) {
  const [allowClipboardReadWrite, setAllowClipboardReadWrite] = useState(
    view.settings.allowClipboardReadWrite,
  );
  const [defaultAgentId, setDefaultAgentId] = useState(view.settings.defaultAgentId);
  const [researchAutoAdvance, setResearchAutoAdvance] = useState(
    view.settings.researchAutoAdvance,
  );
  const [terminalFontSize, setTerminalFontSize] = useState(view.settings.terminalFontSize);
  const [executables, setExecutables] = useState(() => executableMap(view));

  useEffect(() => {
    setAllowClipboardReadWrite(view.settings.allowClipboardReadWrite);
    setDefaultAgentId(view.settings.defaultAgentId);
    setResearchAutoAdvance(view.settings.researchAutoAdvance);
    setTerminalFontSize(view.settings.terminalFontSize);
    setExecutables(executableMap(view));
  }, [view]);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onSave({
      agentExecutables: view.agents.flatMap((agent) => {
        const executablePath = (executables[agent.id] ?? '').trim();
        return executablePath.length === 0 ? [] : [{ agentId: agent.id, executablePath }];
      }),
      allowClipboardReadWrite,
      defaultAgentId,
      expectedRevision: view.settings.revision,
      researchAutoAdvance,
      terminalFontSize,
    });
  };

  return (
    <details className="settings-panel">
      <summary>Settings</summary>
      <form className="settings-form" onSubmit={submit}>
        <div className="settings-form__grid">
          <label>
            <span>Default agent</span>
            <select
              disabled={saving}
              onChange={(event) => setDefaultAgentId(event.currentTarget.value)}
              value={defaultAgentId}
            >
              {view.agents.some(({ id }) => id === defaultAgentId) ? null : (
                <option disabled value={defaultAgentId}>
                  Unknown agent ({defaultAgentId}) — unavailable
                </option>
              )}
              {view.agents.map((agent) => (
                <option disabled={agent.kind === 'unavailable'} key={agent.id} value={agent.id}>
                  {agent.displayName} ({agent.id})
                  {agent.kind === 'unavailable' ? ' — unavailable' : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Terminal font size</span>
            <input
              disabled={saving}
              max={32}
              min={8}
              onChange={(event) => setTerminalFontSize(event.currentTarget.valueAsNumber)}
              required
              type="number"
              value={terminalFontSize}
            />
          </label>
        </div>

        <fieldset className="settings-form__flags" disabled={saving}>
          <legend>Terminal</legend>
          <label className="settings-form__flag">
            <input
              checked={allowClipboardReadWrite}
              onChange={(event) => setAllowClipboardReadWrite(event.currentTarget.checked)}
              type="checkbox"
            />
            <span>Allow TUIs to read and write the system clipboard via OSC 52.</span>
            <small>
              Disabled by default. When enabled, every active terminal pane will honour the
              OSC 52 escape sequences that TUIs use to exchange text with the system clipboard.
            </small>
          </label>
          <label className="settings-form__flag">
            <input
              aria-label="Research auto-advance"
              checked={researchAutoAdvance}
              onChange={(event) => setResearchAutoAdvance(event.currentTarget.checked)}
              type="checkbox"
            />
            <span>
              Auto-advance BACKLOG tasks to PLANNING after a valid research/research.md artifact.
            </span>
            <small>
              Disabled by default. When enabled, the M6 research orchestrator transitions a
              qualifying BACKLOG Task to PLANNING immediately after a VALID research artifact is
              persisted; each transition is recorded in the task audit log.
            </small>
          </label>
        </fieldset>

        <fieldset disabled={saving}>
          <legend>Agent executables</legend>
          {view.agents.map((agent) => (
            <label className="executable-setting" key={agent.id}>
              <span>{agent.displayName} executable</span>
              <input
                autoComplete="off"
                onChange={(event) =>
                  setExecutables((current) => ({
                    ...current,
                    [agent.id]: event.currentTarget.value,
                  }))
                }
                placeholder="Auto-detect from PATH"
                spellCheck={false}
                type="text"
                value={executables[agent.id] ?? ''}
              />
              <small>
                {agent.kind === 'available'
                  ? `Available · ${agent.version ?? 'version unavailable'} · ${formatCapabilities(agent.capabilities)} · Detected: ${agent.detectedExecutablePath}`
                  : `${formatUnavailableReason(agent.reason)} · leave blank to use PATH auto-detection`}
              </small>
            </label>
          ))}
        </fieldset>

        <p className="settings-note">
          CLI manages authentication. Executable changes apply to future app composition; active
          sessions keep running. Terminal font changes apply live.
        </p>
        {error === undefined ? null : (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <button className="secondary-action" disabled={saving} type="submit">
          {saving ? 'Saving settings…' : 'Save settings'}
        </button>
      </form>
    </details>
  );
}

function executableMap(view: ApplicationSettingsView): Record<string, string> {
  return Object.fromEntries(
    view.agents.map((agent) => [agent.id, agent.configuredExecutablePath ?? '']),
  );
}

function formatCapabilities(capabilities: readonly string[]): string {
  return capabilities.length === 0 ? 'No optional capabilities' : capabilities.join(', ');
}

function formatUnavailableReason(reason: 'EXECUTABLE_NOT_FOUND' | 'INSPECTION_FAILED'): string {
  return reason === 'EXECUTABLE_NOT_FOUND' ? 'Executable not found' : 'Inspection failed';
}
