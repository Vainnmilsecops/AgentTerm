export const TaskPhase = {
  BACKLOG: 'BACKLOG',
  PLANNING: 'PLANNING',
  RUNNING: 'RUNNING',
  REVIEW: 'REVIEW',
  DONE: 'DONE',
} as const;

export type TaskPhase = (typeof TaskPhase)[keyof typeof TaskPhase];
