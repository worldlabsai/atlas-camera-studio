import type { PinholeCamera } from "./common";
import { type GetToken, appApiPath, authFetchJson } from "./client";

export type CameraTrajectoryReferenceImage = {
  image_base64: string;
  camera: PinholeCamera;
};

export type CameraTrajectoryAspectRatio = "16:9" | "9:16";
export type CameraTrajectoryDirectionMode =
  "manual" | "forward" | "inward" | "outward" | "look_at" | "look_away";

export type CameraTrajectoryDraftSegment = {
  id: string;
  points: [number, number, number][];
  quaternions?: ([number, number, number, number] | null)[] | null;
  direction_overrides?: ([number, number, number, number] | null)[] | null;
  look_at_target?: [number, number, number] | null;
};

export type CameraTrajectoryDraftSummary = {
  draft_id: string;
  saved_at: number;
  file_name: string;
  prompt: string;
  frame_count: number;
  fps: number;
  seed_count: number;
  cfg?: number;
  freeze_time?: boolean;
  aspect_ratio: CameraTrajectoryAspectRatio;
  point_count: number;
  starred: boolean;
};

export type CameraTrajectoryDraftDetails = {
  draft_id: string;
  saved_at: number;
  file_name: string;
  depth_uri: string;
  centroid_world: [number, number, number];
  prompt: string;
  frame_count: number;
  fps: number;
  seed_count?: number;
  cfg?: number;
  freeze_time?: boolean;
  target_fov_degrees?: number | null;
  aspect_ratio: CameraTrajectoryAspectRatio;
  direction_mode?: CameraTrajectoryDirectionMode;
  direction_target?: [number, number, number] | null;
  closed_loop?: boolean;
  allow_below_floor?: boolean;
  trajectory_smoothing_version?: number;
  segments: CameraTrajectoryDraftSegment[];
  target_cameras: PinholeCamera[];
  reference_camera: PinholeCamera;
  reference_image_base64: string;
};

type CameraTrajectoryDraftList = {
  items: CameraTrajectoryDraftSummary[];
};

export type SaveCameraTrajectoryDraft = {
  file_name: string;
  depth_uri: string;
  centroid_world: [number, number, number];
  reference_image: CameraTrajectoryReferenceImage;
  segments: CameraTrajectoryDraftSegment[];
  target_cameras: PinholeCamera[];
  prompt: string;
  frame_count: number;
  fps: number;
  seed_count: number;
  cfg: number;
  freeze_time: boolean;
  target_fov_degrees: number;
  aspect_ratio: CameraTrajectoryAspectRatio;
  direction_mode: CameraTrajectoryDirectionMode;
  direction_target: [number, number, number] | null;
  closed_loop: boolean;
  allow_below_floor: boolean;
  trajectory_smoothing_version: number;
};

export type CameraTrajectorySubmission = {
  job_id: string;
  generation_storage_dir: string;
};

export type CameraTrajectoryStatus = {
  state: "running" | "done" | "error";
  error?: string | null;
  response?: {
    video_uri?: string | null;
    video_base64?: string | null;
    error?: string | null;
  } | null;
};

export type CameraTrajectoryHistoryItem = {
  iteration_id: string;
  submitted_at: number;
  prompt: string;
  target_frame_count: number;
  fps: number;
  aspect_ratio: CameraTrajectoryAspectRatio;
  variants: CameraTrajectoryHistoryVariant[];
};

export type CameraTrajectoryHistoryVariant = {
  job_id: string;
  generation_storage_dir: string;
  submitted_at: number;
  seed: number | null;
  prompt?: string;
  target_frame_count?: number;
  fps?: number;
  cfg?: number;
  freeze_time?: boolean;
  aspect_ratio: CameraTrajectoryAspectRatio;
  video_uri: string | null;
  starred: boolean;
};

export type CameraTrajectoryHistory = {
  items: CameraTrajectoryHistoryItem[];
  total_count: number;
};

import type { Job } from "../types";
import { readStored, changeStored } from "./storage";
type Draft = CameraTrajectoryDraftDetails & { starred: boolean };
type Preference = {
  starred?: boolean;
  hidden?: boolean;
  iterationId?: string;
  prompt?: string;
  seed?: number;
};
const summary = (draft: Draft): CameraTrajectoryDraftSummary => ({
  ...draft,
  seed_count: 1,
  point_count: draft.segments.reduce((n, s) => n + s.points.length, 0),
});
export async function saveCameraTrajectoryDraft(
  getToken: GetToken,
  input: SaveCameraTrajectoryDraft,
): Promise<CameraTrajectoryDraftSummary> {
  const draft: Draft = {
    ...input,
    draft_id: `draft_${crypto.randomUUID()}`,
    saved_at: Date.now() / 1000,
    starred: false,
    reference_camera: input.reference_image.camera,
    reference_image_base64: input.reference_image.image_base64,
  };
  await changeStored<Draft>(getToken, "drafts", (items) => {
    items[draft.draft_id] = draft;
    const keys = Object.keys(items).sort(
      (a, b) => items[b].saved_at - items[a].saved_at,
    );
    for (const key of keys.slice(30)) delete items[key];
  });
  return summary(draft);
}
export async function getCameraTrajectoryDrafts(getToken: GetToken) {
  return {
    items: Object.values(await readStored<Draft>(getToken, "drafts")).map(
      summary,
    ),
  };
}
export async function getCameraTrajectoryDraft(getToken: GetToken, id: string) {
  const draft = (await readStored<Draft>(getToken, "drafts"))[id];
  if (!draft) throw new Error("Draft is not saved in this browser.");
  return draft;
}
export async function setCameraTrajectoryDraftStar(
  getToken: GetToken,
  id: string,
  starred: boolean,
) {
  await changeStored<Draft>(getToken, "drafts", (items) => {
    if (items[id]) items[id].starred = starred;
  });
  return { starred };
}
export async function setCameraTrajectoryGenerationStar(
  getToken: GetToken,
  id: string,
  starred: boolean,
) {
  await changeStored<Preference>(getToken, "generations", (items) => {
    items[id] = { ...items[id], starred };
  });
  return { starred };
}
export async function deleteCameraTrajectoryGeneration(
  getToken: GetToken,
  id: string,
) {
  await changeStored<Preference>(getToken, "generations", (items) => {
    items[id] = { ...items[id], hidden: true };
  });
  return { deleted: true };
}
export async function submitCameraTrajectory(
  getToken: GetToken,
  _reference: CameraTrajectoryReferenceImage,
  cameras: PinholeCamera[],
  iterationId: string,
  prompt: string,
  _fps: number,
  seed: number,
): Promise<CameraTrajectorySubmission> {
  const draft = await getCameraTrajectoryDraft(getToken, iterationId),
    poseJobId = draft.depth_uri.match(/^\/api\/jobs\/([a-f0-9-]+)\/media/)?.[1];
  if (!poseJobId)
    throw new Error("Source image is unavailable. Upload it again.");
  const job = await authFetchJson<Job>(getToken, "/api/jobs/generate", {
    method: "POST",
    body: JSON.stringify({
      key: crypto.randomUUID(),
      poseJobId,
      cameras,
      prompt,
      seed,
    }),
  });
  await changeStored<Preference>(getToken, "generations", (items) => {
    items[job.id] = { iterationId, prompt, seed };
  });
  window.dispatchEvent(new Event("studio-account-refresh"));
  return { job_id: job.id, generation_storage_dir: job.id };
}
export async function getCameraTrajectoryStatus(
  getToken: GetToken,
  id: string,
): Promise<CameraTrajectoryStatus> {
  const job = await authFetchJson<Job>(getToken, `/api/jobs/${id}`);
  if (job.status === "succeeded" || job.status === "failed")
    window.dispatchEvent(new Event("studio-account-refresh"));
  return {
    state:
      job.status === "succeeded"
        ? "done"
        : job.status === "failed"
          ? "error"
          : "running",
    error: job.error,
    response:
      job.status === "succeeded"
        ? { video_uri: `/api/jobs/${id}/video` }
        : null,
  };
}
export async function getCameraTrajectoryHistory(
  getToken: GetToken,
): Promise<CameraTrajectoryHistory> {
  const jobs = await authFetchJson<Job[]>(getToken, "/api/jobs"),
    prefs = await readStored<Preference>(getToken, "generations");
  const items: CameraTrajectoryHistoryItem[] = jobs
    .filter((j) => j.kind === "generate" && !prefs[j.id]?.hidden)
    .map((job) => {
      const p = prefs[job.id];
      return {
        iteration_id: p?.iterationId ?? job.id,
        submitted_at: job.createdAt / 1000,
        prompt: p?.prompt ?? "Camera move",
        target_frame_count: 48,
        fps: 12,
        aspect_ratio: "16:9",
        variants: [
          {
            job_id: job.id,
            generation_storage_dir: job.id,
            submitted_at: job.createdAt / 1000,
            seed: p?.seed ?? null,
            aspect_ratio: "16:9",
            video_uri:
              job.status === "succeeded" ? `/api/jobs/${job.id}/video` : null,
            starred: p?.starred ?? false,
          },
        ],
      };
    });
  return { items, total_count: items.length };
}
export function cameraTrajectoryVideoUrl(uri: string) {
  if (!/^\/api\/jobs\/[a-f0-9-]+\/video$/.test(uri))
    throw new Error("Invalid video URL");
  return uri;
}
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
