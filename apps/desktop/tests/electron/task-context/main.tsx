import { createRoot } from 'react-dom/client';
import { TaskContextPanel } from '../../../src/renderer/task-context-panel';
import type { TaskContextAttachment } from '@agentterm/application';
import type { AgentTermDesktopApi } from '../../../src/ipc-contract';

async function verify() {
  const container = document.getElementById('root')!;
  const root = createRoot(container);
  const until = async (check: () => boolean) => {
    const deadline = performance.now() + 3000;
    while (!check()) {
      if (performance.now() > deadline) throw new Error('Context UI timed out');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  let calls = 0;
  let handoffs = 0;
  let targetSession = 'session';
  let records: readonly TaskContextAttachment[] = [];
  const client = {
    inspectContextHandoff: async () => ({ canPrepare: true, reason: 'Text context supported' }),
    prepareContextHandoff: async (input: {
      sessionId: string;
      attachmentIds: readonly string[];
      confirmWorktreeCopy: true;
    }) => {
      if (
        input.sessionId !== targetSession ||
        input.attachmentIds[0] !== 'attachment' ||
        input.confirmWorktreeCopy !== true
      )
        throw new Error('Wrong handoff target');
      handoffs++;
      return {
        sessionId: input.sessionId,
        agentName: 'Test agent',
        prompt: 'Review @agentterm-context/file.txt',
        relativePaths: ['agentterm-context/file.txt'],
      };
    },
    listTaskContext: async () => records,
    importTaskContext: async (input: {
      taskId: string;
      sessionId: string;
      files: readonly { name: string; bytes: Uint8Array }[];
    }) => {
      calls++;
      if (
        input.taskId !== 'task' ||
        input.sessionId !== 'session' ||
        new TextDecoder().decode(input.files[0]!.bytes) !== 'Xin chào 👋'
      )
        throw new Error('Wrong target or bytes');
      records = [
        {
          id: 'attachment',
          taskId: input.taskId,
          sessionId: input.sessionId,
          name: input.files[0]!.name,
          mime: 'text/plain',
          size: input.files[0]!.bytes.length,
          digest: 'a'.repeat(64),
          createdAt: 1,
        },
      ];
      return records;
    },
  };
  try {
    const bridge = (window as unknown as { agenttermWorkspace: AgentTermDesktopApi })
      .agenttermWorkspace;
    const transported = await bridge.importTaskContext({
      taskId: 'task',
      sessionId: 'session',
      files: [
        { name: 'ipc.txt', mime: 'text/plain', bytes: new TextEncoder().encode('Xin chào 👋') },
      ],
    });
    if (transported[0]?.id !== 'ipc-record') throw new Error('Preload IPC round trip failed');
    if (!(await bridge.inspectContextHandoff({ taskId: 'task', sessionId: 'session' })).canPrepare)
      throw new Error('Handoff readiness IPC failed');
    const handoff = await bridge.prepareContextHandoff({
      taskId: 'task',
      sessionId: 'session',
      attachmentIds: ['ipc-record'],
      confirmWorktreeCopy: true,
    });
    if (handoff.sessionId !== 'session') throw new Error('Handoff preparation IPC failed');
    root.render(<TaskContextPanel client={client} taskId="task" sessionId="session" />);
    await until(() => container.querySelector('input') !== null);
    const transfer = new DataTransfer();
    transfer.items.add(new File(['Xin chào 👋'], 'ghi-chú.txt', { type: 'text/plain' }));
    const input = container.querySelector('input')!;
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => container.textContent?.includes('ghi-chú.txt') === true);
    if (calls !== 0) throw new Error('Import occurred before confirmation');
    const confirm = container.querySelector<HTMLButtonElement>('[data-context-confirm]')!;
    confirm.click();
    confirm.click();
    await until(() => container.textContent?.includes('Saved 1 attachment') === true);
    if (calls !== 1 || container.textContent?.includes('session') !== true)
      throw new Error('Duplicate or misdirected import');
    if (document.activeElement !== container.querySelector('section'))
      throw new Error('Focus was lost after import');
    await until(() => container.querySelector('[data-context-handoff-select]') !== null);
    container.querySelector<HTMLInputElement>('[data-context-handoff-select]')!.click();
    const prepare = container.querySelector<HTMLButtonElement>('[data-context-handoff-prepare]')!;
    if (!prepare.disabled) throw new Error('Worktree copy must require consent');
    container.querySelector<HTMLInputElement>('[data-context-handoff-consent]')!.click();
    await until(() => !prepare.disabled);
    prepare.click();
    prepare.click();
    await until(
      () => container.querySelector('textarea')?.value.includes('@agentterm-context/') === true,
    );
    if (handoffs !== 1) throw new Error('Duplicate handoff preparation');
    targetSession = 'resumed-session';
    root.render(<TaskContextPanel client={client} taskId="task" sessionId={targetSession} />);
    await until(() => container.textContent?.includes('resumed-session') === true);
    await until(() => container.querySelector('[data-context-handoff-select]') !== null);
    const reused = container.querySelector<HTMLInputElement>('[data-context-handoff-select]')!;
    if (reused.disabled) throw new Error('Historical same-task context cannot be selected');
    if (reused.checked || container.querySelector('textarea'))
      throw new Error('Old selection or prompt survived target change');
    if (!reused.closest('label')?.textContent?.includes('session'))
      throw new Error('Source-session provenance is not visible');
    reused.click();
    const reusePrepare = container.querySelector<HTMLButtonElement>(
      '[data-context-handoff-prepare]',
    )!;
    const reuseConsent = container.querySelector<HTMLInputElement>(
      '[data-context-handoff-consent]',
    )!;
    if (!reusePrepare.disabled || reuseConsent.checked)
      throw new Error('Target change did not require new consent');
    if (!reuseConsent.closest('label')?.textContent?.includes('resumed-session'))
      throw new Error('Consent does not identify the target session');
    reuseConsent.click();
    await until(() => !reusePrepare.disabled);
    reusePrepare.click();
    await until(() => container.querySelector('textarea') !== null);
    if (handoffs !== 2 || calls !== 1 || records[0]?.sessionId !== 'session')
      throw new Error('Reuse duplicated import or changed source provenance');
    if (document.activeElement !== container.querySelector('textarea'))
      throw new Error('Prepared prompt did not receive keyboard focus');
    const drop = new DataTransfer();
    drop.items.add(
      new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'large.txt', { type: 'text/plain' }),
    );
    container
      .querySelector('section')!
      .dispatchEvent(
        new DragEvent('drop', { dataTransfer: drop, bubbles: true, cancelable: true }),
      );
    await until(
      () =>
        container.textContent?.includes('8 MiB') === true &&
        container.querySelector('[role="alert"]') !== null,
    );
    if (calls !== 1) throw new Error('Oversized input sent');
    const image = new DataTransfer();
    const png = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      ),
      (c) => c.charCodeAt(0),
    );
    image.items.add(new File([png], 'pixel.png', { type: 'image/png' }));
    container
      .querySelector('section')!
      .dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: image, bubbles: true, cancelable: true }),
      );
    await until(() => (container.querySelector('img')?.naturalWidth ?? 0) === 1);
    if (calls !== 1) throw new Error('Paste imported without confirmation');
    return {
      ok: true,
      message:
        'PASS: preview, confirmation, exact target/Unicode bytes, single-flight import, oversized drop rejection, historical context reuse, target consent reset and prompt focus',
    };
  } finally {
    root.unmount();
  }
}
Object.assign(window, {
  inputReliabilityResult: verify().catch((error: Error) => ({ ok: false, message: error.message })),
});
