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
  const [defaultAgentId, setDefaultAgentId] = useState(view.settings.defaultAgentId);
  const [terminalFontSize, setTerminalFontSize] = useState(view.settings.terminalFontSize);
  const [executables, setExecutables] = useState(() => executableMap(view));

  useEffect(() => {
    setDefaultAgentId(view.settings.defaultAgentId);
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
      defaultAgentId,
      expectedRevision: view.settings.revision,
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
