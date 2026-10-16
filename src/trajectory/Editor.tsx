import { EXAMPLE_DEPTH, EXAMPLE_IMAGE, EXAMPLE_HANDOFF } from "../example";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Camera,
  ChevronDown,
  Copy,
  Download,
  Film,
  FolderOpen,
  History as HistoryIcon,
  House,
  Loader2,
  Maximize2,
  Minimize2,
  Play,
  Redo2,
  Route,
  Sparkles,
  Star,
  Trash2,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import { verticalFov, type PinholeCamera } from "./common";
import * as THREE from "three";
import {
  CameraTrajectoryCanvas,
  ShotCameraView,
  type PilotPose,
} from "./Canvas";
import {
  cameraPathTarget,
  cameraViewLookingAt,
  materializeTrajectorySmoothing,
  TRAJECTORY_FLOOR_Y,
  type CameraView,
  type TrajectoryPoint,
  type TrajectorySpace,
} from "./camera-trajectory";
import {
  buildShotTargetCameras,
  createShotCurve,
  isCameraKeyframe,
  keyframeAt,
  keyframesFromLegacySegments,
  keyframesFromPoses,
  poseFromView,
  retimeKeyframe,
  setKeyframeGap,
  shotHasMotion,
  sortKeyframes,
  spaceKeyframesEvenly,
  upsertKeyframe,
  type CameraAimMode,
  type CameraKeyframe,
} from "./keyframes";
import {
  blobToDataUrl,
  cameraTrajectoryVideoUrl,
  deleteCameraTrajectoryGeneration,
  getCameraTrajectoryDraft,
  getCameraTrajectoryDrafts,
  getCameraTrajectoryHistory,
  getCameraTrajectoryStatus,
  saveCameraTrajectoryDraft,
  setCameraTrajectoryDraftStar,
  setCameraTrajectoryGenerationStar,
  submitCameraTrajectory,
  type CameraTrajectoryAspectRatio,
  type CameraTrajectoryDraftDetails,
  type CameraTrajectoryDraftSummary,
  type CameraTrajectoryHistoryItem,
  type CameraTrajectoryHistoryVariant,
  type SaveCameraTrajectoryDraft,
} from "./api";
import { authFetch, type GetToken } from "./client";
import { useEditHistory } from "./use-edit-history";
import { loadDepthPointCloud, loadExamplePose } from "./pose";
import { fileToPoseBlob, posePointClouds, type PosedView } from "./pose";
import { createCameraMove, type CameraMovePreset } from "./presets";
import {
  createPlayhead,
  usePlayheadFrame,
  usePlayheadPlaying,
  type Playhead,
} from "./playhead";
import { formatTime, Timeline, type TimeUnit } from "./Timeline";
import { PlanMap } from "./PlanMap";
import { CameraPanel, PathPanel, VideoPanel } from "./ShotPanels";
import { useStudioTheme } from "../theme";

const DEFAULT_FRAME_COUNT = 48;
const DEFAULT_FPS = 12;
const DEFAULT_SEED_COUNT = 1;
const DEFAULT_CFG = 2.5;
const DEFAULT_FREEZE_TIME = true;
const MIN_SEED_COUNT = 1;
const MAX_SEED_COUNT = 16;
const MIN_TARGET_FOV_DEGREES = 5;
const MAX_TARGET_FOV_DEGREES = 140;
const DEFAULT_ASPECT_RATIO: CameraTrajectoryAspectRatio = "16:9";
const PORTRAIT_GENERATION_ENABLED = false;
const TARGET_FORMATS: Record<
  CameraTrajectoryAspectRatio,
  { width: number; height: number }
> = {
  "16:9": { width: 1280, height: 720 },
  "9:16": { width: 400, height: 720 },
};
const FIRST_GENERATION_SEED = 42;

export function mergeHistoryItems(
  optimistic: readonly CameraTrajectoryHistoryItem[],
  persisted: readonly CameraTrajectoryHistoryItem[],
): CameraTrajectoryHistoryItem[] {
  const byIteration = new Map<string, CameraTrajectoryHistoryItem>();
  for (const item of [...optimistic, ...persisted]) {
    const current = byIteration.get(item.iteration_id);
    if (!current) {
      byIteration.set(item.iteration_id, {
        ...item,
        variants: visibleHistoryVariants(item.variants),
      });
      continue;
    }
    byIteration.set(item.iteration_id, {
      ...current,
      ...item,
      submitted_at: Math.max(current.submitted_at, item.submitted_at),
      variants: visibleHistoryVariants([...current.variants, ...item.variants]),
    });
  }
  return [...byIteration.values()].sort(
    (left, right) => right.submitted_at - left.submitted_at,
  );
}

function visibleHistoryVariants(
  variants: readonly CameraTrajectoryHistoryVariant[],
): CameraTrajectoryHistoryVariant[] {
  const byJob = new Map<string, CameraTrajectoryHistoryVariant>();
  for (const variant of variants) {
    const existing = byJob.get(variant.job_id);
    if (!existing || variant.submitted_at > existing.submitted_at) {
      byJob.set(variant.job_id, {
        ...variant,
        starred: variant.starred || existing?.starred || false,
      });
    } else if (variant.starred && !existing.starred) {
      byJob.set(variant.job_id, { ...existing, starred: true });
    }
  }

  const visibleByJob = new Map(
    [...byJob.values()]
      .filter((variant) => variant.starred)
      .map((variant) => [variant.job_id, variant]),
  );
  const newestBySeed = new Map<string, CameraTrajectoryHistoryVariant>();
  for (const variant of byJob.values()) {
    const key =
      variant.seed === null ? `job:${variant.job_id}` : `seed:${variant.seed}`;
    const aspectKey = `${variant.aspect_ratio}:${key}`;
    const existing = newestBySeed.get(aspectKey);
    if (!existing || variant.submitted_at > existing.submitted_at) {
      newestBySeed.set(aspectKey, variant);
    }
  }
  for (const variant of newestBySeed.values()) {
    visibleByJob.set(variant.job_id, variant);
  }
  return [...visibleByJob.values()];
}

export function generationSeeds(seedCount: number): number[] {
  const count = Math.min(
    MAX_SEED_COUNT,
    Math.max(MIN_SEED_COUNT, Math.round(seedCount)),
  );
  return Array.from(
    { length: count },
    (_, index) => FIRST_GENERATION_SEED + index,
  );
}

export function cameraTrajectoryCfgLabel(cfg: number | undefined): string {
  return (cfg ?? DEFAULT_CFG).toFixed(1);
}

export function cameraTrajectoryTimeLabel(
  freezeTime: boolean | undefined,
): "Frozen" | "Moving" {
  return (freezeTime ?? DEFAULT_FREEZE_TIME) ? "Frozen" : "Moving";
}

export function favoriteHistoryItems(
  items: readonly CameraTrajectoryHistoryItem[],
): CameraTrajectoryHistoryItem[] {
  return items
    .flatMap((item) => {
      const variants = item.variants.filter((variant) => variant.starred);
      if (variants.length === 0) return [];
      const newest = variants.reduce((current, variant) =>
        variant.submitted_at > current.submitted_at ? variant : current,
      );
      return [
        {
          ...item,
          submitted_at: newest.submitted_at,
          prompt: newest.prompt ?? item.prompt,
          target_frame_count:
            newest.target_frame_count ?? item.target_frame_count,
          fps: newest.fps ?? item.fps,
          aspect_ratio: newest.aspect_ratio,
          variants,
        },
      ];
    })
    .sort((left, right) => right.submitted_at - left.submitted_at);
}

export function applyGenerationStarOverrides(
  items: readonly CameraTrajectoryHistoryItem[],
  overrides: ReadonlyMap<string, boolean>,
): CameraTrajectoryHistoryItem[] {
  return items.map((item) => {
    let changed = false;
    const variants = item.variants.map((variant) => {
      const starred = overrides.get(variant.job_id);
      if (starred === undefined || starred === variant.starred) return variant;
      changed = true;
      return { ...variant, starred };
    });
    return changed ? { ...item, variants } : item;
  });
}

export function applyDraftStarOverrides(
  drafts: readonly CameraTrajectoryDraftSummary[],
  overrides: ReadonlyMap<string, boolean>,
): CameraTrajectoryDraftSummary[] {
  return drafts.map((draft) => {
    const starred = overrides.get(draft.draft_id);
    return starred === undefined || starred === draft.starred
      ? draft
      : { ...draft, starred };
  });
}

export function removeHistoryJob(
  items: readonly CameraTrajectoryHistoryItem[],
  jobId: string,
): CameraTrajectoryHistoryItem[] {
  return items.flatMap((item) => {
    const variants = item.variants.filter(
      (variant) => variant.job_id !== jobId,
    );
    return variants.length > 0 ? [{ ...item, variants }] : [];
  });
}

export function cameraTrajectoryDownloadName({
  prompt,
  iterationId,
  jobId,
  seed,
  frameCount,
  fps,
  aspectRatio,
}: {
  prompt: string;
  iterationId: string;
  jobId: string;
  seed: number | null;
  frameCount: number;
  fps: number;
  aspectRatio: CameraTrajectoryAspectRatio;
}): string {
  const sceneName =
    prompt
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(0, 48)
      .replace(/-+$/g, "") || "scene";
  const aspectName = aspectRatio.replace(":", "x");
  return `${sceneName}--iteration-${iterationId}--seed-${seed ?? "unknown"}--job-${jobId}--${aspectName}--${frameCount}frames-${fps}fps.mp4`;
}


type SidebarTab = "path" | "camera" | "video";

export function CameraTrajectoryPage({
  toolbarContainer,
  getToken,
  canViewHistory,
  beforePrepare,
  beforeGenerate,
}: {
  toolbarContainer: HTMLDivElement | null;
  getToken: GetToken;
  canViewHistory: boolean;
  beforePrepare: () => boolean;
  beforeGenerate: () => boolean;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const poseAbort = useRef<AbortController | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const pastedImageLoader = useRef<(file: File) => void>(() => undefined);
  const { theme } = useStudioTheme();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [poseBlob, setPoseBlob] = useState<Blob | null>(null);
  const [pose, setPose] = useState<PosedView | null>(null);
  const [poseElapsed, setPoseElapsed] = useState(0);
  const [posing, setPosing] = useState(false);
  const [keyframes, setKeyframes] = useState<CameraKeyframe[]>([]);
  const [aimMode, setAimMode] = useState<CameraAimMode>("free");
  const [aimTarget, setAimTarget] = useState<TrajectoryPoint | null>(null);
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const [pendingPose, setPendingPose] = useState<PilotPose | null>(null);
  const [piloting, setPiloting] = useState(false);
  const [autoKey, setAutoKey] = useState(true);
  const [timeUnit, setTimeUnit] = useState<TimeUnit>("seconds");
  const [previewFill, setPreviewFill] = useState(true);
  const [placingTarget, setPlacingTarget] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [frameCount, setFrameCount] = useState(DEFAULT_FRAME_COUNT);
  const [fps, setFps] = useState(DEFAULT_FPS);
  const [seedCount, setSeedCount] = useState(DEFAULT_SEED_COUNT);
  const [cfg, setCfg] = useState(DEFAULT_CFG);
  const [freezeTime, setFreezeTime] = useState(DEFAULT_FREEZE_TIME);
  const [allowBelowFloor, setAllowBelowFloor] = useState(false);
  const [targetFovDegrees, setTargetFovDegrees] = useState(50);
  const [aspectRatio, setAspectRatio] =
    useState<CameraTrajectoryAspectRatio>(DEFAULT_ASPECT_RATIO);
  const [moveAmount, setMoveAmount] = useState(0.25);
  const [monitorExpanded, setMonitorExpanded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [restoringDraftId, setRestoringDraftId] = useState<string | null>(null);
  const [optimisticQueue, setOptimisticQueue] = useState<
    CameraTrajectoryHistoryItem[]
  >([]);
  const [removedGenerationIds, setRemovedGenerationIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [homeOpen, setHomeOpen] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("camera");
  const [error, setError] = useState<string | null>(null);
  const [playhead] = useState(() =>
    createPlayhead(DEFAULT_FRAME_COUNT - 1, DEFAULT_FPS),
  );
  const targetFormat = TARGET_FORMATS[aspectRatio];
  const fovRadians = THREE.MathUtils.degToRad(targetFovDegrees);
  const lastFrame = frameCount - 1;

  useEffect(() => playhead.configure(frameCount - 1, fps), [fps, frameCount, playhead]);
  useEffect(() => () => playhead.pause(), [playhead]);

  const history = useQuery({
    queryKey: ["camera-trajectory-history", getToken.storageScope],
    queryFn: () => getCameraTrajectoryHistory(getToken),
    enabled: historyOpen && canViewHistory,
    refetchInterval: historyOpen && canViewHistory ? 10_000 : false,
    refetchOnWindowFocus: false,
  });
  const drafts = useQuery({
    queryKey: ["camera-trajectory-drafts", getToken.storageScope],
    queryFn: () => getCameraTrajectoryDrafts(getToken),
    enabled: historyOpen,
    refetchOnWindowFocus: false,
  });
  const queueItems = useMemo(() => {
    const merged = mergeHistoryItems(
      optimisticQueue,
      history.data?.items ?? [],
    );
    return [...removedGenerationIds].reduce(
      (current, jobId) => removeHistoryJob(current, jobId),
      merged,
    );
  }, [history.data?.items, optimisticQueue, removedGenerationIds]);
  const pendingGenerations = queueItems.filter((item) =>
    item.variants.some((variant) => variant.video_uri === null),
  ).length;

  useEffect(
    () => () => {
      poseAbort.current?.abort();
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    },
    [],
  );

  const referenceView = useMemo<CameraView | null>(
    () =>
      pose
        ? {
            id: "reference",
            position: pose.camera.extrinsics.position,
            quaternion: pose.camera.extrinsics.quaternion,
            fovRadians: verticalFov(pose.camera.intrinsics),
          }
        : null,
    [pose],
  );
  const sceneTarget = useMemo(
    () =>
      referenceView && pose
        ? cameraPathTarget(referenceView, pose.centroidWorld)
        : null,
    [pose, referenceView],
  );
  const trajectoryMap = useMemo(
    () => (pose ? buildTrajectoryMap(pose) : null),
    [pose],
  );
  const effectiveAimTarget =
    aimMode === "look_at" ? (aimTarget ?? pose?.centroidWorld ?? null) : null;
  const curve = useMemo(
    () =>
      createShotCurve(keyframes, {
        aimMode,
        aimTarget: effectiveAimTarget,
        allowBelowFloor,
      }),
    [aimMode, allowBelowFloor, effectiveAimTarget, keyframes],
  );
  const sortedKeys = curve.keyframes;
  const hasMotion = shotHasMotion(sortedKeys);

  function sourcePose(): PilotPose | null {
    if (!referenceView) return null;
    return poseFromView(referenceView);
  }

  function resetShotState() {
    playhead.pause();
    playhead.setFrame(0);
    setPendingPose(null);
    setPiloting(false);
    setPlacingTarget(false);
  }

  async function loadImage(
    file: File,
    restoredDraft?: CameraTrajectoryDraftDetails,
    example = false,
  ) {
    if (!file.type.startsWith("image/")) {
      setError("Choose an image file.");
      return;
    }

    const isExample = example || restoredDraft?.depth_uri === EXAMPLE_DEPTH;
    if (!isExample && !beforePrepare()) return;
    if (!isExample) {
      try {
        sessionStorage.removeItem(EXAMPLE_HANDOFF);
      } catch {}
    }
    setHomeOpen(false);

    poseAbort.current?.abort();
    const controller = new AbortController();
    poseAbort.current = controller;

    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    const nextPreviewUrl = isExample
      ? EXAMPLE_IMAGE
      : URL.createObjectURL(file);
    previewUrlRef.current = nextPreviewUrl;
    setPreviewUrl(nextPreviewUrl);
    setFileName(file.name);
    setPoseBlob(null);
    setPose(null);
    setKeyframes([]);
    setSelectedKeyId(null);
    resetShotState();
    setPrompt(restoredDraft?.prompt ?? "");
    setAimMode("free");
    setAimTarget(null);
    setAllowBelowFloor(
      restoredDraft?.allow_below_floor === true ||
        (restoredDraft?.keyframes ?? []).some((key) => key.position[1] < 0) ||
        (restoredDraft?.segments ?? []).some((segment) =>
          segment.points.some((point) => point[1] < TRAJECTORY_FLOOR_Y),
        ),
    );
    setError(null);
    setNotice(null);
    setPoseElapsed(0);
    setPosing(true);

    try {
      const blob = isExample
        ? await fetch(EXAMPLE_IMAGE, { signal: controller.signal }).then(
            (response) => {
              if (!response.ok)
                throw new Error("Could not load the example image.");
              return response.blob();
            },
          )
        : restoredDraft
          ? file
          : await fileToPoseBlob(file);
      const nextPose = isExample
        ? await loadExamplePose(controller.signal)
        : restoredDraft
          ? {
              imageUrl: restoredDraft.reference_image_base64,
              camera: restoredDraft.reference_camera,
              points: await loadDepthPointCloud(
                getToken,
                restoredDraft.depth_uri,
                restoredDraft.reference_camera.intrinsics,
                { signal: controller.signal },
              ),
              depthUri: restoredDraft.depth_uri,
              centroidWorld: restoredDraft.centroid_world,
            }
          : (
              await posePointClouds(getToken, [blob], {
                signal: controller.signal,
                onTick: setPoseElapsed,
              })
            )[0];
      if (!nextPose) throw new Error("No scene was returned");
      if (controller.signal.aborted) return;

      const restoredTargetFov =
        restoredDraft?.target_fov_degrees ??
        (restoredDraft?.target_cameras[0]
          ? THREE.MathUtils.radToDeg(
              verticalFov(restoredDraft.target_cameras[0].intrinsics),
            )
          : THREE.MathUtils.radToDeg(verticalFov(nextPose.camera.intrinsics)));
      const nextFov = THREE.MathUtils.clamp(
        Math.round(restoredTargetFov),
        MIN_TARGET_FOV_DEGREES,
        MAX_TARGET_FOV_DEGREES,
      );
      const reference: CameraView = {
        id: "reference",
        position: nextPose.camera.extrinsics.position,
        quaternion: nextPose.camera.extrinsics.quaternion,
        fovRadians: THREE.MathUtils.degToRad(nextFov),
      };
      let nextKeys: CameraKeyframe[] = keyframesFromPoses(
        [poseFromView(reference)],
        DEFAULT_FRAME_COUNT,
      );
      let nextAim: CameraAimMode = "free";
      let nextTarget: TrajectoryPoint | null = null;
      let restoredNotice: string | null = null;

      if (isExample && !restoredDraft) {
        // A gentle arc around the igloo shows off moving well off-axis.
        const center = cameraPathTarget(reference, nextPose.centroidWorld);
        const move = createCameraMove("arc", reference, center, 0.45, false);
        nextKeys = keyframesFromPoses(
          [0, 2, 4].map((index) =>
            poseFromView(
              cameraViewLookingAt("key", move.points[index]!, center, 1),
            ),
          ),
          DEFAULT_FRAME_COUNT,
        );
        nextAim = "look_at";
        nextTarget = center;
        setPrompt(
          "A smooth cinematic camera move around the cozy igloo. Preserve the scene and its lighting.",
        );
      }
      if (restoredDraft) {
        const savedKeys = restoredDraft.keyframes?.filter(isCameraKeyframe);
        if (savedKeys && savedKeys.length > 0) {
          nextKeys = sortKeyframes(savedKeys);
          nextAim = restoredDraft.aim_mode ?? "free";
          nextTarget = restoredDraft.aim_target ?? null;
          restoredNotice = "Draft reopened.";
        } else if (restoredDraft.segments?.length) {
          const legacyMode = restoredDraft.direction_mode;
          const legacyTarget =
            restoredDraft.direction_target ??
            (legacyMode && legacyMode !== "manual" && legacyMode !== "forward"
              ? nextPose.centroidWorld
              : null);
          const converted = keyframesFromLegacySegments(
            materializeTrajectorySmoothing(
              restoredDraft.segments,
              restoredDraft.trajectory_smoothing_version ?? 0,
            ).segments,
            reference,
            DEFAULT_FRAME_COUNT,
            {
              directionMode:
                legacyMode === "inward"
                  ? "look_at"
                  : legacyMode === "outward"
                    ? "look_away"
                    : (legacyMode ?? "manual"),
              directionTarget: legacyTarget,
              closedLoop: restoredDraft.closed_loop ?? false,
              allowBelowFloor: restoredDraft.allow_below_floor ?? false,
            },
          );
          if (converted.keyframes.length) nextKeys = converted.keyframes;
          nextAim = converted.aimMode;
          nextTarget = converted.aimMode === "look_at" ? legacyTarget : null;
          restoredNotice =
            "Draft reopened. Its cameras are now keys on the timeline.";
        }
        setFrameCount(DEFAULT_FRAME_COUNT);
        setFps(DEFAULT_FPS);
        setSeedCount(DEFAULT_SEED_COUNT);
        setCfg(restoredDraft.cfg ?? DEFAULT_CFG);
        setFreezeTime(restoredDraft.freeze_time ?? DEFAULT_FREEZE_TIME);
        setAspectRatio(restoredDraft.aspect_ratio);
      }

      setPose(nextPose);
      setPoseBlob(blob);
      setTargetFovDegrees(nextFov);
      setKeyframes(nextKeys);
      setAimMode(nextAim);
      setAimTarget(nextTarget);
      setSelectedKeyId(nextKeys[0]?.id ?? null);
      setSidebarTab(nextKeys.length < 2 ? "camera" : "path");
      setNotice(restoredNotice);
    } catch (caught) {
      if (controller.signal.aborted) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (!controller.signal.aborted) setPosing(false);
    }
  }

  function loadExample(draft?: CameraTrajectoryDraftDetails) {
    return loadImage(
      new File([], "Igloo example", { type: "image/jpeg" }),
      draft,
      true,
    );
  }

  // Only this public sample crosses the sign-in remount. Private scenes remain
  // account-scoped, and a new upload clears the sample handoff.
  useEffect(() => {
    let draft: CameraTrajectoryDraftDetails | undefined;
    try {
      const saved = JSON.parse(
        sessionStorage.getItem(EXAMPLE_HANDOFF) || "null",
      );
      if (
        saved?.depth_uri === EXAMPLE_DEPTH &&
        (Array.isArray(saved.keyframes) || Array.isArray(saved.segments))
      )
        draft = saved;
    } catch {}
    if (
      !draft &&
      new URLSearchParams(location.search).get("example") !== "igloo"
    )
      return;
    const timer = setTimeout(() => {
      void loadExample(draft).then(() => {
        if (canViewHistory) {
          try {
            sessionStorage.removeItem(EXAMPLE_HANDOFF);
          } catch {}
        }
      });
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (canViewHistory || pose?.depthUri !== EXAMPLE_DEPTH || posing) return;
    try {
      sessionStorage.setItem(
        EXAMPLE_HANDOFF,
        JSON.stringify({
          draft_id: "example",
          saved_at: Date.now() / 1000,
          file_name: "Igloo example",
          depth_uri: EXAMPLE_DEPTH,
          centroid_world: pose.centroidWorld,
          reference_camera: pose.camera,
          reference_image_base64: pose.imageUrl,
          keyframes,
          aim_mode: aimMode,
          aim_target: aimTarget,
          target_cameras: [],
          prompt,
          frame_count: frameCount,
          fps,
          seed_count: seedCount,
          cfg,
          freeze_time: freezeTime,
          target_fov_degrees: targetFovDegrees,
          aspect_ratio: aspectRatio,
          allow_below_floor: allowBelowFloor,
        } satisfies CameraTrajectoryDraftDetails),
      );
    } catch {
      /* Storage can be unavailable; the editor still works. */
    }
  }, [
    canViewHistory,
    pose,
    posing,
    keyframes,
    aimMode,
    aimTarget,
    prompt,
    frameCount,
    fps,
    seedCount,
    cfg,
    freezeTime,
    targetFovDegrees,
    aspectRatio,
    allowBelowFloor,
  ]);

  pastedImageLoader.current = (file) => void loadImage(file);

  useEffect(() => {
    const pasteImage = (event: ClipboardEvent) => {
      const clipboardImage = Array.from(event.clipboardData?.items ?? [])
        .find((item) => item.kind === "file" && item.type.startsWith("image/"))
        ?.getAsFile();
      if (!clipboardImage) return;
      event.preventDefault();
      const file = clipboardImage.name
        ? clipboardImage
        : new File([clipboardImage], "pasted-image.png", {
            type: clipboardImage.type,
          });
      pastedImageLoader.current(file);
    };
    window.addEventListener("paste", pasteImage);
    return () => window.removeEventListener("paste", pasteImage);
  }, []);

  function goHome() {
    playhead.pause();
    setPiloting(false);
    setHistoryOpen(false);
    setHomeOpen(true);
  }

  /** Target cameras for generation, or an explanation of what is missing. */
  function shotCameras(): PinholeCamera[] {
    if (sortedKeys.length < 2 || !hasMotion)
      throw new Error("Set at least two different keys before generating.");
    if (effectiveAimTarget) {
      const clearance = Math.max(
        0.02,
        (trajectoryMap?.space.radius ?? 1) * 0.015,
      );
      for (let frame = 0; frame < frameCount; frame++) {
        const [x, y, z] = curve.positionAt(frame);
        if (
          Math.hypot(
            x - effectiveAimTarget[0],
            y - effectiveAimTarget[1],
            z - effectiveAimTarget[2],
          ) < clearance
        )
          throw new Error(
            "The camera passes through its look target. Move the target or the path before generating.",
          );
      }
    }
    return buildShotTargetCameras(
      curve,
      frameCount,
      targetFormat.width,
      targetFormat.height,
      fovRadians,
    );
  }

  function draftInput(referenceImage: {
    image_base64: string;
    camera: PinholeCamera;
  }, targetCameras: PinholeCamera[], trimmedPrompt: string): SaveCameraTrajectoryDraft {
    return {
      file_name: fileName || "reference-image.png",
      depth_uri: pose!.depthUri,
      centroid_world: pose!.centroidWorld,
      reference_image: referenceImage,
      keyframes: [...sortedKeys],
      aim_mode: aimMode,
      aim_target: aimMode === "look_at" ? effectiveAimTarget : null,
      target_cameras: targetCameras,
      prompt: trimmedPrompt,
      frame_count: frameCount,
      fps,
      seed_count: seedCount,
      cfg,
      freeze_time: freezeTime,
      target_fov_degrees: targetFovDegrees,
      aspect_ratio: aspectRatio,
      allow_below_floor: allowBelowFloor,
    };
  }

  function contextCamera(): PinholeCamera {
    return {
      intrinsics: pose!.camera.intrinsics,
      extrinsics: {
        ...pose!.camera.extrinsics,
        coordinateSystem: "rub",
      },
    };
  }

  async function generate() {
    if (!beforeGenerate()) return;
    if (!PORTRAIT_GENERATION_ENABLED && aspectRatio === "9:16") {
      setError(
        "9:16 generation is temporarily unavailable. Switch to 16:9.",
      );
      return;
    }
    if (!pose || !poseBlob || !prompt.trim() || submitting || savingDraft)
      return;
    playhead.pause();
    setPiloting(false);
    setSubmitting(true);
    setError(null);
    setNotice(null);
    let savedDraftId: string | null = null;

    try {
      const targetCameras = shotCameras();
      const referenceImage = {
        image_base64: await blobToDataUrl(poseBlob),
        camera: contextCamera(),
      };
      const submittedAt = Date.now() / 1000;
      const submittedPrompt = prompt.trim();
      const seeds = generationSeeds(seedCount);
      const savedDraft = await saveCameraTrajectoryDraft(
        getToken,
        draftInput(referenceImage, targetCameras, submittedPrompt),
      );
      savedDraftId = savedDraft.draft_id;
      const results = await Promise.allSettled(
        seeds.map((seed) =>
          submitCameraTrajectory(
            getToken,
            referenceImage,
            targetCameras,
            savedDraft.draft_id,
            submittedPrompt,
            fps,
            seed,
          ),
        ),
      );
      const queued: CameraTrajectoryHistoryVariant[] = results.flatMap(
        (result, index) =>
          result.status === "fulfilled"
            ? [
                {
                  ...result.value,
                  submitted_at: submittedAt + index / 1000,
                  seed: seeds[index]!,
                  prompt: submittedPrompt,
                  target_frame_count: frameCount,
                  fps,
                  cfg,
                  freeze_time: freezeTime,
                  aspect_ratio: aspectRatio,
                  video_uri: null,
                  starred: false,
                },
              ]
            : [],
      );
      if (queued.length > 0) {
        setOptimisticQueue((current) => [
          {
            iteration_id: savedDraft.draft_id,
            submitted_at: submittedAt,
            prompt: submittedPrompt,
            target_frame_count: frameCount,
            fps,
            aspect_ratio: aspectRatio,
            variants: queued,
          },
          ...current,
        ]);
      }
      if (queued.length === seeds.length) {
        setNotice(
          `Scene saved. ${seeds.length === 1 ? "Your video is" : `${seeds.length} videos are`} generating. Check Saved for the result.`,
        );
      } else if (queued.length > 0) {
        setError(
          `Scene ${savedDraftId} saved. Queued ${queued.length} of ${seeds.length} versions. Try Generate again.`,
        );
      } else {
        const failure = results.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        throw failure?.reason ?? new Error("Could not queue the generations");
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(
        savedDraftId
          ? `${message} Scene ${savedDraftId} is saved.`
          : `Scene was not saved, so no videos were queued. ${message}`,
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function saveDraft() {
    if (!pose || !poseBlob || !referenceView || savingDraft || submitting)
      return;
    setSavingDraft(true);
    setError(null);
    setNotice(null);
    try {
      let targetCameras: PinholeCamera[] = [];
      try {
        targetCameras = shotCameras();
      } catch {
        /* An unfinished shot still saves; it just has no cameras yet. */
      }
      const saved = await saveCameraTrajectoryDraft(
        getToken,
        draftInput(
          { image_base64: await blobToDataUrl(poseBlob), camera: contextCamera() },
          targetCameras,
          prompt.trim(),
        ),
      );
      setNotice(`Draft ${saved.draft_id} saved without generation.`);
      setHistoryOpen(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSavingDraft(false);
    }
  }

  async function openDraft(draftId: string) {
    if (restoringDraftId) return;
    setRestoringDraftId(draftId);
    setError(null);
    try {
      const draft = await getCameraTrajectoryDraft(getToken, draftId);
      const imageBlob = await fetch(draft.reference_image_base64).then(
        (response) => response.blob(),
      );
      const file = new File([imageBlob], draft.file_name, {
        type: imageBlob.type || "image/png",
      });
      setHistoryOpen(false);
      await loadImage(file, draft);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRestoringDraftId(null);
    }
  }

  function removeOptimisticGeneration(jobId: string) {
    setOptimisticQueue((current) => removeHistoryJob(current, jobId));
    setRemovedGenerationIds((current) => new Set(current).add(jobId));
  }

  const ready = pose && referenceView && trajectoryMap;
  const editSnapshot = useMemo(
    () => ({
      keyframes,
      aimMode,
      aimTarget,
      allowBelowFloor,
      targetFovDegrees,
    }),
    [keyframes, aimMode, aimTarget, allowBelowFloor, targetFovDegrees],
  );
  const edits = useEditHistory(editSnapshot, pose?.depthUri ?? null, (state) => {
    setKeyframes(state.keyframes);
    setAimMode(state.aimMode);
    setAimTarget(state.aimTarget);
    setAllowBelowFloor(state.allowBelowFloor);
    setTargetFovDegrees(state.targetFovDegrees);
    setPendingPose(null);
    setPlacingTarget(false);
    setError(null);
    setNotice(null);
  });

  // An unkeyed change belongs to the frame it was made on.
  const pendingFrame = useRef<number | null>(null);
  useEffect(
    () =>
      playhead.subscribe(() => {
        if (
          pendingFrame.current !== null &&
          Math.round(playhead.frame) !== pendingFrame.current
        ) {
          pendingFrame.current = null;
          setPendingPose(null);
        }
      }),
    [playhead],
  );

  function editKeys(next: CameraKeyframe[]) {
    setKeyframes(next);
    setPendingPose(null);
    pendingFrame.current = null;
    setError(null);
  }

  function keyPose(pose: PilotPose, select = true) {
    const frame = Math.round(playhead.frame);
    playhead.setFrame(frame);
    const result = upsertKeyframe(keyframes, frame, pose);
    editKeys(result.keyframes);
    if (select) setSelectedKeyId(result.id);
  }

  /** A camera change at the playhead: key it, or hold it until Set key. */
  function changePoseAtPlayhead(pose: PilotPose) {
    const frame = Math.round(playhead.frame);
    if (autoKey || (playhead.frame === frame && keyframeAt(keyframes, frame))) {
      keyPose(pose);
      return;
    }
    playhead.setFrame(frame);
    pendingFrame.current = frame;
    setPendingPose(pose);
  }

  function setKeyAtPlayhead() {
    if (pendingPose) {
      keyPose(pendingPose);
      return;
    }
    const current = keyframes.length
      ? curve.poseAt(playhead.frame)
      : sourcePose();
    if (!current) return;
    keyPose({
      position: [...current.position],
      yaw: current.yaw,
      pitch: current.pitch,
    });
  }

  function toggleKeyAtPlayhead() {
    const frame = Math.round(playhead.frame);
    const existing =
      playhead.frame === frame ? keyframeAt(keyframes, frame) : null;
    if (existing && !pendingPose) deleteKey(existing.id);
    else setKeyAtPlayhead();
  }

  function deleteKey(id: string) {
    if (keyframes.length <= 1) return;
    const next = keyframes.filter((key) => key.id !== id);
    editKeys(next);
    if (selectedKeyId === id) setSelectedKeyId(null);
  }

  function selectKey(id: string) {
    const key = keyframes.find((candidate) => candidate.id === id);
    if (!key) return;
    playhead.pause();
    playhead.setFrame(key.frame);
    setSelectedKeyId(id);
  }

  function jumpKey(direction: -1 | 1) {
    playhead.pause();
    const frame = playhead.frame;
    const target =
      direction < 0
        ? [...sortedKeys].reverse().find((key) => key.frame < frame - 0.01)
        : sortedKeys.find((key) => key.frame > frame + 0.01);
    if (target) {
      playhead.setFrame(target.frame);
      setSelectedKeyId(target.id);
    }
  }

  function moveKey(id: string, position: TrajectoryPoint) {
    editKeys(
      keyframes.map((key) => (key.id === id ? { ...key, position } : key)),
    );
  }

  function moveLiveCamera(position: TrajectoryPoint) {
    const current = curve.poseAt(playhead.frame);
    const frame = Math.round(playhead.frame);
    if (!autoKey && !keyframeAt(keyframes, frame)) {
      setNotice(
        "Turn on Auto key to record a key by dragging, or pilot the camera and press Set key.",
      );
      return;
    }
    keyPose({ position, yaw: current.yaw, pitch: current.pitch });
  }

  function startPilot() {
    if (!ready) return;
    playhead.pause();
    if (playhead.frame !== Math.round(playhead.frame))
      playhead.setFrame(Math.round(playhead.frame));
    if (keyframes.length === 0) {
      const source = sourcePose();
      if (source) editKeys(keyframesFromPoses([source], frameCount));
    }
    setPlacingTarget(false);
    setMonitorExpanded(false);
    setPiloting(true);
    setNotice(null);
  }

  function applyPreset(preset: CameraMovePreset) {
    if (!referenceView || !sceneTarget) return;
    const move = createCameraMove(
      preset,
      { ...referenceView, fovRadians },
      sceneTarget,
      moveAmount,
      allowBelowFloor,
    );
    const next = keyframesFromPoses(
      [0, 2, 4].map((index) =>
        poseFromView({
          position: move.points[index]!,
          quaternion: move.quaternions![index]!,
        }),
      ),
      frameCount,
    );
    editKeys(next);
    setAimMode("free");
    setSelectedKeyId(next[0]!.id);
    playhead.pause();
    playhead.setFrame(0);
    setNotice("Camera move applied. Press play, or pilot the camera to adjust a key.");
  }

  function applySketch(route: [number, number][]) {
    if (!sceneTarget || route.length < 2) return;
    const lengths = [0];
    for (let i = 1; i < route.length; i++)
      lengths.push(
        lengths.at(-1)! +
          Math.hypot(
            route[i]![0] - route[i - 1]![0],
            route[i]![1] - route[i - 1]![1],
          ),
      );
    const total = lengths.at(-1)!;
    if (total <= 1e-3) return;
    const count = total > (trajectoryMap?.space.radius ?? 1) * 1.2 ? 4 : 3;
    const height = sortedKeys[0]?.position[1] ?? referenceView!.position[1];
    const poses = Array.from({ length: count }, (_, index) => {
      const distance = (index / (count - 1)) * total;
      let i = 1;
      while (i < lengths.length - 1 && lengths[i]! < distance) i++;
      const span = lengths[i]! - lengths[i - 1]! || 1;
      const t = (distance - lengths[i - 1]!) / span;
      const a = route[i - 1]!;
      const b = route[i]!;
      const position: TrajectoryPoint = [
        a[0] + (b[0] - a[0]) * t,
        height,
        a[1] + (b[1] - a[1]) * t,
      ];
      return poseFromView(cameraViewLookingAt("key", position, sceneTarget, 1));
    });
    const next = spaceKeyframesEvenly(keyframesFromPoses(poses, frameCount), frameCount);
    editKeys(next);
    setSelectedKeyId(next[0]!.id);
    setNotice("Route sketched into keys. Drag them to adjust.");
  }

  function resetShot() {
    const source = sourcePose();
    if (!source) return;
    const next = keyframesFromPoses([source], frameCount);
    editKeys(next);
    setSelectedKeyId(next[0]!.id);
    setAimMode("free");
    playhead.pause();
    playhead.setFrame(0);
    setSidebarTab("camera");
  }

  function chooseAimMode(mode: CameraAimMode) {
    if (mode === aimMode) return;
    // Keep the shot looking the same by baking the current aim into the keys.
    const baked = keyframes.map((key) => {
      const aim = curve.poseAt(key.frame);
      return { ...key, yaw: aim.yaw, pitch: aim.pitch };
    });
    editKeys(baked);
    setAimMode(mode);
    if (mode === "look_at" && !aimTarget && pose) setAimTarget(pose.centroidWorld);
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !ready ||
        homeOpen ||
        historyOpen ||
        submitting ||
        savingDraft ||
        event.isComposing
      )
        return;
      const target = event.target instanceof Element ? event.target : null;
      if (
        target?.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="dialog"]',
        )
      )
        return;
      const key = event.key.toLowerCase();
      const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
      if ((event.metaKey || event.ctrlKey) && key === "z") {
        event.preventDefault();
        if (event.shiftKey) edits.redo();
        else edits.undo();
      } else if (event.ctrlKey && key === "y") {
        event.preventDefault();
        edits.redo();
      } else if (!plain) {
        return;
      } else if (key === " " && !target?.closest("button")) {
        event.preventDefault();
        playhead.toggle();
      } else if (key === "i" && !event.repeat) {
        event.preventDefault();
        setKeyAtPlayhead();
      } else if (key === "escape") {
        if (piloting) setPiloting(false);
        else if (monitorExpanded) setMonitorExpanded(false);
      } else if (key === "c" && !piloting && !placingTarget) {
        startPilot();
      } else if (piloting || placingTarget) {
        return;
      } else if ((key === "delete" || key === "backspace") && selectedKeyId) {
        event.preventDefault();
        deleteKey(selectedKeyId);
      } else if (key === "arrowleft" || key === "arrowright") {
        event.preventDefault();
        playhead.pause();
        const step = key === "arrowleft" ? -1 : 1;
        playhead.setFrame(
          event.shiftKey
            ? step < 0
              ? 0
              : lastFrame
            : Math.round(playhead.frame) + step,
        );
      } else if (key === "arrowup" || key === "arrowdown") {
        event.preventDefault();
        jumpKey(key === "arrowup" ? 1 : -1);
      } else if (key === "home" || key === "end") {
        event.preventDefault();
        playhead.pause();
        playhead.setFrame(key === "home" ? 0 : lastFrame);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const generateBlocker = !hasMotion
    ? "Set two keys"
    : !PORTRAIT_GENERATION_ENABLED && aspectRatio === "9:16"
      ? "9:16 unavailable"
      : !prompt.trim()
        ? "Add a prompt"
        : null;
  const generateLabel = submitting
    ? `Starting ${seedCount}…`
    : (generateBlocker ??
      `Generate ${seedCount === 1 ? "video" : `${seedCount} videos`}`);
  const canGenerate = !generateBlocker && !submitting && !savingDraft;

  return (
    <div className="camera-editor">
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void loadImage(file);
        }}
      />

      {!ready ? (
        <UploadScreen
          previewUrl={previewUrl}
          posing={posing}
          poseElapsed={poseElapsed}
          error={error}
          activeSceneName={null}
          onResume={null}
          onChoose={() => fileInput.current?.click()}
          onDrop={(file) => void loadImage(file)}
          onHistory={() => setHistoryOpen(true)}
          onExample={() => void loadExample()}
        />
      ) : (
        <div
          className="studio-workspace"
          data-tab={sidebarTab}
          aria-hidden={homeOpen}
          inert={homeOpen ? true : undefined}
        >
          {toolbarContainer &&
            !homeOpen &&
            createPortal(
              <div className="studio-toolbar">
                <button
                  type="button"
                  aria-label="Undo"
                  title="Undo (⌘Z / Ctrl+Z)"
                  disabled={!edits.canUndo || submitting || savingDraft}
                  onClick={edits.undo}
                  className="studio-icon-button hide-compact"
                >
                  <Undo2 className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  aria-label="Redo"
                  title="Redo (⌘⇧Z / Ctrl+Shift+Z)"
                  disabled={!edits.canRedo || submitting || savingDraft}
                  onClick={edits.redo}
                  className="studio-icon-button hide-compact"
                >
                  <Redo2 className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setHistoryOpen(true)}
                  aria-label="Saved scenes"
                  title="Saved scenes"
                  className="studio-button is-ghost"
                >
                  <HistoryIcon className="h-4 w-4" />
                  <span className="hide-compact">Saved</span>
                  {pendingGenerations > 0 && (
                    <span className="studio-count">{pendingGenerations}</span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={goHome}
                  aria-label="Home"
                  title="Home"
                  className="studio-icon-button"
                >
                  <House className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  className="studio-cta"
                  disabled={
                    submitting ||
                    savingDraft ||
                    (generateBlocker !== null && generateBlocker !== "Add a prompt")
                  }
                  title={generateBlocker ?? "Generate video"}
                  onClick={() => {
                    if (generateBlocker === "Add a prompt") {
                      setSidebarTab("video");
                      return;
                    }
                    void generate();
                  }}
                >
                  {submitting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                  <span className="hide-compact">{generateLabel}</span>
                </button>
              </div>,
              toolbarContainer,
            )}

          <aside className="studio-panel" aria-label="Shot tools">
            <span className="studio-sheet-grabber" aria-hidden />
            <div className="studio-tabs" role="tablist" aria-label="Shot tools">
              {(
                [
                  ["path", "Path", Route],
                  ["camera", "Camera", Camera],
                  ["video", "Video", Film],
                ] as const
              ).map(([tab, label, Icon]) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  id={`studio-tab-${tab}`}
                  aria-selected={sidebarTab === tab}
                  aria-controls={`studio-panel-${tab}`}
                  onClick={() => setSidebarTab(tab)}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              ))}
            </div>
            <div
              className="studio-panel-body"
              role="tabpanel"
              id={`studio-panel-${sidebarTab}`}
              aria-labelledby={`studio-tab-${sidebarTab}`}
            >
              {sidebarTab === "path" && (
                <PathPanel
                  imageUrl={previewUrl ?? pose.imageUrl}
                  fileName={fileName}
                  keyCount={sortedKeys.length}
                  travel={moveAmount}
                  allowBelowFloor={allowBelowFloor}
                  onReplaceImage={() => fileInput.current?.click()}
                  onPreset={applyPreset}
                  onTravelChange={setMoveAmount}
                  onEvenSpacing={() => editKeys(spaceKeyframesEvenly(keyframes, frameCount))}
                  onSmoothAll={() =>
                    editKeys(
                      keyframes.map((key) => ({
                        ...key,
                        interpolation: "smooth",
                        ease: null,
                      })),
                    )
                  }
                  onReset={resetShot}
                  onAllowBelowFloorChange={setAllowBelowFloor}
                  map={
                    <PlanMap
                      points={trajectoryMap.worldPoints}
                      colors={trajectoryMap.colors}
                      source={referenceView}
                      curve={curve}
                      playhead={playhead}
                      selectedKeyId={selectedKeyId}
                      aimTarget={effectiveAimTarget}
                      fovRadians={fovRadians}
                      frameAspect={targetFormat.width / targetFormat.height}
                      frameCount={frameCount}
                      fps={fps}
                      unit={timeUnit}
                      allowBelowFloor={allowBelowFloor}
                      onSelectKey={selectKey}
                      onMoveKey={moveKey}
                      onSketch={applySketch}
                    />
                  }
                />
              )}
              {sidebarTab === "camera" && (
                <CameraPanel
                  playhead={playhead}
                  curve={curve}
                  selectedKeyId={selectedKeyId}
                  pendingPose={pendingPose}
                  aimMode={aimMode}
                  aimTarget={effectiveAimTarget}
                  fovDegrees={targetFovDegrees}
                  minFov={MIN_TARGET_FOV_DEGREES}
                  maxFov={MAX_TARGET_FOV_DEGREES}
                  fps={fps}
                  frameCount={frameCount}
                  unit={timeUnit}
                  allowBelowFloor={allowBelowFloor}
                  onPilot={startPilot}
                  onToggleKey={toggleKeyAtPlayhead}
                  onSetPending={setKeyAtPlayhead}
                  onJumpKey={jumpKey}
                  onSelectKey={selectKey}
                  onPoseChange={changePoseAtPlayhead}
                  onAimModeChange={chooseAimMode}
                  onPickTarget={() => {
                    playhead.pause();
                    setPiloting(false);
                    setPlacingTarget(true);
                  }}
                  onCenterTarget={() => pose && setAimTarget(pose.centroidWorld)}
                  onInterpolationChange={(id, interpolation) =>
                    editKeys(
                      keyframes.map((key) =>
                        key.id === id ? { ...key, interpolation } : key,
                      ),
                    )
                  }
                  onEaseChange={(id, ease) =>
                    editKeys(
                      keyframes.map((key) =>
                        key.id === id ? { ...key, ease } : key,
                      ),
                    )
                  }
                  onGapChange={(index, frames) =>
                    editKeys(setKeyframeGap(keyframes, index, frames, frameCount))
                  }
                  onDeleteKey={deleteKey}
                  onFovChange={setTargetFovDegrees}
                  onGoToEnd={() => {
                    playhead.pause();
                    playhead.setFrame(lastFrame);
                  }}
                />
              )}
              {sidebarTab === "video" && (
                <VideoPanel
                  prompt={prompt}
                  seedCount={seedCount}
                  minSeeds={MIN_SEED_COUNT}
                  maxSeeds={MAX_SEED_COUNT}
                  firstSeed={FIRST_GENERATION_SEED}
                  aspectRatio={aspectRatio}
                  portraitEnabled={PORTRAIT_GENERATION_ENABLED}
                  frameCount={frameCount}
                  fps={fps}
                  frameWidth={targetFormat.width}
                  frameHeight={targetFormat.height}
                  keyCount={sortedKeys.length}
                  generateLabel={generateLabel}
                  canGenerate={canGenerate}
                  submitting={submitting}
                  savingDraft={savingDraft}
                  onPromptChange={setPrompt}
                  onSeedCountChange={setSeedCount}
                  onAspectRatioChange={setAspectRatio}
                  onGenerate={() => void generate()}
                  onSaveDraft={() => void saveDraft()}
                />
              )}
            </div>
          </aside>

          <main className="studio-stage">
            <CameraTrajectoryCanvas
              key={pose.imageUrl}
              pose={pose}
              referenceView={referenceView}
              curve={curve}
              playhead={playhead}
              selectedKeyId={selectedKeyId}
              fovRadians={fovRadians}
              frameWidth={targetFormat.width}
              frameHeight={targetFormat.height}
              aimMode={aimMode}
              aimTarget={effectiveAimTarget}
              allowBelowFloor={allowBelowFloor}
              theme={theme}
              fill={previewFill}
              sceneRadius={trajectoryMap.space.radius}
              piloting={piloting}
              pendingPose={pendingPose}
              targetCandidates={trajectoryMap.worldPoints}
              placingTarget={placingTarget}
              onKeySelect={selectKey}
              onKeyMove={moveKey}
              onLiveCameraMove={moveLiveCamera}
              onPilotPose={changePoseAtPlayhead}
              onPilotStart={startPilot}
              onPilotExit={() => setPiloting(false)}
              onSetKey={setKeyAtPlayhead}
              onTargetPick={(position) => {
                setAimTarget(position);
                setAimMode("look_at");
                setPlacingTarget(false);
                setError(null);
              }}
              onTargetCancel={() => {
                setPlacingTarget(false);
                setError(null);
              }}
              onTargetMiss={() =>
                setError("No scene point here. Choose a point on the visible scene.")
              }
            />

            {!piloting && !placingTarget && (
              <div className="studio-float studio-preview-style">
                <span>Preview</span>
                <div className="studio-seg is-small" role="group" aria-label="Preview style">
                  <button
                    type="button"
                    aria-pressed={previewFill}
                    title="Fill gaps the way the generated video will"
                    onClick={() => setPreviewFill(true)}
                  >
                    <Sparkles className="h-3 w-3" />
                    Filled
                  </button>
                  <button
                    type="button"
                    aria-pressed={!previewFill}
                    title="Show only the measured depth points"
                    onClick={() => setPreviewFill(false)}
                  >
                    Points
                  </button>
                </div>
              </div>
            )}

            {!piloting && sortedKeys.length > 0 && (
              <div
                className={`studio-monitor ${monitorExpanded ? "is-expanded" : ""}`}
                style={{ aspectRatio: `${targetFormat.width} / ${targetFormat.height}` }}
              >
                <ShotCameraView
                  pose={pose}
                  curve={curve}
                  playhead={playhead}
                  fovRadians={fovRadians}
                  theme={theme}
                  fill={previewFill}
                />
                <MonitorOverlay
                  playhead={playhead}
                  fps={fps}
                  frameCount={frameCount}
                  unit={timeUnit}
                  fill={previewFill}
                  expanded={monitorExpanded}
                  onToggleExpanded={() => setMonitorExpanded(!monitorExpanded)}
                />
              </div>
            )}

            {(error || notice) && (
              <div className="studio-toasts" aria-live="polite">
                {error && (
                  <div className="studio-toast is-error" role="alert">
                    <span>{error}</span>
                    <button type="button" aria-label="Dismiss" onClick={() => setError(null)}>
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
                {notice && (
                  <div className="studio-toast" role="status">
                    <span>{notice}</span>
                    <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}>
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </div>
            )}
          </main>

          <Timeline
            playhead={playhead}
            curve={curve}
            frameCount={frameCount}
            fps={fps}
            unit={timeUnit}
            selectedKeyId={selectedKeyId}
            autoKey={autoKey}
            onUnitChange={setTimeUnit}
            onAutoKeyChange={setAutoKey}
            onSelectKey={selectKey}
            onRetimeKey={(id, frame) => {
              const next = retimeKeyframe(keyframes, id, frame, frameCount);
              editKeys(next);
              const moved = next.find((key) => key.id === id);
              if (moved) playhead.setFrame(moved.frame);
            }}
            onToggleKey={toggleKeyAtPlayhead}
            onInterpolationChange={(id, interpolation) =>
              editKeys(
                keyframes.map((key) =>
                  key.id === id ? { ...key, interpolation } : key,
                ),
              )
            }
          />
        </div>
      )}

      {ready && homeOpen && (
        <div className="studio-home-overlay">
          <UploadScreen
            previewUrl={previewUrl}
            posing={false}
            poseElapsed={poseElapsed}
            error={error}
            activeSceneName={fileName}
            onResume={() => setHomeOpen(false)}
            onChoose={() => fileInput.current?.click()}
            onDrop={(file) => void loadImage(file)}
            onHistory={() => setHistoryOpen(true)}
            onExample={() => void loadExample()}
          />
        </div>
      )}

      <HistoryPanel
        getToken={getToken}
        open={historyOpen}
        history={history}
        items={queueItems}
        drafts={drafts}
        draftItems={drafts.data?.items ?? []}
        restoringDraftId={restoringDraftId}
        onOpenDraft={openDraft}
        onGenerationRemoved={removeOptimisticGeneration}
        onClose={() => setHistoryOpen(false)}
      />
    </div>
  );
}

function MonitorOverlay({
  playhead,
  fps,
  frameCount,
  unit,
  fill,
  expanded,
  onToggleExpanded,
}: {
  playhead: Playhead;
  fps: number;
  frameCount: number;
  unit: TimeUnit;
  fill: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const frame = usePlayheadFrame(playhead);
  const playing = usePlayheadPlaying(playhead);
  return (
    <>
      <div className="studio-monitor-head">
        <span className="studio-monitor-live" data-playing={playing || undefined}>
          <i />
          {playing ? "Play" : "Cam"}
        </span>
        <span className="studio-mono hide-compact">{formatTime(frame, fps, unit)}</span>
        <span className="flex-1" />
        <button
          type="button"
          aria-label={expanded ? "Shrink camera view" : "Enlarge camera view"}
          title={expanded ? "Shrink (Esc)" : "Enlarge"}
          onClick={onToggleExpanded}
        >
          {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </button>
      </div>
      <div className="studio-monitor-thirds" aria-hidden />
      {fill && (
        <span className="studio-monitor-badge hide-compact">
          <i />
          Unseen areas are generated
        </span>
      )}
      <div className="studio-monitor-progress" aria-hidden>
        <i style={{ width: `${(frame / Math.max(1, frameCount - 1)) * 100}%` }} />
      </div>
    </>
  );
}

type TrajectoryMap = {
  space: TrajectorySpace;
  worldPoints: TrajectoryPoint[];
  colors: string[];
};

function buildTrajectoryMap(pose: PosedView): TrajectoryMap {
  const center = new THREE.Vector3(...pose.centroidWorld);
  const transform = new THREE.Matrix4().compose(
    new THREE.Vector3(...pose.camera.extrinsics.position),
    new THREE.Quaternion(...pose.camera.extrinsics.quaternion),
    new THREE.Vector3(1, 1, 1),
  );
  const worldPoints: TrajectoryPoint[] = [];
  const colors: string[] = [];
  const color = new THREE.Color();
  const pointCount = pose.points.shape[0] * pose.points.shape[1];
  const step = Math.max(1, Math.floor(pointCount / 1200));
  const world = new THREE.Vector3();

  for (let index = 0; index < pointCount; index += step) {
    const offset = index * 3;
    const x = pose.points.positions[offset];
    const y = pose.points.positions[offset + 1];
    const z = pose.points.positions[offset + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
      continue;
    world.set(x, y, z).applyMatrix4(transform);
    worldPoints.push(world.toArray());
    colors.push(color.fromArray(pose.points.colors, offset).getStyle());
  }

  const extents = worldPoints
    .map((point) => new THREE.Vector3(...point).distanceTo(center))
    .sort((a, b) => a - b);
  const sceneExtent = extents[Math.floor(extents.length * 0.95)] ?? 1;

  return {
    space: {
      center: pose.centroidWorld,
      radius: Math.max(1, sceneExtent * 1.35),
    },
    worldPoints,
    colors,
  };
}

function UploadScreen({
  previewUrl,
  posing,
  poseElapsed,
  error,
  activeSceneName,
  onResume,
  onChoose,
  onDrop,
  onHistory,
  onExample,
}: {
  previewUrl: string | null;
  posing: boolean;
  poseElapsed: number;
  error: string | null;
  activeSceneName: string | null;
  onResume: (() => void) | null;
  onChoose: () => void;
  onDrop: (file: File) => void;
  onHistory: () => void;
  onExample: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  return (
    <main className="studio-start">
      <button type="button" onClick={onHistory} className="studio-button studio-start-saved">
        <HistoryIcon className="h-4 w-4" />
        Saved
      </button>
      <div className="studio-start-inner">
        {onResume ? (
          <button type="button" onClick={onResume} className="studio-button studio-start-resume">
            <ArrowLeft className="h-4 w-4 shrink-0" />
            <span className="truncate">Back to {activeSceneName}</span>
          </button>
        ) : (
          <p className="studio-start-eyebrow">Atlas Camera Studio</p>
        )}
        <h1>
          {onResume ? (
            "Start another scene."
          ) : (
            <>
              One image. <em>Any camera move.</em>
            </>
          )}
        </h1>
        <p className="studio-start-lede">
          {onResume
            ? "Your current scene stays open until you choose another image."
            : "Upload a photo, set a few keyframes, and Atlas generates the shot, filling in everything the photo never saw."}
        </p>

        <button
          type="button"
          disabled={posing}
          onClick={onChoose}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const file = event.dataTransfer.files[0];
            if (file) onDrop(file);
          }}
          data-dragging={dragging || undefined}
          className="studio-dropzone"
        >
          {previewUrl && posing && <img src={previewUrl} alt="" />}
          <span className="studio-dropzone-content">
            {posing ? (
              <>
                <Loader2 className="h-7 w-7 animate-spin" />
                <strong>Preparing the 3D scene</strong>
                <small>{Math.max(1, Math.round(poseElapsed / 1000))}s</small>
              </>
            ) : (
              <>
                <span className="studio-dropzone-icon">
                  <Upload className="h-5 w-5" />
                </span>
                <strong>Choose an image</strong>
                <small>or drop or paste one (Ctrl/⌘+V) · JPG, PNG, or WebP</small>
              </>
            )}
          </span>
        </button>

        <button
          type="button"
          disabled={posing}
          onClick={onExample}
          className="studio-example"
        >
          <img src={EXAMPLE_IMAGE} alt="" />
          <span>
            <strong>Open the igloo example</strong>
            <small>Try the editor with a sample scene. No account needed.</small>
          </span>
          <Play className="h-4 w-4 shrink-0" fill="currentColor" />
        </button>
        {error && <p className="studio-start-error">{error}</p>}
      </div>
    </main>
  );
}

function HistoryPanel({
  getToken,
  open,
  history,
  items,
  drafts,
  draftItems,
  restoringDraftId,
  onOpenDraft,
  onGenerationRemoved,
  onClose,
}: {
  getToken: GetToken;
  open: boolean;
  history: {
    isLoading: boolean;
    error: unknown;
    refetch: () => Promise<unknown>;
  };
  items: readonly CameraTrajectoryHistoryItem[];
  drafts: {
    isLoading: boolean;
    error: unknown;
    refetch: () => Promise<unknown>;
  };
  draftItems: readonly CameraTrajectoryDraftSummary[];
  restoringDraftId: string | null;
  onOpenDraft: (draftId: string) => Promise<void>;
  onGenerationRemoved: (jobId: string) => void;
  onClose: () => void;
}) {
  const [activeTab, setActiveTab] = useState<
    "favorites" | "generations" | "drafts"
  >("generations");
  const [starError, setStarError] = useState<string | null>(null);
  const [draftStarOverrides, setDraftStarOverrides] = useState(
    () => new Map<string, boolean>(),
  );
  const [generationStarOverrides, setGenerationStarOverrides] = useState(
    () => new Map<string, boolean>(),
  );
  const displayedDraftItems = useMemo(
    () => applyDraftStarOverrides(draftItems, draftStarOverrides),
    [draftItems, draftStarOverrides],
  );
  const displayedItems = useMemo(
    () => applyGenerationStarOverrides(items, generationStarOverrides),
    [generationStarOverrides, items],
  );
  const starredDraftIds = useMemo(
    () =>
      new Set(
        displayedDraftItems
          .filter((draft) => draft.starred)
          .map((draft) => draft.draft_id),
      ),
    [displayedDraftItems],
  );
  const sortedDraftItems = useMemo(
    () =>
      [...displayedDraftItems].sort(
        (left, right) => right.saved_at - left.saved_at,
      ),
    [displayedDraftItems],
  );
  const sortedItems = useMemo(
    () =>
      [...displayedItems].sort(
        (left, right) => right.submitted_at - left.submitted_at,
      ),
    [displayedItems],
  );
  const favoriteDraftItems = useMemo(
    () => sortedDraftItems.filter((draft) => draft.starred),
    [sortedDraftItems],
  );
  const favoriteItems = useMemo(
    () => favoriteHistoryItems(sortedItems),
    [sortedItems],
  );
  const favoriteCount = useMemo(
    () =>
      favoriteDraftItems.length +
      favoriteItems.reduce((count, item) => count + item.variants.length, 0),
    [favoriteDraftItems.length, favoriteItems],
  );

  async function toggleDraftStar(draftId: string, starred: boolean) {
    setStarError(null);
    setDraftStarOverrides((current) => {
      const next = new Map(current);
      next.set(draftId, starred);
      return next;
    });
    try {
      await setCameraTrajectoryDraftStar(getToken, draftId, starred);
    } catch (caught) {
      setDraftStarOverrides((current) => {
        if (current.get(draftId) !== starred) return current;
        const next = new Map(current);
        next.set(draftId, !starred);
        return next;
      });
      setStarError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function toggleGenerationStar(jobId: string, starred: boolean) {
    setStarError(null);
    setGenerationStarOverrides((current) => {
      const next = new Map(current);
      next.set(jobId, starred);
      return next;
    });
    try {
      await setCameraTrajectoryGenerationStar(getToken, jobId, starred);
    } catch (caught) {
      setGenerationStarOverrides((current) => {
        if (current.get(jobId) !== starred) return current;
        const next = new Map(current);
        next.set(jobId, !starred);
        return next;
      });
      setStarError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function removeGeneration(jobId: string) {
    await deleteCameraTrajectoryGeneration(getToken, jobId);
    onGenerationRemoved(jobId);
  }

  if (!open) return null;

  return (
    <aside className="fixed inset-y-0 right-0 z-[70] flex w-[min(28rem,100%)] flex-col border-l border-[var(--ink)]/15 bg-[var(--panel)]/98 shadow-sm ">
      <div className="flex items-center justify-between px-5 pb-3 pt-4">
        <div>
          <h2 className="text-lg font-semibold tracking-[-0.025em]">
            Saved scenes
          </h2>
          <p className="mt-0.5 text-xs text-[var(--ink)]/60">
            Drafts stay in this browser. Videos expire after 7 days.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close saved scenes"
          className="grid h-9 w-9 place-items-center rounded-md text-[var(--ink)]/50 transition hover:bg-[var(--ink)]/10 hover:text-[var(--ink)]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div
        role="tablist"
        aria-label="Saved scene views"
        className="grid grid-cols-3 gap-1 border-b border-[var(--ink)]/10 px-3 pb-3"
      >
        <HistoryTabButton
          active={activeTab === "favorites"}
          count={favoriteCount}
          label="Favorites"
          onClick={() => setActiveTab("favorites")}
        />
        <HistoryTabButton
          active={activeTab === "generations"}
          count={sortedItems.length}
          label="Generations"
          onClick={() => setActiveTab("generations")}
        />
        <HistoryTabButton
          active={activeTab === "drafts"}
          count={sortedDraftItems.length}
          label="Drafts"
          onClick={() => setActiveTab("drafts")}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {starError && (
          <p className="mb-3 rounded-md border border-red-400/20 bg-red-50 p-3 text-xs text-red-700">
            Could not update favorite: {starError}
          </p>
        )}

        {activeTab === "favorites" &&
          (history.isLoading && drafts.isLoading && favoriteCount === 0 ? (
            <div className="grid h-24 place-items-center">
              <Loader2 className="h-4 w-4 animate-spin text-[var(--ink)]/60" />
            </div>
          ) : favoriteCount === 0 ? (
            <p className="rounded-lg border border-dashed border-[var(--ink)]/10 px-3 py-8 text-center text-xs text-[var(--ink)]/55">
              Star a video or path to keep it here.
            </p>
          ) : (
            <div className="space-y-5">
              {favoriteItems.length > 0 && (
                <section>
                  <h3 className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--ink)]/60">
                    Videos
                  </h3>
                  <div className="space-y-2">
                    {favoriteItems.map((item) => (
                      <QueueItem
                        key={item.iteration_id}
                        getToken={getToken}
                        item={item}
                        pathStarred={starredDraftIds.has(item.iteration_id)}
                        showPathStar={false}
                        onStarPath={(starred) =>
                          toggleDraftStar(item.iteration_id, starred)
                        }
                        onStarGeneration={toggleGenerationStar}
                        onRemoveGeneration={removeGeneration}
                      />
                    ))}
                  </div>
                </section>
              )}
              {favoriteDraftItems.length > 0 && (
                <section>
                  <h3 className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--ink)]/60">
                    Paths
                  </h3>
                  <div className="space-y-2">
                    {favoriteDraftItems.map((draft) => (
                      <DraftItem
                        key={draft.draft_id}
                        draft={draft}
                        restoring={restoringDraftId === draft.draft_id}
                        onOpen={onOpenDraft}
                        onStar={(starred) =>
                          toggleDraftStar(draft.draft_id, starred)
                        }
                      />
                    ))}
                  </div>
                </section>
              )}
            </div>
          ))}

        {activeTab === "generations" &&
          (history.isLoading && sortedItems.length === 0 ? (
            <div className="grid h-24 place-items-center">
              <Loader2 className="h-4 w-4 animate-spin text-[var(--ink)]/60" />
            </div>
          ) : history.error && sortedItems.length === 0 ? (
            <p className="rounded-md border border-red-400/20 bg-red-50 p-3 text-sm text-red-700">
              {history.error instanceof Error
                ? history.error.message
                : "Could not load generations"}
            </p>
          ) : sortedItems.length > 0 ? (
            <div className="space-y-2">
              {history.isLoading && (
                <p className="flex items-center gap-2 rounded-md border border-[var(--ink)]/10 bg-[var(--ink)]/[0.04] px-3 py-2 text-xs text-[var(--ink)]/55">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading earlier generations…
                </p>
              )}
              {sortedItems.map((item) => (
                <QueueItem
                  key={item.iteration_id}
                  getToken={getToken}
                  item={item}
                  pathStarred={starredDraftIds.has(item.iteration_id)}
                  onStarPath={(starred) =>
                    toggleDraftStar(item.iteration_id, starred)
                  }
                  onStarGeneration={toggleGenerationStar}
                  onRemoveGeneration={removeGeneration}
                />
              ))}
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-[var(--ink)]/10 px-3 py-8 text-center text-xs text-[var(--ink)]/55">
              Generated versions will appear here.
            </p>
          ))}

        {activeTab === "drafts" &&
          (drafts.isLoading && sortedDraftItems.length === 0 ? (
            <div className="grid h-24 place-items-center">
              <Loader2 className="h-4 w-4 animate-spin text-[var(--ink)]/60" />
            </div>
          ) : drafts.error && sortedDraftItems.length === 0 ? (
            <p className="rounded-md border border-red-400/20 bg-red-50 p-3 text-sm text-red-700">
              {drafts.error instanceof Error
                ? drafts.error.message
                : "Could not load drafts"}
            </p>
          ) : sortedDraftItems.length > 0 ? (
            <div className="space-y-2">
              {sortedDraftItems.map((draft) => (
                <DraftItem
                  key={draft.draft_id}
                  draft={draft}
                  restoring={restoringDraftId === draft.draft_id}
                  onOpen={onOpenDraft}
                  onStar={(starred) => toggleDraftStar(draft.draft_id, starred)}
                />
              ))}
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-[var(--ink)]/10 px-3 py-8 text-center text-xs text-[var(--ink)]/55">
              Generate or save a draft to keep the editable scene here.
            </p>
          ))}
      </div>
    </aside>
  );
}

function HistoryTabButton({
  active,
  count,
  label,
  onClick,
}: {
  active: boolean;
  count: number;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex h-10 min-w-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)]/70 ${
        active
          ? "bg-[var(--panel)] text-[var(--ink)]"
          : "text-[var(--ink)]/50 hover:bg-[var(--ink)]/[0.06] hover:text-[var(--ink)]"
      }`}
    >
      <span className="truncate">{label}</span>
      <span
        className={`rounded-full px-1.5 py-0.5 text-[9px] tabular-nums ${
          active
            ? "bg-[var(--ink)]/10 text-[var(--ink)]/55"
            : "bg-[var(--ink)]/[0.07] text-[var(--ink)]/60"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

function DraftItem({
  draft,
  restoring,
  onOpen,
  onStar,
}: {
  draft: CameraTrajectoryDraftSummary;
  restoring: boolean;
  onOpen: (draftId: string) => Promise<void>;
  onStar: (starred: boolean) => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <article className="rounded-lg border border-[var(--ink)]/20 bg-[var(--ink)]/[0.05] p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] text-[var(--ink)]/60">
          {new Intl.DateTimeFormat(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          }).format(new Date(draft.saved_at * 1000))}
        </span>
        <div className="flex items-center gap-2">
          <StarButton starred={draft.starred} label="path" onChange={onStar} />
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--ink)]">
            Draft
          </span>
        </div>
      </div>
      <p className="mt-2 line-clamp-2 text-sm leading-5 text-[var(--ink)]/85">
        {draft.prompt || "No prompt yet"}
      </p>
      <p className="mt-2 text-xs text-[var(--ink)]/55">
        {draft.point_count} keys · {draft.frame_count} frames · {draft.fps}{" "}
        FPS · {draft.aspect_ratio}
      </p>
      <code className="mt-2 block select-all truncate text-[10px] text-[var(--ink)]/55">
        {draft.draft_id}
      </code>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={restoring}
          onClick={() => void onOpen(draft.draft_id)}
          className="flex h-9 items-center justify-center gap-2 rounded-md bg-[var(--ink)] text-xs font-semibold text-[var(--panel)] transition hover:opacity-90 active:translate-y-px disabled:cursor-wait disabled:opacity-40"
        >
          {restoring ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <FolderOpen className="h-3.5 w-3.5" />
          )}
          {restoring ? "Opening…" : "Open draft"}
        </button>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard
              .writeText(draft.draft_id)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
          className="flex h-9 items-center justify-center gap-2 rounded-md border border-[var(--ink)]/15 text-xs font-semibold text-[var(--ink)]/65 transition hover:border-[var(--ink)]/30 hover:bg-[var(--ink)]/[0.06] hover:text-[var(--ink)] active:translate-y-px"
        >
          <Copy className="h-3.5 w-3.5" />
          {copied ? "ID copied" : "Copy ID"}
        </button>
      </div>
    </article>
  );
}

function QueueItem({
  getToken,
  item,
  pathStarred,
  showPathStar = true,
  onStarPath,
  onStarGeneration,
  onRemoveGeneration,
}: {
  getToken: GetToken;
  item: CameraTrajectoryHistoryItem;
  pathStarred: boolean;
  showPathStar?: boolean;
  onStarPath: (starred: boolean) => Promise<void>;
  onStarGeneration: (jobId: string, starred: boolean) => Promise<void>;
  onRemoveGeneration: (jobId: string) => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const detailsId = `generation-details-${item.iteration_id}`;

  return (
    <article className="rounded-lg border border-[var(--ink)]/10 bg-[var(--ink)]/[0.03] p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] text-[var(--ink)]/60">
          {new Intl.DateTimeFormat(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          }).format(new Date(item.submitted_at * 1000))}
        </span>
        <div className="flex items-center gap-2">
          {showPathStar && item.iteration_id.startsWith("draft_") && (
            <StarButton
              starred={pathStarred}
              label="path"
              onChange={onStarPath}
            />
          )}
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--ink)]">
            {item.variants.length}{" "}
            {item.variants.length === 1 ? "video" : "videos"}
          </span>
        </div>
      </div>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={detailsId}
        aria-label={`${expanded ? "Collapse" : "Expand"} scene ${item.prompt}`}
        onClick={() => setExpanded((current) => !current)}
        className="mt-1.5 flex w-full items-center gap-2 rounded-md px-1 py-2 text-left transition hover:bg-[var(--ink)]/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)]/70 active:translate-y-px"
      >
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-[var(--ink)]/60 transition-transform ${expanded ? "rotate-0" : "-rotate-90"}`}
        />
        <span className="line-clamp-2 text-sm leading-5 text-[var(--ink)]/85">
          {item.prompt}
        </span>
      </button>
      {expanded && (
        <div id={detailsId}>
          <p className="mt-1 text-xs text-[var(--ink)]/55">
            {item.target_frame_count} frames · {item.fps} FPS ·{" "}
            {item.aspect_ratio}
          </p>
          <div className="mt-2 flex items-center gap-2 rounded-md border border-[var(--ink)]/10 bg-[var(--ink)]/[0.04] px-2 py-1.5">
            <code className="min-w-0 flex-1 select-all truncate text-[10px] text-[var(--ink)]/60">
              {item.iteration_id}
            </code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard
                  .writeText(item.iteration_id)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
              className="flex shrink-0 items-center gap-1 text-[10px] font-semibold text-[var(--ink)] transition hover:text-[var(--ink)]"
            >
              <Copy className="h-3 w-3" />
              {copied ? "Copied" : "Copy iteration ID"}
            </button>
          </div>
          <div className="mt-3 space-y-2">
            {[...item.variants]
              .sort(
                (left, right) =>
                  Number(right.starred) - Number(left.starred) ||
                  (left.seed ?? Number.MAX_SAFE_INTEGER) -
                    (right.seed ?? Number.MAX_SAFE_INTEGER),
              )
              .map((variant) => (
                <QueueVariant
                  key={variant.job_id}
                  getToken={getToken}
                  prompt={item.prompt}
                  iterationId={item.iteration_id}
                  frameCount={item.target_frame_count}
                  fps={item.fps}
                  variant={variant}
                  onStar={(starred) =>
                    onStarGeneration(variant.job_id, starred)
                  }
                  onRemove={() => onRemoveGeneration(variant.job_id)}
                />
              ))}
          </div>
        </div>
      )}
    </article>
  );
}

function QueueVariant({
  getToken,
  prompt,
  iterationId,
  frameCount,
  fps,
  variant,
  onStar,
  onRemove,
}: {
  getToken: GetToken;
  prompt: string;
  iterationId: string;
  frameCount: number;
  fps: number;
  variant: CameraTrajectoryHistoryVariant;
  onStar: (starred: boolean) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const status = useQuery({
    queryKey: ["camera-trajectory", variant.job_id],
    queryFn: () => getCameraTrajectoryStatus(getToken, variant.job_id),
    enabled: variant.video_uri === null,
    refetchInterval: (query) =>
      query.state.data?.state === "running" ? 3000 : false,
  });
  const response = status.data?.response;
  const videoUri = variant.video_uri ?? response?.video_uri ?? null;
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!videoUri) return;
    let cancelled = false,
      url: string | undefined;
    const controller = new AbortController();
    void authFetch(getToken, cameraTrajectoryVideoUrl(videoUri), {
      signal: controller.signal,
    })
      .then((response) => response.blob())
      .then((blob) => {
        if (!cancelled) {
          url = URL.createObjectURL(blob);
          setVideoUrl(url);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [videoUri, getToken]);
  const failure =
    response?.error ??
    status.data?.error ??
    (status.error instanceof Error ? status.error.message : null);
  const state = videoUrl ? "Ready" : failure ? "Failed" : "Generating";
  const downloadName = cameraTrajectoryDownloadName({
    prompt: variant.prompt ?? prompt,
    iterationId,
    jobId: variant.job_id,
    seed: variant.seed,
    frameCount: variant.target_frame_count ?? frameCount,
    fps: variant.fps ?? fps,
    aspectRatio: variant.aspect_ratio,
  });

  return (
    <div className="rounded-md border border-[var(--ink)]/10 bg-[var(--ink)]/[0.04] p-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-[var(--ink)]/70">
          Seed {variant.seed ?? "unknown"} · {variant.aspect_ratio}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label={`Remove seed ${variant.seed ?? "unknown"} from Saved`}
            title="Remove this version from Saved"
            disabled={removing}
            onClick={() => {
              setRemoveError(null);
              setConfirmingRemove(true);
            }}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-[var(--ink)]/10 text-[var(--ink)]/55 transition hover:border-red-300/30 hover:bg-red-400/10 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300/60 disabled:cursor-wait disabled:opacity-50"
          >
            {removing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
          </button>
          <StarButton
            starred={variant.starred}
            label={`seed ${variant.seed ?? "unknown"}`}
            onChange={onStar}
          />
          <span
            className={`text-[10px] font-semibold uppercase tracking-[0.06em] ${
              videoUrl
                ? "text-emerald-700"
                : failure
                  ? "text-red-700"
                  : "text-[var(--ink-3)]"
            }`}
          >
            {state}
          </span>
        </div>
      </div>
      {confirmingRemove && (
        <div className="mt-2 rounded-md border border-red-300/20 bg-red-50 p-2.5">
          <p className="text-xs leading-5 text-red-800/85">
            Remove this version from Saved? The path and raw output stay
            available for recovery.
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              disabled={removing}
              onClick={() => setConfirmingRemove(false)}
              className="h-8 rounded-md px-3 text-xs font-semibold text-[var(--ink)]/55 transition hover:bg-[var(--ink)]/[0.06] hover:text-[var(--ink)] disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={removing}
              onClick={() => {
                setRemoving(true);
                setRemoveError(null);
                void onRemove()
                  .catch((caught) => {
                    setRemoveError(
                      caught instanceof Error ? caught.message : String(caught),
                    );
                    setConfirmingRemove(false);
                  })
                  .finally(() => setRemoving(false));
              }}
              className="h-8 rounded-md bg-red-200 px-3 text-xs font-semibold text-red-950 transition hover:bg-red-100 active:translate-y-px disabled:cursor-wait disabled:opacity-40"
            >
              {removing ? "Removing…" : "Remove"}
            </button>
          </div>
        </div>
      )}
      {removeError && (
        <p className="mt-2 text-xs text-red-700">
          Could not remove this version: {removeError}
        </p>
      )}
      {failure && <p className="mt-2 text-xs text-red-700">{failure}</p>}
      {videoUrl && (
        <div className="mt-2 space-y-2">
          <video
            src={videoUrl}
            controls
            playsInline
            className="w-full rounded"
          />
          <div className="grid grid-cols-2 gap-2">
            <a
              href={videoUrl}
              target="_blank"
              rel="noreferrer"
              className="flex h-9 items-center justify-center gap-2 rounded-md border border-[var(--ink)]/15 text-xs font-semibold text-[var(--ink)]/70 transition hover:border-[var(--ink)]/30 hover:bg-[var(--ink)]/[0.06] hover:text-[var(--ink)]"
            >
              <Play className="h-3.5 w-3.5" />
              Open
            </a>
            <a
              href={videoUrl}
              download={downloadName}
              title={`Download ${downloadName}`}
              className="flex h-9 items-center justify-center gap-2 rounded-md bg-[var(--panel)] text-xs font-semibold text-[var(--ink)] transition hover:bg-[var(--panel)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)] active:translate-y-px"
            >
              <Download className="h-3.5 w-3.5" />
              Download
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function StarButton({
  starred,
  label,
  onChange,
}: {
  starred: boolean;
  label: string;
  onChange: (starred: boolean) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);

  return (
    <button
      type="button"
      aria-label={`${starred ? "Unstar" : "Star"} ${label}`}
      aria-pressed={starred}
      title={`${starred ? "Unstar" : "Star"} ${label}`}
      disabled={saving}
      onClick={() => {
        setSaving(true);
        void onChange(!starred).finally(() => setSaving(false));
      }}
      className={`grid h-8 w-8 shrink-0 place-items-center rounded-md border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink-3)]/70 disabled:cursor-wait disabled:opacity-50 ${
        starred
          ? "border-[var(--ink-3)]/35 bg-[var(--ink-3)]/15 text-[var(--ink-3)] hover:bg-[var(--ink-3)]/25"
          : "border-[var(--ink)]/10 text-[var(--ink)]/55 hover:border-[var(--ink)]/25 hover:bg-[var(--ink)]/[0.06] hover:text-[var(--ink)]/70"
      }`}
    >
      {saving ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Star className={`h-3.5 w-3.5 ${starred ? "fill-current" : ""}`} />
      )}
    </button>
  );
}

