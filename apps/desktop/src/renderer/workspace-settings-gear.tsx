import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { WorkspaceSettings } from './workspace-settings';
import type { WorkspaceLayoutState } from './workspace-layout-persistence';

export interface WorkspaceSettingsGearProps {
  readonly layout: WorkspaceLayoutState;
  readonly onLayoutChange: (next: WorkspaceLayoutState) => void;
}

export function WorkspaceSettingsGear({
  layout,
  onLayoutChange,
}: WorkspaceSettingsGearProps): ReactNode {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointer = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && containerRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('pointerdown', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  return (
    <div className="workspace-settings-gear" ref={containerRef}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Workspace settings"
        className="workspace-settings-gear__trigger"
        data-settings-gear
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span aria-hidden="true">⚙</span>
      </button>
      {open ? (
        <div
          className="workspace-settings-gear__popover"
          role="dialog"
          aria-label="Workspace settings"
        >
          <WorkspaceSettings layout={layout} onLayoutChange={onLayoutChange} />
        </div>
      ) : null}
    </div>
  );
}
