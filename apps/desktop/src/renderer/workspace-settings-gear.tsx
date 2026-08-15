import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { WorkspaceSettings } from './workspace-settings';
import type { WorkspaceLayoutState } from './workspace-layout-persistence';
import { WorkspaceIcon } from './workspace-icons';

export interface WorkspaceSettingsGearProps {
  readonly children?: ReactNode;
  readonly layout: WorkspaceLayoutState;
  readonly onLayoutChange: (next: WorkspaceLayoutState) => void;
}

export function WorkspaceSettingsGear({
  children,
  layout,
  onLayoutChange,
}: WorkspaceSettingsGearProps): ReactNode {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

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
        event.preventDefault();
        setOpen(false);
        window.requestAnimationFrame(() => triggerRef.current?.focus());
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
        ref={triggerRef}
        type="button"
      >
        <WorkspaceIcon name="settings" />
      </button>
      {open ? (
        <div
          className="workspace-settings-gear__popover"
          role="dialog"
          aria-label="Workspace settings"
        >
          <WorkspaceSettings layout={layout} onLayoutChange={onLayoutChange} />
          {children === undefined ? null : (
            <div className="workspace-settings-gear__advanced">{children}</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
