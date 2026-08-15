import type { ReactNode } from 'react';

export type WorkspaceIconName =
  | 'brand'
  | 'chevron-left'
  | 'chevron-right'
  | 'close'
  | 'folder'
  | 'history'
  | 'inbox'
  | 'info'
  | 'pending'
  | 'plus'
  | 'project'
  | 'refresh'
  | 'search'
  | 'settings'
  | 'terminal';

export interface WorkspaceIconProps {
  readonly className?: string;
  readonly name: WorkspaceIconName;
  readonly size?: number;
}

export function WorkspaceIcon({ className, name, size = 18 }: WorkspaceIconProps): ReactNode {
  return (
    <svg
      aria-hidden="true"
      className={className === undefined ? 'workspace-icon' : `workspace-icon ${className}`}
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
    >
      {iconPath(name)}
    </svg>
  );
}

function iconPath(name: WorkspaceIconName): ReactNode {
  const shared = {
    stroke: 'currentColor',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    strokeWidth: 1.75,
  };

  switch (name) {
    case 'brand':
      return (
        <>
          <rect {...shared} height="17" rx="4" width="19" x="2.5" y="3.5" />
          <path {...shared} d="m7 9 3 3-3 3m6 0h4" />
        </>
      );
    case 'chevron-left':
      return <path {...shared} d="m15 18-6-6 6-6" />;
    case 'chevron-right':
      return <path {...shared} d="m9 18 6-6-6-6" />;
    case 'close':
      return <path {...shared} d="m6 6 12 12M18 6 6 18" />;
    case 'folder':
      return <path {...shared} d="M3 7.5h7l2-2h9v13H3z" />;
    case 'history':
      return (
        <>
          <path {...shared} d="M4.5 7.5V3.8m0 0h3.7m-3.7 0 2.3 2.3a8 8 0 1 1-2 8" />
          <path {...shared} d="M12 8v4l2.8 1.7" />
        </>
      );
    case 'inbox':
      return (
        <>
          <path {...shared} d="M4 5h16l1 10v4H3v-4z" />
          <path {...shared} d="M3 15h5l1.4 2h5.2l1.4-2h5" />
        </>
      );
    case 'info':
      return (
        <>
          <circle {...shared} cx="12" cy="12" r="9" />
          <path {...shared} d="M12 11v5m0-8h.01" />
        </>
      );
    case 'pending':
      return (
        <>
          <circle {...shared} cx="12" cy="12" r="9" />
          <path {...shared} d="M12 7v5l3 2" />
        </>
      );
    case 'plus':
      return <path {...shared} d="M12 5v14M5 12h14" />;
    case 'project':
      return (
        <>
          <rect {...shared} height="16" rx="2.5" width="18" x="3" y="4" />
          <path {...shared} d="M8 4v16m4-11h5m-5 4h5" />
        </>
      );
    case 'refresh':
      return (
        <>
          <path {...shared} d="M20 7v5h-5M4 17v-5h5" />
          <path {...shared} d="M6.1 8.3A7.5 7.5 0 0 1 19.4 12M4.6 12A7.5 7.5 0 0 0 18 15.7" />
        </>
      );
    case 'search':
      return (
        <>
          <circle {...shared} cx="10.5" cy="10.5" r="6.5" />
          <path {...shared} d="m15.5 15.5 4.5 4.5" />
        </>
      );
    case 'settings':
      return (
        <>
          <circle {...shared} cx="12" cy="12" r="3" />
          <path
            {...shared}
            d="M19 13.5v-3l-2-.7a7 7 0 0 0-.7-1.6l.9-1.9-2.1-2.1-1.9.9a7 7 0 0 0-1.7-.7L10.8 2h-3l-.7 2.4a7 7 0 0 0-1.7.7l-1.9-.9-2.1 2.1.9 1.9a7 7 0 0 0-.7 1.6l-2 .7v3l2 .7a7 7 0 0 0 .7 1.6l-.9 1.9 2.1 2.1 1.9-.9a7 7 0 0 0 1.7.7l.7 2.4h3l.7-2.4a7 7 0 0 0 1.7-.7l1.9.9 2.1-2.1-.9-1.9a7 7 0 0 0 .7-1.6z"
            transform="translate(2.2 0) scale(.82)"
          />
        </>
      );
    case 'terminal':
      return (
        <>
          <rect {...shared} height="16" rx="2.5" width="19" x="2.5" y="4" />
          <path {...shared} d="m7 9 3 3-3 3m6 0h4" />
        </>
      );
  }
}
