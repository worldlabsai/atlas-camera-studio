export type ScreenPoint = { x: number; y: number };

/** Keep nearby camera numbers distinct without moving the actual cameras. */
export function layoutCameraLabels(
  points: readonly ScreenPoint[],
  width: number,
  height: number,
): ScreenPoint[] {
  const placed: ScreenPoint[] = [];
  for (const point of points) {
    const candidates = [
      [18, 24],
      [18, -24],
      [-24, 24],
      [-24, -24],
    ];
    for (let ring = 1; ring <= points.length + 1; ring++) {
      candidates.push(
        [18 + ring * 26, 24],
        [18 + ring * 26, -24],
        [-24 - ring * 26, 24],
        [-24 - ring * 26, -24],
      );
    }
    const positions = candidates.map(([dx, dy]) => ({
      x: Math.max(12, Math.min(width - 12, point.x + dx)),
      y: Math.max(9, Math.min(height - 9, point.y + dy)),
    }));
    const position =
      positions.find((p) =>
        placed.every(
          (q) => Math.abs(p.x - q.x) >= 26 || Math.abs(p.y - q.y) >= 20,
        ),
      ) ?? positions[0];
    placed.push(position);
  }
  return placed;
}
