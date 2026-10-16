/** Incremental scrubbing keeps fine-mode changes and bounds from causing jumps. */
export function scrubNumber(
  value: number,
  pixels: number,
  step: number,
  fine: boolean,
  min = -Infinity,
  max = Infinity,
): number {
  return Math.min(max, Math.max(min, value + pixels * step * (fine ? 0.1 : 1)));
}
