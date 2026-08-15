import type { ReactNode } from 'react';

import { WorkspaceIcon } from './workspace-icons';

export interface EmptyStateProps {
  readonly action?: ReactNode;
  readonly description: string;
  readonly icon?: 'folder' | 'history' | 'inbox' | 'pending' | 'terminal';
  readonly title: string;
}

export function EmptyState({ action, description, icon, title }: EmptyStateProps) {
  return (
    <div className="empty-state" data-empty-state role="status">
      {icon === undefined ? null : (
        <span aria-hidden="true" className={`empty-state__icon empty-state__icon--${icon}`}>
          <WorkspaceIcon name={icon} size={20} />
        </span>
      )}
      <div className="empty-state__body">
        <strong>{title}</strong>
        <p>{description}</p>
        {action === undefined ? null : <div className="empty-state__action">{action}</div>}
      </div>
    </div>
  );
}
