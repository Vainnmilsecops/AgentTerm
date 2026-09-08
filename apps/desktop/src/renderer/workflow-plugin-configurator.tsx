import { useState, type ReactNode } from 'react';

import type {
  InstallWorkflowPluginRequest,
  InstallWorkflowPluginResponse,
  SelectWorkflowPluginPathResponse,
} from '../ipc-contract';

export interface WorkflowPluginConfiguratorProps {
  readonly busy: boolean;
  readonly disabledReason: string | undefined;
  readonly error: string | undefined;
  readonly installed: readonly InstalledWorkflowPluginSummary[];
  readonly onInstall: (
    input: InstallWorkflowPluginRequest,
  ) => Promise<InstallWorkflowPluginResponse>;
  readonly onSelectPath: () => Promise<SelectWorkflowPluginPathResponse>;
  readonly selectedTaskId: string | undefined;
}

/**
 * Lightweight record of a plugin binding known to the renderer. The panel
 * treats the main-process binding repository as the source of truth and
 * only mirrors the fields the Settings UI needs to render.
 */
export interface InstalledWorkflowPluginSummary {
  readonly activePhaseId: string;
  readonly bindingRevision: number;
  readonly pluginId: string;
  readonly pluginName: string;
  readonly sourcePath: string;
  readonly taskId: string;
}

/**
 * Settings-panel surface that lets the user install a Workflow Plugin file
 * selected through the native main-process dialog and to inspect bindings
 * already persisted for the open Project.
 *
 * Trust-root enforcement, file parsing, and binding revision control are all
 * owned by the main process; the renderer never receives an arbitrary path
 * from untrusted code and never mutates plugin files directly.
 */
export function WorkflowPluginConfigurator({
  busy,
  disabledReason,
  error,
  installed,
  onInstall,
  onSelectPath,
  selectedTaskId,
}: WorkflowPluginConfiguratorProps): ReactNode {
  const [installing, setInstalling] = useState(false);
  const [feedback, setFeedback] = useState<string | undefined>(undefined);
  const [installError, setInstallError] = useState<string | undefined>(undefined);

  const handleInstall = async (): Promise<void> => {
    if (selectedTaskId === undefined) {
      return;
    }
    setInstallError(undefined);
    setFeedback(undefined);
    setInstalling(true);
    try {
      const selection = await onSelectPath();
      if (selection.result === 'CANCELLED' || selection.path === undefined) {
        return;
      }
      const existing = installed.find((entry) => entry.taskId === selectedTaskId);
      const expectedRevision = existing?.bindingRevision ?? 0;
      const installedBinding = await onInstall({
        expectedRevision,
        path: selection.path,
        taskId: selectedTaskId,
      });
      setFeedback(
        existing === undefined
          ? `Installed ${installedBinding.pluginName} for task ${selectedTaskId}.`
          : `Updated ${installedBinding.pluginName} for task ${selectedTaskId} (revision ${String(installedBinding.bindingRevision)}).`,
      );
    } catch (cause) {
      setInstallError(
        cause instanceof Error
          ? cause.message
          : 'Workflow plugin could not be installed.',
      );
    } finally {
      setInstalling(false);
    }
  };

  return (
    <details
      className="workflow-plugin-configurator"
      data-workflow-plugin-configurator
    >
      <summary>Workflow plugins</summary>
      <section className="workflow-plugin-configurator__body">
        <header>
          <p className="eyebrow">Install / remove</p>
          <h3>Workflow plugin bindings</h3>
          <p>
            Install a trusted JSON file to bind a Workflow Plugin to the currently selected
            Task. The main process picks the file and validates the trust root; the renderer
            never receives an arbitrary path from untrusted code.
          </p>
          <p
            className="workflow-plugin-configurator__hint"
            data-workflow-plugin-trust-hint
          >
            Trust roots are configured on the desktop launch environment
            (<code>AT_DESKTOP_PLUGIN_ROOT</code>). Files outside the configured trust root
            are rejected.
          </p>
        </header>
        <div className="workflow-plugin-configurator__actions">
          <button
            aria-label="Install Workflow Plugin"
            className="workflow-plugin-configurator__install"
            data-workflow-plugin-install
            disabled={busy || installing || selectedTaskId === undefined || disabledReason !== undefined}
            onClick={() => void handleInstall()}
            type="button"
          >
            {installing ? 'Installing…' : 'Install from trusted file…'}
          </button>
        </div>
        {disabledReason === undefined ? null : (
          <p
            className="workflow-plugin-configurator__hint"
            data-workflow-plugin-disabled
            role="status"
          >
            {disabledReason}
          </p>
        )}
        {installError === undefined ? null : (
          <p className="workflow-plugin-configurator__error" role="alert">
            {installError}
          </p>
        )}
        {error === undefined ? null : (
          <p className="workflow-plugin-configurator__error" role="alert">
            {error}
          </p>
        )}
        {feedback === undefined ? null : (
          <p
            className="workflow-plugin-configurator__feedback"
            data-workflow-plugin-feedback
          >
            {feedback}
          </p>
        )}
        <ul
          aria-label="Installed workflow plugins"
          className="workflow-plugin-configurator__list"
          data-workflow-plugin-list
        >
          {installed.length === 0 ? (
            <li className="workflow-plugin-configurator__empty">
              No workflow plugins installed for this Project.
            </li>
          ) : (
            installed.map((entry) => (
              <li
                className="workflow-plugin-configurator__item"
                data-workflow-plugin-item={entry.taskId}
                key={`${entry.taskId}:${entry.bindingRevision}`}
              >
                <div>
                  <strong>{entry.pluginName}</strong>
                  <span className="workflow-plugin-configurator__id"> ({entry.pluginId})</span>
                  <p className="workflow-plugin-configurator__meta">
                    Task <code>{entry.taskId}</code> · revision{' '}
                    <code>{String(entry.bindingRevision)}</code> · active phase{' '}
                    <code>{entry.activePhaseId || '(none)'}</code>
                  </p>
                  <p className="workflow-plugin-configurator__meta">
                    Source <code>{entry.sourcePath}</code>
                  </p>
                </div>
              </li>
            ))
          )}
        </ul>
      </section>
    </details>
  );
}
