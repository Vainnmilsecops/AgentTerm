import type { ReactNode } from 'react';

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
          {iconGlyph(icon)}
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

function iconGlyph(icon: 'folder' | 'history' | 'inbox' | 'pending' | 'terminal'): string {
  switch (icon) {
    case 'folder':
      return '◇';
    case 'history':
      return '↻';
    case 'inbox':
      return '⌷';
    case 'pending':
      return '◷';
    case 'terminal':
      return '›_';
  }
}
