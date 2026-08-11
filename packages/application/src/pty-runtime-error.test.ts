import { describe, expect, it } from 'vitest';

import { PtyRuntimeError, type PtyRuntimeFailureReason, type PtyRuntimeOperation } from './index';

describe('PtyRuntimeError', () => {
  it.each<readonly [PtyRuntimeFailureReason, string]>([
    ['INVALID_EXECUTABLE', 'Terminal executable path is invalid.'],
    ['INVALID_ARGUMENT', 'Terminal process arguments are invalid.'],
    ['INVALID_WORKING_DIRECTORY', 'Terminal working directory is invalid.'],
    ['INVALID_ENVIRONMENT', 'Terminal process environment is invalid.'],
    ['INVALID_TERMINAL_SIZE', 'Terminal size is invalid.'],
    ['INVALID_INPUT', 'Terminal input is invalid.'],
    ['NOT_RUNNING', 'The terminal process is not running.'],
    ['UNSUPPORTED_PLATFORM', 'The terminal runtime is not supported on this platform.'],
    ['CONPTY_UNAVAILABLE', 'Windows ConPTY is unavailable.'],
    ['RUNTIME_FAILURE', 'The terminal runtime operation failed.'],
  ])('uses a fixed sanitized message for %s', (reason, message) => {
    const operation: PtyRuntimeOperation = 'spawn';

    const error = new PtyRuntimeError(operation, reason);

    expect(error).toMatchObject({
      message,
      name: 'PtyRuntimeError',
      operation,
      reason,
    });
  });
});
