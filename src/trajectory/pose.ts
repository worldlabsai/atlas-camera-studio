import { Vector3 } from "three";
import type { Camera, Job } from "../types";
import { cameraPose, toCamera } from "../camera";
import { decodePointCloud } from "../pointcloud";
import { blobToDataUrl } from "./api";
import { authFetch, authFetchJson, type GetToken } from "./client";
export type PosedView = {
  imageUrl: string;
  camera: Camera;
  depthUri: string;
  centroidWorld: [number, number, number];
  points: {
    positions: Float32Array;
    colors: Float32Array;
    shape: [number, number];
    pointSize: number;
  };
};
export async function fileToPoseBlob(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file),
    canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not prepare image");
  const scale = Math.max(1280 / bitmap.width, 720 / bitmap.height);
  ctx.drawImage(
    bitmap,
    (1280 - bitmap.width * scale) / 2,
    (720 - bitmap.height * scale) / 2,
    bitmap.width * scale,
    bitmap.height * scale,
  );
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("Could not encode image")),
      "image/jpeg",
      0.92,
    ),
  );
}
export async function loadDepthPointCloud(
  getToken: GetToken,
  depthUri: string,
  _intrinsics: Camera["intrinsics"],
  opts: { signal?: AbortSignal } = {},
) {
  const match = depthUri.match(
    /^\/api\/jobs\/([a-f0-9-]+)\/media\?kind=depth$/,
  );
  if (!match)
    throw new Error(
      "This draft uses an unsupported source. Upload the image again.",
    );
  const id = match[1],
    job = await authFetchJson<Job>(getToken, `/api/jobs/${id}`, {
      signal: opts.signal,
    });
  const camera = job.result?.frames?.[0]?.camera as Camera;
  if (!camera) throw new Error("Source image has expired; upload it again.");
  const [image, depth] = await Promise.all([
    authFetch(getToken, `/api/jobs/${id}/media?kind=image`, {
      signal: opts.signal,
    }),
    authFetch(getToken, depthUri, { signal: opts.signal }),
  ]);
  const cloud = await decodePointCloud(
    image,
    depth,
    camera,
    opts.signal ?? new AbortController().signal,
    240000,
  );
  const pose = cameraPose(camera),
    inverse = pose.quaternion.clone().invert(),
    positions = cloud.positions;
  const point = new Vector3();
  for (let i = 0; i < positions.length; i += 3) {
    point
      .fromArray(positions, i)
      .sub(pose.position)
      .applyQuaternion(inverse)
      .toArray(positions, i);
  }
  return {
    focus: cloud.focus,
    positions,
    colors: cloud.colors,
    shape: [positions.length / 3, 1] as [number, number],
    pointSize: Math.max(0.003, cloud.medianDepth * 0.006),
  };
}
export async function posePointClouds(
  getToken: GetToken,
  images: readonly Blob[],
  opts: { signal?: AbortSignal; onTick?: (ms: number) => void } = {},
): Promise<PosedView[]> {
  const start = Date.now();
  const timer = window.setInterval(
    () => opts.onTick?.(Date.now() - start),
    200,
  );
  try {
    const base64 = await blobToDataUrl(images[0]!);
    let job = await authFetchJson<Job>(getToken, "/api/jobs/pose", {
      method: "POST",
      body: JSON.stringify({
        key: crypto.randomUUID(),
        image: { base64: base64.split(",")[1], mimeType: images[0]!.type },
      }),
      signal: opts.signal,
    });
    while (job.status === "running" || job.status === "queued") {
      opts.signal?.throwIfAborted();
      if (Date.now() - start > 20 * 60_000)
        throw new Error(
          "Preparing the scene is taking longer than expected. Reload to check your jobs.",
        );
      await new Promise((resolve) => setTimeout(resolve, 1500));
      job = await authFetchJson<Job>(getToken, `/api/jobs/${job.id}`, {
        signal: opts.signal,
      });
    }
    if (job.status !== "succeeded")
      throw new Error(job.error || "Could not prepare scene");
    const frame = job.result.frames[0],
      camera = toCamera(cameraPose(frame.camera), frame.camera.intrinsics),
      depthUri = `/api/jobs/${job.id}/media?kind=depth`;
    const points = await loadDepthPointCloud(
      getToken,
      depthUri,
      camera.intrinsics,
      opts,
    );
    return [
      {
        imageUrl: base64,
        camera,
        points,
        depthUri,
        centroidWorld: frame.centroidWorld ?? points.focus,
      },
    ];
  } finally {
    clearInterval(timer);
  }
}
