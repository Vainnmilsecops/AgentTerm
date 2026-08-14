export interface MnemonicHint {
  readonly key: string;
  readonly label: string;
  readonly modifiers: readonly string[];
}

export function shortcutLabel(separator: string, parts: readonly string[]): string {
  return parts.join(separator);
}

export function mnemonicFor(id: string): MnemonicHint | undefined {
  switch (id) {
    case 'begin-planning':
      return { key: 'P', label: 'Begin planning', modifiers: ['Alt'] };
    case 'start-task':
      return { key: 'S', label: 'Start execution', modifiers: ['Alt'] };
    case 'retry-task':
      return { key: 'R', label: 'Retry execution', modifiers: ['Alt'] };
    case 'accept-plan':
      return { key: 'A', label: 'Accept plan', modifiers: ['Alt'] };
    case 'request-review':
      return { key: 'R', label: 'Start review', modifiers: ['Alt', 'Shift'] };
    case 'request-changes':
      return { key: 'C', label: 'Request changes', modifiers: ['Alt', 'Shift'] };
    case 'approve-review':
      return { key: 'D', label: 'Approve and mark done', modifiers: ['Alt'] };
    default:
      return undefined;
  }
}