import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FloatType, RedFormat } from "three";
import { EXRLoader } from "three/examples/jsm/loaders/EXRLoader.js";
import {
  buildDepthSurface,
  triangulateDepthSurface,
  fillIsolatedDepthHoles,
  type DepthSurfaceGrid,
} from "../src/depth-surface";

// Build a grid the same way decodePointCloud does: regular lattice over the
// source image, camera-local positions from the pinhole projection, and a
// compact vertex order that skips invalid samples.
const FX = 1000;
const FY = 1000;
const STRIDE = 4;

type Sample = number | null; // null = missing/invalid depth

function buildGrid(
  cols: number,
  rows: number,
  depthAtSample: (col: number, row: number) => Sample,
): DepthSurfaceGrid {
  const cx = (cols * STRIDE) / 2,
    cy = (rows * STRIDE) / 2;
  const vertexAt = new Int32Array(cols * rows).fill(-1);
  const depthAt = new Float32Array(cols * rows).fill(NaN);
  const positions: number[] = [];
  for (let row = 0; row < rows; row += 1)
    for (let col = 0; col < cols; col += 1) {
      const d = depthAtSample(col, row);
      if (d === null || !Number.isFinite(d) || d <= 0) continue;
      const px = col * STRIDE + 0.5,
        py = row * STRIDE + 0.5;
      positions.push(((px - cx) / FX) * d, (-(py - cy) / FY) * d, -d);
      vertexAt[row * cols + col] = positions.length / 3 - 1;
      depthAt[row * cols + col] = d;
    }
  return {
    cols,
    rows,
    vertexAt,
    depthAt,
    positions: new Float32Array(positions),
  };
}

function triangulate(
  cols: number,
  rows: number,
  depthAtSample: (col: number, row: number) => Sample,
) {
  return triangulateDepthSurface(buildGrid(cols, rows, depthAtSample), {
    stride: STRIDE,
    fx: FX,
    fy: FY,
  });
}

/** Reverse of vertexAt: compact vertex index -> grid cell index. */
function cellOfVertex(grid: DepthSurfaceGrid): Map<number, number> {
  const cellOf = new Map<number, number>();
  for (let cell = 0; cell < grid.vertexAt.length; cell += 1) {
    const vertex = grid.vertexAt[cell]!;
    if (vertex >= 0) cellOf.set(vertex, cell);
  }
  return cellOf;
}

test("flat plane connects every grid cell with two triangles", () => {
  const cols = 8,
    rows = 6,
    depth = 5;
  const indices = triangulate(cols, rows, () => depth);
  // Every (cols-1)*(rows-1) cell yields both triangles.
  assert.equal(indices.length, (cols - 1) * (rows - 1) * 6);
  // Every sampled vertex participates in the surface.
  const used = new Set(indices);
  const vertexCount = cols * rows;
  assert.equal(used.size, vertexCount);
});

test("flat plane triangle corners all sit at the sampled depth", () => {
  const indices = triangulate(6, 5, () => 3);
  const grid = buildGrid(6, 5, () => 3);
  for (const index of indices) assert.equal(grid.positions[index * 3 + 2], -3);
});

test("sharp foreground/background step is not bridged", () => {
  const cols = 10,
    rows = 6,
    near = 2,
    far = 9;
  // A relative depth jump of 3.5 across the middle columns must produce
  // no triangle mixing the two surfaces.
  const depthAtSample = (col: number) => (col < 5 ? near : far);
  const indices = triangulate(cols, rows, depthAtSample);
  const cellOf = cellOfVertex(buildGrid(cols, rows, depthAtSample));
  for (let t = 0; t < indices.length; t += 3) {
    const triangleCols = [0, 1, 2].map(
      (k) => cellOf.get(indices[t + k]!)! % cols,
    );
    const nearSide = triangleCols[0]! < 5;
    for (const col of triangleCols)
      assert.equal(col < 5, nearSide, "triangle spans the step");
  }
});

test("sloped plane stays fully connected", () => {
  const cols = 8,
    rows = 6;
  // Depth grows linearly with x: about 0.03 world units per sample, a
  // roughly 60 degree slope from a camera at depth 4. Well inside both
  // the relative jump cutoff and the footprint length limit.
  const slope = (col: number) => 4 + 0.0075 * col * STRIDE;
  const indices = triangulate(cols, rows, (col) => slope(col));
  assert.equal(indices.length, (cols - 1) * (rows - 1) * 6);
});

test("missing depth cells are skipped and never indexed", () => {
  const cols = 7,
    rows = 7;
  const isMissing = (col: number, row: number) =>
    col === 3 || (col === 5 && row === 5);
  const depthAtSample = (col: number, row: number) =>
    isMissing(col, row) ? null : 4;
  const indices = triangulate(cols, rows, depthAtSample);
  const grid = buildGrid(cols, rows, depthAtSample);
  const cellOf = cellOfVertex(grid);
  for (const index of indices) {
    const cell = cellOf.get(index)!;
    const col = cell % cols,
      row = Math.floor(cell / cols);
    assert.ok(!isMissing(col, row), `index ${index} came from a missing cell`);
  }
  // The surface closes around the hole but never covers it.
  assert.ok(indices.length > 0);
  assert.ok(indices.length < (cols - 1) * (rows - 1) * 6);
});

test("indices always reference valid compact vertices in groups of three", () => {
  const cols = 9,
    rows = 8;
  const indices = triangulate(cols, rows, (col, row) =>
    (col * 7 + row * 5) % 11 === 0 ? null : 2.5 + 0.01 * col,
  );
  const vertexCount =
    buildGrid(cols, rows, (col, row) =>
      (col * 7 + row * 5) % 11 === 0 ? null : 2.5 + 0.01 * col,
    ).positions.length / 3;
  assert.equal(indices.length % 3, 0);
  for (const index of indices)
    assert.ok(
      Number.isInteger(index) && index >= 0 && index < vertexCount,
      `index ${index} outside [0, ${vertexCount})`,
    );
});

test("a cell with three valid corners emits exactly one triangle", () => {
  // 2x2 grid, the far corner (col 1, row 1) has no depth.
  const grid = buildGrid(2, 2, (col, row) =>
    col === 1 && row === 1 ? null : 3,
  );
  const indices = triangulateDepthSurface(grid, {
    stride: STRIDE,
    fx: FX,
    fy: FY,
  });
  assert.equal(indices.length, 3);
  const used = new Set(indices);
  assert.equal(used.size, 3);
  const valid = [...grid.vertexAt].filter((v) => v >= 0);
  for (const v of valid) assert.ok(used.has(v));
});

test("nonfinite and nonpositive depths never produce indices", () => {
  const grid = buildGrid(3, 3, () => 4);
  // Corrupt depths while keeping the vertex indices: these cells must be
  // treated as missing, so no triangle may reference them.
  grid.depthAt[4] = NaN;
  grid.depthAt[0] = 0;
  grid.depthAt[8] = -2;
  const indices = triangulateDepthSurface(grid, {
    stride: STRIDE,
    fx: FX,
    fy: FY,
  });
  const corrupted = new Set([0, 4, 8].map((cell) => grid.vertexAt[cell]));
  // The two cells diagonal to the corrupted corners keep three valid
  // corners each and emit one triangle apiece; the other two cells lose
  // two corners and emit none.
  assert.equal(indices.length, 6);
  for (const index of indices) assert.ok(!corrupted.has(index));
});

test("custom depth thresholds tighten or loosen acceptance", () => {
  // A small step passes normal guards but fails stricter thresholds;
  // neither side provides evidence of a continuous plane across the step.
  const cols = 2,
    rows = 2;
  const slope = (col: number) => 4 + 0.08 * col;
  const grid = buildGrid(cols, rows, (col) => slope(col));
  const relaxed = triangulateDepthSurface(grid, {
    stride: STRIDE,
    fx: FX,
    fy: FY,
  });
  const tight = triangulateDepthSurface(grid, {
    stride: STRIDE,
    fx: FX,
    fy: FY,
    maxFootprintScale: 1,
    maxDepthJump: 0.001,
  });
  assert.ok(relaxed.length > 0);
  assert.equal(tight.length, 0);
});

test("empty and single-cell grids produce no indices", () => {
  for (const [cols, rows] of [
    [1, 1],
    [2, 1],
    [1, 2],
  ] as const) {
    const indices = triangulate(cols, rows, () => 3);
    assert.equal(indices.length, 0);
  }
});

test("pixel footprint respects both focal lengths and diagonal spacing", () => {
  const grid = buildGrid(4, 4, () => 5);
  // Make the horizontal spacing twice as wide as vertical spacing.
  for (let i = 0; i < grid.positions.length; i += 3) grid.positions[i] *= 2;
  const indices = triangulateDepthSurface(grid, {
    stride: STRIDE,
    fx: FX / 2,
    fy: FY,
    maxFootprintScale: 1.01,
  });
  assert.equal(indices.length, 3 * 3 * 6);
});

test("grazing floor keeps interior cells connected", () => {
  const cols = 7,
    rows = 7;
  const positions: number[] = [],
    depths: number[] = [];
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const depth = FX / (60 + y * STRIDE);
      depths.push(depth);
      positions.push(((x * STRIDE) / FX) * depth, -1, -depth);
    }
  const grid = {
    cols,
    rows,
    vertexAt: Int32Array.from(depths, (_, i) => i),
    depthAt: Float32Array.from(depths),
    positions: Float32Array.from(positions),
  };
  const indices = triangulateDepthSurface(grid, {
    stride: STRIDE,
    fx: FX,
    fy: FY,
  });
  assert.ok(
    indices.length > 0,
    "a smooth floor at a shallow angle must not disappear",
  );
  const cells = new Set(indices);
  assert.ok(cells.has(3 * cols + 3), "the middle of the floor remains covered");
});

test("grazing planes with large depth changes remain covered up to image borders", () => {
  const cols = 8,
    rows = 8;
  // The topmost edge changes depth by 50%, yet all samples lie on one plane.
  const indices = triangulate(cols, rows, (_x, y) => 1 / (0.02 + 0.01 * y));
  assert.equal(indices.length, (cols - 1) * (rows - 1) * 6);
});

test("local planar support preserves a noisy grazing surface", () => {
  const cols = 9,
    rows = 9;
  const indices = triangulate(
    cols,
    rows,
    (x, y) => 1 / (0.1 + 0.006 * y + ((x + y) % 2 ? 0.0006 : -0.0006)),
  );
  // Neighboring slopes differ enough to defeat the directional trend guard,
  // but the interior still fits a plane to within the measured depth noise.
  const used = new Set(indices);
  for (let y = 1; y + 1 < rows; y++)
    for (let x = 1; x + 1 < cols; x++) assert.ok(used.has(y * cols + x));
  assert.ok(indices.length >= (cols - 3) * (rows - 3) * 6);
});

test("local plane support never bridges a moderate depth step", () => {
  const cols = 9,
    rows = 9;
  const grid = buildGrid(cols, rows, (x) => (x < 4 ? 4 : 4.2));
  const indices = triangulateDepthSurface(grid, {
    stride: STRIDE,
    fx: FX,
    fy: FY,
  });
  assert.equal(indices.length, (cols - 2) * (rows - 1) * 6);
  for (let i = 0; i < indices.length; i += 3) {
    const side = indices[i] % cols < 4;
    assert.equal(indices[i + 1] % cols < 4, side);
    assert.equal(indices[i + 2] % cols < 4, side);
  }
});

test("an isolated foreground sample is not joined to its background", () => {
  const indices = triangulate(9, 9, (x, y) => (x === 4 && y === 4 ? 2 : 4));
  assert.ok(indices.length > 0);
  assert.ok(!new Set(indices).has(4 * 9 + 4));
});

test("isolated missing depth is recovered on its measured inverse-depth plane", () => {
  const cols = 5,
    rows = 5;
  const depths = Float32Array.from(
    { length: cols * rows },
    (_, i) => 1 / (0.1 + (i % cols) * 0.01 + Math.floor(i / cols) * 0.02),
  );
  const expected = depths[12];
  depths[12] = NaN;
  const filled = fillIsolatedDepthHoles(depths, cols, rows);
  assert.ok(Math.abs(filled[12] - expected) < 1e-6);
  assert.ok(Number.isNaN(depths[12]), "measured samples remain unchanged");
  const indices = triangulate(cols, rows, (x, y) => filled[y * cols + x]);
  assert.equal(indices.length, (cols - 1) * (rows - 1) * 6);
});

test("holes at a depth step, borders, or in larger gaps remain missing", () => {
  const step = Float32Array.from({ length: 25 }, (_, i) => (i % 5 < 2 ? 2 : 4));
  step[12] = NaN;
  assert.ok(Number.isNaN(fillIsolatedDepthHoles(step, 5, 5)[12]));
  const gap = new Float32Array(25).fill(4);
  gap[0] = gap[12] = gap[13] = NaN;
  const filled = fillIsolatedDepthHoles(gap, 5, 5);
  for (const cell of [0, 12, 13]) assert.ok(Number.isNaN(filled[cell]));
});

test("example depth retains measured surface coverage when viewed from above", () => {
  const file = readFileSync(
    new URL("../public/example/igloo.exr", import.meta.url),
  );
  const decoded = new EXRLoader()
    .setDataType(FloatType)
    .setOutputFormat(RedFormat)
    .parse(
      file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
    );
  const { width, height, data } = decoded;
  assert.ok(
    width && height && data,
    "example EXR must decode to a complete depth image",
  );
  const camera = JSON.parse(
    readFileSync(
      new URL("../public/example/igloo.json", import.meta.url),
      "utf8",
    ),
  ).camera.intrinsics;
  const stride = 2,
    cols = Math.ceil(width / stride),
    rows = Math.ceil(height / stride);
  const depthAt = new Float32Array(cols * rows);
  const vertexAt = Int32Array.from(depthAt, (_, i) => i);
  const positions = new Float32Array(cols * rows * 3);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const cell = y * cols + x;
      const depth = data[(height - 1 - y * stride) * width + x * stride];
      depthAt[cell] = depth;
      positions.set(
        [
          ((x * stride + 0.5 - camera.cx) / camera.fx) * depth,
          (-(y * stride + 0.5 - camera.cy) / camera.fy) * depth,
          -depth,
        ],
        cell * 3,
      );
    }
  }
  const indices = triangulateDepthSurface(
    { cols, rows, depthAt, vertexAt, positions },
    { stride, fx: camera.fx, fy: camera.fy },
  );
  let projectedArea = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3,
      b = indices[i + 1] * 3,
      c = indices[i + 2] * 3;
    projectedArea +=
      Math.abs(
        (positions[b] - positions[a]) * (positions[c + 2] - positions[a + 2]) -
          (positions[b + 2] - positions[a + 2]) * (positions[c] - positions[a]),
      ) / 2;
  }
  // The old directional guards kept only 14.58 square units of projected
  // area. Count geometry, not pixels, so this remains independent of WebGL.
  assert.ok(projectedArea > 19, `only ${projectedArea} square units remain`);
  assert.ok(indices.length / 3 > 440000);
});

function surfaceOf(
  cols: number,
  rows: number,
  depthAtSample: (col: number, row: number) => Sample,
  extra: { maxStretchDepthRatio?: number } = {},
) {
  const grid = buildGrid(cols, rows, depthAtSample);
  return {
    grid,
    surface: buildDepthSurface(grid, {
      stride: STRIDE,
      fx: FX,
      fy: FY,
      ...extra,
    }),
  };
}

/** Grid cell of each triangle, keyed by its top-left grid corner. */
function trianglesPerCell(
  grid: DepthSurfaceGrid,
  ...lists: Uint32Array[]
): Map<number, number> {
  const cellOf = cellOfVertex(grid);
  const perCell = new Map<number, number>();
  for (const list of lists)
    for (let t = 0; t < list.length; t += 3) {
      const cells = [0, 1, 2].map((k) => cellOf.get(list[t + k]!)!);
      const col = Math.min(...cells.map((cell) => cell % grid.cols)),
        row = Math.min(...cells.map((cell) => Math.floor(cell / grid.cols)));
      const key = row * grid.cols + col;
      perCell.set(key, (perCell.get(key) ?? 0) + 1);
    }
  return perCell;
}

test("stretched output leaves the textured triangulation unchanged", () => {
  const shapes: ((col: number, row: number) => Sample)[] = [
    () => 4,
    (x) => (x < 4 ? 4 : 4.2),
    (x) => (x < 5 ? 2 : 9),
    (x, y) => (x === 4 && y === 4 ? 2 : 4),
    (x, y) => ((x * 7 + y * 5) % 11 === 0 ? null : 2.5 + 0.01 * x),
  ];
  for (const shape of shapes) {
    const { grid, surface } = surfaceOf(9, 9, shape);
    assert.deepEqual(
      surface.indices,
      triangulateDepthSurface(grid, { stride: STRIDE, fx: FX, fy: FY }),
    );
  }
});

test("a supported plane has no stretched triangles", () => {
  const { surface } = surfaceOf(8, 6, (x) => 4 + 0.0075 * x * STRIDE);
  assert.equal(surface.stretchIndices.length, 0);
});

test("a moderate depth step is bridged only by stretched triangles", () => {
  const cols = 9,
    rows = 9;
  const { grid, surface } = surfaceOf(cols, rows, (x) => (x < 4 ? 4 : 4.2));
  const { stretchIndices } = surface;
  // Exactly the column of cells across the step: two triangles per row.
  assert.equal(stretchIndices.length, (rows - 1) * 2 * 3);
  for (let t = 0; t < stretchIndices.length; t += 3) {
    const sides = [0, 1, 2].map((k) => stretchIndices[t + k]! % cols < 4);
    assert.ok(sides.includes(true) && sides.includes(false));
  }
  // Textured and stretched triangles tile the grid without overlapping.
  const perCell = trianglesPerCell(grid, surface.indices, stretchIndices);
  assert.equal(perCell.size, (cols - 1) * (rows - 1));
  for (const count of perCell.values()) assert.equal(count, 2);
});

test("an isolated foreground sample keeps a stretched link to its background", () => {
  const { grid, surface } = surfaceOf(9, 9, (x, y) =>
    x === 4 && y === 4 ? 2 : 4,
  );
  const center = grid.vertexAt[4 * 9 + 4]!;
  assert.ok(!new Set(surface.indices).has(center));
  assert.ok(new Set(surface.stretchIndices).has(center));
  const perCell = trianglesPerCell(grid, surface.indices, surface.stretchIndices);
  for (const count of perCell.values()) assert.ok(count <= 2);
});

test("stretched triangles skip extreme depth ratios", () => {
  // Foreground at 2 against a backdrop at 9: a ratio of 4.5 reads as sky
  // or a distant wall, not as a surface continuing behind the subject.
  const far = surfaceOf(10, 6, (x) => (x < 5 ? 2 : 9)).surface;
  assert.equal(far.stretchIndices.length, 0);
  const near = surfaceOf(10, 6, (x) => (x < 5 ? 2 : 5)).surface;
  assert.equal(near.stretchIndices.length, 5 * 2 * 3);
  const tight = surfaceOf(10, 6, (x) => (x < 5 ? 2 : 5), {
    maxStretchDepthRatio: 2,
  }).surface;
  assert.equal(tight.stretchIndices.length, 0);
});

test("stretched triangles skip edges far beyond the sampled footprint", () => {
  const cols = 6,
    rows = 4;
  const grid = buildGrid(cols, rows, (x) => (x < 3 ? 4 : 4.4));
  const options = { stride: STRIDE, fx: FX, fy: FY };
  assert.ok(buildDepthSurface(grid, options).stretchIndices.length > 0);
  // Push the far side sideways off its source rays.
  for (let cell = 0; cell < cols * rows; cell++)
    if (cell % cols >= 3) grid.positions[grid.vertexAt[cell]! * 3] += 2;
  assert.equal(buildDepthSurface(grid, options).stretchIndices.length, 0);
});

test("stretched triangles never reference missing or invalid samples", () => {
  const cols = 9,
    rows = 9;
  const isMissing = (x: number, y: number) => (x * 3 + y * 7) % 10 === 0;
  const { grid, surface } = surfaceOf(cols, rows, (x, y) =>
    isMissing(x, y) ? null : x < 4 ? 3 : 3.6,
  );
  grid.depthAt[grid.cols * 2 + 6] = NaN;
  const { stretchIndices } = buildDepthSurface(grid, {
    stride: STRIDE,
    fx: FX,
    fy: FY,
  });
  assert.ok(surface.stretchIndices.length > 0);
  assert.equal(stretchIndices.length % 3, 0);
  const cellOf = cellOfVertex(grid);
  for (const index of stretchIndices) {
    const cell = cellOf.get(index)!;
    assert.ok(!isMissing(cell % cols, Math.floor(cell / cols)));
    assert.notEqual(cell, grid.cols * 2 + 6);
  }
});
