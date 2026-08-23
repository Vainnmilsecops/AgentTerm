/**
 * Polyfills the UMD globals that legacy xterm addons expect when they
 * load inside Node test runners. `@xterm/addon-clipboard` is shipped
 * as a webpack UMD bundle and crashes if `self` is undefined.
 */
if (typeof globalThis.self === 'undefined') {
  (globalThis as { self?: unknown }).self = globalThis;
}