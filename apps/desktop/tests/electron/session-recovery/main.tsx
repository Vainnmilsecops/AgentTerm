import { createRoot } from 'react-dom/client';
import { SessionRecoveryPanel } from '../../../src/renderer/session-recovery-panel';
import type { SessionRecoveryReadiness } from '@agentterm/application';

async function verify() {
  const container = document.getElementById('root')!;
  const root = createRoot(container);
  const until = async (condition: () => boolean) => {
    const deadline = performance.now() + 3000;
    while (!condition()) {
      if (performance.now() > deadline) throw new Error('Recovery UI timed out');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  let reason: SessionRecoveryReadiness['reason'] = 'PROVIDER_ID_MISSING';
  let resumeCalls = 0;
  let refreshes = 0;
  let release: (() => void) | undefined;
  const client = {
    inspectSessionRecovery: async ({
      sessionId,
    }: {
      sessionId: string;
    }): Promise<SessionRecoveryReadiness> => ({ canResume: reason === 'READY', reason, sessionId }),
    resumeAgentSession: async () => {
      resumeCalls++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      reason = 'ACTIVE_SESSION';
    },
  };
  const button = () => container.querySelector<HTMLButtonElement>('button')!;
  try {
    root.render(
      <SessionRecoveryPanel
        client={client}
        sessionId="old-session"
        onResumed={() => {
          refreshes++;
        }}
      />,
    );
    await until(() => container.textContent?.includes('No conversation ID') === true);
    if (!button().disabled) throw new Error('Missing ID must disable resume');
    reason = 'READY';
    container.querySelectorAll<HTMLButtonElement>('button')[1]!.click();
    await until(() => !button().disabled);
    button().click();
    button().click();
    await until(() => resumeCalls === 1 && button().disabled);
    if (resumeCalls !== 1) throw new Error('Duplicate resume');
    release!();
    await until(() => refreshes === 1 && container.textContent?.includes('still active') === true);
    if (!button().disabled) throw new Error('Active session must disable resume');
    return {
      ok: true,
      message:
        'PASS: missing identity reason, refresh readiness, single-flight resume, workspace refresh, active-session lockout',
    };
  } finally {
    root.unmount();
  }
}
Object.assign(window, {
  inputReliabilityResult: verify().catch((error: Error) => ({ ok: false, message: error.message })),
});
