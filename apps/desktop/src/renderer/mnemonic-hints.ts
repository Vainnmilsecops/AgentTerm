export interface MnemonicHint {
  readonly key: string;
  readonly label: string;
  readonly modifiers: readonly string[];
}

export type WorkspaceMnemonicAction =
  | 'accept-plan'
  | 'approve-review'
  | 'begin-planning'
  | 'request-changes'
  | 'request-review'
  | 'retry-task'
  | 'start-planning'
  | 'start-task';

export interface WorkspaceMnemonicKey {
  readonly altKey: boolean;
  readonly composing?: boolean;
  readonly ctrlKey: boolean;
  readonly editable?: boolean;
  readonly key: string;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

export interface WorkspaceMnemonicContext {
  readonly canAcceptPlan: boolean;
  readonly canApproveReview: boolean;
  readonly canBeginPlanning: boolean;
  readonly canRequestChanges: boolean;
  readonly canRequestReview: boolean;
  readonly canRetryExecution: boolean;
  readonly canRevisePlan: boolean;
  readonly canStartExecution: boolean;
  readonly canStartPlanning: boolean;
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

export function resolveWorkspaceMnemonic(
  key: WorkspaceMnemonicKey,
  context: WorkspaceMnemonicContext,
): WorkspaceMnemonicAction | undefined {
  if (
    !key.altKey ||
    key.ctrlKey ||
    key.metaKey ||
    key.composing === true ||
    key.editable === true
  ) {
    return undefined;
  }

  switch (key.key.toLowerCase()) {
    case 'p':
      if (key.shiftKey) return undefined;
      if (context.canBeginPlanning) return 'begin-planning';
      return context.canStartPlanning || context.canRevisePlan ? 'start-planning' : undefined;
    case 's':
      return !key.shiftKey && context.canStartExecution ? 'start-task' : undefined;
    case 'r':
      if (key.shiftKey) return context.canRequestReview ? 'request-review' : undefined;
      return context.canRetryExecution ? 'retry-task' : undefined;
    case 'a':
      return !key.shiftKey && context.canAcceptPlan ? 'accept-plan' : undefined;
    case 'c':
      return key.shiftKey && context.canRequestChanges ? 'request-changes' : undefined;
    case 'd':
      return !key.shiftKey && context.canApproveReview ? 'approve-review' : undefined;
    default:
      return undefined;
  }
}
