import { useState, type ReactNode } from 'react';

import type {
  AdvanceWorkflowPluginPhaseRequest,
  AdvanceWorkflowPluginPhaseResponse,
  InstallWorkflowPluginRequest,
  InstallWorkflowPluginResponse,
  RemoveWorkflowPluginBindingRequest,
  RemoveWorkflowPluginBindingResponse,
  SelectWorkflowPluginPathResponse,
  SwitchWorkflowPluginBindingRequest,
  SwitchWorkflowPluginBindingResponse,
} from '../ipc-contract';

export interface WorkflowPluginConfiguratorProps {
  readonly availablePhases: Readonly<
    Record<string, WorkflowPluginAvailablePhases | undefined>
  >;
  readonly busy: boolean;
  readonly disabledReason: string | undefined;
  readonly error: string | undefined;
  readonly installed: readonly InstalledWorkflowPluginSummary[];
  readonly onAdvance: (
    input: AdvanceWorkflowPluginPhaseRequest,
  ) => Promise<AdvanceWorkflowPluginPhaseResponse>;
  readonly onInstall: (
    input: InstallWorkflowPluginRequest,
  ) => Promise<InstallWorkflowPluginResponse>;
  readonly onRemove: (
    input: RemoveWorkflowPluginBindingRequest,
  ) => Promise<RemoveWorkflowPluginBindingResponse>;
  readonly onSelectPath: () => Promise<SelectWorkflowPluginPathResponse>;
  readonly onSwitch: (
    input: SwitchWorkflowPluginBindingRequest,
  ) => Promise<SwitchWorkflowPluginBindingResponse>;
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
  readonly phaseAgentId: string | undefined;
  readonly pluginId: string;
  readonly pluginName: string;
  readonly sourcePath: string;
  readonly taskId: string;
}

export interface WorkflowPluginAvailablePhases {
  /** Sorted list of phase ids declared by the bound plugin in declared order. */
  readonly availablePhaseIds: readonly string[];
  /**
   * Per-phase artifact kind for every declared phase so the renderer can
   * render a "skip already-recorded phase" hint next to the advance
   * controls without re-parsing the plugin file.
   */
  readonly phaseArtifactKinds: readonly WorkflowPluginProjectionKind[];
  readonly pluginId: string;
}

export type WorkflowPluginProjectionKind =
  | 'plan'
  | 'research'
  | 'review'
  | 'execution-summary'
  | 'brainstorm'
  | 'sweep';

/**
 * Settings-panel surface that lets the user install and remove Workflow
 * Plugin files selected through the native main-process dialog and to
 * inspect bindings already persisted for the open Project.
 *
 * Trust-root enforcement, file parsing, revision control, and persistence
 * are all owned by the main process; the renderer never receives an
 * arbitrary path from untrusted code and never mutates plugin files
 * directly. The renderer mirrors the binding list optimistically so a
 * remove is reflected immediately on success — the main process is the
 * source of truth on the next refresh.
 */
export function WorkflowPluginConfigurator({
  availablePhases,
  busy,
  disabledReason,
  error,
  installed,
  onAdvance,
  onInstall,
  onRemove,
  onSelectPath,
  onSwitch,
  selectedTaskId,
}: WorkflowPluginConfiguratorProps): ReactNode {
  const [installing, setInstalling] = useState(false);
  const [feedback, setFeedback] = useState<string | undefined>(undefined);
  const [installError, setInstallError] = useState<string | undefined>(undefined);
  /**
   * The binding the user has clicked "Remove" on. While non-null we
   * surface an inline confirm/cancel pair instead of the button so
   * accidental removal requires two clicks. The state is intentionally
   * per-panel rather than per-row so the panel can swap the prompt
   * between bindings without a new state slot.
   */
  const [pendingRemoval, setPendingRemoval] = useState<string | undefined>(undefined);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | undefined>(undefined);

  const handleInstall = async (): Promise<void> => {
    if (selectedTaskId === undefined) {
      return;
    }
    setInstallError(undefined);
    setFeedback(undefined);
    setRemoving(false);
    setRemoveError(undefined);
    setPendingRemoval(undefined);
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

  const handleRemove = async (entry: InstalledWorkflowPluginSummary): Promise<void> => {
    setInstallError(undefined);
    setFeedback(undefined);
    setRemoveError(undefined);
    setPendingRemoval(undefined);
    setRemoving(true);
    try {
      const result = await onRemove({
        expectedRevision: entry.bindingRevision,
        taskId: entry.taskId,
      });
      // Mirror the main-process source of truth so the optimistic UI is
      // accurate on the next refresh. We do not delete the local row
      // here because the parent owns `installed`; we surface the result
      // as feedback so the user knows the removal succeeded.
      setFeedback(
        `Removed plugin ${result.pluginId} from task ${entry.taskId}.`,
      );
      if (pendingRemoval === entry.taskId) {
        setPendingRemoval(undefined);
      }
    } catch (cause) {
      setRemoveError(
        cause instanceof Error ? cause.message : 'Workflow plugin could not be removed.',
      );
    } finally {
      setRemoving(false);
    }
  };

  const handleCancelRemove = (): void => {
    setPendingRemoval(undefined);
    setRemoveError(undefined);
  };

  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | undefined>(undefined);
  const [advanceError, setAdvanceError] = useState<string | undefined>(undefined);
  const [advancing, setAdvancing] = useState<string | undefined>(undefined);

  const handleSwitch = async (entry: InstalledWorkflowPluginSummary): Promise<void> => {
    setSwitchError(undefined);
    setAdvanceError(undefined);
    setSwitching(true);
    try {
      const selection = await onSelectPath();
      if (selection.result === 'CANCELLED' || selection.path === undefined) {
        return;
      }
      const result = await onSwitch({
        expectedRevision: entry.bindingRevision,
        path: selection.path,
        taskId: entry.taskId,
      });
      setFeedback(
        `Switched task ${entry.taskId} to ${result.pluginName}.`,
      );
    } catch (cause) {
      setSwitchError(
        cause instanceof Error
          ? cause.message
          : 'Workflow plugin could not be switched.',
      );
    } finally {
      setSwitching(false);
    }
  };

  const handleAdvance = async (
    entry: InstalledWorkflowPluginSummary,
    direction: 'next' | 'previous' | 'set',
    options?: { readonly force?: boolean; readonly phaseId?: string },
  ): Promise<void> => {
    setAdvanceError(undefined);
    setAdvancing(`${entry.taskId}:${direction}`);
    try {
      const result = await onAdvance({
        direction,
        expectedRevision: entry.bindingRevision,
        ...(options?.force === true ? { force: true } : {}),
        ...(options?.phaseId !== undefined ? { phaseId: options.phaseId } : {}),
        taskId: entry.taskId,
      });
      setFeedback(
        `Moved task ${entry.taskId} to phase ${result.activePhaseId}.`,
      );
    } catch (cause) {
      setAdvanceError(
        cause instanceof Error
          ? cause.message
          : 'Workflow plugin phase could not be advanced.',
      );
    } finally {
      setAdvancing(undefined);
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
            installed.map((entry) => {
              const confirming = pendingRemoval === entry.taskId;
              return (
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
                  <div className="workflow-plugin-configurator__controls">
                    {(() => {
                      const phases = availablePhases[entry.taskId];
                      if (phases === undefined) {
                        return null;
                      }
                      const phaseIndex = phases.availablePhaseIds.indexOf(
                        entry.activePhaseId,
                      );
                      const canAdvance =
                        phaseIndex >= 0 &&
                        phaseIndex < phases.availablePhaseIds.length - 1;
                      const canPrevious = phaseIndex > 0;
                      const isAdvancing = advancing === `${entry.taskId}:next`;
                      const isPrevious = advancing === `${entry.taskId}:previous`;
                      const isSetting = advancing === `${entry.taskId}:set`;
                      const advanceKind = phases.phaseArtifactKinds[phaseIndex + 1];
                      const advanceRecordedHint =
                        advanceKind !== undefined &&
                        (entry.bindingRevision > 0)
                          ? ` (next phase already recorded; use force)`
                          : '';
                      return (
                        <fieldset
                          className="workflow-plugin-configurator__phases"
                          data-workflow-plugin-phases={entry.taskId}
                        >
                          <legend>Phase</legend>
                          <button
                            aria-label={`Previous phase for ${entry.pluginName}`}
                            className="workflow-plugin-configurator__phase-previous"
                            data-workflow-plugin-phase-previous={entry.taskId}
                            disabled={
                              busy ||
                              switching ||
                              removing ||
                              !canPrevious ||
                              isAdvancing ||
                              isPrevious ||
                              isSetting
                            }
                            onClick={() => void handleAdvance(entry, 'previous')}
                            type="button"
                          >
                            {isPrevious ? 'Moving…' : '◀ Previous'}
                          </button>
                          <span
                            className="workflow-plugin-configurator__phase-label"
                            data-workflow-plugin-phase-label={entry.taskId}
                          >
                            {entry.activePhaseId || '(none)'}
                          </span>
                          <button
                            aria-label={`Next phase for ${entry.pluginName}`}
                            className="workflow-plugin-configurator__phase-next"
                            data-workflow-plugin-phase-next={entry.taskId}
                            disabled={
                              busy ||
                              switching ||
                              removing ||
                              !canAdvance ||
                              isAdvancing ||
                              isPrevious ||
                              isSetting
                            }
                            onClick={() => void handleAdvance(entry, 'next')}
                            type="button"
                          >
                            {isAdvancing ? 'Moving…' : `Next ▶${advanceRecordedHint}`}
                          </button>
                        </fieldset>
                      );
                    })()}
                  </div>
                  <div className="workflow-plugin-configurator__remove">
                    {confirming ? (
                      <>
                        <button
                          aria-label={`Confirm remove ${entry.pluginName}`}
                          className="workflow-plugin-configurator__confirm"
                          data-workflow-plugin-confirm-remove={entry.taskId}
                          disabled={removing || switching || advancing !== undefined}
                          onClick={() => void handleRemove(entry)}
                          type="button"
                        >
                          {removing ? 'Removing…' : 'Confirm remove'}
                        </button>
                        <button
                          aria-label="Cancel remove"
                          className="workflow-plugin-configurator__cancel"
                          data-workflow-plugin-cancel-remove
                          disabled={removing || switching || advancing !== undefined}
                          onClick={handleCancelRemove}
                          type="button"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          aria-label={`Switch ${entry.pluginName} to another trusted file`}
                          className="workflow-plugin-configurator__switch"
                          data-workflow-plugin-switch={entry.taskId}
                          disabled={
                            removing ||
                            installing ||
                            switching ||
                            busy ||
                            advancing !== undefined
                          }
                          onClick={() => void handleSwitch(entry)}
                          type="button"
                        >
                          {switching ? 'Switching…' : 'Switch…'}
                        </button>
                        <button
                          aria-label={`Remove ${entry.pluginName}`}
                          className="workflow-plugin-configurator__remove-button"
                          data-workflow-plugin-remove={entry.taskId}
                          disabled={
                            removing ||
                            installing ||
                            switching ||
                            busy ||
                            advancing !== undefined
                          }
                          onClick={() => setPendingRemoval(entry.taskId)}
                          type="button"
                        >
                          Remove
                        </button>
                      </>
                    )}
                  </div>
                  {removeError !== undefined && confirming ? (
                    <p
                      className="workflow-plugin-configurator__error"
                      data-workflow-plugin-remove-error
                      role="alert"
                    >
                      {removeError}
                    </p>
                  ) : null}
                  {switchError !== undefined && !confirming ? (
                    <p
                      className="workflow-plugin-configurator__error"
                      data-workflow-plugin-switch-error
                      role="alert"
                    >
                      {switchError}
                    </p>
                  ) : null}
                  {advanceError !== undefined ? (
                    <p
                      className="workflow-plugin-configurator__error"
                      data-workflow-plugin-advance-error
                      role="alert"
                    >
                      {advanceError}
                    </p>
                  ) : null}
                </li>
              );
            })
          )}
        </ul>
      </section>
    </details>
  );
}
