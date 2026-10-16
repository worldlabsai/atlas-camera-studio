import * as THREE from "three";
import { createIntrinsicsFromFov, type PinholeCamera } from "./common";
import {
  cameraAimDegrees,
  cameraQuaternionFromAim,
  cameraViewsFromSegments,
  sampleCameraPath,
  TRAJECTORY_FLOOR_Y,
  type CameraDirectionMode,
  type CameraView,
  type SampledCameraView,
  type TrajectoryPoint,
  type TrajectoryQuaternion,
  type TrajectorySegment,
} from "./camera-trajectory";

/** Motion from a key to the next one. */
export type KeyInterpolation = "smooth" | "linear" | "hold";
/**
 * Free uses each key's pan and tilt; look_at aims every frame at one point;
 * forward faces along the direction of travel.
 */
export type CameraAimMode = "free" | "look_at" | "forward";

export type CameraKeyframe = {
  id: string;
  /** Whole frame in [0, frameCount - 1]. */
  frame: number;
  position: TrajectoryPoint;
  /** Degrees, using the cameraAimDegrees convention. */
  yaw: number;
  pitch: number;
  /** Motion from this key to the next key. */
  interpolation: KeyInterpolation;
  /**
   * How fully the camera settles at this key, 0 (flows through) to 1 (comes
   * to rest). Null follows the default: rest at the first and last keys.
   */
  ease: number | null;
};

export type ShotOptions = {
  aimMode: CameraAimMode;
  aimTarget: TrajectoryPoint | null;
  allowBelowFloor: boolean;
};

export type ShotPose = {
  position: TrajectoryPoint;
  quaternion: TrajectoryQuaternion;
  yaw: number;
  pitch: number;
};

export type ShotCurve = {
  keyframes: readonly CameraKeyframe[];
  positionAt(frame: number): TrajectoryPoint;
  poseAt(frame: number): ShotPose;
};

export function sortKeyframes(
  keyframes: readonly CameraKeyframe[],
): CameraKeyframe[] {
  return [...keyframes].sort((a, b) => a.frame - b.frame);
}

export function effectiveEase(
  keyframes: readonly CameraKeyframe[],
  index: number,
): number {
  const ease = keyframes[index]?.ease;
  if (ease !== null && ease !== undefined) return THREE.MathUtils.clamp(ease, 0, 1);
  return index === 0 || index === keyframes.length - 1 ? 1 : 0;
}

/**
 * Hermite tangents per key, in value units per frame. Interior tangents follow
 * the neighbouring keys and flatten at local extremes so the camera never
 * overshoots a key, like Blender's auto-clamped handles. Ease scales a
 * tangent toward zero so the camera slows into and out of that key.
 */
function channelTangents(
  times: readonly number[],
  values: readonly number[],
  eases: readonly number[],
): number[] {
  const n = values.length;
  return values.map((value, j) => {
    let slope: number;
    if (n < 2) slope = 0;
    else if (j === 0) slope = (values[1]! - value) / (times[1]! - times[0]!);
    else if (j === n - 1)
      slope = (value - values[j - 1]!) / (times[j]! - times[j - 1]!);
    else {
      const previous = values[j - 1]!;
      const next = values[j + 1]!;
      slope =
        (value - previous) * (next - value) <= 0
          ? 0
          : (next - previous) / (times[j + 1]! - times[j - 1]!);
    }
    return slope * (1 - eases[j]!);
  });
}

function unwrapDegrees(values: readonly number[]): number[] {
  const out: number[] = [];
  for (const value of values) {
    const previous = out.at(-1);
    out.push(
      previous === undefined
        ? value
        : previous +
            (THREE.MathUtils.euclideanModulo(value - previous + 180, 360) -
              180),
    );
  }
  return out;
}

const lookCamera = new THREE.PerspectiveCamera();
function quaternionLookingAt(
  position: TrajectoryPoint,
  target: TrajectoryPoint,
): TrajectoryQuaternion {
  lookCamera.position.set(...position);
  lookCamera.up.set(0, 1, 0);
  lookCamera.lookAt(...target);
  return lookCamera.quaternion.toArray() as TrajectoryQuaternion;
}

export function createShotCurve(
  keyframes: readonly CameraKeyframe[],
  options: ShotOptions,
): ShotCurve {
  const keys = sortKeyframes(keyframes);
  const n = keys.length;
  const times = keys.map((key) => key.frame);
  const eases = keys.map((_, index) => effectiveEase(keys, index));
  const channels = [
    keys.map((key) => key.position[0]),
    keys.map((key) => key.position[1]),
    keys.map((key) => key.position[2]),
    unwrapDegrees(keys.map((key) => key.yaw)),
    keys.map((key) => key.pitch),
  ];
  const tangents = channels.map((values) =>
    channelTangents(times, values, eases),
  );

  function evaluate(frame: number, out: number[]): number[] {
    if (n === 0) return out.fill(0);
    if (n === 1 || frame <= times[0]!) {
      channels.forEach((values, c) => (out[c] = values[0]!));
      return out;
    }
    if (frame >= times[n - 1]!) {
      channels.forEach((values, c) => (out[c] = values[n - 1]!));
      return out;
    }
    let i = 0;
    while (i < n - 2 && frame >= times[i + 1]!) i++;
    const dt = times[i + 1]! - times[i]!;
    const u = (frame - times[i]!) / dt;
    const interpolation = keys[i]!.interpolation;
    const u2 = u * u;
    const u3 = u2 * u;
    channels.forEach((values, c) => {
      const a = values[i]!;
      const b = values[i + 1]!;
      if (interpolation === "hold") out[c] = a;
      else if (interpolation === "linear") out[c] = a + (b - a) * u;
      else
        out[c] =
          (2 * u3 - 3 * u2 + 1) * a +
          (u3 - 2 * u2 + u) * dt * tangents[c]![i]! +
          (-2 * u3 + 3 * u2) * b +
          (u3 - u2) * dt * tangents[c]![i + 1]!;
    });
    return out;
  }

  const scratch = [0, 0, 0, 0, 0];
  function positionAt(frame: number): TrajectoryPoint {
    evaluate(frame, scratch);
    return [
      scratch[0]!,
      options.allowBelowFloor
        ? scratch[1]!
        : Math.max(TRAJECTORY_FLOOR_Y, scratch[1]!),
      scratch[2]!,
    ];
  }

  function poseAt(frame: number): ShotPose {
    const position = positionAt(frame);
    const yaw = scratch[3]!;
    const pitch = scratch[4]!;
    let quaternion: TrajectoryQuaternion | null = null;
    if (options.aimMode === "look_at" && options.aimTarget) {
      const target = options.aimTarget;
      if (
        Math.hypot(
          target[0] - position[0],
          target[1] - position[1],
          target[2] - position[2],
        ) > 1e-4
      )
        quaternion = quaternionLookingAt(position, target);
    } else if (options.aimMode === "forward" && n >= 2) {
      const first = times[0]!;
      const last = times[n - 1]!;
      // Look ahead along the path; at the very end, keep the last heading.
      const from = THREE.MathUtils.clamp(frame - 0.5, first, last - 1);
      const ahead = positionAt(from + 1);
      const behind = positionAt(from);
      const direction: TrajectoryPoint = [
        ahead[0] - behind[0],
        (ahead[1] - behind[1]) * 0.5,
        ahead[2] - behind[2],
      ];
      if (Math.hypot(...direction) > 1e-5)
        quaternion = quaternionLookingAt(position, [
          position[0] + direction[0],
          position[1] + direction[1],
          position[2] + direction[2],
        ]);
    }
    if (!quaternion) return { position, quaternion: cameraQuaternionFromAim(yaw, pitch), yaw: wrapDegrees(yaw), pitch };
    const aim = cameraAimDegrees(quaternion);
    return { position, quaternion, yaw: aim.yaw, pitch: aim.pitch };
  }

  return { keyframes: keys, positionAt, poseAt };
}

function wrapDegrees(value: number) {
  return THREE.MathUtils.euclideanModulo(value + 180, 360) - 180;
}

export function sampleShot(
  curve: ShotCurve,
  frameCount: number,
  fovRadians: number,
): SampledCameraView[] {
  return Array.from({ length: frameCount }, (_, frame) => {
    const pose = curve.poseAt(frame);
    return { position: pose.position, quaternion: pose.quaternion, fovRadians };
  });
}

export function buildShotTargetCameras(
  curve: ShotCurve,
  frameCount: number,
  width: number,
  height: number,
  fovRadians: number,
): PinholeCamera[] {
  return sampleShot(curve, frameCount, fovRadians).map((view) => ({
    intrinsics: createIntrinsicsFromFov(
      THREE.MathUtils.radToDeg(view.fovRadians),
      width,
      height,
    ),
    extrinsics: {
      position: view.position,
      quaternion: view.quaternion,
      coordinateSystem: "rub",
    },
  }));
}

/** True when the shot moves or turns enough to be worth generating. */
export function shotHasMotion(keyframes: readonly CameraKeyframe[]): boolean {
  if (keyframes.length < 2) return false;
  const first = keyframes[0]!;
  return keyframes.some(
    (key) =>
      Math.hypot(
        key.position[0] - first.position[0],
        key.position[1] - first.position[1],
        key.position[2] - first.position[2],
      ) > 1e-3 ||
      Math.abs(wrapDegrees(key.yaw - first.yaw)) > 0.1 ||
      Math.abs(key.pitch - first.pitch) > 0.1,
  );
}

export function newKeyframeId() {
  return `key_${crypto.randomUUID()}`;
}

export function keyframeAt(
  keyframes: readonly CameraKeyframe[],
  frame: number,
): CameraKeyframe | null {
  return keyframes.find((key) => key.frame === Math.round(frame)) ?? null;
}

/**
 * Record a pose at a frame: update the key already there, or insert one that
 * continues the motion style of the key before it.
 */
export function upsertKeyframe(
  keyframes: readonly CameraKeyframe[],
  frame: number,
  pose: { position: TrajectoryPoint; yaw: number; pitch: number },
): { keyframes: CameraKeyframe[]; id: string } {
  const whole = Math.round(frame);
  const existing = keyframeAt(keyframes, whole);
  if (existing) {
    return {
      id: existing.id,
      keyframes: keyframes.map((key) =>
        key.id === existing.id ? { ...key, ...pose } : key,
      ),
    };
  }
  const previous = sortKeyframes(keyframes)
    .filter((key) => key.frame < whole)
    .at(-1);
  const key: CameraKeyframe = {
    id: newKeyframeId(),
    frame: whole,
    ...pose,
    interpolation: previous?.interpolation ?? "smooth",
    ease: null,
  };
  return { id: key.id, keyframes: sortKeyframes([...keyframes, key]) };
}

/** Move a key in time without passing its neighbours. */
export function retimeKeyframe(
  keyframes: readonly CameraKeyframe[],
  id: string,
  frame: number,
  frameCount: number,
): CameraKeyframe[] {
  const keys = sortKeyframes(keyframes);
  const index = keys.findIndex((key) => key.id === id);
  if (index < 0) return keys;
  const low = index > 0 ? keys[index - 1]!.frame + 1 : 0;
  const high =
    index < keys.length - 1 ? keys[index + 1]!.frame - 1 : frameCount - 1;
  const next = THREE.MathUtils.clamp(Math.round(frame), low, Math.max(low, high));
  return keys.map((key) => (key.id === id ? { ...key, frame: next } : key));
}

/**
 * Change the time between key `index` and the next one. Later keys move with
 * it, limited so the last key stays inside the shot.
 */
export function setKeyframeGap(
  keyframes: readonly CameraKeyframe[],
  index: number,
  gapFrames: number,
  frameCount: number,
): CameraKeyframe[] {
  const keys = sortKeyframes(keyframes);
  if (index < 0 || index >= keys.length - 1) return keys;
  const current = keys[index + 1]!.frame - keys[index]!.frame;
  const room = frameCount - 1 - keys.at(-1)!.frame;
  const delta = THREE.MathUtils.clamp(
    Math.round(gapFrames) - current,
    1 - current,
    room,
  );
  return keys.map((key, keyIndex) =>
    keyIndex > index ? { ...key, frame: key.frame + delta } : key,
  );
}

/**
 * Spread keys over the whole shot so the camera travels at an even pace:
 * first key at the start, last at the end, the rest by distance travelled.
 */
export function spaceKeyframesEvenly(
  keyframes: readonly CameraKeyframe[],
  frameCount: number,
): CameraKeyframe[] {
  const keys = sortKeyframes(keyframes);
  if (keys.length < 2) return keys;
  const lengths = [0];
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]!;
    const b = keys[i]!;
    const distance = Math.hypot(
      b.position[0] - a.position[0],
      b.position[1] - a.position[1],
      b.position[2] - a.position[2],
    );
    // Turning in place still needs screen time.
    const turn =
      (Math.abs(wrapDegrees(b.yaw - a.yaw)) + Math.abs(b.pitch - a.pitch)) /
      90;
    lengths.push(lengths.at(-1)! + Math.max(distance, turn, 1e-3));
  }
  const total = lengths.at(-1)!;
  const last = frameCount - 1;
  const frames = lengths.map((length) => Math.round((length / total) * last));
  for (let i = 1; i < frames.length; i++)
    frames[i] = Math.max(frames[i]!, frames[i - 1]! + 1);
  for (let i = frames.length - 2; i >= 0; i--)
    frames[i] = Math.min(frames[i]!, frames[i + 1]! - 1);
  return keys.map((key, index) => ({ ...key, frame: frames[index]! }));
}

/** Keys spaced evenly in time from a list of poses. */
export function keyframesFromPoses(
  poses: readonly { position: TrajectoryPoint; yaw: number; pitch: number }[],
  frameCount: number,
): CameraKeyframe[] {
  const last = frameCount - 1;
  return poses.map((pose, index) => ({
    id: newKeyframeId(),
    frame:
      poses.length === 1
        ? 0
        : Math.round((index / (poses.length - 1)) * last),
    position: [...pose.position],
    yaw: pose.yaw,
    pitch: pose.pitch,
    interpolation: "smooth",
    ease: null,
  }));
}

export function poseFromView(view: {
  position: TrajectoryPoint;
  quaternion: TrajectoryQuaternion;
}) {
  return {
    position: [...view.position] as TrajectoryPoint,
    ...cameraAimDegrees(view.quaternion),
  };
}

/**
 * Convert a draft saved with the earlier pivot paths. Each pivot becomes a key
 * at the frame where the old sampler reached it, keeping the old aim.
 */
export function keyframesFromLegacySegments(
  segments: readonly TrajectorySegment[],
  reference: CameraView,
  frameCount: number,
  legacy: {
    directionMode: CameraDirectionMode;
    directionTarget: TrajectoryPoint | null;
    closedLoop: boolean;
    allowBelowFloor: boolean;
  },
): { keyframes: CameraKeyframe[]; aimMode: CameraAimMode } {
  const views = cameraViewsFromSegments(
    segments,
    reference,
    legacy.allowBelowFloor,
  );
  const aimMode: CameraAimMode =
    legacy.directionMode === "look_at" && legacy.directionTarget
      ? "look_at"
      : legacy.directionMode === "forward"
        ? "forward"
        : "free";
  if (views.length === 0) return { keyframes: [], aimMode };
  if (views.length === 1)
    return { keyframes: keyframesFromPoses([poseFromView(views[0]!)], frameCount), aimMode };
  const samples = sampleCameraPath(views, frameCount, {
    directionMode: legacy.directionMode,
    directionTarget: legacy.directionTarget ?? undefined,
    closedLoop: legacy.closedLoop,
    allowBelowFloor: legacy.allowBelowFloor,
  });
  const pivots = legacy.closedLoop ? [...views, views[0]!] : views;
  const frames: number[] = [];
  let from = 0;
  pivots.forEach((pivot, index) => {
    if (index === 0) return void frames.push(0);
    if (index === pivots.length - 1) return void frames.push(frameCount - 1);
    let best = from;
    let bestDistance = Infinity;
    for (let frame = from; frame < samples.length; frame++) {
      const p = samples[frame]!.position;
      const distance = Math.hypot(
        p[0] - pivot.position[0],
        p[1] - pivot.position[1],
        p[2] - pivot.position[2],
      );
      if (distance < bestDistance) {
        best = frame;
        bestDistance = distance;
      }
    }
    frames.push(best);
    from = best + 1;
  });
  for (let i = 1; i < frames.length; i++)
    frames[i] = Math.max(frames[i]!, frames[i - 1]! + 1);
  const keyframes = pivots
    .map((pivot, index) => {
      const frame = Math.min(frames[index]!, frameCount - 1);
      const sample = samples[frame] ?? samples.at(-1)!;
      return {
        id: newKeyframeId(),
        frame,
        position: [...pivot.position] as TrajectoryPoint,
        ...cameraAimDegrees(sample.quaternion),
        interpolation: "smooth" as const,
        ease: null,
      };
    })
    .filter(
      (key, index, all) => index === 0 || key.frame > all[index - 1]!.frame,
    );
  return { keyframes, aimMode };
}

export function isCameraKeyframe(value: unknown): value is CameraKeyframe {
  if (!value || typeof value !== "object") return false;
  const key = value as Partial<CameraKeyframe>;
  return (
    typeof key.id === "string" &&
    Number.isInteger(key.frame) &&
    Array.isArray(key.position) &&
    key.position.length === 3 &&
    key.position.every(Number.isFinite) &&
    Number.isFinite(key.yaw) &&
    Number.isFinite(key.pitch) &&
    (key.interpolation === "smooth" ||
      key.interpolation === "linear" ||
      key.interpolation === "hold") &&
    (key.ease === null || Number.isFinite(key.ease))
  );
}
