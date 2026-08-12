export const AgentSessionStatus = {
  EXITED: 'EXITED',
  FAILED: 'FAILED',
  IDLE: 'IDLE',
  STARTING: 'STARTING',
  WAITING_INPUT: 'WAITING_INPUT',
  WORKING: 'WORKING',
} as const;

export type AgentSessionStatus = (typeof AgentSessionStatus)[keyof typeof AgentSessionStatus];
