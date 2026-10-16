// Connect the sampled image grid without stretching it across depth edges.
// A cell with three valid corners keeps one triangle; otherwise prefer the
// split with more valid triangles, then the shorter diagonal. Long edges require
// a consistent inverse-depth trend. Positions may
// be in camera or world coordinates because rigid transforms preserve length.

export type DepthSurfaceGrid = {
  /** Number of sampled columns and rows in the source image grid. */
  cols: number;
  rows: number;
  /** Compact vertex index per grid cell, -1 where no sample was kept. */
  vertexAt: Int32Array;
  /** Camera-space depth per grid cell, NaN where no sample was kept. */
  depthAt: Float32Array;
  /** Interleaved xyz positions of the compact vertex order. */
  positions: Float32Array;
};

export type DepthSurfaceOptions = {
  /** Sampling stride in source pixels between adjacent grid cells. */
  stride: number;
  fx: number;
  fy: number;
  /** Longer edges need a consistent neighboring depth trend. Default 7 footprints. */
  maxFootprintScale?: number;
  /** Relative depth change requiring planar trend evidence. Default 0.12. */
  maxDepthJump?: number;
  /** Farthest-to-nearest depth ratio a stretched triangle may span. Default 3. */
  maxStretchDepthRatio?: number;
};

export type DepthSurface = {
  /** Triangles the source image supports; these carry its texture. */
  indices: Uint32Array;
  /** Rejected triangles that still bridge a plausible depth gap. They
   * convey colour and shape only; the image never saw what they cover. */
  stretchIndices: Uint32Array;
};

export function triangulateDepthSurface(
  grid: DepthSurfaceGrid,
  options: DepthSurfaceOptions,
): Uint32Array {
  return buildDepthSurface(grid, options).indices;
}

// Stretched triangles are bounded so they only bridge gaps a viewer would
// read as one continuing scene. A far/near depth ratio above 3 usually joins
// a foreground silhouette to sky or a distant backdrop; the curtain would
// then cover most of the scene depth and streak across every off-axis view.
// Each edge must also be explained by its depth change plus the lateral
// footprint limit used for supported edges (7 footprints). Samples lie on
// rays one grid cell apart, so a longer edge means inconsistent positions.
// The 1.5 factor covers rays up to about 48 degrees off the optical axis.
const STRETCH_RAY_SLACK = 1.5;

export function buildDepthSurface(
  grid: DepthSurfaceGrid,
  options: DepthSurfaceOptions,
): DepthSurface {
  const { cols, rows, vertexAt, depthAt, positions } = grid;
  const maxStretchDepthRatio = options.maxStretchDepthRatio ?? 3;
  const maxFootprintScale = options.maxFootprintScale ?? 7;
  const maxDepthJump = options.maxDepthJump ?? 0.12;
  const finitePositive = (depth: number) => Number.isFinite(depth) && depth > 0;

  // A 2D neighborhood can establish a plane where a line of samples crosses
  // curved/noisy detail. Check every measured sample, so an occlusion step
  // cannot be explained away by an average fit.
  const planar = new Uint8Array(cols * rows);
  for (let y = 1; y + 1 < rows; y++) {
    for (let x = 1; x + 1 < cols; x++) {
      const center = y * cols + x;
      let mean = 0,
        slopeX = 0,
        slopeY = 0,
        valid = true;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cell = center + dy * cols + dx;
          if (vertexAt[cell] < 0 || !finitePositive(depthAt[cell])) {
            valid = false;
            continue;
          }
          const inverse = 1 / depthAt[cell];
          mean += inverse / 9;
          slopeX += (dx * inverse) / 6;
          slopeY += (dy * inverse) / 6;
        }
      }
      if (!valid) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (
            Math.abs(
              1 / depthAt[center + dy * cols + dx] -
                (mean + dx * slopeX + dy * slopeY),
            ) >
            mean * 0.01
          )
            valid = false;
        }
      }
      planar[center] = Number(valid);
    }
  }

  // An edge may be a triangle side only when both endpoints exist with
  // usable depths and the samples are plausibly part of one surface.
  const edgeOk = (a: number, b: number) => {
    const va = vertexAt[a]!,
      vb = vertexAt[b]!;
    if (va < 0 || vb < 0) return false;
    const da = depthAt[a]!,
      db = depthAt[b]!;
    if (!finitePositive(da) || !finitePositive(db)) return false;
    const nearer = Math.min(da, db);
    const pixelX = (((a % cols) - (b % cols)) * options.stride) / options.fx;
    const pixelY =
      ((Math.floor(a / cols) - Math.floor(b / cols)) * options.stride) /
      options.fy;
    const limitSquared =
      (maxFootprintScale * nearer) ** 2 * (pixelX * pixelX + pixelY * pixelY);
    const i = va * 3,
      j = vb * 3;
    const dx = positions[j]! - positions[i]!,
      dy = positions[j + 1]! - positions[i + 1]!,
      dz = positions[j + 2]! - positions[i + 2]!;
    const lengthSquared = dx * dx + dy * dy + dz * dz;
    if (!Number.isFinite(lengthSquared)) return false;
    if (
      lengthSquared <= limitSquared &&
      Math.abs(da - db) <= maxDepthJump * nearer
    )
      return true;

    if (planar[a] || planar[b]) return true;

    // Inverse depth varies linearly across a plane in the source image.
    // A grazing floor has long 3D edges but the same trend on both sides;
    // an occlusion step has a different trend before and after the edge.
    const ax = a % cols,
      ay = Math.floor(a / cols);
    const bx = b % cols,
      by = Math.floor(b / cols);
    const stepX = bx - ax,
      stepY = by - ay;
    const slope = 1 / db - 1 / da;
    const tolerance = Math.abs(slope) * 0.25 + 0.005 / nearer;
    const inverseAt = (step: number) => {
      const x = ax + step * stepX,
        y = ay + step * stepY;
      if (x < 0 || y < 0 || x >= cols || y >= rows) return NaN;
      const cell = y * cols + x;
      return vertexAt[cell] >= 0 && finitePositive(depthAt[cell])
        ? 1 / depthAt[cell]
        : NaN;
    };
    const matches = (first: number, second: number) =>
      Math.abs(inverseAt(second) - inverseAt(first) - slope) <= tolerance;
    // Require two additional consecutive edges. At image boundaries both can
    // be on the same side; an isolated depth step still has no matching trend.
    const before = matches(-1, 0),
      after = matches(1, 2);
    return (
      (before && after) ||
      (before && matches(-2, -1)) ||
      (after && matches(2, 3))
    );
  };

  const usable = (cell: number) =>
    vertexAt[cell]! >= 0 && finitePositive(depthAt[cell]!);
  const footprint = (a: number, b: number) =>
    Math.hypot(
      (((a % cols) - (b % cols)) * options.stride) / options.fx,
      ((Math.floor(a / cols) - Math.floor(b / cols)) * options.stride) /
        options.fy,
    ) * Math.min(depthAt[a]!, depthAt[b]!);
  const stretchEdgeOk = (a: number, b: number) => {
    const i = vertexAt[a]! * 3,
      j = vertexAt[b]! * 3;
    const length = Math.hypot(
      positions[j]! - positions[i]!,
      positions[j + 1]! - positions[i + 1]!,
      positions[j + 2]! - positions[i + 2]!,
    );
    return (
      Number.isFinite(length) &&
      length <=
        STRETCH_RAY_SLACK * Math.abs(depthAt[a]! - depthAt[b]!) +
          maxFootprintScale * footprint(a, b)
    );
  };
  const stretchOk = (a: number, b: number, c: number) => {
    if (!usable(a) || !usable(b) || !usable(c)) return false;
    const da = depthAt[a]!,
      db = depthAt[b]!,
      dc = depthAt[c]!;
    if (Math.max(da, db, dc) > maxStretchDepthRatio * Math.min(da, db, dc))
      return false;
    return stretchEdgeOk(a, b) && stretchEdgeOk(b, c) && stretchEdgeOk(c, a);
  };

  const diagonalLengthSq = (a: number, b: number) => {
    const i = vertexAt[a]! * 3,
      j = vertexAt[b]! * 3;
    const dx = positions[j]! - positions[i]!,
      dy = positions[j + 1]! - positions[i + 1]!,
      dz = positions[j + 2]! - positions[i + 2]!;
    return dx * dx + dy * dy + dz * dz;
  };

  const out: number[] = [];
  const stretched: number[] = [];
  // Emit a triangle as textured when its sides are supported, otherwise as
  // stretched when its corners are usable and its span is plausible.
  const emit = (supported: boolean, a: number, b: number, c: number) => {
    if (supported) out.push(vertexAt[a]!, vertexAt[b]!, vertexAt[c]!);
    else if (stretchOk(a, b, c))
      stretched.push(vertexAt[a]!, vertexAt[b]!, vertexAt[c]!);
  };
  for (let y = 0; y + 1 < rows; y += 1) {
    for (let x = 0; x + 1 < cols; x += 1) {
      const a = y * cols + x,
        b = a + 1,
        c = a + cols,
        d = c + 1;
      // Cell sides, shared with neighboring cells and recomputed per cell
      // to keep the helper stateless.
      const top = edgeOk(a, b),
        bottom = edgeOk(c, d),
        left = edgeOk(a, c),
        right = edgeOk(b, d);
      const diagAd = edgeOk(a, d),
        diagBc = edgeOk(b, c);
      const countAd = diagAd
        ? Number(top && right) + Number(left && bottom)
        : 0;
      const countBc = diagBc
        ? Number(right && bottom) + Number(top && left)
        : 0;
      // A shorter diagonal must not hide a valid triangle from the other split.
      let splitAd: boolean;
      if (
        countAd > countBc ||
        (countAd > 0 &&
          countAd === countBc &&
          diagonalLengthSq(a, d) <= diagonalLengthSq(b, c))
      )
        splitAd = true;
      else if (diagBc) splitAd = false;
      // No supported diagonal: stretched triangles keep the split that has a
      // triangle over every usable corner, preferring the shorter diagonal.
      else if (!usable(a) || !usable(d)) splitAd = false;
      else if (!usable(b) || !usable(c)) splitAd = true;
      else splitAd = diagonalLengthSq(a, d) <= diagonalLengthSq(b, c);
      if (splitAd) {
        // Triangle (a, b, d) spans the top and right sides.
        emit(diagAd && top && right, a, b, d);
        // Triangle (a, d, c) spans the bottom and left sides.
        emit(diagAd && left && bottom, a, d, c);
      } else {
        // Triangle (b, d, c) spans the right and bottom sides.
        emit(diagBc && right && bottom, b, d, c);
        // Triangle (b, c, a) spans the top and left sides.
        emit(diagBc && top && left, b, c, a);
      }
    }
  }
  return {
    indices: new Uint32Array(out),
    stretchIndices: new Uint32Array(stretched),
  };
}

/** Fill only isolated interior holes whose eight measured neighbors fit a plane.
 * Inverse depth is affine over image coordinates for a pinhole-viewed plane.
 * Reading only the original samples prevents repairs from growing into gaps.
 */
export function fillIsolatedDepthHoles(
  depths: Float32Array,
  cols: number,
  rows: number,
): Float32Array {
  const filled = depths.slice();
  for (let y = 1; y + 1 < rows; y++) {
    for (let x = 1; x + 1 < cols; x++) {
      const cell = y * cols + x;
      if (Number.isFinite(depths[cell]) && depths[cell] > 0) continue;
      let mean = 0,
        slopeX = 0,
        slopeY = 0;
      let valid = true;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const depth = depths[cell + dy * cols + dx];
          if (!Number.isFinite(depth) || depth <= 0) {
            valid = false;
            continue;
          }
          const inverse = 1 / depth;
          mean += inverse / 8;
          slopeX += (dx * inverse) / 6;
          slopeY += (dy * inverse) / 6;
        }
      }
      if (!valid) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const predicted = mean + dx * slopeX + dy * slopeY;
          if (
            Math.abs(1 / depths[cell + dy * cols + dx] - predicted) >
            mean * 0.005
          )
            valid = false;
        }
      }
      if (valid) filled[cell] = 1 / mean;
    }
  }
  return filled;
}
