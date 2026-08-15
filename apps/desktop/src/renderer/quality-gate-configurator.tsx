import { useState, type ReactNode } from 'react';

import type {
  ImportQualityGateConfigResult,
  QualityGate,
  QualityGateConfiguration,
} from '@agentterm/application';

export interface QualityGateConfiguratorProps {
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly gates: readonly QualityGate[];
  readonly onExport: (input: { readonly configuration: QualityGateConfiguration }) => Promise<unknown>;
  readonly onImport: () => Promise<ImportQualityGateConfigResult | undefined>;
}

/**
 * Trusted Quality Gate configuration consumer. Lets the user import a JSON
 * configuration file selected through the native main-process dialog and
 * export the currently configured gates to a file selected through the same
 * dialog. The native dialog ownership ensures the renderer never receives an
 * arbitrary filesystem path from untrusted code.
 */
export function QualityGateConfigurator({
  busy,
  error,
  gates,
  onExport,
  onImport,
}: QualityGateConfiguratorProps): ReactNode {
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importError, setImportError] = useState<string | undefined>(undefined);
  const [exportError, setExportError] = useState<string | undefined>(undefined);
  const [feedback, setFeedback] = useState<string | undefined>(undefined);

  const handleImport = async (): Promise<void> => {
    setImportError(undefined);
    setFeedback(undefined);
    setImporting(true);
    try {
      const result = await onImport();
      if (result === undefined) {
        return;
      }
      const total = result.registered.length + result.rejected.length;
      setFeedback(
        result.rejected.length === 0
          ? `Imported ${String(result.registered.length)} of ${String(total)} gate(s) from ${result.configuration.path}.`
          : `Imported ${String(result.registered.length)} of ${String(total)} gate(s); ${String(result.rejected.length)} rejected by the catalog.`,
      );
    } catch (cause) {
      setImportError(cause instanceof Error ? cause.message : 'Quality Gate config could not be imported.');
    } finally {
      setImporting(false);
    }
  };

  const handleExport = async (): Promise<void> => {
    setExportError(undefined);
    setFeedback(undefined);
    setExporting(true);
    try {
      await onExport({
        configuration: {
          gates: [...gates],
          path: '',
          revision: 'agentterm-export',
        },
      });
      setFeedback('Exported current Quality Gates to the selected file.');
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : 'Quality Gates could not be exported.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <details className="quality-gate-configurator" data-quality-gate-configurator>
      <summary>Trusted configuration</summary>
      <section className="quality-gate-configurator__body">
        <header>
          <p className="eyebrow">Import / Export</p>
          <h3>Quality Gate configuration file</h3>
          <p>
            Import a trusted JSON file or export the current Quality Gates for sharing. The
            main process picks the file; the renderer never receives an arbitrary path.
          </p>
          <p className="quality-gate-configurator__hint" data-quality-gate-trust-hint>
            Trust roots are configured on the desktop launch environment (AT_DESKTOP_GATE_CONFIG_ROOT).
            Imports outside the configured trust root are rejected.
          </p>
        </header>
        <div className="quality-gate-configurator__actions">
          <button
            aria-label="Import Quality Gate configuration"
            className="quality-gate-configurator__import"
            data-quality-gate-import
            disabled={busy || importing || exporting}
            onClick={() => void handleImport()}
            type="button"
          >
            {importing ? 'Importing…' : 'Import from trusted file…'}
          </button>
          <button
            aria-label="Export Quality Gates to file"
            className="quality-gate-configurator__export"
            data-quality-gate-export
            disabled={busy || exporting || importing || gates.length === 0}
            onClick={() => void handleExport()}
            type="button"
          >
            {exporting ? 'Exporting…' : 'Export to file…'}
          </button>
        </div>
        {importError === undefined ? null : (
          <p className="quality-gate-configurator__error" role="alert">
            {importError}
          </p>
        )}
        {exportError === undefined ? null : (
          <p className="quality-gate-configurator__error" role="alert">
            {exportError}
          </p>
        )}
        {error === undefined ? null : (
          <p className="quality-gate-configurator__error" role="alert">
            {error}
          </p>
        )}
        {feedback === undefined ? null : (
          <p className="quality-gate-configurator__feedback" data-quality-gate-feedback>
            {feedback}
          </p>
        )}
      </section>
    </details>
  );
}