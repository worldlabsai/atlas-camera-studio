import { EXAMPLE_DEPTH, EXAMPLE_IMAGE, EXAMPLE_HANDOFF } from "../example";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronDown,
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  History as HistoryIcon,
  House,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  Play,
  Plus,
  Rotate3D,
  Undo2,
  Redo2,
  Save,
  Send,
  Sparkles,
  Stamp,
  Star,
  Trash2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { verticalFov, type PinholeCamera } from "./common";
import * as THREE from "three";
import { CameraPointCloudView, CameraTrajectoryCanvas } from "./Canvas";
import {
  appendDrawnTrajectory,
  buildTargetCameras,
  cameraAimDegrees,
  cameraDrawingView,
  cameraQuaternionFromAim,
  cameraTargetIsClearOfPath,
  cameraViewsFromSegments,
  deleteTrajectoryPivot,
  frameTrajectorySpaceAboveFloor,
  insertTrajectoryPivot,
  materializeTrajectorySmoothing,
  smoothTrajectorySegments,
  moveTrajectoryPoint,
  normalizeClosedTrajectorySegments,
  partLookAtTargetIsClearOfPath,
  projectTrajectoryPoint,
  reshapeTrajectorySegments,
  sampleCameraPivot,
  setTrajectoryPointDirectionOverride,
  setTrajectoryPointQuaternion,
  TRAJECTORY_FLOOR_Y,
  TRAJECTORY_SMOOTHING_VERSION,
  trajectoryPathFromSegments,
  trajectoryPivotsFromSegments,
  trajectoryFloorBoundary,
  type CameraDirectionMode,
  type CameraView,
  type DrawPoint,
  type TrajectoryDrawingView,
  type TrajectoryPoint,
  type TrajectoryPivot,
  type TrajectoryQuaternion,
  type TrajectorySegment,
  type TrajectoryShape,
  type TrajectorySpace,
} from "./camera-trajectory";
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
} from "./api";
import { authFetch, type GetToken } from "./client";
import { useEditHistory } from "./use-edit-history";
import { loadDepthPointCloud, loadExamplePose } from "./pose";
import { fileToPoseBlob, posePointClouds, type PosedView } from "./pose";

const DEFAULT_FRAME_COUNT = 48;
const DEFAULT_FPS = 12;
const DEFAULT_SEED_COUNT = 1;
const DEFAULT_CFG = 2.5;
const DEFAULT_FREEZE_TIME = true;
const DEFAULT_DIRECTION_MODE: CameraDirectionMode = "manual";
const MIN_FRAME_COUNT = 2;
const MAX_FRAME_COUNT = 48;
const MIN_FPS = 1;
const MAX_FPS = 60;
const MIN_SEED_COUNT = 1;
const MAX_SEED_COUNT = 16;
const MIN_CFG = 0;
const MAX_CFG = 15;
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
const MAX_DEPTH_ANCHORS = 16;
const DRAWING_PANEL_SIZES = [
  { label: "Small", widthClass: "w-80" },
  { label: "Medium", widthClass: "w-[26rem]" },
  { label: "Large", widthClass: "w-[34rem]" },
  { label: "Full", widthClass: "w-[44rem]" },
] as const;
const CAMERA_DIRECTION_PRESETS: readonly {
  mode: CameraDirectionMode;
  label: string;
  title: string;
}[] = [
  {
    mode: "manual",
    label: "My angles",
    title: "Use the camera directions you set below",
  },
  {
    mode: "forward",
    label: "Forward",
    title: "Face along the flight path",
  },
  {
    mode: "look_at",
    label: "Look at point",
    title: "Point every camera at one spot you choose in the scene",
  },
  {
    mode: "look_away",
    label: "Look away",
    title: "Point every camera away from one spot you choose in the scene",
  },
];
const DEFAULT_DRAWING_PANEL_SIZE_INDEX = 1;
type PointDirectionMode = "look_at" | "look_away";

function isPointDirectionMode(
  mode: CameraDirectionMode,
): mode is PointDirectionMode {
  return mode === "look_at" || mode === "look_away";
}

function restoredDirectionMode(
  mode: CameraDirectionMode | undefined,
): CameraDirectionMode {
  if (mode === "inward") return "look_at";
  if (mode === "outward") return "look_away";
  return mode ?? DEFAULT_DIRECTION_MODE;
}

type SelectedPivot = {
  segmentId: string;
  pointIndex: number;
  pivotNumber: number;
};

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

export function CameraTrajectoryPage({
  getToken,
  canViewHistory,
  beforePrepare,
  beforeGenerate,
}: {
  getToken: GetToken;
  canViewHistory: boolean;
  beforePrepare: () => boolean;
  beforeGenerate: () => boolean;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const poseAbort = useRef<AbortController | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const pastedImageLoader = useRef<(file: File) => void>(() => undefined);
  const drawingPanelMinimizeButton = useRef<HTMLButtonElement | null>(null);
  const drawingPanelRestoreButton = useRef<HTMLButtonElement | null>(null);
  const directionPanelMinimizeButton = useRef<HTMLButtonElement | null>(null);
  const directionPanelRestoreButton = useRef<HTMLButtonElement | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [poseBlob, setPoseBlob] = useState<Blob | null>(null);
  const [pose, setPose] = useState<PosedView | null>(null);
  const [poseElapsed, setPoseElapsed] = useState(0);
  const [posing, setPosing] = useState(false);
  const [segments, setSegments] = useState<TrajectorySegment[]>([]);
  const [trajectorySmoothingVersion, setTrajectorySmoothingVersion] =
    useState(0);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(
    null,
  );
  const [selectedPivot, setSelectedPivot] = useState<SelectedPivot | null>(
    null,
  );
  const [drawingView, setDrawingView] = useState<TrajectoryDrawingView | null>(
    null,
  );
  const [prompt, setPrompt] = useState("");
  const [frameCount, setFrameCount] = useState(DEFAULT_FRAME_COUNT);
  const [fps, setFps] = useState(DEFAULT_FPS);
  const [seedCount, setSeedCount] = useState(DEFAULT_SEED_COUNT);
  const [cfg, setCfg] = useState(DEFAULT_CFG);
  const [freezeTime, setFreezeTime] = useState(DEFAULT_FREEZE_TIME);
  const [directionMode, setDirectionMode] = useState<CameraDirectionMode>(
    DEFAULT_DIRECTION_MODE,
  );
  const [directionTarget, setDirectionTarget] =
    useState<TrajectoryPoint | null>(null);
  const [placingDirectionTarget, setPlacingDirectionTarget] = useState(false);
  const [pendingDirectionMode, setPendingDirectionMode] =
    useState<PointDirectionMode | null>(null);
  const [placingLookAtSegmentId, setPlacingLookAtSegmentId] = useState<
    string | null
  >(null);
  const [closedLoop, setClosedLoop] = useState(false);
  const [allowBelowFloor, setAllowBelowFloor] = useState(false);
  const [targetFovDegrees, setTargetFovDegrees] = useState(50);
  const [aspectRatio, setAspectRatio] =
    useState<CameraTrajectoryAspectRatio>(DEFAULT_ASPECT_RATIO);
  const [previewing, setPreviewing] = useState(false);
  const [addingPivot, setAddingPivot] = useState(false);
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
  const [drawingPanelOpen, setDrawingPanelOpen] = useState(true);
  const [directionPanelOpen, setDirectionPanelOpen] = useState(true);
  const [drawingPanelSizeIndex, setDrawingPanelSizeIndex] = useState(
    DEFAULT_DRAWING_PANEL_SIZE_INDEX,
  );
  const [error, setError] = useState<string | null>(null);
  const targetFormat = TARGET_FORMATS[aspectRatio];
  const effectiveDirectionTarget = isPointDirectionMode(directionMode)
    ? (directionTarget ?? pose?.centroidWorld)
    : pose?.centroidWorld;
  const path = useMemo(() => trajectoryPathFromSegments(segments), [segments]);
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

  useEffect(
    () => () => {
      poseAbort.current?.abort();
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    },
    [],
  );

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
    setSegments([]);
    setTrajectorySmoothingVersion(0);
    setSelectedSegmentId(null);
    setSelectedPivot(null);
    setAddingPivot(false);
    setPreviewing(false);
    setDrawingView(null);
    setPrompt(restoredDraft?.prompt ?? "");
    setDirectionMode(restoredDirectionMode(restoredDraft?.direction_mode));
    setDirectionTarget(null);
    setPlacingDirectionTarget(false);
    setPendingDirectionMode(null);
    setPlacingLookAtSegmentId(null);
    setClosedLoop(restoredDraft?.closed_loop ?? false);
    setAllowBelowFloor(
      restoredDraft?.allow_below_floor === true ||
        (restoredDraft?.segments.some((segment) =>
          segment.points.some((point) => point[1] < TRAJECTORY_FLOOR_Y),
        ) ??
          false),
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
      if (!nextPose) throw new Error("No point cloud was returned");
      if (controller.signal.aborted) return;

      setPose(nextPose);
      setPoseBlob(blob);
      setDirectionTarget(
        restoredDraft?.direction_target ??
          (restoredDraft?.direction_mode === "inward" ||
          restoredDraft?.direction_mode === "outward" ||
          restoredDraft?.direction_mode === "look_at" ||
          restoredDraft?.direction_mode === "look_away"
            ? nextPose.centroidWorld
            : null),
      );
      const restoredTargetFov =
        restoredDraft?.target_fov_degrees ??
        (restoredDraft?.target_cameras[0]
          ? THREE.MathUtils.radToDeg(
              verticalFov(restoredDraft.target_cameras[0].intrinsics),
            )
          : THREE.MathUtils.radToDeg(verticalFov(nextPose.camera.intrinsics)));
      setTargetFovDegrees(
        THREE.MathUtils.clamp(
          Math.round(restoredTargetFov),
          MIN_TARGET_FOV_DEGREES,
          MAX_TARGET_FOV_DEGREES,
        ),
      );
      if (isExample && !restoredDraft) {
        const [x, y, z] = nextPose.camera.extrinsics.position;
        const id = "example-path";
        setSegments([
          {
            id,
            points: [
              [x, y, z],
              [x + 0.35, y, z - 0.2],
              [x + 0.75, y + 0.05, z - 0.45],
            ],
          },
        ]);
        setTrajectorySmoothingVersion(TRAJECTORY_SMOOTHING_VERSION);
        setSelectedSegmentId(id);
        setDirectionMode("look_at");
        setDirectionTarget(nextPose.centroidWorld);
        setPrompt(
          "A smooth cinematic camera move around the cozy igloo. Preserve the scene and its lighting.",
        );
      }
      if (restoredDraft) {
        const restoredSmoothingVersion =
          restoredDraft.trajectory_smoothing_version ?? 0;
        const restoredTrajectory = materializeTrajectorySmoothing(
          restoredDraft.segments,
          restoredSmoothingVersion,
        );
        const segmentsWereSmoothed =
          restoredSmoothingVersion >= TRAJECTORY_SMOOTHING_VERSION;
        const restoredSegments = restoredTrajectory.segments;
        setSegments(restoredSegments);
        setTrajectorySmoothingVersion(restoredTrajectory.version);
        const lastSegment = restoredSegments.at(-1);
        setSelectedSegmentId(lastSegment?.id ?? null);
        setSelectedPivot(
          lastSegment
            ? {
                segmentId: lastSegment.id,
                pointIndex: lastSegment.points.length - 1,
                pivotNumber:
                  trajectoryPathFromSegments(restoredSegments).length,
              }
            : null,
        );
        setFrameCount(DEFAULT_FRAME_COUNT);
        setFps(DEFAULT_FPS);
        setSeedCount(DEFAULT_SEED_COUNT);
        setCfg(restoredDraft.cfg ?? DEFAULT_CFG);
        setFreezeTime(restoredDraft.freeze_time ?? DEFAULT_FREEZE_TIME);
        setAspectRatio(restoredDraft.aspect_ratio);
        setNotice(
          segmentsWereSmoothed
            ? "Draft reopened."
            : `Draft ${restoredDraft.draft_id} reopened with its hand-drawn path smoothed.`,
        );
      }
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
      if (saved?.depth_uri === EXAMPLE_DEPTH && Array.isArray(saved.segments))
        draft = saved;
    } catch {}
    if (
      !draft &&
      new URLSearchParams(location.search).get("example") !== "igloo"
    )
      return;
    const timer = setTimeout(() => void loadExample(draft), 0);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (pose?.depthUri !== EXAMPLE_DEPTH || posing) return;
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
          segments,
          target_cameras: [],
          prompt,
          frame_count: frameCount,
          fps,
          seed_count: seedCount,
          cfg,
          freeze_time: freezeTime,
          target_fov_degrees: targetFovDegrees,
          aspect_ratio: aspectRatio,
          direction_mode: directionMode,
          direction_target: directionTarget,
          closed_loop: closedLoop,
          allow_below_floor: allowBelowFloor,
          trajectory_smoothing_version: trajectorySmoothingVersion,
        }),
      );
    } catch {
      /* Storage can be unavailable; the editor still works. */
    }
  }, [
    pose,
    posing,
    segments,
    prompt,
    frameCount,
    fps,
    seedCount,
    cfg,
    freezeTime,
    targetFovDegrees,
    aspectRatio,
    directionMode,
    directionTarget,
    closedLoop,
    allowBelowFloor,
    trajectorySmoothingVersion,
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

  function chooseNewImage() {
    fileInput.current?.click();
  }

  function goHome() {
    setPreviewing(false);
    setAddingPivot(false);
    setHistoryOpen(false);
    setHomeOpen(true);
  }

  async function generate() {
    if (!beforeGenerate()) return;
    if (!PORTRAIT_GENERATION_ENABLED && aspectRatio === "9:16") {
      setError(
        "9:16 generation is temporarily unavailable. Switch Aspect to 16:9.",
      );
      return;
    }
    if (
      !pose ||
      !poseBlob ||
      !prompt.trim() ||
      views.length < 2 ||
      frameCount < requiredFrameCount ||
      submitting ||
      savingDraft
    ) {
      return;
    }
    setAddingPivot(false);
    setPreviewing(false);
    setSubmitting(true);
    setError(null);
    setNotice(null);
    let savedDraftId: string | null = null;

    try {
      const generationSegments = materializeSmoothedTrajectory();
      const generationViews = targetReferenceView
        ? cameraViewsFromSegments(
            generationSegments,
            targetReferenceView,
            allowBelowFloor,
          )
        : [];
      if (
        isPointDirectionMode(directionMode) &&
        effectiveDirectionTarget &&
        !cameraTargetIsClearOfPath(
          generationViews,
          effectiveDirectionTarget,
          closedLoop,
          Math.max(0.02, (trajectoryMap?.space.radius ?? 1) * 0.015),
          undefined,
          allowBelowFloor,
        )
      ) {
        throw new Error(
          "The camera path passes through the look target. Move the target away from the blue path before generating.",
        );
      }
      for (const target of partLookAtTargets) {
        if (
          !partLookAtTargetIsClearOfPath(
            generationViews,
            target,
            closedLoop,
            Math.max(0.02, (trajectoryMap?.space.radius ?? 1) * 0.015),
            allowBelowFloor,
          )
        ) {
          throw new Error(
            "A camera part passes through its look target. Move that target away from the blue path before generating.",
          );
        }
      }
      const targetCameras = buildTargetCameras(
        generationViews,
        frameCount,
        targetFormat.width,
        targetFormat.height,
        {
          directionMode,
          directionTarget: effectiveDirectionTarget,
          closedLoop,
          allowBelowFloor,
        },
      );
      const contextCamera: PinholeCamera = {
        intrinsics: pose.camera.intrinsics,
        extrinsics: {
          ...pose.camera.extrinsics,
          coordinateSystem: "rub",
        },
      };
      const referenceImage = {
        image_base64: await blobToDataUrl(poseBlob),
        camera: contextCamera,
      };
      const submittedAt = Date.now() / 1000;
      const submittedPrompt = prompt.trim();
      const seeds = generationSeeds(seedCount);
      const savedDraft = await saveCameraTrajectoryDraft(getToken, {
        file_name: fileName || "reference-image.png",
        depth_uri: pose.depthUri,
        centroid_world: pose.centroidWorld,
        reference_image: referenceImage,
        segments: generationSegments,
        target_cameras: targetCameras,
        prompt: submittedPrompt,
        frame_count: frameCount,
        fps,
        seed_count: seedCount,
        cfg,
        freeze_time: freezeTime,
        target_fov_degrees: targetFovDegrees,
        aspect_ratio: aspectRatio,
        direction_mode: directionMode,
        direction_target: isPointDirectionMode(directionMode)
          ? (effectiveDirectionTarget ?? null)
          : null,
        closed_loop: closedLoop,
        allow_below_floor: allowBelowFloor,
        trajectory_smoothing_version: TRAJECTORY_SMOOTHING_VERSION,
      });
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
    if (!pose || !poseBlob || !referenceView || savingDraft || submitting) {
      return;
    }
    setSavingDraft(true);
    setError(null);
    setNotice(null);
    try {
      const savedSegments = materializeSmoothedTrajectory();
      const savedViews = targetReferenceView
        ? cameraViewsFromSegments(
            savedSegments,
            targetReferenceView,
            allowBelowFloor,
          )
        : [];
      const contextCamera: PinholeCamera = {
        intrinsics: pose.camera.intrinsics,
        extrinsics: {
          ...pose.camera.extrinsics,
          coordinateSystem: "rub",
        },
      };
      const saved = await saveCameraTrajectoryDraft(getToken, {
        file_name: fileName || "reference-image.png",
        depth_uri: pose.depthUri,
        centroid_world: pose.centroidWorld,
        reference_image: {
          image_base64: await blobToDataUrl(poseBlob),
          camera: contextCamera,
        },
        segments: savedSegments,
        target_cameras:
          savedViews.length >= 2 && frameCount >= requiredFrameCount
            ? buildTargetCameras(
                savedViews,
                frameCount,
                targetFormat.width,
                targetFormat.height,
                {
                  directionMode,
                  directionTarget: effectiveDirectionTarget,
                  closedLoop,
                  allowBelowFloor,
                },
              )
            : [],
        prompt: prompt.trim(),
        frame_count: frameCount,
        fps,
        seed_count: seedCount,
        cfg,
        freeze_time: freezeTime,
        target_fov_degrees: targetFovDegrees,
        aspect_ratio: aspectRatio,
        direction_mode: directionMode,
        direction_target: isPointDirectionMode(directionMode)
          ? (effectiveDirectionTarget ?? null)
          : null,
        closed_loop: closedLoop,
        allow_below_floor: allowBelowFloor,
        trajectory_smoothing_version: TRAJECTORY_SMOOTHING_VERSION,
      });
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
  const targetReferenceView = useMemo<CameraView | null>(
    () =>
      referenceView
        ? {
            ...referenceView,
            fovRadians: THREE.MathUtils.degToRad(targetFovDegrees),
          }
        : null,
    [referenceView, targetFovDegrees],
  );
  const trajectoryMap = useMemo(
    () => (pose ? buildTrajectoryMap(pose) : null),
    [pose],
  );
  const views = useMemo(
    () =>
      targetReferenceView
        ? cameraViewsFromSegments(
            segments,
            targetReferenceView,
            allowBelowFloor,
          )
        : [],
    [allowBelowFloor, segments, targetReferenceView],
  );
  const requiredFrameCount =
    views.length + (closedLoop && views.length >= 3 ? 1 : 0);
  const minimumFrameCount = Math.min(
    MAX_FRAME_COUNT,
    Math.max(MIN_FRAME_COUNT, requiredFrameCount),
  );
  const cameraPivots = useMemo(
    () => trajectoryPivotsFromSegments(segments),
    [segments],
  );
  const selectedPartIndex = selectedSegmentId
    ? segments.findIndex((segment) => segment.id === selectedSegmentId)
    : -1;
  const selectedPart =
    selectedPartIndex >= 0 ? segments[selectedPartIndex]! : null;
  const partLookAtTargets = useMemo(
    () =>
      segments.reduce<TrajectoryPoint[]>((targets, segment) => {
        const target = segment.look_at_target;
        if (
          target &&
          !targets.some(
            (current) =>
              new THREE.Vector3(...current).distanceTo(
                new THREE.Vector3(...target),
              ) <= 1e-5,
          )
        ) {
          targets.push(target);
        }
        return targets;
      }, []),
    [segments],
  );
  const selectedCameraView = useMemo<CameraView | null>(() => {
    if (!selectedPivot) return null;
    const viewIndex = selectedPivot.pivotNumber - 1;
    const view = views[viewIndex];
    return view
      ? {
          id: view.id,
          ...sampleCameraPivot(views, viewIndex, {
            directionMode,
            directionTarget: effectiveDirectionTarget,
            closedLoop,
            allowBelowFloor,
          }),
        }
      : null;
  }, [
    allowBelowFloor,
    closedLoop,
    directionMode,
    effectiveDirectionTarget,
    selectedPivot,
    views,
  ]);
  const ready = pose && referenceView && trajectoryMap;
  const editSnapshot = useMemo(
    () => ({
      segments,
      trajectorySmoothingVersion,
      directionMode,
      directionTarget,
      closedLoop,
      allowBelowFloor,
      targetFovDegrees,
    }),
    [
      segments,
      trajectorySmoothingVersion,
      directionMode,
      directionTarget,
      closedLoop,
      allowBelowFloor,
      targetFovDegrees,
    ],
  );
  const edits = useEditHistory(
    editSnapshot,
    pose?.depthUri ?? null,
    (state) => {
      setSegments(state.segments);
      setTrajectorySmoothingVersion(state.trajectorySmoothingVersion);
      setDirectionMode(state.directionMode);
      setDirectionTarget(state.directionTarget);
      setClosedLoop(state.closedLoop);
      setAllowBelowFloor(state.allowBelowFloor);
      setTargetFovDegrees(state.targetFovDegrees);
      setSelectedPivot(null);
      setSelectedSegmentId(null);
      setPreviewing(false);
      setAddingPivot(false);
      setPlacingDirectionTarget(false);
      setPlacingLookAtSegmentId(null);
      setPendingDirectionMode(null);
      setError(null);
      setNotice(null);
    },
  );
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
      if (
        event.target instanceof Element &&
        event.target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="dialog"]',
        )
      )
        return;
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === "z") {
        event.preventDefault();
        if (event.shiftKey) edits.redo();
        else edits.undo();
      } else if (event.ctrlKey && key === "y") {
        event.preventDefault();
        edits.redo();
      } else if (
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !previewing &&
        !addingPivot &&
        !placingDirectionTarget &&
        selectedPivot &&
        (key === "delete" || key === "backspace")
      ) {
        event.preventDefault();
        deletePathPivot(selectedPivot);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  function smoothPath() {
    setSegments(smoothTrajectorySegments(segments, closedLoop));
    setTrajectorySmoothingVersion(TRAJECTORY_SMOOTHING_VERSION);
    setPreviewing(false);
    setAddingPivot(false);
    setError(null);
    setNotice(
      "Path smoothed. Camera aim and timing are preserved. Undo to compare.",
    );
  }

  function materializeSmoothedTrajectory(): TrajectorySegment[] {
    const materialized = materializeTrajectorySmoothing(
      segments,
      trajectorySmoothingVersion,
    );
    if (materialized.version !== trajectorySmoothingVersion) {
      setSegments(materialized.segments);
      setTrajectorySmoothingVersion(materialized.version);
    }
    return materialized.segments;
  }

  useEffect(() => {
    if (frameCount >= minimumFrameCount) return;
    setFrameCount(minimumFrameCount);
    setPreviewing(false);
  }, [frameCount, minimumFrameCount]);

  function updateDrawnSegments(nextSegments: TrajectorySegment[]) {
    setSegments(nextSegments);
    setClosedLoop(false);
    setAddingPivot(false);
    setPreviewing(false);
    setError(null);
  }

  function completeDrawnSegments(nextSegments: TrajectorySegment[]) {
    updateDrawnSegments(nextSegments);
    const lastSegment = nextSegments.at(-1);
    setSelectedSegmentId(lastSegment?.id ?? null);
    setSelectedPivot(
      lastSegment
        ? {
            segmentId: lastSegment.id,
            pointIndex: lastSegment.points.length - 1,
            pivotNumber: trajectoryPathFromSegments(nextSegments).length,
          }
        : null,
    );
  }

  function movePathPoint(
    segmentId: string,
    pointIndex: number,
    position: TrajectoryPoint,
  ) {
    setSegments((current) =>
      moveTrajectoryPoint(current, segmentId, pointIndex, position),
    );
    setPreviewing(false);
    setSelectedSegmentId(segmentId);
    setError(null);
  }

  function applyPathShape(
    shape: TrajectoryShape,
    scopeSegmentId: string | null,
  ) {
    const materialized = materializeTrajectorySmoothing(
      segments,
      trajectorySmoothingVersion,
    );
    const shaped = reshapeTrajectorySegments(
      materialized.segments,
      shape,
      drawingView ?? cameraDrawingView(referenceView!.quaternion),
      scopeSegmentId,
      closedLoop,
      allowBelowFloor,
    );
    if (!shaped) {
      setError(
        allowBelowFloor
          ? "That shape would collapse cameras together. Try another part or rotate the 3D view."
          : "That shape would collapse cameras together or move them below the floor. Try another part or rotate the 3D view.",
      );
      return;
    }
    setSegments(shaped);
    setTrajectorySmoothingVersion(materialized.version);
    setAddingPivot(false);
    setPreviewing(false);
    setError(null);
    const scopeLabel = scopeSegmentId
      ? `Part ${segments.findIndex((segment) => segment.id === scopeSegmentId) + 1}`
      : "Whole path";
    const actionLabel =
      shape === "straighten"
        ? "straightened"
        : shape === "circular"
          ? "made circular"
          : "flattened";
    setNotice(
      `${scopeLabel} ${actionLabel}. Camera aim and timing stayed the same.`,
    );
  }

  function chooseDirectionMode(mode: CameraDirectionMode) {
    if (isPointDirectionMode(mode) && !directionTarget) {
      setPlacingLookAtSegmentId(null);
      setPendingDirectionMode(mode);
      setPlacingDirectionTarget(true);
      setPreviewing(false);
      setError(null);
      return;
    }
    if (isPointDirectionMode(mode)) {
      setSegments((current) =>
        current.map((segment) => ({ ...segment, look_at_target: null })),
      );
    }
    setDirectionMode(mode);
    setPlacingLookAtSegmentId(null);
    setPendingDirectionMode(null);
    setPlacingDirectionTarget(false);
    setPreviewing(false);
    setError(null);
  }

  function choosePartDirectionTarget(segmentId: string) {
    setPlacingLookAtSegmentId(segmentId);
    setPendingDirectionMode(null);
    setPlacingDirectionTarget(true);
    setPreviewing(false);
    setError(null);
  }

  function setPartLookAtTarget(
    segmentId: string,
    target: TrajectoryPoint | null,
  ) {
    setSegments((current) =>
      current.map((segment) =>
        segment.id === segmentId
          ? { ...segment, look_at_target: target }
          : segment,
      ),
    );
    setPreviewing(false);
    setError(null);
  }

  function removePartLookAtTarget(segmentId: string) {
    setPartLookAtTarget(segmentId, null);
    const partNumber =
      segments.findIndex((segment) => segment.id === segmentId) + 1;
    setNotice(`Part ${partNumber} now uses the whole-path camera behavior.`);
  }

  function limitLookAtTargetToPart(segmentId: string) {
    if (!effectiveDirectionTarget) return;
    setSegments((current) =>
      current.map((segment) => ({
        ...segment,
        look_at_target:
          segment.id === segmentId ? effectiveDirectionTarget : null,
      })),
    );
    setDirectionMode("manual");
    setPreviewing(false);
    setError(null);
    const partNumber =
      segments.findIndex((segment) => segment.id === segmentId) + 1;
    setNotice(
      `Only Part ${partNumber} looks at that point. Other parts keep their camera angles.`,
    );
  }

  function placeDirectionTarget(position: TrajectoryPoint) {
    const targetViews =
      placingLookAtSegmentId && targetReferenceView
        ? cameraViewsFromSegments(
            segments.map((segment) =>
              segment.id === placingLookAtSegmentId
                ? { ...segment, look_at_target: position }
                : segment,
            ),
            targetReferenceView,
            allowBelowFloor,
          )
        : views;
    if (
      !(placingLookAtSegmentId
        ? partLookAtTargetIsClearOfPath(
            targetViews,
            position,
            closedLoop,
            Math.max(0.02, (trajectoryMap?.space.radius ?? 1) * 0.015),
            allowBelowFloor,
          )
        : cameraTargetIsClearOfPath(
            targetViews,
            position,
            closedLoop,
            Math.max(0.02, (trajectoryMap?.space.radius ?? 1) * 0.015),
            undefined,
            allowBelowFloor,
          ))
    ) {
      setError(
        "That point is on the camera path. Pick a nearby object away from the blue line.",
      );
      return;
    }
    if (placingLookAtSegmentId) {
      setPartLookAtTarget(placingLookAtSegmentId, position);
      const partNumber =
        segments.findIndex((segment) => segment.id === placingLookAtSegmentId) +
        1;
      setPlacingLookAtSegmentId(null);
      setPlacingDirectionTarget(false);
      setNotice(
        `Part ${partNumber} now looks at that point. Other parts keep their current behavior.`,
      );
      return;
    }
    setSegments((current) =>
      current.map((segment) => ({ ...segment, look_at_target: null })),
    );
    setDirectionTarget(position);
    const nextMode =
      pendingDirectionMode ??
      (isPointDirectionMode(directionMode) ? directionMode : "look_at");
    setDirectionMode(nextMode);
    setPlacingLookAtSegmentId(null);
    setPendingDirectionMode(null);
    setPlacingDirectionTarget(false);
    setPreviewing(false);
    setError(null);
    setNotice(
      nextMode === "look_at"
        ? "Every camera now points at the selected scene point."
        : "Every camera now points away from the selected scene point.",
    );
  }

  function addPathPivot(position: TrajectoryPoint, pathProgress: number) {
    const inserted = insertTrajectoryPivot(
      segments,
      position,
      pathProgress,
      closedLoop,
      allowBelowFloor,
    );
    setAddingPivot(false);
    if (!inserted) {
      setError("Could not add a pivot there. Choose another part of the path.");
      return;
    }
    setSegments(inserted.segments);
    setSelectedSegmentId(inserted.segmentId);
    setSelectedPivot({
      segmentId: inserted.segmentId,
      pointIndex: inserted.pointIndex,
      pivotNumber: inserted.pivotNumber,
    });
    setPreviewing(false);
    setError(null);
  }

  function selectPathPivot(
    segmentId: string,
    pointIndex: number,
    pivotNumber: number,
  ) {
    setSelectedPivot({ segmentId, pointIndex, pivotNumber });
    setSelectedSegmentId(segmentId);
    setAddingPivot(false);
    setError(null);
  }

  function setPathPivotCameraAngle(
    segmentId: string,
    pointIndex: number,
    quaternion: TrajectoryQuaternion,
  ) {
    setSegments((current) =>
      directionMode === "manual"
        ? setTrajectoryPointQuaternion(
            current,
            segmentId,
            pointIndex,
            quaternion,
          )
        : setTrajectoryPointDirectionOverride(
            current,
            segmentId,
            pointIndex,
            quaternion,
          ),
    );
    setPreviewing(false);
    setError(null);
  }

  function clearPath() {
    setSegments([]);
    setTrajectorySmoothingVersion(0);
    setSelectedSegmentId(null);
    setSelectedPivot(null);
    setAddingPivot(false);
    setPreviewing(false);
    setPlacingLookAtSegmentId(null);
    setClosedLoop(false);
    setError(null);
  }

  function updateAllowBelowFloor(nextAllowBelowFloor: boolean) {
    const belowFloorCount = path.filter(
      (point) => point[1] < TRAJECTORY_FLOOR_Y - 1e-6,
    ).length;
    if (!nextAllowBelowFloor && belowFloorCount > 0) {
      setError(
        `${belowFloorCount} camera ${belowFloorCount === 1 ? "is" : "are"} below the floor. Move ${belowFloorCount === 1 ? "it" : "them"} above it first.`,
      );
      return;
    }
    setAllowBelowFloor(nextAllowBelowFloor);
    setAddingPivot(false);
    setPreviewing(false);
    setError(null);
  }

  function closePathLoop() {
    if (path.length < 3) return;
    const nextSegments = normalizeClosedTrajectorySegments(segments);
    const nextPivots = trajectoryPivotsFromSegments(nextSegments);
    if (nextPivots.length < 3) {
      setError("A loop needs at least three different camera points.");
      return;
    }
    if (nextPivots.length !== cameraPivots.length) {
      setSegments(nextSegments);
      setSelectedPivot(null);
    }
    setClosedLoop(true);
    setPreviewing(false);
    setError(null);
  }

  function deletePathPart(id: string) {
    const remaining = segments.filter((segment) => segment.id !== id);
    setSegments(remaining);
    if (selectedSegmentId === id) {
      setSelectedSegmentId(remaining.at(-1)?.id ?? null);
    }
    setSelectedPivot(null);
    setPreviewing(false);
    setAddingPivot(false);
    setClosedLoop(false);
    setError(null);
  }

  function deletePathPivot(pivot: SelectedPivot) {
    const nextSegments = deleteTrajectoryPivot(
      segments,
      pivot.segmentId,
      pivot.pointIndex,
    );
    if (!nextSegments) {
      setError("That camera is no longer in the path.");
      return;
    }

    const nextPivots = trajectoryPivotsFromSegments(nextSegments);
    const nextPivot =
      nextPivots[Math.min(pivot.pivotNumber - 1, nextPivots.length - 1)] ??
      null;
    setSegments(nextSegments);
    if (nextPivots.length < 3) setClosedLoop(false);
    setSelectedPivot(
      nextPivot
        ? {
            segmentId: nextPivot.segmentId,
            pointIndex: nextPivot.pointIndex,
            pivotNumber: nextPivot.pivotNumber,
          }
        : null,
    );
    setSelectedSegmentId(nextPivot?.segmentId ?? null);
    setPreviewing(false);
    setAddingPivot(false);
    setError(null);
  }

  function updateFrameCount(nextFrameCount: number) {
    setFrameCount(Math.max(nextFrameCount, minimumFrameCount));
    setPreviewing(false);
  }

  function updateFps(nextFps: number) {
    setFps(nextFps);
    setPreviewing(false);
  }

  function updateTargetFov(nextTargetFovDegrees: number) {
    setTargetFovDegrees(nextTargetFovDegrees);
    setPreviewing(false);
  }

  function updateAspectRatio(nextAspectRatio: CameraTrajectoryAspectRatio) {
    setAspectRatio(nextAspectRatio);
    setPreviewing(false);
  }

  function togglePathPreview() {
    if (views.length < 2) return;
    setAddingPivot(false);
    if (!previewing) materializeSmoothedTrajectory();
    setPreviewing((current) => !current);
    setError(null);
  }

  function setDrawingPanelVisibility(open: boolean) {
    setDrawingPanelOpen(open);
    requestAnimationFrame(() => {
      (open
        ? drawingPanelMinimizeButton
        : drawingPanelRestoreButton
      ).current?.focus();
    });
  }

  function setDirectionPanelVisibility(open: boolean) {
    setDirectionPanelOpen(open);
    requestAnimationFrame(() => {
      (open
        ? directionPanelMinimizeButton
        : directionPanelRestoreButton
      ).current?.focus();
    });
  }

  return (
    <div className="relative h-dvh min-h-dvh overflow-hidden bg-[#0b0c0f] font-sans text-[#f7f5ef]">
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
          className="flex h-full min-h-0 flex-col"
          aria-hidden={homeOpen}
          inert={homeOpen ? true : undefined}
        >
          {pose.depthUri === EXAMPLE_DEPTH && (
            <div className="border-b border-white/10 bg-[#151b2c] px-4 py-2 text-xs text-white/70">
              Example scene · Move the cameras, smooth the path, and press
              Preview. No signup needed to explore.
              {!canViewHistory &&
                " Sign in and verify your phone only when you want to generate a video or upload your own image."}
            </div>
          )}
          <header className="relative z-40 grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-end gap-2 border-b border-white/10 bg-[#0f1014] px-3 py-2 md:grid-cols-[minmax(0,1fr)_auto] md:gap-3 md:px-4">
            <div className="hidden md:block">
              <h1 className="text-lg font-semibold tracking-[-0.025em]">
                Plan the camera move
              </h1>
              <p className="mt-0.5 text-xs text-white/45">
                {views.length >= 2
                  ? `3D path → ${frameCount} video frames`
                  : "Draw, rotate, and continue"}
              </p>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                aria-label="Undo"
                title="Undo (⌘Z / Ctrl+Z)"
                disabled={!edits.canUndo || submitting || savingDraft}
                onClick={edits.undo}
                className="grid h-11 w-11 place-items-center rounded-md border border-white/15 text-white/65 hover:bg-white/10 disabled:opacity-25"
              >
                <Undo2 className="h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label="Redo"
                title="Redo (⌘⇧Z / Ctrl+Shift+Z)"
                disabled={!edits.canRedo || submitting || savingDraft}
                onClick={edits.redo}
                className="grid h-11 w-11 place-items-center rounded-md border border-white/15 text-white/65 hover:bg-white/10 disabled:opacity-25"
              >
                <Redo2 className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setHistoryOpen(true)}
                className="flex h-11 items-center justify-center gap-2 rounded-md border border-white/15 px-3 text-sm text-white/65 transition hover:border-white/30 hover:bg-white/[0.06] hover:text-white disabled:opacity-30"
              >
                <HistoryIcon className="h-4 w-4" />
                <span className="hidden lg:inline">Saved</span>
                {queueItems.some((item) =>
                  item.variants.some((variant) => variant.video_uri === null),
                ) && (
                  <span className="rounded bg-[#a9bcff]/15 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-[#c0cdff]">
                    {
                      queueItems.filter((item) =>
                        item.variants.some(
                          (variant) => variant.video_uri === null,
                        ),
                      ).length
                    }
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={goHome}
                aria-label="Home"
                title="Home"
                className="flex h-11 items-center justify-center gap-2 rounded-md border border-white/15 px-3 text-sm text-white/65 transition hover:border-white/30 hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a9bcff] active:translate-y-px disabled:opacity-30"
              >
                <House className="h-4 w-4" />
                <span className="hidden sm:inline">Home</span>
              </button>
            </div>
          </header>

          <main className="relative min-h-0 flex-1 overflow-hidden bg-[#111216]">
            <div
              className={
                previewing
                  ? "absolute inset-0 grid place-items-center bg-[#07080a] p-4 sm:p-8"
                  : "absolute inset-0"
              }
            >
              <div
                className={
                  previewing
                    ? aspectRatio === "9:16"
                      ? "relative h-full max-h-full max-w-full overflow-hidden rounded-lg border border-white/15 bg-black shadow-2xl"
                      : "relative aspect-video w-full max-w-[min(72rem,130dvh)] overflow-hidden rounded-lg border border-white/15 bg-black shadow-2xl"
                    : "h-full w-full"
                }
                style={
                  previewing
                    ? {
                        aspectRatio: `${targetFormat.width} / ${targetFormat.height}`,
                      }
                    : undefined
                }
              >
                <CameraTrajectoryCanvas
                  key={pose.imageUrl}
                  pose={pose}
                  referenceView={referenceView}
                  views={views}
                  segments={segments}
                  selectedPivot={selectedPivot}
                  addingPivot={addingPivot}
                  previewing={previewing}
                  disabled={false}
                  frameCount={frameCount}
                  previewSeconds={frameCount / fps}
                  frameWidth={targetFormat.width}
                  frameHeight={targetFormat.height}
                  directionMode={directionMode}
                  directionTarget={effectiveDirectionTarget ?? null}
                  directionTargetCandidates={trajectoryMap.worldPoints}
                  placingDirectionTarget={placingDirectionTarget}
                  placingDirectionTargetMode={
                    pendingDirectionMode ??
                    (isPointDirectionMode(directionMode)
                      ? directionMode
                      : "look_at")
                  }
                  closedLoop={closedLoop}
                  allowBelowFloor={allowBelowFloor}
                  onPreviewDone={() => setPreviewing(false)}
                  onDrawingViewChange={setDrawingView}
                  onPointChange={movePathPoint}
                  onPointSelect={selectPathPivot}
                  onPivotAdd={addPathPivot}
                  onDirectionTargetChange={placeDirectionTarget}
                  onDirectionTargetCancel={() => {
                    setPlacingDirectionTarget(false);
                    setPendingDirectionMode(null);
                    setPlacingLookAtSegmentId(null);
                    setError(null);
                  }}
                  onDirectionTargetMiss={() =>
                    setError(
                      "No reconstructed scene point there. Click on the visible point cloud.",
                    )
                  }
                />

                {previewing && (
                  <>
                    <div className="pointer-events-none absolute left-3 top-3 rounded-md border border-white/15 bg-[#0b0c0f]/85 px-3 py-2 text-xs font-medium text-white/75 backdrop-blur">
                      Camera preview · {aspectRatio}
                    </div>
                    <button
                      type="button"
                      onClick={togglePathPreview}
                      className="absolute right-3 top-3 flex h-9 items-center gap-2 rounded-md bg-white px-3 text-xs font-semibold text-[#101114] shadow-lg transition hover:bg-white/90 active:translate-y-px"
                    >
                      <Pause className="h-3.5 w-3.5" />
                      Stop preview
                    </button>
                  </>
                )}
              </div>
            </div>

            {!previewing && (
              <div
                id="trajectory-drawing-panel"
                hidden={!drawingPanelOpen || placingDirectionTarget}
                inert={placingDirectionTarget ? true : undefined}
                data-camera-drawing-panel-size={
                  DRAWING_PANEL_SIZES[drawingPanelSizeIndex]!.label
                }
                className={`absolute left-3 top-3 z-30 max-h-[calc(100%-11rem)] max-w-[calc(100%-1.5rem)] overflow-y-auto overscroll-contain rounded-xl border border-white/15 bg-[#0b0c0f]/94 p-3 shadow-2xl transition-[width] duration-200 backdrop-blur-xl xl:max-h-[calc(100%-7rem)] ${DRAWING_PANEL_SIZES[drawingPanelSizeIndex]!.widthClass}`}
              >
                <div className="mb-2 flex items-center gap-2.5 border-b border-white/10 pb-2">
                  <button
                    type="button"
                    onClick={chooseNewImage}
                    className="group w-16 shrink-0 overflow-hidden rounded bg-black disabled:opacity-30"
                  >
                    <img
                      src={previewUrl ?? pose.imageUrl}
                      alt="Change reference image"
                      className="aspect-video w-full object-cover transition group-hover:opacity-80"
                    />
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#f4b860]">
                      Reference image
                    </p>
                    <p className="mt-0.5 text-[11px] text-white/55">
                      Not frame 1
                    </p>
                    <p
                      className="mt-0.5 truncate text-[10px] text-white/30"
                      title={fileName}
                    >
                      {fileName}
                    </p>
                  </div>
                  <button
                    ref={drawingPanelMinimizeButton}
                    type="button"
                    data-overlay-toggle="path"
                    aria-label="Minimize path panel"
                    aria-controls="trajectory-drawing-panel"
                    aria-expanded="true"
                    title="Minimize path panel"
                    onClick={() => setDrawingPanelVisibility(false)}
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-white/10 text-white/45 transition hover:border-white/25 hover:bg-white/[0.07] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a9bcff] active:translate-y-px"
                  >
                    <PanelLeftClose className="h-4 w-4" />
                  </button>
                </div>

                <TrajectoryDrawPad
                  points={trajectoryMap.worldPoints}
                  referencePosition={referenceView.position}
                  segments={segments}
                  selectedSegmentId={selectedSegmentId}
                  path={path}
                  view={
                    drawingView ?? cameraDrawingView(referenceView.quaternion)
                  }
                  space={trajectoryMap.space}
                  previewing={previewing}
                  addingPivot={addingPivot}
                  closedLoop={closedLoop}
                  allowBelowFloor={allowBelowFloor}
                  disabled={false}
                  panelSizeIndex={drawingPanelSizeIndex}
                  onChange={updateDrawnSegments}
                  onComplete={completeDrawnSegments}
                  onSelectPart={setSelectedSegmentId}
                  onDeletePart={deletePathPart}
                  onApplyShape={applyPathShape}
                  onSmooth={smoothPath}
                  onTogglePivot={() => {
                    setAddingPivot((current) => !current);
                    setPreviewing(false);
                    setError(null);
                  }}
                  onCloseLoop={closePathLoop}
                  onAllowBelowFloorChange={updateAllowBelowFloor}
                  onClear={clearPath}
                  onPlay={togglePathPreview}
                  onPanelSizeChange={setDrawingPanelSizeIndex}
                />
              </div>
            )}

            {!previewing && !placingDirectionTarget && !drawingPanelOpen && (
              <button
                ref={drawingPanelRestoreButton}
                type="button"
                data-overlay-toggle="path"
                aria-label="Restore path panel"
                aria-controls="trajectory-drawing-panel"
                aria-expanded="false"
                onClick={() => setDrawingPanelVisibility(true)}
                className="absolute left-3 top-3 z-30 flex h-10 items-center gap-2 rounded-lg border border-white/15 bg-[#0b0c0f]/94 px-3 text-xs font-semibold text-white/70 shadow-xl backdrop-blur-xl transition hover:border-white/30 hover:bg-[#17181d] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a9bcff] active:translate-y-px"
              >
                <PanelLeftOpen className="h-4 w-4" />
                Path
              </button>
            )}

            {!previewing && views.length >= 1 && (
              <CameraDirectionPanel
                pose={pose}
                pivots={cameraPivots}
                selectedPivot={selectedPivot}
                selectedView={selectedCameraView}
                aspectRatio={aspectRatio}
                frameWidth={targetFormat.width}
                frameHeight={targetFormat.height}
                directionMode={directionMode}
                hasDirectionTarget={directionTarget !== null}
                selectedPart={
                  selectedPart
                    ? {
                        id: selectedPart.id,
                        number: selectedPartIndex + 1,
                        hasLookAtTarget: selectedPart.look_at_target != null,
                      }
                    : null
                }
                disabled={addingPivot}
                hidden={!directionPanelOpen || placingDirectionTarget}
                minimizeButtonRef={directionPanelMinimizeButton}
                onMinimize={() => setDirectionPanelVisibility(false)}
                onSelect={(pivot) =>
                  selectPathPivot(
                    pivot.segmentId,
                    pivot.pointIndex,
                    pivot.pivotNumber,
                  )
                }
                onAngleChange={(pivot, quaternion) => {
                  setPathPivotCameraAngle(
                    pivot.segmentId,
                    pivot.pointIndex,
                    quaternion,
                  );
                }}
                onDirectionModeChange={chooseDirectionMode}
                onChooseDirectionTarget={() => {
                  setPlacingLookAtSegmentId(null);
                  if (isPointDirectionMode(directionMode)) {
                    setPendingDirectionMode(directionMode);
                  }
                  setPlacingDirectionTarget(true);
                  setPreviewing(false);
                  setError(null);
                }}
                onChoosePartDirectionTarget={choosePartDirectionTarget}
                onRemovePartDirectionTarget={removePartLookAtTarget}
                onLimitDirectionTargetToPart={limitLookAtTargetToPart}
                onDelete={deletePathPivot}
              />
            )}

            {!previewing &&
              !placingDirectionTarget &&
              views.length >= 1 &&
              !directionPanelOpen && (
                <button
                  ref={directionPanelRestoreButton}
                  type="button"
                  data-overlay-toggle="direction"
                  aria-label="Restore camera direction panel"
                  aria-controls="camera-direction-panel"
                  aria-expanded="false"
                  onClick={() => setDirectionPanelVisibility(true)}
                  className="absolute right-3 top-3 z-30 flex h-10 items-center gap-2 rounded-lg border border-white/15 bg-[#0b0c0f]/94 px-3 text-xs font-semibold text-white/70 shadow-xl backdrop-blur-xl transition hover:border-white/30 hover:bg-[#17181d] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a9bcff] active:translate-y-px"
                >
                  Aim
                  <PanelRightOpen className="h-4 w-4" />
                </button>
              )}

            {!previewing && (
              <div className="absolute inset-x-3 bottom-3 z-20 mx-auto max-w-6xl">
                {error && (
                  <div className="mb-2 rounded-md border border-red-400/30 bg-red-950/90 px-3 py-2 text-center text-xs text-red-100 backdrop-blur">
                    {error}
                  </div>
                )}
                {notice && (
                  <div
                    role="status"
                    aria-live="polite"
                    className="mb-2 rounded-md border border-emerald-300/25 bg-emerald-950/90 px-3 py-2 text-center text-xs text-emerald-100 backdrop-blur"
                  >
                    {notice}
                  </div>
                )}

                <div
                  aria-hidden={placingDirectionTarget ? true : undefined}
                  inert={placingDirectionTarget ? true : undefined}
                  className={`flex flex-wrap items-end gap-2 rounded-xl border border-white/15 bg-[#0b0c0f]/92 p-2.5 pl-4 shadow-2xl backdrop-blur-xl sm:gap-3 xl:flex-nowrap ${placingDirectionTarget ? "pointer-events-none invisible" : ""}`}
                >
                  <OutputNumberInput
                    label="FOV°"
                    value={targetFovDegrees}
                    min={MIN_TARGET_FOV_DEGREES}
                    max={MAX_TARGET_FOV_DEGREES}
                    disabled={false}
                    onChange={updateTargetFov}
                  />

                  <button
                    type="button"
                    disabled={savingDraft || submitting}
                    onClick={() => void saveDraft()}
                    className="flex h-11 min-w-28 items-center justify-center gap-2 rounded-md border border-white/20 px-3 text-sm font-semibold text-white/75 transition hover:border-white/35 hover:bg-white/[0.07] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 active:translate-y-px disabled:cursor-wait disabled:opacity-35 sm:px-4"
                  >
                    {savingDraft ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4" />
                    )}
                    {savingDraft ? "Saving…" : "Save draft"}
                  </button>

                  <label className="block min-w-48 flex-1">
                    <span className="mb-1 block text-[11px] font-medium text-white/55">
                      What should happen?{" "}
                      <span className="text-[#a9bcff]"></span>
                    </span>
                    <input
                      aria-label="Video prompt"
                      value={prompt}
                      onChange={(event) => setPrompt(event.target.value)}
                      maxLength={1000}
                      placeholder="Example: Slowly orbit left as the person walks forward"
                      className="h-11 w-full rounded-md border border-white/15 bg-white/[0.06] px-3 text-sm text-white outline-none transition placeholder:text-white/30 hover:border-white/25 focus:border-[#a9bcff] focus:ring-2 focus:ring-[#8ca8ff]/20 disabled:opacity-40"
                    />
                  </label>

                  <button
                    type="button"
                    disabled={
                      !prompt.trim() ||
                      views.length < 2 ||
                      frameCount < requiredFrameCount ||
                      (!PORTRAIT_GENERATION_ENABLED &&
                        aspectRatio === "9:16") ||
                      submitting ||
                      savingDraft
                    }
                    onClick={() => void generate()}
                    className="flex h-11 min-w-28 items-center justify-center gap-2 rounded-md bg-[#a9bcff] px-3 text-sm font-semibold text-[#10131c] transition hover:bg-[#c0cdff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-35 sm:min-w-36 sm:px-4"
                  >
                    {submitting ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Sparkles className="h-4 w-4" />
                    )}
                    {views.length < 2
                      ? "Draw a path"
                      : !PORTRAIT_GENERATION_ENABLED && aspectRatio === "9:16"
                        ? "9:16 unavailable"
                        : requiredFrameCount > MAX_FRAME_COUNT
                          ? "Remove path points"
                          : frameCount < requiredFrameCount
                            ? `Use ${requiredFrameCount}+ frames`
                            : !prompt.trim()
                              ? "Add a prompt"
                              : submitting
                                ? `Adding ${seedCount}…`
                                : `Queue ${seedCount} ${seedCount === 1 ? "video" : "videos"}`}
                  </button>
                </div>
              </div>
            )}
          </main>
        </div>
      )}

      {ready && homeOpen && (
        <div className="absolute inset-0 z-[60] bg-[#0b0c0f]">
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

function CameraDirectionPanel({
  pose,
  pivots,
  selectedPivot,
  selectedView,
  aspectRatio,
  frameWidth,
  frameHeight,
  directionMode,
  hasDirectionTarget,
  selectedPart,
  disabled,
  hidden,
  minimizeButtonRef,
  onMinimize,
  onSelect,
  onAngleChange,
  onDirectionModeChange,
  onChooseDirectionTarget,
  onChoosePartDirectionTarget,
  onRemovePartDirectionTarget,
  onLimitDirectionTargetToPart,
  onDelete,
}: {
  pose: PosedView;
  pivots: readonly TrajectoryPivot[];
  selectedPivot: SelectedPivot | null;
  selectedView: CameraView | null;
  aspectRatio: CameraTrajectoryAspectRatio;
  frameWidth: number;
  frameHeight: number;
  directionMode: CameraDirectionMode;
  hasDirectionTarget: boolean;
  selectedPart: {
    id: string;
    number: number;
    hasLookAtTarget: boolean;
  } | null;
  disabled: boolean;
  hidden: boolean;
  minimizeButtonRef: RefObject<HTMLButtonElement | null>;
  onMinimize: () => void;
  onSelect: (pivot: TrajectoryPivot) => void;
  onAngleChange: (
    pivot: SelectedPivot,
    quaternion: TrajectoryQuaternion,
  ) => void;
  onDirectionModeChange: (mode: CameraDirectionMode) => void;
  onChooseDirectionTarget: () => void;
  onChoosePartDirectionTarget: (segmentId: string) => void;
  onRemovePartDirectionTarget: (segmentId: string) => void;
  onLimitDirectionTargetToPart: (segmentId: string) => void;
  onDelete: (pivot: SelectedPivot) => void;
}) {
  const [previewQuaternion, setPreviewQuaternion] =
    useState<TrajectoryQuaternion | null>(null);
  const aimDrag = useRef<{
    pointerId: number;
    target: HTMLDivElement;
    pivot: SelectedPivot;
    startX: number;
    startY: number;
    startAim: { yaw: number; pitch: number };
    quaternion: TrajectoryQuaternion;
    moved: boolean;
  } | null>(null);
  const displayedQuaternion =
    previewQuaternion ?? selectedView?.quaternion ?? null;
  const aim = displayedQuaternion
    ? cameraAimDegrees(displayedQuaternion)
    : null;
  const pointDirectionMode = isPointDirectionMode(directionMode);
  const selectedPivotUsesPartTarget = Boolean(
    selectedPivot &&
    pivots.find((pivot) => pivot.pivotNumber === selectedPivot.pivotNumber)
      ?.hasLookAtTarget,
  );
  const selectedUsesPointTarget =
    pointDirectionMode || selectedPivotUsesPartTarget;

  useEffect(() => {
    const activeDrag = aimDrag.current;
    aimDrag.current = null;
    if (activeDrag?.target.hasPointerCapture(activeDrag.pointerId)) {
      activeDrag.target.releasePointerCapture(activeDrag.pointerId);
    }
    setPreviewQuaternion(selectedView?.quaternion ?? null);
  }, [selectedPivot, selectedView]);

  function startAimDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (
      disabled ||
      selectedUsesPointTarget ||
      event.button !== 0 ||
      !selectedPivot ||
      !displayedQuaternion
    )
      return;
    event.currentTarget.setPointerCapture(event.pointerId);
    aimDrag.current = {
      pointerId: event.pointerId,
      target: event.currentTarget,
      pivot: selectedPivot,
      startX: event.clientX,
      startY: event.clientY,
      startAim: cameraAimDegrees(displayedQuaternion),
      quaternion: displayedQuaternion,
      moved: false,
    };
  }

  function continueAimDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const activeDrag = aimDrag.current;
    if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
    const horizontalPixels = event.clientX - activeDrag.startX;
    const verticalPixels = event.clientY - activeDrag.startY;
    if (!activeDrag.moved && Math.hypot(horizontalPixels, verticalPixels) < 3) {
      return;
    }
    activeDrag.moved = true;
    activeDrag.quaternion = cameraQuaternionFromAim(
      activeDrag.startAim.yaw + horizontalPixels * 0.3,
      activeDrag.startAim.pitch - verticalPixels * 0.3,
    );
    setPreviewQuaternion(activeDrag.quaternion);
  }

  function finishAimDrag(
    event: ReactPointerEvent<HTMLDivElement>,
    commit: boolean,
  ) {
    const activeDrag = aimDrag.current;
    if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
    aimDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (commit && activeDrag.moved) {
      onAngleChange(activeDrag.pivot, activeDrag.quaternion);
    } else {
      setPreviewQuaternion(selectedView?.quaternion ?? null);
    }
  }

  function nudgeAim(yawDelta: number, pitchDelta: number) {
    if (disabled || selectedUsesPointTarget || !selectedPivot || !aim) return;
    const quaternion = cameraQuaternionFromAim(
      aim.yaw + yawDelta,
      aim.pitch + pitchDelta,
    );
    setPreviewQuaternion(quaternion);
    onAngleChange(selectedPivot, quaternion);
  }

  return (
    <aside
      id="camera-direction-panel"
      hidden={hidden}
      aria-label="Camera direction"
      className="absolute right-3 top-3 z-20 max-h-[calc(100%-7rem)] w-[calc(50%-1.125rem)] max-w-[22rem] overflow-y-auto rounded-xl border border-white/15 bg-[#0b0c0f]/94 p-3 shadow-2xl backdrop-blur-xl"
    >
      <div className="flex items-start justify-between gap-3 border-b border-white/10 pb-2.5">
        <div>
          <h2 className="text-sm font-semibold text-white">Camera direction</h2>
          <p className="mt-1 text-[11px] leading-4 text-white/45">
            Select a camera to move, aim, or delete it.
          </p>
        </div>
        <button
          ref={minimizeButtonRef}
          type="button"
          data-overlay-toggle="direction"
          aria-label="Minimize camera direction panel"
          aria-controls="camera-direction-panel"
          aria-expanded="true"
          title="Minimize camera direction panel"
          onClick={onMinimize}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-white/10 text-white/45 transition hover:border-white/25 hover:bg-white/[0.07] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a9bcff] active:translate-y-px"
        >
          <PanelRightClose className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <div
          aria-label="Choose camera point"
          className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto py-1"
        >
          {pivots.map((pivot) => {
            const selected = pivot.pivotNumber === selectedPivot?.pivotNumber;
            const partTargeted = pivot.hasLookAtTarget;
            return (
              <button
                key={`${pivot.segmentId}:${pivot.pointIndex}`}
                type="button"
                data-camera-point={pivot.pivotNumber}
                data-part-look-at-camera={partTargeted ? "true" : "false"}
                aria-label={`Select camera at point ${pivot.pivotNumber}`}
                aria-pressed={selected}
                onClick={() => onSelect(pivot)}
                className={`grid h-8 w-8 shrink-0 place-items-center rounded-md border text-xs font-semibold tabular-nums transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a9bcff] active:translate-y-px ${
                  selected
                    ? partTargeted
                      ? "border-[#f4b860] bg-[#f4b860] text-[#10131c]"
                      : "border-white bg-white text-[#10131c]"
                    : partTargeted
                      ? "border-[#f4b860]/55 bg-[#f4b860]/10 text-[#ffd18d] hover:border-[#f4b860] hover:bg-[#f4b860]/20"
                      : "border-white/15 bg-white/[0.06] text-white/60 hover:border-white/30 hover:text-white"
                } ${!pointDirectionMode && pivot.hasCameraAngle ? "ring-1 ring-[#a9bcff]/80 ring-offset-1 ring-offset-[#0b0c0f]" : ""}`}
              >
                {pivot.pivotNumber}
              </button>
            );
          })}
        </div>
        {selectedPivot && (
          <button
            type="button"
            data-delete-camera-point={selectedPivot.pivotNumber}
            aria-label={`Delete camera point ${selectedPivot.pivotNumber}`}
            disabled={disabled}
            onClick={() => onDelete(selectedPivot)}
            title={`Delete camera ${selectedPivot.pivotNumber} (Delete / Backspace)`}
            className="flex h-8 shrink-0 items-center justify-center gap-1 rounded-md border border-red-400/25 bg-red-500/[0.06] px-2 text-[11px] font-medium text-red-200/70 transition hover:border-red-400/45 hover:bg-red-500/10 hover:text-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete {selectedPivot.pivotNumber}
          </button>
        )}
      </div>

      {selectedPivot && selectedView && aim ? (
        <>
          <div
            role={selectedUsesPointTarget ? "img" : "application"}
            aria-label={
              selectedUsesPointTarget
                ? "Point-cloud preview from the selected camera"
                : "Drag the point-cloud preview to aim the selected camera"
            }
            data-camera-aim-preview={selectedPivot.pivotNumber}
            onPointerDown={selectedUsesPointTarget ? undefined : startAimDrag}
            onPointerMove={
              selectedUsesPointTarget ? undefined : continueAimDrag
            }
            onPointerUp={
              selectedUsesPointTarget
                ? undefined
                : (event) => finishAimDrag(event, true)
            }
            onPointerCancel={
              selectedUsesPointTarget
                ? undefined
                : (event) => finishAimDrag(event, false)
            }
            onLostPointerCapture={
              selectedUsesPointTarget
                ? undefined
                : (event) => finishAimDrag(event, false)
            }
            className={`relative mt-2.5 select-none overflow-hidden rounded-lg border border-white/15 bg-[#090a0d] ${selectedUsesPointTarget ? "touch-auto" : "touch-none"} ${aspectRatio === "9:16" ? "mx-auto w-[58%]" : "w-full"} ${disabled ? "cursor-not-allowed opacity-40" : selectedUsesPointTarget ? "cursor-default" : "cursor-grab active:cursor-grabbing"}`}
            style={{ aspectRatio: `${frameWidth} / ${frameHeight}` }}
          >
            <div
              data-camera-preview-renderer="dense-splats"
              aria-label="Dense point-cloud view from the selected camera"
              className="pointer-events-none absolute inset-0"
            >
              <CameraPointCloudView
                pose={pose}
                view={{
                  ...selectedView,
                  quaternion: displayedQuaternion!,
                }}
              />
            </div>
            <div className="pointer-events-none absolute left-2 top-2 rounded border border-white/15 bg-[#0b0c0f]/80 px-2 py-1 text-[10px] font-medium text-white/65 backdrop-blur">
              Point {selectedPivot.pivotNumber} · dense camera view
            </div>
            <div className="pointer-events-none absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2">
              <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-white/55" />
              <span className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-white/55" />
            </div>
          </div>
          <p className="mt-1.5 text-[10px] leading-4 text-white/35">
            {selectedUsesPointTarget
              ? selectedPivotUsesPartTarget && !pointDirectionMode
                ? "Preview follows this part's target. Other parts keep their own behavior."
                : "Preview follows the chosen target. Pick another camera above to inspect its view."
              : "Drag to aim. Position stays fixed."}
          </p>

          {!selectedUsesPointTarget && (
            <div className="mt-3 space-y-2.5">
              <div>
                <p className="flex items-center justify-between text-[11px] font-medium text-white/60">
                  <span>Yaw · left / right</span>
                  <span className="font-mono text-[10px] tabular-nums text-[#c0cdff]">
                    {Math.round(aim.yaw)}°
                  </span>
                </p>
                <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                  <CameraAimButton
                    label="← Left"
                    disabled={disabled}
                    onClick={() => nudgeAim(-5, 0)}
                  />
                  <CameraAimButton
                    label="Right →"
                    disabled={disabled}
                    onClick={() => nudgeAim(5, 0)}
                  />
                </div>
              </div>
              <div>
                <p className="flex items-center justify-between text-[11px] font-medium text-white/60">
                  <span>Pitch · down / up</span>
                  <span className="font-mono text-[10px] tabular-nums text-[#c0cdff]">
                    {Math.round(aim.pitch)}°
                  </span>
                </p>
                <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                  <CameraAimButton
                    label="↓ Down"
                    disabled={disabled}
                    onClick={() => nudgeAim(0, -5)}
                  />
                  <CameraAimButton
                    label="Up ↑"
                    disabled={disabled}
                    onClick={() => nudgeAim(0, 5)}
                  />
                </div>
              </div>
            </div>
          )}
        </>
      ) : (
        <div
          className={`mt-3 grid place-items-center rounded-lg border border-dashed border-white/15 bg-white/[0.025] px-8 text-center text-xs leading-5 text-white/40 ${aspectRatio === "9:16" ? "mx-auto w-[58%]" : "w-full"}`}
          style={{ aspectRatio: `${frameWidth} / ${frameHeight}` }}
        >
          Choose a point above to aim its camera.
        </div>
      )}
      <div className="mt-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-white/40">
          Camera behavior
        </p>
        <div
          role="group"
          aria-label="Camera behavior"
          className="mt-1.5 grid grid-cols-2 gap-1.5"
        >
          {CAMERA_DIRECTION_PRESETS.map((preset) => {
            const selected = directionMode === preset.mode;
            return (
              <button
                key={preset.mode}
                type="button"
                data-camera-direction-mode={preset.mode}
                aria-pressed={selected}
                title={preset.title}
                onClick={() => onDirectionModeChange(preset.mode)}
                className={`h-8 rounded-md border px-2 text-[11px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a9bcff] active:translate-y-px ${
                  selected
                    ? "border-[#a9bcff] bg-[#a9bcff] text-[#10131c]"
                    : "border-white/15 bg-white/[0.04] text-white/60 hover:border-white/30 hover:text-white"
                }`}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
        {directionMode !== "manual" && !isPointDirectionMode(directionMode) && (
          <p className="mt-1.5 text-[10px] leading-4 text-white/35">
            Adjusted cameras override this preset; the rest stay automatic.
          </p>
        )}
      </div>

      {pointDirectionMode && (
        <div className="mt-3 flex flex-col items-stretch gap-2 rounded-lg border border-[#f4b860]/25 bg-[#f4b860]/[0.06] p-2.5">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold text-[#ffd18d]">
              {hasDirectionTarget ? "Target set in scene" : "Choose a target"}
            </p>
            <p className="mt-0.5 text-[10px] leading-4 text-white/40">
              Every camera points{" "}
              {directionMode === "look_at" ? "at" : "away from"} this spot with
              a level horizon.
            </p>
          </div>
          <button
            type="button"
            data-change-direction-target="true"
            onClick={onChooseDirectionTarget}
            className="h-8 shrink-0 rounded-md border border-[#f4b860]/35 bg-[#f4b860]/10 px-2.5 text-[11px] font-semibold text-[#ffd18d] transition hover:bg-[#f4b860]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f4b860] active:translate-y-px"
          >
            {hasDirectionTarget ? "Change point" : "Pick point in 3D"}
          </button>
        </div>
      )}

      {selectedPart && (
        <div
          data-part-look-at={selectedPart.hasLookAtTarget ? "set" : "unset"}
          className="mt-3 rounded-lg border border-white/15 bg-white/[0.035] p-2.5"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold text-white/70">
                Selected Part {selectedPart.number}
              </p>
              <p className="mt-0.5 text-[10px] leading-4 text-white/40">
                {selectedPart.hasLookAtTarget
                  ? "This part looks at its own scene point."
                  : pointDirectionMode
                    ? "The whole path currently uses the scene target."
                    : "This part uses the whole-path camera behavior."}
              </p>
            </div>
            {selectedPart.hasLookAtTarget && (
              <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-[#f4b860] shadow-[0_0_10px_rgba(244,184,96,0.65)]" />
            )}
          </div>
          {selectedPart.hasLookAtTarget ? (
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              <button
                type="button"
                data-change-part-look-at={selectedPart.number}
                onClick={() => onChoosePartDirectionTarget(selectedPart.id)}
                className="h-8 rounded-md border border-[#f4b860]/35 bg-[#f4b860]/10 px-2 text-[11px] font-semibold text-[#ffd18d] transition hover:bg-[#f4b860]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f4b860] active:translate-y-px"
              >
                Change point
              </button>
              <button
                type="button"
                data-remove-part-look-at={selectedPart.number}
                onClick={() => onRemovePartDirectionTarget(selectedPart.id)}
                className="h-8 rounded-md border border-white/15 px-2 text-[11px] font-semibold text-white/55 transition hover:border-white/30 hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a9bcff] active:translate-y-px"
              >
                Remove
              </button>
            </div>
          ) : directionMode === "look_at" && hasDirectionTarget ? (
            <button
              type="button"
              data-limit-look-at-to-part={selectedPart.number}
              onClick={() => onLimitDirectionTargetToPart(selectedPart.id)}
              className="mt-2 h-8 w-full rounded-md border border-[#f4b860]/35 bg-[#f4b860]/10 px-2 text-[11px] font-semibold text-[#ffd18d] transition hover:bg-[#f4b860]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f4b860] active:translate-y-px"
            >
              Look here only for Part {selectedPart.number}
            </button>
          ) : (
            <button
              type="button"
              data-add-part-look-at={selectedPart.number}
              onClick={() => onChoosePartDirectionTarget(selectedPart.id)}
              className="mt-2 h-8 w-full rounded-md border border-[#f4b860]/35 bg-[#f4b860]/10 px-2 text-[11px] font-semibold text-[#ffd18d] transition hover:bg-[#f4b860]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f4b860] active:translate-y-px"
            >
              Look at a point for Part {selectedPart.number}
            </button>
          )}
        </div>
      )}
    </aside>
  );
}

function CameraAimButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="h-8 rounded-md border border-white/15 bg-white/[0.05] px-2 text-[11px] font-medium text-white/60 transition hover:border-white/30 hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a9bcff] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-30"
    >
      {label}
    </button>
  );
}

type TrajectoryMap = {
  space: TrajectorySpace;
  worldPoints: TrajectoryPoint[];
};

function buildTrajectoryMap(pose: PosedView): TrajectoryMap {
  const center = new THREE.Vector3(...pose.centroidWorld);
  const transform = new THREE.Matrix4().compose(
    new THREE.Vector3(...pose.camera.extrinsics.position),
    new THREE.Quaternion(...pose.camera.extrinsics.quaternion),
    new THREE.Vector3(1, 1, 1),
  );
  const worldPoints: TrajectoryPoint[] = [];
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
  };
}

function TrajectoryDrawPad({
  points,
  referencePosition,
  segments,
  selectedSegmentId,
  path,
  view,
  space,
  previewing,
  addingPivot,
  closedLoop,
  allowBelowFloor,
  disabled,
  panelSizeIndex,
  onChange,
  onComplete,
  onSelectPart,
  onDeletePart,
  onApplyShape,
  onSmooth,
  onTogglePivot,
  onCloseLoop,
  onAllowBelowFloorChange,
  onClear,
  onPlay,
  onPanelSizeChange,
}: {
  points: readonly TrajectoryPoint[];
  referencePosition: TrajectoryPoint;
  segments: readonly TrajectorySegment[];
  selectedSegmentId: string | null;
  path: readonly TrajectoryPoint[];
  view: TrajectoryDrawingView;
  space: TrajectorySpace;
  previewing: boolean;
  addingPivot: boolean;
  closedLoop: boolean;
  allowBelowFloor: boolean;
  disabled: boolean;
  panelSizeIndex: number;
  onChange: (segments: TrajectorySegment[]) => void;
  onComplete: (segments: TrajectorySegment[]) => void;
  onSelectPart: (id: string) => void;
  onDeletePart: (id: string) => void;
  onApplyShape: (shape: TrajectoryShape, segmentId: string | null) => void;
  onSmooth: () => void;
  onTogglePivot: () => void;
  onCloseLoop: () => void;
  onAllowBelowFloorChange: (allowBelowFloor: boolean) => void;
  onClear: () => void;
  onPlay: () => void;
  onPanelSizeChange: (index: number) => void;
}) {
  const [frozenView, setFrozenView] = useState<TrajectoryDrawingView | null>(
    null,
  );
  const [frozenSpace, setFrozenSpace] = useState<TrajectorySpace | null>(null);
  const [shapeScope, setShapeScope] = useState<"selected" | "whole">(
    "selected",
  );
  const draft = useRef<DrawPoint[]>([]);
  const draftDistance = useRef(0);
  const previousSegments = useRef<TrajectorySegment[]>([]);
  const previousPath = useRef<TrajectoryPoint[]>([]);
  const publishedSegments = useRef<TrajectorySegment[]>([]);
  const published = useRef(false);
  const pointerId = useRef<number | null>(null);
  const pointerOrigin = useRef<DrawPoint>([0, 0]);
  const screenOrigin = useRef<DrawPoint>([0, 0]);
  const activePartId = useRef("");
  const nextPartId = useRef(1);
  const strokeView = useRef<TrajectoryDrawingView>(view);
  const strokeSpace = useRef<TrajectorySpace>(space);
  const strokeFloorBoundary = useRef<[DrawPoint, DrawPoint] | null>(null);
  const displayView = frozenView ?? view;
  const drawingSpace = useMemo(
    () =>
      frameTrajectorySpaceAboveFloor(
        space,
        displayView,
        path.at(-1) ?? referencePosition,
        allowBelowFloor,
      ),
    [allowBelowFloor, displayView, path, referencePosition, space],
  );
  const displaySpace = frozenSpace ?? drawingSpace;
  const panelSize = DRAWING_PANEL_SIZES[panelSizeIndex]!;
  const selectedPartIndex = segments.findIndex(
    (segment) => segment.id === selectedSegmentId,
  );
  const effectiveShapeScope =
    shapeScope === "selected" && selectedPartIndex >= 0 ? "selected" : "whole";
  const shapePointCount =
    effectiveShapeScope === "selected"
      ? segments[selectedPartIndex]!.points.length
      : path.length;

  const projectedPoints = useMemo(
    () =>
      points
        .map((point) =>
          projectTrajectoryPoint(point, displayView, displaySpace),
        )
        .filter(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1),
    [displaySpace, displayView, points],
  );
  const referencePoint = projectTrajectoryPoint(
    referencePosition,
    displayView,
    displaySpace,
  );
  const projectedPath = path.map((point) =>
    projectTrajectoryPoint(point, displayView, displaySpace),
  );
  const displayedPath =
    closedLoop && projectedPath.length >= 3
      ? [...projectedPath, projectedPath[0]!]
      : projectedPath;
  const projectedPartEnds = segments.map((segment) =>
    projectTrajectoryPoint(segment.points.at(-1)!, displayView, displaySpace),
  );
  const floorBoundary = trajectoryFloorBoundary(
    displayView,
    displaySpace,
    path.at(-1) ?? referencePosition,
  );

  function pointerFromEvent(
    event: ReactPointerEvent<SVGSVGElement>,
  ): DrawPoint {
    const bounds = event.currentTarget.getBoundingClientRect();
    return [
      (event.clientX - bounds.left) / bounds.width,
      (event.clientY - bounds.top) / bounds.height,
    ];
  }

  function clampDrawPoint(
    point: DrawPoint,
    boundary: [DrawPoint, DrawPoint] | null,
    drawingView: TrajectoryDrawingView,
  ): DrawPoint {
    const x = THREE.MathUtils.clamp(point[0], 0, 1);
    let y = THREE.MathUtils.clamp(point[1], 0, 1);
    if (boundary) {
      const floorY = THREE.MathUtils.lerp(boundary[0][1], boundary[1][1], x);
      y = drawingView.up[1] >= 0 ? Math.min(y, floorY) : Math.max(y, floorY);
    }
    return [x, THREE.MathUtils.clamp(y, 0, 1)];
  }

  function startPointer(event: ReactPointerEvent<SVGSVGElement>) {
    if (
      disabled ||
      addingPivot ||
      event.button !== 0 ||
      pointerId.current !== null
    )
      return;
    const pointer = pointerFromEvent(event);
    startDrawing(event, pointer);
  }

  function startDrawing(
    event: ReactPointerEvent<SVGSVGElement>,
    pointer: DrawPoint,
  ) {
    const endpoint = projectedPath.at(-1);
    const anchor = path.at(-1) ?? referencePosition;
    const activeView = displayView;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerId.current = event.pointerId;
    previousSegments.current = [...segments];
    previousPath.current = [...path];
    publishedSegments.current = [...segments];
    pointerOrigin.current = pointer;
    strokeView.current = activeView;
    strokeSpace.current = displaySpace;
    strokeFloorBoundary.current = trajectoryFloorBoundary(
      activeView,
      displaySpace,
      anchor,
    );
    if (allowBelowFloor) strokeFloorBoundary.current = null;
    screenOrigin.current =
      endpoint ??
      clampDrawPoint(pointer, strokeFloorBoundary.current, activeView);
    draft.current = [screenOrigin.current];
    draftDistance.current = 0;
    do {
      activePartId.current = `part-${nextPartId.current++}`;
    } while (segments.some((segment) => segment.id === activePartId.current));
    published.current = false;
    setFrozenView(activeView);
    setFrozenSpace(displaySpace);
  }

  function continueDrawing(event: ReactPointerEvent<SVGSVGElement>) {
    if (pointerId.current !== event.pointerId) return;
    const pointer = pointerFromEvent(event);
    const point = clampDrawPoint(
      [
        screenOrigin.current[0] + pointer[0] - pointerOrigin.current[0],
        screenOrigin.current[1] + pointer[1] - pointerOrigin.current[1],
      ],
      strokeFloorBoundary.current,
      strokeView.current,
    );
    const previous = draft.current.at(-1)!;
    const segmentLength = Math.hypot(
      point[0] - previous[0],
      point[1] - previous[1],
    );
    if (segmentLength < 0.012) return;
    draft.current = [...draft.current, point];
    draftDistance.current += segmentLength;
    if (draftDistance.current >= 0.02) {
      const nextPath = appendDrawnTrajectory(
        previousPath.current,
        draft.current,
        strokeView.current,
        strokeSpace.current,
        referencePosition,
        allowBelowFloor,
      );
      const addedPoints = nextPath.slice(previousPath.current.length);
      if (addedPoints.length === 0) return;
      const partPoints = previousPath.current.length
        ? [previousPath.current.at(-1)!, ...addedPoints]
        : addedPoints;
      const sharedQuaternion = previousSegments.current
        .at(-1)
        ?.quaternions?.at(-1);
      const quaternions = sharedQuaternion
        ? partPoints.map((_, index) => (index === 0 ? sharedQuaternion : null))
        : undefined;
      published.current = true;
      publishedSegments.current = [
        ...previousSegments.current,
        { id: activePartId.current, points: partPoints, quaternions },
      ];
      onChange(publishedSegments.current);
    }
  }

  function continuePointer(event: ReactPointerEvent<SVGSVGElement>) {
    continueDrawing(event);
  }

  function finishPointer(event: ReactPointerEvent<SVGSVGElement>) {
    if (pointerId.current !== event.pointerId) return;
    pointerId.current = null;
    if (published.current) onComplete(publishedSegments.current);
    draft.current = [];
    draftDistance.current = 0;
    published.current = false;
    setFrozenView(null);
    setFrozenSpace(null);
  }

  function cancelPointer(event: ReactPointerEvent<SVGSVGElement>) {
    if (pointerId.current !== event.pointerId) return;
    pointerId.current = null;
    if (published.current) onChange(previousSegments.current);
    draft.current = [];
    draftDistance.current = 0;
    published.current = false;
    setFrozenView(null);
    setFrozenSpace(null);
  }

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Rotate3D className="h-3.5 w-3.5 text-white/45" />
          <h2 className="text-sm font-semibold text-white">Draw new path</h2>
        </div>
        <div
          className="flex h-7 items-center overflow-hidden rounded-md border border-white/15 bg-black/25"
          aria-label="Drawing panel size"
        >
          <button
            type="button"
            disabled={panelSizeIndex === 0}
            onClick={() => onPanelSizeChange(Math.max(0, panelSizeIndex - 1))}
            aria-label="Make drawing panel smaller"
            title="Make drawing panel smaller"
            className="grid h-full w-7 place-items-center text-white/55 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/60 disabled:opacity-25"
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onPanelSizeChange(DEFAULT_DRAWING_PANEL_SIZE_INDEX)}
            aria-label={`Reset drawing panel size from ${panelSize.label} to Medium`}
            title="Reset drawing panel size"
            className="h-full min-w-14 border-x border-white/10 px-1.5 text-[10px] font-semibold text-white/75 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/60"
          >
            {panelSize.label}
          </button>
          <button
            type="button"
            disabled={panelSizeIndex === DRAWING_PANEL_SIZES.length - 1}
            onClick={() =>
              onPanelSizeChange(
                Math.min(DRAWING_PANEL_SIZES.length - 1, panelSizeIndex + 1),
              )
            }
            aria-label="Make drawing panel larger"
            title="Make drawing panel larger"
            className="grid h-full w-7 place-items-center text-white/55 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/60 disabled:opacity-25"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <p className="mb-2 text-[10px] leading-4 text-white/45">
        {addingPivot
          ? "Click the blue path in the main 3D view."
          : "Larger panel = finer moves. Every point-to-point section gets equal video time."}
      </p>

      <button
        type="button"
        role="switch"
        aria-checked={allowBelowFloor}
        data-allow-below-floor={allowBelowFloor}
        disabled={disabled}
        onClick={() => onAllowBelowFloorChange(!allowBelowFloor)}
        className={`mb-2 flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a9bcff] disabled:opacity-30 ${
          allowBelowFloor
            ? "border-[#66c7e8]/45 bg-[#66c7e8]/10"
            : "border-white/10 bg-white/[0.025] hover:border-white/20 hover:bg-white/[0.05]"
        }`}
      >
        <span>
          <span className="block text-[11px] font-semibold text-white/80">
            Allow below floor
          </span>
          <span className="mt-0.5 block text-[9px] leading-3.5 text-white/40">
            Turn on for underwater or underground shots.
          </span>
        </span>
        <span
          aria-hidden="true"
          className={`relative h-5 w-9 shrink-0 rounded-full transition ${
            allowBelowFloor ? "bg-[#66c7e8]" : "bg-white/15"
          }`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
              allowBelowFloor ? "translate-x-[1.125rem]" : "translate-x-0.5"
            }`}
          />
        </span>
      </button>

      <div className="relative aspect-square overflow-hidden rounded-lg border border-white/15 bg-[#15171c]">
        <svg
          viewBox="0 0 100 100"
          role="application"
          aria-label="Draw camera path from the current 3D view"
          aria-disabled={disabled || addingPivot}
          className={`h-full w-full touch-none cursor-crosshair select-none ${disabled || addingPivot ? "pointer-events-none opacity-40" : ""}`}
          onPointerDown={startPointer}
          onPointerMove={continuePointer}
          onPointerUp={finishPointer}
          onPointerCancel={cancelPointer}
        >
          {floorBoundary && (
            <>
              {!allowBelowFloor && (
                <polygon
                  points={
                    displayView.up[1] >= 0
                      ? `${floorBoundary[0][0] * 100},${floorBoundary[0][1] * 100} ${floorBoundary[1][0] * 100},${floorBoundary[1][1] * 100} 100,100 0,100`
                      : `0,0 100,0 ${floorBoundary[1][0] * 100},${floorBoundary[1][1] * 100} ${floorBoundary[0][0] * 100},${floorBoundary[0][1] * 100}`
                  }
                  fill="rgba(244, 184, 96, 0.07)"
                />
              )}
              <line
                data-trajectory-floor="true"
                x1={floorBoundary[0][0] * 100}
                x2={floorBoundary[1][0] * 100}
                y1={floorBoundary[0][1] * 100}
                y2={floorBoundary[1][1] * 100}
                stroke={
                  allowBelowFloor
                    ? "rgba(102, 199, 232, 0.55)"
                    : "rgba(244, 184, 96, 0.8)"
                }
                strokeWidth="0.7"
                strokeDasharray="2 1.5"
              />
              <text
                x="97"
                y={THREE.MathUtils.clamp(
                  floorBoundary[1][1] * 100 - 1.5,
                  4,
                  96,
                )}
                textAnchor="end"
                fill={
                  allowBelowFloor
                    ? "rgba(102, 199, 232, 0.8)"
                    : "rgba(244, 184, 96, 0.85)"
                }
                fontSize="3.2"
                fontWeight="600"
              >
                {allowBelowFloor
                  ? "FLOOR - CROSSING ALLOWED"
                  : "FLOOR - LOCKED"}
              </text>
            </>
          )}
          <path
            d="M25 0V100M50 0V100M75 0V100M0 25H100M0 50H100M0 75H100"
            stroke="rgba(255,255,255,0.06)"
            strokeWidth="0.45"
          />
          {projectedPoints.map(([x, y], index) => (
            <circle
              key={index}
              cx={x * 100}
              cy={y * 100}
              r="0.45"
              fill="rgba(255,255,255,0.28)"
            />
          ))}
          <circle
            cx={referencePoint[0] * 100}
            cy={referencePoint[1] * 100}
            r="1.8"
            fill="#f4b860"
            stroke="#111216"
            strokeWidth="0.8"
          />
          {displayedPath.length >= 2 && (
            <>
              <polyline
                points={displayedPath
                  .map(([x, y]) => `${x * 100},${y * 100}`)
                  .join(" ")}
                fill="none"
                stroke="#a9bcff"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle
                cx={projectedPath[0]![0] * 100}
                cy={projectedPath[0]![1] * 100}
                r="2.2"
                fill="#f7f5ef"
              />
              <circle
                cx={projectedPath.at(-1)![0] * 100}
                cy={projectedPath.at(-1)![1] * 100}
                r="2.2"
                fill="#a9bcff"
              />
              <circle
                cx={projectedPath.at(-1)![0] * 100}
                cy={projectedPath.at(-1)![1] * 100}
                r="4.5"
                fill="none"
                stroke="rgba(169,188,255,0.7)"
                strokeWidth="0.8"
              />
              {projectedPartEnds.map(([x, y], index) => (
                <g key={segments[index]!.id} pointerEvents="none">
                  <circle
                    cx={x * 100}
                    cy={y * 100}
                    r="2.5"
                    fill={index === segments.length - 1 ? "#a9bcff" : "#15171c"}
                    stroke="#a9bcff"
                    strokeWidth="0.7"
                  />
                  <text
                    x={x * 100}
                    y={y * 100 + 1}
                    textAnchor="middle"
                    fill={index === segments.length - 1 ? "#10131c" : "#f7f5ef"}
                    fontSize="2.8"
                    fontWeight="700"
                  >
                    {index + 1}
                  </text>
                </g>
              ))}
            </>
          )}
        </svg>

        {path.length < 2 && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <span className="rounded-md border border-white/20 bg-[#0b0c0f]/85 px-3 py-2 text-xs font-semibold text-white shadow-xl">
              DRAG TO DRAW
            </span>
          </div>
        )}
      </div>

      <button
        type="button"
        disabled={path.length < 2}
        onClick={onTogglePivot}
        className={`mt-2 flex h-10 w-full items-center justify-center gap-2 rounded border text-xs font-semibold transition disabled:opacity-25 ${
          addingPivot
            ? "border-[#a9bcff] bg-[#a9bcff] text-[#10131c]"
            : "border-[#a9bcff]/40 bg-[#a9bcff]/10 text-[#d8e1ff] hover:bg-[#a9bcff]/20"
        }`}
      >
        <Plus className="h-3.5 w-3.5" />
        {addingPivot ? "Click the blue path in 3D" : "Add pivot on path"}
      </button>

      <button
        type="button"
        onClick={onSmooth}
        disabled={disabled || addingPivot || path.length < 3}
        title="Soften bends in the camera path while keeping camera aim and timing"
        className="mt-2 flex h-9 w-full items-center justify-center gap-1.5 rounded border border-white/15 bg-white/[0.04] text-xs font-semibold text-white/65 transition hover:border-[#a9bcff]/45 hover:bg-[#a9bcff]/10 hover:text-white disabled:opacity-35"
      >
        <Sparkles className="h-3.5 w-3.5" />
        Smooth path
      </button>
      <button
        type="button"
        data-close-camera-loop="true"
        disabled={disabled || addingPivot || path.length < 3 || closedLoop}
        onClick={onCloseLoop}
        className="mt-2 flex h-9 w-full items-center justify-center gap-1.5 rounded border border-white/15 bg-white/[0.04] text-xs font-semibold text-white/65 transition hover:border-[#a9bcff]/45 hover:bg-[#a9bcff]/10 hover:text-white disabled:opacity-35"
      >
        <Rotate3D className="h-3.5 w-3.5" />
        {closedLoop ? "Loop closed" : "Close loop"}
      </button>

      {segments.length > 0 && (
        <div className="mt-2 flex items-center gap-2">
          <span className="shrink-0 text-[9px] font-semibold uppercase tracking-[0.1em] text-white/35">
            Parts
          </span>
          <div className="min-w-0 flex-1 overflow-x-auto">
            <div className="flex w-max gap-1">
              {segments.map((segment, index) => (
                <div
                  key={segment.id}
                  className={`flex h-7 overflow-hidden rounded border text-[10px] font-semibold transition ${
                    segment.id === selectedSegmentId
                      ? "border-[#a9bcff]/60 bg-[#a9bcff]/15 text-white"
                      : "border-white/15 bg-white/[0.04] text-white/65"
                  }`}
                >
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onSelectPart(segment.id)}
                    className="px-2 transition hover:bg-white/10 disabled:opacity-30"
                    aria-label={`Edit path part ${index + 1}`}
                  >
                    {index + 1}
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onDeletePart(segment.id)}
                    aria-label={`Delete path part ${index + 1}`}
                    className="border-l border-current/15 px-1.5 transition hover:bg-red-400/15 hover:text-red-100 disabled:opacity-30"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {path.length >= 2 && (
        <details
          data-path-shape-panel="true"
          className="group mt-2 rounded-lg border border-white/15 bg-white/[0.025]"
        >
          <summary className="flex h-9 cursor-pointer list-none items-center justify-between px-2.5 text-xs font-semibold text-white/65 transition hover:bg-white/[0.05] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#a9bcff] [&::-webkit-details-marker]:hidden">
            <span>Shape path</span>
            <ChevronDown className="h-3.5 w-3.5 transition group-open:rotate-180" />
          </summary>
          <div className="border-t border-white/10 p-2.5">
            <p className="text-[9px] font-semibold uppercase tracking-[0.1em] text-white/35">
              Apply to
            </p>
            <div
              role="group"
              aria-label="Apply path shape to"
              className="mt-1.5 grid grid-cols-2 gap-1.5"
            >
              <button
                type="button"
                data-path-shape-scope="selected"
                aria-pressed={effectiveShapeScope === "selected"}
                disabled={selectedPartIndex < 0}
                onClick={() => setShapeScope("selected")}
                className={`h-8 rounded-md border px-2 text-[10px] font-semibold transition disabled:opacity-30 ${
                  effectiveShapeScope === "selected"
                    ? "border-[#a9bcff] bg-[#a9bcff] text-[#10131c]"
                    : "border-white/15 text-white/55 hover:border-white/30 hover:text-white"
                }`}
              >
                {selectedPartIndex >= 0
                  ? `Selected part ${selectedPartIndex + 1}`
                  : "Selected part"}
              </button>
              <button
                type="button"
                data-path-shape-scope="whole"
                aria-pressed={effectiveShapeScope === "whole"}
                onClick={() => setShapeScope("whole")}
                className={`h-8 rounded-md border px-2 text-[10px] font-semibold transition ${
                  effectiveShapeScope === "whole"
                    ? "border-[#a9bcff] bg-[#a9bcff] text-[#10131c]"
                    : "border-white/15 text-white/55 hover:border-white/30 hover:text-white"
                }`}
              >
                Whole path
              </button>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-1.5">
              {(
                [
                  ["straighten", "Straighten"],
                  ["circular", "Make circular"],
                  ["flatten", "Flatten"],
                ] as const
              ).map(([shape, label]) => (
                <button
                  key={shape}
                  type="button"
                  data-path-shape-action={shape}
                  disabled={
                    disabled ||
                    addingPivot ||
                    shapePointCount < 3 ||
                    (shape === "straighten" &&
                      effectiveShapeScope === "whole" &&
                      closedLoop)
                  }
                  title={
                    shape === "straighten"
                      ? "Place pivots evenly on a line between the endpoints"
                      : shape === "circular"
                        ? "Arrange pivots on a circular arc; closed loops become a full circle"
                        : "Place pivots on the plane facing the current 3D view"
                  }
                  onClick={() =>
                    onApplyShape(
                      shape,
                      effectiveShapeScope === "selected"
                        ? selectedSegmentId
                        : null,
                    )
                  }
                  className="min-h-9 rounded-md border border-white/15 bg-white/[0.04] px-1.5 text-[10px] font-semibold leading-3 text-white/60 transition hover:border-[#a9bcff]/45 hover:bg-[#a9bcff]/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a9bcff] disabled:cursor-not-allowed disabled:opacity-25"
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[9px] leading-3.5 text-white/35">
              Circular and Flatten use the current 3D view. Camera aim and
              timing stay unchanged.
            </p>
          </div>
        </details>
      )}

      <div className="mt-2 grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={disabled || path.length === 0}
          onClick={onClear}
          className="flex h-9 items-center justify-center gap-1.5 rounded border border-white/15 text-xs font-semibold text-white/60 transition hover:bg-white/10 hover:text-white disabled:opacity-25"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Clear path
        </button>
        <button
          type="button"
          disabled={path.length < 2}
          onClick={onPlay}
          className="flex h-9 items-center justify-center gap-1.5 rounded bg-[#a9bcff] text-xs font-semibold text-[#10131c] transition hover:bg-[#c0cdff] disabled:opacity-25"
        >
          {previewing ? (
            <Pause className="h-3.5 w-3.5" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          {previewing ? "Stop" : "Play path"}
        </button>
      </div>
    </section>
  );
}

function OutputNumberInput({
  label,
  value,
  min,
  max,
  step = 1,
  title,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  title?: string;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => setDraft(String(value)), [value]);

  function commit() {
    const parsed = Number(draft);
    const precision = Math.max(0, (String(step).split(".")[1] ?? "").length);
    const rounded = Number(
      (Math.round(parsed / step) * step).toFixed(precision),
    );
    const nextValue =
      draft && Number.isFinite(parsed)
        ? THREE.MathUtils.clamp(rounded, min, max)
        : value;
    setDraft(String(nextValue));
    if (nextValue !== value) onChange(nextValue);
  }

  return (
    <label className="w-20 shrink-0" title={title}>
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-white/45">
        {label}
      </span>
      <input
        type="text"
        inputMode={step < 1 ? "decimal" : "numeric"}
        value={draft}
        disabled={disabled}
        onChange={(event) => {
          const pattern = step < 1 ? /^\d*\.?\d*$/ : /^\d*$/;
          if (pattern.test(event.target.value)) setDraft(event.target.value);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(String(value));
            event.currentTarget.blur();
          }
        }}
        className="h-11 w-full rounded-md border border-white/15 bg-white/[0.06] px-3 text-sm font-semibold text-white outline-none transition hover:border-white/25 focus:border-[#a9bcff] focus:ring-2 focus:ring-[#8ca8ff]/20 disabled:opacity-40"
      />
    </label>
  );
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
  return (
    <main className="relative grid h-full place-items-center px-5">
      <button
        type="button"
        onClick={onHistory}
        className="absolute right-4 top-4 flex h-10 items-center gap-2 rounded-md border border-white/15 px-3 text-sm text-white/60 transition hover:bg-white/[0.06] hover:text-white"
      >
        <HistoryIcon className="h-4 w-4" />
        Saved
      </button>
      <div className="w-full max-w-xl">
        {onResume ? (
          <button
            type="button"
            onClick={onResume}
            className="mb-7 flex h-11 max-w-full items-center gap-2 rounded-md bg-white px-4 text-sm font-semibold text-black transition hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a9bcff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b0c0f] active:translate-y-px"
          >
            <ArrowLeft className="h-4 w-4 shrink-0" />
            <span className="truncate">Continue {activeSceneName}</span>
          </button>
        ) : (
          <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-white/40">
            Step 1 of 3
          </p>
        )}
        <h1 className="mt-4 max-w-lg text-4xl font-medium tracking-[-0.055em] sm:text-5xl">
          {onResume ? "Start another scene." : "Add a reference image."}
        </h1>
        <p className="mt-4 max-w-md text-base leading-6 text-white/55">
          {onResume
            ? "Your current scene is still open. Choosing another image replaces it in the editor."
            : "Then rotate the 3D scene and draw the camera path from any angle."}
        </p>

        <button
          type="button"
          disabled={posing}
          onClick={onChoose}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const file = event.dataTransfer.files[0];
            if (file) onDrop(file);
          }}
          className="group relative mt-9 flex h-64 w-full items-center justify-center overflow-hidden border border-dashed border-white/25 bg-white/[0.03] text-left transition hover:border-white/50 hover:bg-white/[0.05] disabled:cursor-wait"
        >
          {previewUrl ? (
            <>
              <img
                src={previewUrl}
                alt="Selected reference image"
                className="absolute inset-0 h-full w-full object-cover opacity-40"
              />
              <div className="absolute inset-0 bg-black/45" />
            </>
          ) : null}
          <div className="relative flex flex-col items-center text-center">
            {posing ? (
              <>
                <Loader2 className="h-7 w-7 animate-spin text-white/80" />
                <span className="mt-4 text-sm font-medium">
                  Preparing the 3D view
                </span>
                <span className="mt-1 text-xs text-white/45">
                  {Math.max(1, Math.round(poseElapsed / 1000))}s
                </span>
              </>
            ) : (
              <>
                <Upload className="h-7 w-7 text-white/60 transition group-hover:text-white" />
                <span className="mt-4 text-sm font-medium">
                  Choose an image
                </span>
                <span className="mt-1 text-xs text-white/40">
                  or drop / paste (Ctrl/⌘+V)
                </span>
              </>
            )}
          </div>
        </button>

        <button
          type="button"
          disabled={posing}
          onClick={onExample}
          className="mt-4 flex w-full items-center gap-4 rounded-md border border-[#a9bcff]/30 bg-[#a9bcff]/10 p-3 text-left transition hover:bg-[#a9bcff]/20 disabled:opacity-50"
        >
          <img
            src={EXAMPLE_IMAGE}
            alt="Cozy igloo example"
            className="h-16 w-24 rounded object-cover"
          />
          <span>
            <span className="block text-sm font-semibold text-white">
              Explore an example
            </span>
            <span className="mt-1 block text-xs text-white/60">
              Move cameras and preview a path · No signup needed
            </span>
          </span>
          <Play className="ml-auto h-5 w-5 shrink-0 text-[#a9bcff]" />
        </button>
        {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
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
    <aside className="fixed inset-y-0 right-0 z-[70] flex w-[min(28rem,100%)] flex-col border-l border-white/15 bg-[#111216]/98 shadow-2xl backdrop-blur-xl">
      <div className="flex items-center justify-between px-5 pb-3 pt-4">
        <div>
          <h2 className="text-lg font-semibold tracking-[-0.025em]">
            Saved scenes
          </h2>
          <p className="mt-0.5 text-xs text-white/40">
            Drafts stay in this browser. Videos expire after 7 days.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close saved scenes"
          className="grid h-9 w-9 place-items-center rounded-md text-white/50 transition hover:bg-white/10 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div
        role="tablist"
        aria-label="Saved scene views"
        className="grid grid-cols-3 gap-1 border-b border-white/10 px-3 pb-3"
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
          <p className="mb-3 rounded-md border border-red-400/20 bg-red-950/40 p-3 text-xs text-red-200">
            Could not update favorite: {starError}
          </p>
        )}

        {activeTab === "favorites" &&
          (history.isLoading && drafts.isLoading && favoriteCount === 0 ? (
            <div className="grid h-24 place-items-center">
              <Loader2 className="h-4 w-4 animate-spin text-white/45" />
            </div>
          ) : favoriteCount === 0 ? (
            <p className="rounded-lg border border-dashed border-white/10 px-3 py-8 text-center text-xs text-white/35">
              Star a video or path to keep it here.
            </p>
          ) : (
            <div className="space-y-5">
              {favoriteItems.length > 0 && (
                <section>
                  <h3 className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-white/40">
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
                  <h3 className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-white/40">
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
              <Loader2 className="h-4 w-4 animate-spin text-white/45" />
            </div>
          ) : history.error && sortedItems.length === 0 ? (
            <p className="rounded-md border border-red-400/20 bg-red-950/40 p-3 text-sm text-red-200">
              {history.error instanceof Error
                ? history.error.message
                : "Could not load generations"}
            </p>
          ) : sortedItems.length > 0 ? (
            <div className="space-y-2">
              {history.isLoading && (
                <p className="flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-white/55">
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
            <p className="rounded-lg border border-dashed border-white/10 px-3 py-8 text-center text-xs text-white/35">
              Generated versions will appear here.
            </p>
          ))}

        {activeTab === "drafts" &&
          (drafts.isLoading && sortedDraftItems.length === 0 ? (
            <div className="grid h-24 place-items-center">
              <Loader2 className="h-4 w-4 animate-spin text-white/45" />
            </div>
          ) : drafts.error && sortedDraftItems.length === 0 ? (
            <p className="rounded-md border border-red-400/20 bg-red-950/40 p-3 text-sm text-red-200">
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
            <p className="rounded-lg border border-dashed border-white/10 px-3 py-8 text-center text-xs text-white/35">
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
      className={`flex h-10 min-w-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a9bcff]/70 ${
        active
          ? "bg-white text-[#10131c]"
          : "text-white/50 hover:bg-white/[0.06] hover:text-white"
      }`}
    >
      <span className="truncate">{label}</span>
      <span
        className={`rounded-full px-1.5 py-0.5 text-[9px] tabular-nums ${
          active ? "bg-black/10 text-black/55" : "bg-white/[0.07] text-white/40"
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
    <article className="rounded-lg border border-[#a9bcff]/20 bg-[#a9bcff]/[0.05] p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] text-white/40">
          {new Intl.DateTimeFormat(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          }).format(new Date(draft.saved_at * 1000))}
        </span>
        <div className="flex items-center gap-2">
          <StarButton starred={draft.starred} label="path" onChange={onStar} />
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#c0cdff]">
            Draft
          </span>
        </div>
      </div>
      <p className="mt-2 line-clamp-2 text-sm leading-5 text-white/85">
        {draft.prompt || "No prompt yet"}
      </p>
      <p className="mt-2 text-xs text-white/35">
        {draft.point_count} controls · {draft.frame_count} frames · {draft.fps}{" "}
        FPS · {draft.aspect_ratio}
      </p>
      <code className="mt-2 block select-all truncate text-[10px] text-white/35">
        {draft.draft_id}
      </code>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={restoring}
          onClick={() => void onOpen(draft.draft_id)}
          className="flex h-9 items-center justify-center gap-2 rounded-md bg-[#a9bcff] text-xs font-semibold text-[#10131c] transition hover:bg-[#c0cdff] active:translate-y-px disabled:cursor-wait disabled:opacity-40"
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
          className="flex h-9 items-center justify-center gap-2 rounded-md border border-white/15 text-xs font-semibold text-white/65 transition hover:border-white/30 hover:bg-white/[0.06] hover:text-white active:translate-y-px"
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
    <article className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] text-white/40">
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
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#c0cdff]">
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
        className="mt-1.5 flex w-full items-center gap-2 rounded-md px-1 py-2 text-left transition hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a9bcff]/70 active:translate-y-px"
      >
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-white/45 transition-transform ${expanded ? "rotate-0" : "-rotate-90"}`}
        />
        <span className="line-clamp-2 text-sm leading-5 text-white/85">
          {item.prompt}
        </span>
      </button>
      {expanded && (
        <div id={detailsId}>
          <p className="mt-1 text-xs text-white/35">
            {item.target_frame_count} frames · {item.fps} FPS ·{" "}
            {item.aspect_ratio}
          </p>
          <div className="mt-2 flex items-center gap-2 rounded-md border border-white/10 bg-black/20 px-2 py-1.5">
            <code className="min-w-0 flex-1 select-all truncate text-[10px] text-white/45">
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
              className="flex shrink-0 items-center gap-1 text-[10px] font-semibold text-[#c0cdff] transition hover:text-white"
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
    <div className="rounded-md border border-white/10 bg-black/20 p-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-white/70">
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
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-white/10 text-white/35 transition hover:border-red-300/30 hover:bg-red-400/10 hover:text-red-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300/60 disabled:cursor-wait disabled:opacity-50"
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
                ? "text-emerald-300"
                : failure
                  ? "text-red-300"
                  : "text-[#f4b860]"
            }`}
          >
            {state}
          </span>
        </div>
      </div>
      {confirmingRemove && (
        <div className="mt-2 rounded-md border border-red-300/20 bg-red-950/30 p-2.5">
          <p className="text-xs leading-5 text-red-100/85">
            Remove this version from Saved? The path and raw output stay
            available for recovery.
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              disabled={removing}
              onClick={() => setConfirmingRemove(false)}
              className="h-8 rounded-md px-3 text-xs font-semibold text-white/55 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-40"
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
        <p className="mt-2 text-xs text-red-300">
          Could not remove this version: {removeError}
        </p>
      )}
      {failure && <p className="mt-2 text-xs text-red-300">{failure}</p>}
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
              className="flex h-9 items-center justify-center gap-2 rounded-md border border-white/15 text-xs font-semibold text-white/70 transition hover:border-white/30 hover:bg-white/[0.06] hover:text-white"
            >
              <Play className="h-3.5 w-3.5" />
              Open
            </a>
            <a
              href={videoUrl}
              download={downloadName}
              title={`Download ${downloadName}`}
              className="flex h-9 items-center justify-center gap-2 rounded-md bg-white text-xs font-semibold text-black transition hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a9bcff] active:translate-y-px"
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
      className={`grid h-8 w-8 shrink-0 place-items-center rounded-md border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f4b860]/70 disabled:cursor-wait disabled:opacity-50 ${
        starred
          ? "border-[#f4b860]/35 bg-[#f4b860]/15 text-[#f4b860] hover:bg-[#f4b860]/25"
          : "border-white/10 text-white/35 hover:border-white/25 hover:bg-white/[0.06] hover:text-white/70"
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
