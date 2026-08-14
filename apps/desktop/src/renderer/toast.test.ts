import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createToastRegistry, toastForAction } from './toast';

describe('createToastRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a stable id and removes the toast after the lifespan', () => {
    const registry = createToastRegistry();
    const id = registry.push({ message: 'Task created', tone: 'success' });
    expect(registry.getToasts()).toHaveLength(1);
    vi.advanceTimersByTime(3300);
    expect(registry.getToasts().find((toast) => toast.id === id)).toBeUndefined();
  });

  it('removes the toast on manual dismiss and clears the timer', () => {
    const registry = createToastRegistry();
    const id = registry.push({ message: 'Task deleted', tone: 'danger' });
    registry.dismiss(id);
    expect(registry.getToasts()).toHaveLength(0);
    vi.advanceTimersByTime(5000);
    expect(registry.getToasts()).toHaveLength(0);
  });
});

describe('toastForAction', () => {
  it('produces past tense labels for verbs that end in e', () => {
    expect(toastForAction('Approve and mark done', 'success').message).toMatch(/Approve/);
  });

  it('produces past tense labels for regular verbs', () => {
    expect(toastForAction('Create task', 'success').message).toBe('Create tasked');
  });

  it('keeps the provided tone', () => {
    expect(toastForAction('Delete project', 'danger').tone).toBe('danger');
  });
});