import { AgentSessionStatus, type AgentSession } from '@agentterm/domain';

/** True while persisted history cannot prove that this Session no longer owns a code-writing runtime. */
export function hasUnsettledTaskCodeWriter(session: AgentSession): boolean {
  if (session.status === AgentSessionStatus.EXITED) {
    return false;
  }
  if (session.status !== AgentSessionStatus.FAILED) {
    return true;
  }
  if (session.history.some(({ kind }) => kind === 'PROCESS_EXITED')) {
    return false;
  }
  return !session.history.some(
    (event) =>
      event.kind === 'RUNTIME_FAILED' &&
      event.fatal &&
      (event.stage === 'START' || event.code === 'RUNTIME_OWNERSHIP_LOST'),
  );
}
