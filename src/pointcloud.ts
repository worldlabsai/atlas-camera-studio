import { Color, FloatType, RedFormat, SRGBColorSpace, Vector3 } from "three";
import { EXRLoader } from "three/examples/jsm/loaders/EXRLoader.js";
import type { Camera } from "./types";
import { cameraPose } from "./camera";
import { buildDepthSurface, fillIsolatedDepthHoles } from "./depth-surface";

// Source pixels are sRGB-encoded while vertex colors are consumed as
// linear-sRGB, so every 8-bit channel is converted once through Three's
// Color conversion instead of once per point.
const SRGB_TO_LINEAR = buildSrgbToLinearTable();

function buildSrgbToLinearTable(): Float32Array {
  const table = new Float32Array(256);
  const channel = new Color();
  for (let byte = 0; byte < 256; byte += 1) {
    channel.setRGB(byte / 255, byte / 255, byte / 255, SRGBColorSpace);
    table[byte] = channel.r;
  }
  return table;
}

/** Linear-sRGB intensity for an 8-bit sRGB channel value. */
export function srgbByteToLinear(byte: number): number {
  return SRGB_TO_LINEAR[Math.min(255, Math.max(0, Math.round(byte)))] ?? 0;
}

export type PointCloudData = {
  positions: Float32Array;
  colors: Float32Array;
  /** Compact vertex indices forming the surface triangulation. */
  indices: Uint32Array;
  /** Untextured triangles bridging plausible depth gaps the surface rejects. */
  stretchIndices: Uint32Array;
  /** Per-vertex uv, (u / width, 1 - v / height) for flipY textures. */
  uvs: Float32Array;
  medianDepth: number;
  focus: [number, number, number];
};
export async function decodePointCloud(
  imageResponse: Response,
  depthResponse: Response,
  camera: Camera,
  signal: AbortSignal,
  maxPoints = 20000,
): Promise<PointCloudData> {
  const [imageBlob, depthBuffer] = await Promise.all([
    imageResponse.blob(),
    depthResponse.arrayBuffer(),
  ]);
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const bitmap = await createImageBitmap(imageBlob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Could not read the source image.");
    context.drawImage(bitmap, 0, 0);
    const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const decoded = new EXRLoader()
      .setDataType(FloatType)
      .setOutputFormat(RedFormat)
      .parse(depthBuffer) as {
      width: number;
      height: number;
      data: Float32Array;
    };
    const width = decoded.width,
      height = decoded.height,
      depths = decoded.data;
    const depthAt = (x: number, y: number) =>
      depths[(height - 1 - y) * width + x];
    const stride = Math.max(
      1,
      Math.ceil(Math.sqrt((width * height) / maxPoints)),
    );
    const cols = Math.ceil(width / stride),
      rows = Math.ceil(height / stride);
    // Grid topology of the regular sample lattice: which compact vertex
    // (if any) each cell produced, and the depth that generated it.
    const vertexAt = new Int32Array(cols * rows).fill(-1);
    const measuredDepth = new Float32Array(cols * rows);
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++)
        measuredDepth[y * cols + x] = depthAt(x * stride, y * stride);
    const cellDepth = fillIsolatedDepthHoles(measuredDepth, cols, rows);
    const sampled: number[] = [];
    for (let y = 0; y < height; y += stride)
      for (let x = 0; x < width; x += stride) {
        const d = cellDepth[(y / stride) * cols + x / stride];
        if (Number.isFinite(d) && d > 0) sampled.push(d);
      }
    if (!sampled.length)
      throw new Error("The depth map has no usable positive depth values.");
    sampled.sort((a, b) => a - b);
    const medianDepth = sampled[Math.floor(sampled.length / 2)];
    const { intrinsics } = camera,
      pose = cameraPose(camera),
      positions: number[] = [],
      colors: number[] = [],
      uvs: number[] = [];
    const sx = width / bitmap.width,
      sy = height / bitmap.height;
    for (let y = 0; y < height; y += stride)
      for (let x = 0; x < width; x += stride) {
        const d = cellDepth[(y / stride) * cols + x / stride];
        if (!Number.isFinite(d) || d <= 0) continue;
        const u = (x + 0.5) / sx,
          v = (y + 0.5) / sy;
        const local = [
          ((u - intrinsics.cx) / intrinsics.fx) * d,
          (-(v - intrinsics.cy) / intrinsics.fy) * d,
          -d,
        ] as const;
        // Apply the RUB camera rotation to each reconstructed camera-space point.
        const point = pose.position
          .clone()
          .add(
            new Vector3(local[0], local[1], local[2]).applyQuaternion(
              pose.quaternion,
            ),
          );
        positions.push(point.x, point.y, point.z);
        uvs.push(u / bitmap.width, 1 - v / bitmap.height);
        const ix = Math.min(bitmap.width - 1, Math.floor(u)),
          iy = Math.min(bitmap.height - 1, Math.floor(v)),
          ci = (iy * bitmap.width + ix) * 4;
        colors.push(
          srgbByteToLinear(rgba[ci]!),
          srgbByteToLinear(rgba[ci + 1]!),
          srgbByteToLinear(rgba[ci + 2]!),
        );
        const cell = (y / stride) * cols + x / stride;
        vertexAt[cell] = positions.length / 3 - 1;
        cellDepth[cell] = d;
      }
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const forward = new Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
    const focus = pose.position.clone().addScaledVector(forward, medianDepth);
    const positionArray = new Float32Array(positions);
    const surface = buildDepthSurface(
      { cols, rows, vertexAt, depthAt: cellDepth, positions: positionArray },
      { stride, fx: intrinsics.fx * sx, fy: intrinsics.fy * sy },
    );
    return {
      positions: positionArray,
      colors: new Float32Array(colors),
      indices: surface.indices,
      stretchIndices: surface.stretchIndices,
      uvs: new Float32Array(uvs),
      medianDepth,
      focus: [focus.x, focus.y, focus.z],
    };
  } finally {
    bitmap.close();
  }
}
