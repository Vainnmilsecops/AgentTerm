export const DEFAULT_TERMINAL_HEIGHT = 360;
export const MIN_TERMINAL_HEIGHT = 240;
export const MAX_TERMINAL_VIEWPORT_OFFSET = 180;

export function resizeTerminalHeight(
  startHeight: number,
  startPointerY: number,
  currentPointerY: number,
  viewportHeight: number,
): number {
  const maximum = Math.max(MIN_TERMINAL_HEIGHT, viewportHeight - MAX_TERMINAL_VIEWPORT_OFFSET);
  return Math.min(
    maximum,
    Math.max(MIN_TERMINAL_HEIGHT, startHeight + startPointerY - currentPointerY),
  );
}
