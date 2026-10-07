import type { PinholeCamera } from "./common";
import { createIntrinsicsFromFov } from "./common";
import * as THREE from "three";

export type CameraView = {
  id: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  fovRadians: number;
  angleKey?: boolean;
  directionOverride?: TrajectoryQuaternion;
  lookAtTarget?: TrajectoryPoint;
};

export type CameraDirectionMode =
  "manual" | "forward" | "inward" | "outward" | "look_at" | "look_away";
export type TrajectoryShape = "straighten" | "circular" | "flatten";
export type CameraPathOptions = {
  directionMode?: CameraDirectionMode;
  directionTarget?: TrajectoryPoint;
  closedLoop?: boolean;
  allowBelowFloor?: boolean;
};
export type SampledCameraView = Omit<
  CameraView,
  "angleKey" | "directionOverride" | "id" | "lookAtTarget"
>;
export type DrawPoint = [number, number];
export type TrajectoryPoint = [number, number, number];
export type TrajectoryQuaternion = [number, number, number, number];
export type TrajectoryDrawingView = {
  right: TrajectoryPoint;
  up: TrajectoryPoint;
  forward: TrajectoryPoint;
};
export type TrajectorySegment = {
  id: string;
  points: TrajectoryPoint[];
  quaternions?: (TrajectoryQuaternion | null)[] | null;
  direction_overrides?: (TrajectoryQuaternion | null)[] | null;
  look_at_target?: TrajectoryPoint | null;
};
export type TrajectoryPivot = {
  segmentId: string;
  pointIndex: number;
  pivotNumber: number;
  position: TrajectoryPoint;
  hasCameraAngle: boolean;
  hasLookAtTarget: boolean;
};
export type TrajectorySpace = {
  center: TrajectoryPoint;
  radius: number;
};

export const TRAJECTORY_FLOOR_Y = 0;
export const TRAJECTORY_SMOOTHING_VERSION = 1;
export const MAX_PIVOTS_PER_PART = 12;
const MAX_POINTS_PER_DRAWN_PART = 5;
const DRAW_POINT_SPACING = 0.18;
const POSITION_SMOOTHING_WEIGHTS = [1, 6, 15, 20, 15, 6, 1] as const;
const POSITION_SMOOTHING_WEIGHT_TOTAL = 64;
const POSITION_SMOOTHING_REFERENCE_FRAMES = 96;
const POSITION_SMOOTHING_STEP = 1 / POSITION_SMOOTHING_REFERENCE_FRAMES;
const POSITION_FAIRING_NEIGHBOR_WEIGHT = 0.2;
const POSITION_FAIRING_PASSES = 2;
const PRESET_ORIENTATION_REFERENCE_FRAMES = 128;

export function trajectoryPathFromSegments(
  segments: readonly TrajectorySegment[],
): TrajectoryPoint[] {
  return trajectoryPathEntries(segments).map((entry) => entry.point);
}

export function trajectoryPivotsFromSegments(
  segments: readonly TrajectorySegment[],
): TrajectoryPivot[] {
  const entries = trajectoryPathEntries(segments);
  return entries.map((entry, index) => ({
    segmentId: segments[entry.segmentIndex]!.id,
    pointIndex: entry.pointIndex,
    pivotNumber: index + 1,
    position: entry.point,
    hasCameraAngle: Boolean(entry.quaternion || entry.directionOverride),
    hasLookAtTarget: Boolean(
      entry.lookAtTarget || entries[index - 1]?.lookAtTarget,
    ),
  }));
}

type TrajectoryPathEntry = {
  point: TrajectoryPoint;
  quaternion: TrajectoryQuaternion | null;
  directionOverride: TrajectoryQuaternion | null;
  lookAtTarget: TrajectoryPoint | null;
  segmentIndex: number;
  pointIndex: number;
};

function trajectoryPathEntries(
  segments: readonly TrajectorySegment[],
): TrajectoryPathEntry[] {
  const entries: TrajectoryPathEntry[] = [];
  segments.forEach((segment, segmentIndex) => {
    segment.points.forEach((point, pointIndex) => {
      const lookAtTarget =
        pointIndex < segment.points.length - 1
          ? (segment.look_at_target ?? null)
          : null;
      const quaternion = segment.quaternions?.[pointIndex] ?? null;
      const directionOverride =
        segment.direction_overrides?.[pointIndex] ?? null;
      const previous = entries.at(-1);
      if (previous && sameTrajectoryPoint(point, previous.point)) {
        if (!previous.quaternion && quaternion)
          previous.quaternion = quaternion;
        if (!previous.directionOverride && directionOverride)
          previous.directionOverride = directionOverride;
        previous.lookAtTarget = lookAtTarget;
        return;
      }
      entries.push({
        point,
        quaternion,
        directionOverride,
        lookAtTarget,
        segmentIndex,
        pointIndex,
      });
    });
  });
  return entries;
}

export function smoothTrajectorySegments(
  segments: readonly TrajectorySegment[],
  closedLoop = false,
): TrajectorySegment[] {
  const smoothedPath = fairTrajectoryPoints(
    trajectoryPathEntries(segments).map((entry) => entry.point),
    closedLoop,
  );
  let pathIndex = -1;
  let previousPoint: TrajectoryPoint | null = null;

  return segments.map((segment) => ({
    ...segment,
    points: segment.points.map((point) => {
      if (!previousPoint || !sameTrajectoryPoint(point, previousPoint)) {
        pathIndex += 1;
      }
      previousPoint = point;
      return smoothedPath[pathIndex]!;
    }),
  }));
}

export function reshapeTrajectorySegments(
  segments: readonly TrajectorySegment[],
  shape: TrajectoryShape,
  view: TrajectoryDrawingView,
  segmentId: string | null,
  closedLoop: boolean,
  allowBelowFloor = false,
): TrajectorySegment[] | null {
  const selectedIndex = segmentId
    ? segments.findIndex((segment) => segment.id === segmentId)
    : -1;
  if (segmentId && selectedIndex < 0) return null;

  const sourcePoints = segmentId
    ? segments[selectedIndex]!.points
    : trajectoryPathEntries(segments).map((entry) => entry.point);
  const repeatedClosedEndpoint =
    !segmentId &&
    closedLoop &&
    sourcePoints.length >= 4 &&
    sameTrajectoryPoint(sourcePoints[0]!, sourcePoints.at(-1)!);
  const shapeSourcePoints = repeatedClosedEndpoint
    ? sourcePoints.slice(0, -1)
    : sourcePoints;
  if (
    shapeSourcePoints.length < 3 ||
    (!segmentId && closedLoop && shape === "straighten")
  ) {
    return null;
  }
  if (
    shape === "circular" &&
    !(!segmentId && closedLoop) &&
    sameTrajectoryPoint(shapeSourcePoints[0]!, shapeSourcePoints.at(-1)!)
  ) {
    return null;
  }

  const shapedLogicalPoints =
    shape === "straighten"
      ? straightTrajectoryPoints(shapeSourcePoints)
      : shape === "circular"
        ? circularTrajectoryPoints(
            shapeSourcePoints,
            view,
            !segmentId && closedLoop,
            allowBelowFloor,
          )
        : flattenTrajectoryPoints(
            shapeSourcePoints,
            view,
            !segmentId && closedLoop,
            allowBelowFloor,
          );
  const shapedPoints = repeatedClosedEndpoint
    ? [...shapedLogicalPoints, shapedLogicalPoints[0]!]
    : shapedLogicalPoints;
  if (
    shapedPoints.some(
      (point) =>
        point.some((coordinate) => !Number.isFinite(coordinate)) ||
        (!allowBelowFloor && point[1] < TRAJECTORY_FLOOR_Y - 1e-6),
    ) ||
    shapedPoints.some(
      (point, index) =>
        index > 0 && sameTrajectoryPoint(point, shapedPoints[index - 1]!),
    )
  ) {
    return null;
  }

  if (segmentId) {
    return segments.map((segment, index) =>
      index === selectedIndex ? { ...segment, points: shapedPoints } : segment,
    );
  }
  return replaceTrajectoryPathPoints(segments, shapedPoints);
}

function straightTrajectoryPoints(
  points: readonly TrajectoryPoint[],
): TrajectoryPoint[] {
  const start = new THREE.Vector3(...points[0]!);
  const end = new THREE.Vector3(...points.at(-1)!);
  return points.map((_, index) =>
    start
      .clone()
      .lerp(end, index / (points.length - 1))
      .toArray(),
  );
}

function circularTrajectoryPoints(
  points: readonly TrajectoryPoint[],
  view: TrajectoryDrawingView,
  closed: boolean,
  allowBelowFloor: boolean,
): TrajectoryPoint[] {
  if (closed) {
    return circularLoopTrajectoryPoints(points, view, allowBelowFloor);
  }

  const start = new THREE.Vector3(...points[0]!);
  const end = new THREE.Vector3(...points.at(-1)!);
  const chord = end.clone().sub(start);
  const chordLength = chord.length();
  if (chordLength < 1e-5) return [...points];

  const along = chord.clone().normalize();
  const normal = trajectoryPlaneNormal(view, along);
  const side = normal.clone().cross(along).normalize();
  if (side.dot(new THREE.Vector3(...view.up)) < 0) side.negate();
  const midpoint = start.clone().add(end).multiplyScalar(0.5);
  const offsets = points.slice(1, -1).map((point, index) => {
    const amount = (index + 1) / (points.length - 1);
    const baseline = start.clone().lerp(end, amount);
    return new THREE.Vector3(...point).sub(baseline).dot(side);
  });
  const measuredSagitta =
    offsets.reduce((sum, offset) => sum + offset, 0) / offsets.length;
  const sign = measuredSagitta < 0 ? -1 : 1;
  const sagitta =
    sign *
    THREE.MathUtils.clamp(
      Math.abs(measuredSagitta) < chordLength * 0.03
        ? chordLength * 0.25
        : Math.abs(measuredSagitta),
      chordLength * 0.08,
      chordLength * 0.75,
    );
  const halfChord = chordLength / 2;
  const centerOffset =
    (sagitta * sagitta - halfChord * halfChord) / (2 * sagitta);
  const center = midpoint.clone().addScaledVector(side, centerOffset);
  const startRadius = start.clone().sub(center);
  const endRadius = end.clone().sub(center);
  let sweep = Math.atan2(
    normal.dot(startRadius.clone().cross(endRadius)),
    startRadius.dot(endRadius),
  );
  const desiredMiddle = midpoint
    .clone()
    .addScaledVector(side, sagitta)
    .sub(center)
    .normalize();
  const shortMiddle = startRadius
    .clone()
    .applyAxisAngle(normal, sweep / 2)
    .normalize();
  if (shortMiddle.dot(desiredMiddle) < 0.999) {
    sweep += sweep < 0 ? Math.PI * 2 : -Math.PI * 2;
  }

  return points.map((_, index) => {
    if (index === 0) return points[0]!;
    if (index === points.length - 1) return points.at(-1)!;
    return center
      .clone()
      .add(
        startRadius
          .clone()
          .applyAxisAngle(normal, (sweep * index) / (points.length - 1)),
      )
      .toArray();
  });
}

function circularLoopTrajectoryPoints(
  points: readonly TrajectoryPoint[],
  view: TrajectoryDrawingView,
  allowBelowFloor: boolean,
): TrajectoryPoint[] {
  const normal = new THREE.Vector3(...view.forward).normalize();
  const center = points
    .reduce(
      (sum, point) => sum.add(new THREE.Vector3(...point)),
      new THREE.Vector3(),
    )
    .multiplyScalar(1 / points.length);
  const right = new THREE.Vector3(...view.right)
    .addScaledVector(normal, -new THREE.Vector3(...view.right).dot(normal))
    .normalize();
  const up = normal.clone().cross(right).normalize();
  if (up.dot(new THREE.Vector3(...view.up)) < 0) up.negate();
  const projected = points.map((point) => {
    const offset = new THREE.Vector3(...point).sub(center);
    return new THREE.Vector2(offset.dot(right), offset.dot(up));
  });
  const radius = Math.max(
    1e-4,
    projected.reduce((sum, point) => sum + point.length(), 0) / points.length,
  );
  const startAngle =
    projected[0]!.lengthSq() > 1e-8
      ? Math.atan2(projected[0]!.y, projected[0]!.x)
      : 0;
  const signedArea = projected.reduce((area, point, index) => {
    const next = projected[(index + 1) % projected.length]!;
    return area + point.x * next.y - point.y * next.x;
  }, 0);
  const direction = signedArea < 0 ? -1 : 1;
  const shaped = points.map((_, index) => {
    const angle =
      startAngle + (direction * Math.PI * 2 * index) / points.length;
    return center
      .clone()
      .addScaledVector(right, Math.cos(angle) * radius)
      .addScaledVector(up, Math.sin(angle) * radius);
  });
  const floorShift = allowBelowFloor
    ? 0
    : Math.max(
        0,
        TRAJECTORY_FLOOR_Y - Math.min(...shaped.map((point) => point.y)),
      );
  return shaped.map((point) => {
    point.y += floorShift;
    return point.toArray();
  });
}

function flattenTrajectoryPoints(
  points: readonly TrajectoryPoint[],
  view: TrajectoryDrawingView,
  closed: boolean,
  allowBelowFloor: boolean,
): TrajectoryPoint[] {
  const start = new THREE.Vector3(...points[0]!);
  const end = new THREE.Vector3(...points.at(-1)!);
  const chord = end.clone().sub(start);
  const origin = closed
    ? points
        .reduce(
          (sum, point) => sum.add(new THREE.Vector3(...point)),
          new THREE.Vector3(),
        )
        .multiplyScalar(1 / points.length)
    : start;
  const normal = trajectoryPlaneNormal(
    view,
    chord.lengthSq() > 1e-10 ? chord.normalize() : null,
  );
  const shaped = points.map((point) => {
    const projected = new THREE.Vector3(...point);
    projected.addScaledVector(
      normal,
      -projected.clone().sub(origin).dot(normal),
    );
    return projected;
  });
  if (closed) {
    const floorShift = allowBelowFloor
      ? 0
      : Math.max(
          0,
          TRAJECTORY_FLOOR_Y - Math.min(...shaped.map((point) => point.y)),
        );
    return shaped.map((point) => {
      point.y += floorShift;
      return point.toArray();
    });
  }
  return shaped.map((point, index) => {
    if (index === 0) return points[0]!;
    if (index === points.length - 1) return points.at(-1)!;
    return point.toArray();
  });
}

function trajectoryPlaneNormal(
  view: TrajectoryDrawingView,
  along: THREE.Vector3 | null,
): THREE.Vector3 {
  const candidates = [view.forward, view.up, view.right].map((axis) =>
    new THREE.Vector3(...axis).normalize(),
  );
  for (const candidate of candidates) {
    if (along) candidate.addScaledVector(along, -candidate.dot(along));
    if (candidate.lengthSq() > 1e-8) return candidate.normalize();
  }
  return new THREE.Vector3(0, 1, 0);
}

function replaceTrajectoryPathPoints(
  segments: readonly TrajectorySegment[],
  points: readonly TrajectoryPoint[],
): TrajectorySegment[] {
  let pathIndex = -1;
  let previousPoint: TrajectoryPoint | null = null;
  return segments.map((segment) => ({
    ...segment,
    points: segment.points.map((point) => {
      if (!previousPoint || !sameTrajectoryPoint(point, previousPoint)) {
        pathIndex += 1;
      }
      previousPoint = point;
      return points[pathIndex]!;
    }),
  }));
}

export function materializeTrajectorySmoothing(
  segments: readonly TrajectorySegment[],
  currentVersion: number,
): { segments: TrajectorySegment[]; version: number } {
  return {
    segments:
      currentVersion >= TRAJECTORY_SMOOTHING_VERSION
        ? [...segments]
        : smoothTrajectorySegments(segments),
    version: TRAJECTORY_SMOOTHING_VERSION,
  };
}

function fairTrajectoryPoints(
  trajectoryPoints: readonly TrajectoryPoint[],
  closedLoop = false,
): TrajectoryPoint[] {
  if (trajectoryPoints.length < 3) return [...trajectoryPoints];

  let points = trajectoryPoints.map((point) => new THREE.Vector3(...point));
  for (let pass = 0; pass < POSITION_FAIRING_PASSES; pass += 1) {
    const previous = points;
    points = previous.map((point, index) => {
      if (!closedLoop && (index === 0 || index === previous.length - 1)) {
        return point.clone();
      }
      return point
        .clone()
        .multiplyScalar(1 - 2 * POSITION_FAIRING_NEIGHBOR_WEIGHT)
        .addScaledVector(
          previous[(index - 1 + previous.length) % previous.length]!,
          POSITION_FAIRING_NEIGHBOR_WEIGHT,
        )
        .addScaledVector(
          previous[(index + 1) % previous.length]!,
          POSITION_FAIRING_NEIGHBOR_WEIGHT,
        );
    });
  }
  return points.map((point) => point.toArray());
}

export function moveTrajectoryPoint(
  segments: readonly TrajectorySegment[],
  segmentId: string,
  pointIndex: number,
  position: TrajectoryPoint,
): TrajectorySegment[] {
  const segmentIndex = segments.findIndex(
    (segment) => segment.id === segmentId,
  );
  const segment = segments[segmentIndex]!;
  const previousPosition = segment.points[pointIndex]!;

  return segments.map((current, currentIndex) => {
    const points = [...current.points];
    let changed = false;
    if (currentIndex === segmentIndex) {
      points[pointIndex] = position;
      changed = true;
    }
    if (
      currentIndex === segmentIndex - 1 &&
      pointIndex === 0 &&
      sameTrajectoryPoint(points.at(-1)!, previousPosition)
    ) {
      points[points.length - 1] = position;
      changed = true;
    }
    if (
      currentIndex === segmentIndex + 1 &&
      pointIndex === segment.points.length - 1 &&
      sameTrajectoryPoint(points[0]!, previousPosition)
    ) {
      points[0] = position;
      changed = true;
    }
    return changed ? { ...current, points } : current;
  });
}

export function deleteTrajectoryPivot(
  segments: readonly TrajectorySegment[],
  segmentId: string,
  pointIndex: number,
): TrajectorySegment[] | null {
  const segmentIndex = segments.findIndex(
    (segment) => segment.id === segmentId,
  );
  const segment = segments[segmentIndex];
  const position = segment?.points[pointIndex];
  if (!segment || !position) return null;

  const storedPoints = segments.flatMap((current, currentIndex) =>
    current.points.map((point, currentPointIndex) => ({
      point,
      segmentIndex: currentIndex,
      pointIndex: currentPointIndex,
    })),
  );
  const selectedIndex = storedPoints.findIndex(
    (entry) =>
      entry.segmentIndex === segmentIndex && entry.pointIndex === pointIndex,
  );
  let firstDuplicate = selectedIndex;
  let lastDuplicate = selectedIndex;
  while (
    firstDuplicate > 0 &&
    sameTrajectoryPoint(storedPoints[firstDuplicate - 1]!.point, position)
  ) {
    firstDuplicate -= 1;
  }
  while (
    lastDuplicate < storedPoints.length - 1 &&
    sameTrajectoryPoint(storedPoints[lastDuplicate + 1]!.point, position)
  ) {
    lastDuplicate += 1;
  }

  const removedIndexes = new Map<number, Set<number>>();
  storedPoints.slice(firstDuplicate, lastDuplicate + 1).forEach((entry) => {
    const indexes = removedIndexes.get(entry.segmentIndex) ?? new Set();
    indexes.add(entry.pointIndex);
    removedIndexes.set(entry.segmentIndex, indexes);
  });

  return segments.flatMap((current, currentIndex) => {
    const indexes = removedIndexes.get(currentIndex);
    if (!indexes) return [current];
    const points = current.points.filter((_, index) => !indexes.has(index));
    if (points.length === 0) return [];
    const quaternions = current.quaternions
      ? current.quaternions.filter((_, index) => !indexes.has(index))
      : current.quaternions;
    const direction_overrides = current.direction_overrides
      ? current.direction_overrides.filter((_, index) => !indexes.has(index))
      : current.direction_overrides;
    return [{ ...current, points, quaternions, direction_overrides }];
  });
}

export function setTrajectoryPointQuaternion(
  segments: readonly TrajectorySegment[],
  segmentId: string,
  pointIndex: number,
  quaternion: TrajectoryQuaternion,
): TrajectorySegment[] {
  return setTrajectoryPointOrientation(
    segments,
    segmentId,
    pointIndex,
    quaternion,
    "quaternions",
  );
}

export function setTrajectoryPointDirectionOverride(
  segments: readonly TrajectorySegment[],
  segmentId: string,
  pointIndex: number,
  quaternion: TrajectoryQuaternion,
): TrajectorySegment[] {
  return setTrajectoryPointOrientation(
    segments,
    segmentId,
    pointIndex,
    quaternion,
    "direction_overrides",
  );
}

function setTrajectoryPointOrientation(
  segments: readonly TrajectorySegment[],
  segmentId: string,
  pointIndex: number,
  quaternion: TrajectoryQuaternion,
  field: "quaternions" | "direction_overrides",
): TrajectorySegment[] {
  const segmentIndex = segments.findIndex(
    (segment) => segment.id === segmentId,
  );
  const segment = segments[segmentIndex]!;
  const position = segment.points[pointIndex]!;
  const normalized = new THREE.Quaternion(...quaternion).normalize().toArray();

  return segments.map((current, currentIndex) => {
    let quaternionIndex: number | null = null;
    if (currentIndex === segmentIndex) quaternionIndex = pointIndex;
    if (
      currentIndex === segmentIndex - 1 &&
      pointIndex === 0 &&
      sameTrajectoryPoint(current.points.at(-1)!, position)
    ) {
      quaternionIndex = current.points.length - 1;
    }
    if (
      currentIndex === segmentIndex + 1 &&
      pointIndex === segment.points.length - 1 &&
      sameTrajectoryPoint(current.points[0]!, position)
    ) {
      quaternionIndex = 0;
    }
    if (quaternionIndex === null) return current;

    const orientations = current.points.map(
      (_, index) => current[field]?.[index] ?? null,
    );
    orientations[quaternionIndex] = normalized;
    return { ...current, [field]: orientations };
  });
}

export function insertTrajectoryPivot(
  segments: readonly TrajectorySegment[],
  position: TrajectoryPoint,
  curveProgress: number,
  closedLoop = false,
  allowBelowFloor = false,
): {
  segments: TrajectorySegment[];
  segmentId: string;
  pointIndex: number;
  pivotNumber: number;
} | null {
  const normalizedSegments = closedLoop
    ? normalizeClosedTrajectorySegments(segments)
    : [...segments];
  const entries = trajectoryPathEntries(normalizedSegments);
  const path = entries.map((entry) => entry.point);
  if (path.length < 2) return null;
  const closed = closedLoop && path.length >= 3;
  const clampedCurveProgress = THREE.MathUtils.clamp(curveProgress, 0, 1);
  const spanCount = closed ? path.length : path.length - 1;
  const spanIndex = Math.min(
    Math.floor(clampedCurveProgress * spanCount),
    spanCount - 1,
  );
  const closingSpan = closed && spanIndex === path.length - 1;
  const owner = closingSpan ? entries.at(-1) : entries[spanIndex + 1];
  if (!owner) return null;
  const segment = normalizedSegments[owner.segmentIndex]!;
  if (segment.points.length >= MAX_PIVOTS_PER_PART) return null;
  const nextPosition: TrajectoryPoint = [
    position[0],
    allowBelowFloor ? position[1] : Math.max(TRAJECTORY_FLOOR_Y, position[1]),
    position[2],
  ];
  const pointIndex = owner.pointIndex + (closingSpan ? 1 : 0);
  const nextPathPoint = closingSpan ? path[0]! : path[spanIndex + 1]!;
  if (
    sameTrajectoryPoint(nextPosition, path[spanIndex]!) ||
    sameTrajectoryPoint(nextPosition, nextPathPoint)
  ) {
    return null;
  }
  const nextSegments = normalizedSegments.map((current, index) => {
    if (index !== owner.segmentIndex) return current;
    const quaternions = current.quaternions
      ? [
          ...current.quaternions.slice(0, pointIndex),
          null,
          ...current.quaternions.slice(pointIndex),
        ]
      : current.quaternions;
    const direction_overrides = current.direction_overrides
      ? [
          ...current.direction_overrides.slice(0, pointIndex),
          null,
          ...current.direction_overrides.slice(pointIndex),
        ]
      : current.direction_overrides;
    return {
      ...current,
      points: [
        ...current.points.slice(0, pointIndex),
        nextPosition,
        ...current.points.slice(pointIndex),
      ],
      quaternions,
      direction_overrides,
    };
  });
  return {
    segments: nextSegments,
    segmentId: segment.id,
    pointIndex,
    pivotNumber: spanIndex + 2,
  };
}

export function normalizeClosedTrajectorySegments(
  segments: readonly TrajectorySegment[],
): TrajectorySegment[] {
  const entries = trajectoryPathEntries(segments);
  if (
    entries.length < 3 ||
    !sameTrajectoryPoint(entries[0]!.point, entries.at(-1)!.point)
  ) {
    return [...segments];
  }
  const duplicate = entries.at(-1)!;
  return (
    deleteTrajectoryPivot(
      segments,
      segments[duplicate.segmentIndex]!.id,
      duplicate.pointIndex,
    ) ?? [...segments]
  );
}

function sameTrajectoryPoint(
  first: TrajectoryPoint,
  second: TrajectoryPoint,
): boolean {
  return (
    new THREE.Vector3(...first).distanceTo(new THREE.Vector3(...second)) <= 1e-5
  );
}

export function cameraViewLookingAt(
  id: string,
  position: [number, number, number],
  target: [number, number, number],
  fovRadians: number,
): CameraView {
  return {
    id,
    position,
    quaternion: cameraQuaternionLookingAt(position, target).toArray(),
    fovRadians,
  };
}

export function cameraPathTarget(
  start: CameraView,
  groundTarget: [number, number, number],
): [number, number, number] {
  const position = new THREE.Vector3(...start.position);
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(
    new THREE.Quaternion(...start.quaternion),
  );
  const horizontalForward = Math.hypot(forward.x, forward.z);
  const horizontalDistance = Math.hypot(
    groundTarget[0] - start.position[0],
    groundTarget[2] - start.position[2],
  );
  const targetY =
    horizontalForward > 1e-5
      ? position.y + (forward.y * horizontalDistance) / horizontalForward
      : position.y;
  return [groundTarget[0], targetY, groundTarget[2]];
}

export function cameraDrawingView(
  quaternion: readonly [number, number, number, number],
): TrajectoryDrawingView {
  const rotation = new THREE.Quaternion(...quaternion).normalize();
  return {
    right: new THREE.Vector3(1, 0, 0).applyQuaternion(rotation).toArray(),
    up: new THREE.Vector3(0, 1, 0).applyQuaternion(rotation).toArray(),
    forward: new THREE.Vector3(0, 0, -1).applyQuaternion(rotation).toArray(),
  };
}

export function frameTrajectorySpaceAboveFloor(
  space: TrajectorySpace,
  view: TrajectoryDrawingView,
  anchor: TrajectoryPoint,
  allowBelowFloor = false,
): TrajectorySpace {
  const [anchorX, anchorY] = projectTrajectoryPoint(anchor, view, space);
  const anchoredSpace =
    anchorX >= 0 && anchorX <= 1 && anchorY >= 0 && anchorY <= 1
      ? space
      : { ...space, center: [...anchor] as TrajectoryPoint };
  if (allowBelowFloor) return anchoredSpace;
  const boundary = trajectoryFloorBoundary(view, anchoredSpace, anchor);
  if (!boundary) return anchoredSpace;

  const floorFacesDown = view.up[1] >= 0;
  const currentEdge = floorFacesDown
    ? Math.max(boundary[0][1], boundary[1][1])
    : Math.min(boundary[0][1], boundary[1][1]);
  const targetEdge = floorFacesDown ? 0.94 : 0.06;
  const [, anchoredAnchorY] = projectTrajectoryPoint(
    anchor,
    view,
    anchoredSpace,
  );
  const screenShift = THREE.MathUtils.clamp(
    targetEdge - currentEdge,
    0.06 - anchoredAnchorY,
    0.94 - anchoredAnchorY,
  );
  const shift = screenShift * anchoredSpace.radius * 2;
  const center = new THREE.Vector3(...anchoredSpace.center).addScaledVector(
    new THREE.Vector3(...view.up),
    shift,
  );
  return { center: center.toArray(), radius: anchoredSpace.radius };
}

export function projectTrajectoryPoint(
  point: TrajectoryPoint,
  view: TrajectoryDrawingView,
  space: TrajectorySpace,
): DrawPoint {
  const offset = new THREE.Vector3(...point).sub(
    new THREE.Vector3(...space.center),
  );
  return [
    0.5 + offset.dot(new THREE.Vector3(...view.right)) / (space.radius * 2),
    0.5 - offset.dot(new THREE.Vector3(...view.up)) / (space.radius * 2),
  ];
}

export function unprojectTrajectoryPoint(
  point: DrawPoint,
  view: TrajectoryDrawingView,
  space: TrajectorySpace,
  anchor: TrajectoryPoint,
  allowBelowFloor = false,
): TrajectoryPoint {
  const right = new THREE.Vector3(...view.right);
  const up = new THREE.Vector3(...view.up);
  const forward = new THREE.Vector3(...view.forward);
  const anchorOffset = new THREE.Vector3(...anchor).sub(
    new THREE.Vector3(...space.center),
  );
  const position = new THREE.Vector3(...space.center)
    .addScaledVector(right, (point[0] - 0.5) * space.radius * 2)
    .addScaledVector(up, (0.5 - point[1]) * space.radius * 2)
    .addScaledVector(forward, anchorOffset.dot(forward));
  if (!allowBelowFloor) {
    position.y = Math.max(TRAJECTORY_FLOOR_Y, position.y);
  }
  return position.toArray();
}

export function trajectoryFloorBoundary(
  view: TrajectoryDrawingView,
  space: TrajectorySpace,
  anchor: TrajectoryPoint,
): [DrawPoint, DrawPoint] | null {
  if (Math.abs(view.up[1]) < 0.1) return null;

  const center = new THREE.Vector3(...space.center);
  const forward = new THREE.Vector3(...view.forward);
  const depth = new THREE.Vector3(...anchor).sub(center).dot(forward);
  const boundaryPoint = (x: number): DrawPoint => {
    const rightOffset = (x - 0.5) * space.radius * 2;
    const upOffset =
      -(
        space.center[1] +
        view.right[1] * rightOffset +
        view.forward[1] * depth
      ) / view.up[1];
    return [x, 0.5 - upOffset / (space.radius * 2)];
  };
  return [boundaryPoint(0), boundaryPoint(1)];
}

export function appendDrawnTrajectory(
  existing: readonly TrajectoryPoint[],
  stroke: readonly DrawPoint[],
  view: TrajectoryDrawingView,
  space: TrajectorySpace,
  referencePosition: TrajectoryPoint,
  allowBelowFloor = false,
): TrajectoryPoint[] {
  if (stroke.length < 2) return [...existing];
  const anchor = existing.at(-1) ?? referencePosition;
  const newPoints = resampleDrawStroke(stroke)
    .slice(existing.length > 0 ? 1 : 0)
    .map((point) =>
      unprojectTrajectoryPoint(point, view, space, anchor, allowBelowFloor),
    );
  const path = [...existing];
  for (const point of newPoints) {
    const previous = path.at(-1);
    if (!previous || !sameTrajectoryPoint(point, previous)) {
      path.push(point);
    }
  }
  return path;
}

function resampleDrawStroke(stroke: readonly DrawPoint[]): DrawPoint[] {
  const distances = [0];
  for (let index = 1; index < stroke.length; index++) {
    const previous = stroke[index - 1]!;
    const current = stroke[index]!;
    distances.push(
      distances[index - 1]! +
        Math.hypot(current[0] - previous[0], current[1] - previous[1]),
    );
  }

  const totalDistance = distances.at(-1)!;
  const pointCount = Math.min(
    MAX_POINTS_PER_DRAWN_PART,
    Math.max(2, Math.ceil(totalDistance / DRAW_POINT_SPACING) + 1),
  );
  if (stroke.length <= pointCount || totalDistance < 1e-6) return [...stroke];

  let segmentIndex = 1;
  return Array.from({ length: pointCount }, (_, index) => {
    const targetDistance = (totalDistance * index) / (pointCount - 1);
    while (
      segmentIndex < distances.length - 1 &&
      distances[segmentIndex]! < targetDistance
    ) {
      segmentIndex += 1;
    }
    const startDistance = distances[segmentIndex - 1]!;
    const endDistance = distances[segmentIndex]!;
    const amount =
      endDistance === startDistance
        ? 0
        : (targetDistance - startDistance) / (endDistance - startDistance);
    const start = stroke[segmentIndex - 1]!;
    const end = stroke[segmentIndex]!;
    return [
      THREE.MathUtils.lerp(start[0], end[0], amount),
      THREE.MathUtils.lerp(start[1], end[1], amount),
    ];
  });
}

export function cameraViewsFromTrajectory(
  path: readonly TrajectoryPoint[],
  reference: CameraView,
  allowBelowFloor = false,
): CameraView[] {
  return path.map((point, index) => {
    const position: TrajectoryPoint = [
      point[0],
      allowBelowFloor ? point[1] : Math.max(TRAJECTORY_FLOOR_Y, point[1]),
      point[2],
    ];
    return {
      id: `drawn-frame-${index + 1}`,
      position,
      quaternion: reference.quaternion,
      fovRadians: reference.fovRadians,
    };
  });
}

export function cameraViewsFromSegments(
  segments: readonly TrajectorySegment[],
  reference: CameraView,
  allowBelowFloor = false,
): CameraView[] {
  const entries = trajectoryPathEntries(segments);
  return cameraViewsFromTrajectory(
    entries.map((entry) => entry.point),
    reference,
    allowBelowFloor,
  ).map((view, index) => ({
    ...view,
    quaternion: entries[index]!.quaternion ?? reference.quaternion,
    angleKey: Boolean(entries[index]!.quaternion),
    directionOverride: entries[index]!.directionOverride ?? undefined,
    lookAtTarget: entries[index]!.lookAtTarget ?? undefined,
  }));
}

export function cameraQuaternionAtView(
  views: readonly CameraView[],
  viewIndex: number,
  options: CameraPathOptions = {},
): TrajectoryQuaternion {
  if (views.length === 0) return [0, 0, 0, 1];
  return sampleCameraPivot(views, viewIndex, options).quaternion;
}

export function cameraAimDegrees(quaternion: TrajectoryQuaternion): {
  yaw: number;
  pitch: number;
} {
  const euler = new THREE.Euler().setFromQuaternion(
    new THREE.Quaternion(...quaternion).normalize(),
    "YXZ",
  );
  return {
    yaw:
      THREE.MathUtils.euclideanModulo(
        -THREE.MathUtils.radToDeg(euler.y) + 180,
        360,
      ) - 180,
    pitch: THREE.MathUtils.radToDeg(euler.x),
  };
}

export function cameraQuaternionFromAim(
  yaw: number,
  pitch: number,
): TrajectoryQuaternion {
  return new THREE.Quaternion()
    .setFromEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(THREE.MathUtils.clamp(pitch, -89, 89)),
        THREE.MathUtils.degToRad(-yaw),
        0,
        "YXZ",
      ),
    )
    .normalize()
    .toArray();
}

export function projectCameraPreviewPoints(
  points: readonly TrajectoryPoint[],
  view: CameraView,
  aspectRatio = 16 / 9,
): { x: number; y: number; depth: number; pointIndex: number }[] {
  const cameraPosition = new THREE.Vector3(...view.position);
  const worldToCamera = new THREE.Quaternion(...view.quaternion)
    .normalize()
    .invert();
  const halfHeightAtUnitDepth = Math.tan(view.fovRadians / 2);
  const local = new THREE.Vector3();
  const projected: {
    x: number;
    y: number;
    depth: number;
    pointIndex: number;
  }[] = [];

  for (const [pointIndex, point] of points.entries()) {
    local
      .set(...point)
      .sub(cameraPosition)
      .applyQuaternion(worldToCamera);
    const depth = -local.z;
    if (depth <= 0.01) continue;
    const x = 0.5 + local.x / (2 * depth * halfHeightAtUnitDepth * aspectRatio);
    const y = 0.5 - local.y / (2 * depth * halfHeightAtUnitDepth);
    if (x < 0 || x > 1 || y < 0 || y > 1) continue;
    projected.push({ x, y, depth, pointIndex });
  }
  return projected;
}

/** Sample a smooth path using the chosen camera direction behavior. */
export function sampleCameraPath(
  views: readonly CameraView[],
  frameCount: number,
  options: CameraPathOptions = {},
): SampledCameraView[] {
  if (views.length < 2 || frameCount < 1) return [];

  const {
    directionMode = "manual",
    directionTarget,
    closedLoop = false,
    allowBelowFloor = false,
  } = options;
  const minimumY = allowBelowFloor ? -Infinity : TRAJECTORY_FLOOR_Y;
  const path = normalizedCameraPath(views, closedLoop);
  const pathViews = path.views;
  const closed = path.closed;
  const curve = cameraPathCurve(pathViews, closed, minimumY);
  const orientationKeys = cameraOrientationKeys(pathViews, closed);
  const segmentCount = closed ? pathViews.length : pathViews.length - 1;
  const constantFovRadians = pathViews.every(
    (view) => view.fovRadians === pathViews[0]!.fovRadians,
  )
    ? pathViews[0]!.fovRadians
    : null;
  const progresses = Array.from({ length: frameCount }, (_, index) =>
    cameraPathProgressAtFrame(index, frameCount, pathViews.length, closed),
  );
  const positions = progresses.map((curveProgress, index) =>
    cameraPositionAtProgress(
      pathViews,
      curve,
      curveProgress,
      closed,
      index === 0,
      index === frameCount - 1,
      minimumY,
    ),
  );
  const target =
    directionMode === "inward" ||
    directionMode === "outward" ||
    directionMode === "look_at" ||
    directionMode === "look_away"
      ? cameraDirectionTarget(pathViews, directionTarget, minimumY)
      : null;
  const presetOrientationFrame =
    directionMode === "manual"
      ? null
      : cameraPresetOrientationFrame(
          pathViews,
          curve,
          directionMode,
          target,
          closed,
          orientationKeys,
          minimumY,
        );
  const presetOverrideDeltas =
    directionMode === "manual" ||
    directionMode === "look_at" ||
    directionMode === "look_away"
      ? null
      : cameraPresetOverrideDeltas(
          pathViews,
          curve,
          directionMode,
          target,
          closed,
          orientationKeys,
          presetOrientationFrame!,
          minimumY,
        );
  let previousQuaternion: THREE.Quaternion | null = null;

  return progresses.map((curveProgress, index) => {
    const position = positions[index]!;
    const viewProgress = curveProgress * segmentCount;
    const segment = Math.min(Math.floor(viewProgress), segmentCount - 1);
    const amount = THREE.MathUtils.clamp(viewProgress - segment, 0, 1);
    const manualQuaternion = quaternionAtProgress(
      orientationKeys,
      curveProgress,
    );
    const presetQuaternion =
      directionMode === "manual"
        ? null
        : cameraPresetQuaternion(
            curve,
            curveProgress,
            position,
            directionMode,
            target,
            closed,
            manualQuaternion,
            presetOrientationFrame!,
            minimumY,
          );
    const baseQuaternion = presetQuaternion
      ? presetDeltaAtProgress(
          presetOverrideDeltas,
          curveProgress,
          pathViews.length,
          closed,
        ).multiply(presetQuaternion)
      : manualQuaternion;
    const quaternion =
      partialLookAtQuaternion(
        pathViews,
        segment,
        amount,
        position,
        baseQuaternion,
        closed,
      ) ?? baseQuaternion;
    if (previousQuaternion && previousQuaternion.dot(quaternion) < 0) {
      quaternion.set(
        -quaternion.x,
        -quaternion.y,
        -quaternion.z,
        -quaternion.w,
      );
    }
    previousQuaternion = quaternion.clone();
    const fovRadians =
      constantFovRadians ??
      THREE.MathUtils.lerp(
        pathViews[segment]!.fovRadians,
        pathViews[closed ? (segment + 1) % pathViews.length : segment + 1]!
          .fovRadians,
        amount,
      );

    return {
      position: position.toArray(),
      quaternion: quaternion.toArray(),
      fovRadians,
    };
  });
}

const PART_DIRECTION_HANDOFF = 0.25;

function partialLookAtQuaternion(
  views: readonly CameraView[],
  spanIndex: number,
  amount: number,
  position: THREE.Vector3,
  baseQuaternion: THREE.Quaternion,
  closed: boolean,
): THREE.Quaternion | null {
  const currentTarget = lookAtTargetForSpan(views, spanIndex, closed);
  const previousTarget = lookAtTargetForSpan(views, spanIndex - 1, closed);
  const nextTarget = lookAtTargetForSpan(views, spanIndex + 1, closed);

  if (currentTarget) {
    const current = quaternionLookingAtPoint(
      position,
      currentTarget,
      baseQuaternion,
    );
    if (
      previousTarget &&
      !sameTrajectoryPoint(previousTarget, currentTarget) &&
      amount < PART_DIRECTION_HANDOFF
    ) {
      const previous = quaternionLookingAtPoint(
        position,
        previousTarget,
        baseQuaternion,
      );
      const boundary = previous.clone().slerp(current, 0.5);
      return boundary.slerp(
        current,
        smoothstep(amount / PART_DIRECTION_HANDOFF),
      );
    }
    if (
      nextTarget &&
      !sameTrajectoryPoint(nextTarget, currentTarget) &&
      amount > 1 - PART_DIRECTION_HANDOFF
    ) {
      const next = quaternionLookingAtPoint(
        position,
        nextTarget,
        baseQuaternion,
      );
      const boundary = current.clone().slerp(next, 0.5);
      return current.slerp(
        boundary,
        smoothstep(
          (amount - (1 - PART_DIRECTION_HANDOFF)) / PART_DIRECTION_HANDOFF,
        ),
      );
    }
    return current;
  }

  if (previousTarget && amount < PART_DIRECTION_HANDOFF) {
    const previous = quaternionLookingAtPoint(
      position,
      previousTarget,
      baseQuaternion,
    );
    return previous.slerp(
      baseQuaternion,
      smoothstep(amount / PART_DIRECTION_HANDOFF),
    );
  }
  if (nextTarget && amount > 1 - PART_DIRECTION_HANDOFF) {
    const next = quaternionLookingAtPoint(position, nextTarget, baseQuaternion);
    return baseQuaternion
      .clone()
      .slerp(
        next,
        smoothstep(
          (amount - (1 - PART_DIRECTION_HANDOFF)) / PART_DIRECTION_HANDOFF,
        ),
      );
  }
  return null;
}

function lookAtTargetForSpan(
  views: readonly CameraView[],
  spanIndex: number,
  closed: boolean,
): TrajectoryPoint | null {
  const spanCount = closed ? views.length : views.length - 1;
  if (spanCount <= 0) return null;
  if (!closed && (spanIndex < 0 || spanIndex >= spanCount)) return null;
  const normalizedIndex = THREE.MathUtils.euclideanModulo(spanIndex, spanCount);
  return views[normalizedIndex]?.lookAtTarget ?? null;
}

function quaternionLookingAtPoint(
  position: THREE.Vector3,
  target: TrajectoryPoint,
  fallback: THREE.Quaternion,
): THREE.Quaternion {
  const direction = new THREE.Vector3(...target).sub(position);
  return direction.lengthSq() > 1e-10
    ? cameraQuaternionFacingDirection(direction, new THREE.Quaternion())
    : fallback.clone();
}

function smoothstep(amount: number): number {
  const clamped = THREE.MathUtils.clamp(amount, 0, 1);
  return clamped * clamped * (3 - 2 * clamped);
}

export function cameraTargetIsClearOfPath(
  views: readonly CameraView[],
  target: TrajectoryPoint,
  closedLoop: boolean,
  clearance: number,
  spanIndexes?: readonly number[],
  allowBelowFloor = false,
): boolean {
  if (views.length < 2) return true;
  const minimumY = allowBelowFloor ? -Infinity : TRAJECTORY_FLOOR_Y;
  const path = normalizedCameraPath(views, closedLoop);
  const curve = cameraPathCurve(path.views, path.closed, minimumY);
  const subdivisionCount = Math.max(256, path.views.length * 64);
  const segmentCount = path.closed ? path.views.length : path.views.length - 1;
  const includedSpans = spanIndexes ? new Set(spanIndexes) : null;
  const targetVector = new THREE.Vector3(...target);
  const closest = new THREE.Vector3();
  let previous = cameraPositionAtProgress(
    path.views,
    curve,
    0,
    path.closed,
    true,
    false,
    minimumY,
  );
  for (let index = 1; index <= subdivisionCount; index += 1) {
    const progress = index / subdivisionCount;
    const current = cameraPositionAtProgress(
      path.views,
      curve,
      progress,
      path.closed,
      false,
      index === subdivisionCount,
      minimumY,
    );
    const spanIndex = Math.min(
      Math.floor(((index - 0.5) / subdivisionCount) * segmentCount),
      segmentCount - 1,
    );
    if (includedSpans && !includedSpans.has(spanIndex)) {
      previous = current;
      continue;
    }
    new THREE.Line3(previous, current).closestPointToPoint(
      targetVector,
      true,
      closest,
    );
    if (closest.distanceTo(targetVector) <= clearance) return false;
    previous = current;
  }
  return true;
}

export function partLookAtTargetIsClearOfPath(
  views: readonly CameraView[],
  target: TrajectoryPoint,
  closedLoop: boolean,
  clearance: number,
  allowBelowFloor = false,
): boolean {
  if (views.length < 2) return true;
  const path = normalizedCameraPath(views, closedLoop);
  const spanCount = path.closed ? path.views.length : path.views.length - 1;
  const targetSpans = Array.from({ length: spanCount }, (_, spanIndex) =>
    sameOptionalTrajectoryPoint(
      lookAtTargetForSpan(path.views, spanIndex, path.closed),
      target,
    ) ||
    sameOptionalTrajectoryPoint(
      lookAtTargetForSpan(path.views, spanIndex - 1, path.closed),
      target,
    ) ||
    sameOptionalTrajectoryPoint(
      lookAtTargetForSpan(path.views, spanIndex + 1, path.closed),
      target,
    )
      ? spanIndex
      : null,
  ).filter((spanIndex): spanIndex is number => spanIndex !== null);
  return cameraTargetIsClearOfPath(
    views,
    target,
    closedLoop,
    clearance,
    targetSpans,
    allowBelowFloor,
  );
}

function sameOptionalTrajectoryPoint(
  first: TrajectoryPoint | null,
  second: TrajectoryPoint,
): boolean {
  return first !== null && sameTrajectoryPoint(first, second);
}

export function sampleCameraPivot(
  views: readonly CameraView[],
  viewIndex: number,
  options: CameraPathOptions = {},
): SampledCameraView {
  if (views.length === 0) {
    return {
      position: [0, TRAJECTORY_FLOOR_Y, 0],
      quaternion: [0, 0, 0, 1],
      fovRadians: Math.PI / 3,
    };
  }
  if (views.length === 1) {
    const minimumY = options.allowBelowFloor ? -Infinity : TRAJECTORY_FLOOR_Y;
    return {
      position: constrainPosition(views[0]!.position, minimumY),
      quaternion: views[0]!.quaternion,
      fovRadians: views[0]!.fovRadians,
    };
  }

  const path = normalizedCameraPath(views, options.closedLoop ?? false);
  const samples = sampleCameraPath(
    views,
    path.closed ? path.views.length + 1 : path.views.length,
    options,
  );
  const sampleIndex =
    path.views.length < views.length && viewIndex === views.length - 1
      ? path.views.length
      : THREE.MathUtils.clamp(viewIndex, 0, path.views.length - 1);
  return samples[sampleIndex]!;
}

export function cameraPathProgressAtFrame(
  frameIndex: number,
  frameCount: number,
  viewCount: number,
  closedLoop = false,
): number {
  if (frameCount <= 1 || viewCount <= 1) return 0;

  const lastFrame = frameCount - 1;
  const index = THREE.MathUtils.clamp(frameIndex, 0, lastFrame);
  const segmentCount = closedLoop ? viewCount : viewCount - 1;
  if (lastFrame < segmentCount) return index / lastFrame;

  const frameProgresses = Array.from(
    { length: segmentCount + 1 },
    (_, keyIndex) =>
      Math.round((keyIndex * lastFrame) / segmentCount) / lastFrame,
  );
  const pathProgresses = frameProgresses.map(
    (_, keyIndex) => keyIndex / segmentCount,
  );
  const frameProgress = index / lastFrame;
  const endIndex = frameProgresses.findIndex(
    (progress) => progress >= frameProgress,
  );
  if (endIndex <= 0) return 0;
  if (Math.abs(frameProgresses[endIndex]! - frameProgress) < 1e-10) {
    return pathProgresses[endIndex]!;
  }
  return cubicHermiteAtProgress(
    scalarSpline(frameProgresses, pathProgresses),
    frameProgresses,
    endIndex,
    frameProgress,
  );
}

type ScalarSpline = {
  values: number[];
  slopes: number[];
};

type CameraOrientationKeys = {
  quaternions: THREE.Quaternion[];
  progresses: number[];
  aimSpline: { yaw: ScalarSpline; pitch: ScalarSpline } | null;
};

function cameraOrientationKeys(
  views: readonly CameraView[],
  closed = false,
): CameraOrientationKeys {
  const explicitKeyIndices = views.flatMap((view, index) =>
    view.angleKey ? [index] : [],
  );
  const keyIndices =
    explicitKeyIndices.length > 0
      ? explicitKeyIndices
      : views.map((_, index) => index);
  const baseQuaternions = keyIndices.map((index) =>
    new THREE.Quaternion(...views[index]!.quaternion).normalize(),
  );
  const baseProgresses = keyIndices.map((index) =>
    closed ? index / views.length : index / (views.length - 1),
  );
  const quaternions =
    closed && baseQuaternions.length > 1
      ? [-1, 0, 1].flatMap(() =>
          baseQuaternions.map((quaternion) => quaternion.clone()),
        )
      : baseQuaternions;
  const progresses =
    closed && baseProgresses.length > 1
      ? [-1, 0, 1].flatMap((offset) =>
          baseProgresses.map((progress) => progress + offset),
        )
      : baseProgresses;
  for (let index = 1; index < quaternions.length; index += 1) {
    const previous = quaternions[index - 1]!;
    const current = quaternions[index]!;
    if (previous.dot(current) < 0) {
      current.set(-current.x, -current.y, -current.z, -current.w);
    }
  }
  return {
    quaternions,
    progresses,
    aimSpline: cameraAimSpline(quaternions, progresses),
  };
}

function quaternionAtProgress(
  keys: CameraOrientationKeys,
  progress: number,
): THREE.Quaternion {
  const { aimSpline, progresses, quaternions } = keys;
  if (quaternions.length === 1 || progress <= progresses[0]!) {
    return quaternions[0]!.clone();
  }
  const lastIndex = quaternions.length - 1;
  if (progress >= progresses[lastIndex]!) {
    return quaternions[lastIndex]!.clone();
  }

  const endIndex = progresses.findIndex((value) => value >= progress);
  const startProgress = progresses[endIndex - 1]!;
  const endProgress = progresses[endIndex]!;
  if (Math.abs(progress - endProgress) < 1e-8) {
    return quaternions[endIndex]!.clone();
  }
  if (aimSpline) {
    return new THREE.Quaternion(
      ...cameraQuaternionFromAim(
        cubicHermiteAtProgress(aimSpline.yaw, progresses, endIndex, progress),
        cubicHermiteAtProgress(aimSpline.pitch, progresses, endIndex, progress),
      ),
    );
  }
  const amount =
    endProgress - startProgress > 1e-8
      ? (progress - startProgress) / (endProgress - startProgress)
      : 0;
  return new THREE.Quaternion().slerpQuaternions(
    quaternions[endIndex - 1]!,
    quaternions[endIndex]!,
    amount,
  );
}

function cameraAimSpline(
  quaternions: readonly THREE.Quaternion[],
  progresses: readonly number[],
): CameraOrientationKeys["aimSpline"] {
  if (quaternions.length < 2) return null;

  const aims = quaternions.map((quaternion) =>
    cameraAimDegrees(quaternion.toArray()),
  );
  const hasRoll = quaternions.some(
    (quaternion, index) =>
      quaternion.angleTo(
        new THREE.Quaternion(
          ...cameraQuaternionFromAim(aims[index]!.yaw, aims[index]!.pitch),
        ),
      ) > 1e-5,
  );
  if (hasRoll) return null;

  const yawValues = [aims[0]!.yaw];
  for (const aim of aims.slice(1)) {
    const previous = yawValues.at(-1)!;
    const shortestTurn =
      THREE.MathUtils.euclideanModulo(aim.yaw - previous + 180, 360) - 180;
    yawValues.push(previous + shortestTurn);
  }
  const pitchValues = aims.map((aim) => aim.pitch);
  const spline = {
    yaw: scalarSpline(progresses, yawValues),
    pitch: scalarSpline(progresses, pitchValues),
  };
  if (progresses[0]! > 0) {
    spline.yaw.slopes[0] = 0;
    spline.pitch.slopes[0] = 0;
  }
  if (progresses.at(-1)! < 1) {
    spline.yaw.slopes[spline.yaw.slopes.length - 1] = 0;
    spline.pitch.slopes[spline.pitch.slopes.length - 1] = 0;
  }
  return spline;
}

function scalarSpline(
  progresses: readonly number[],
  values: readonly number[],
): ScalarSpline {
  return {
    values: [...values],
    slopes: monotoneCubicSlopes(progresses, values),
  };
}

function monotoneCubicSlopes(
  progresses: readonly number[],
  values: readonly number[],
): number[] {
  const intervalWidths = values
    .slice(1)
    .map((_, index) => progresses[index + 1]! - progresses[index]!);
  const intervalSlopes = intervalWidths.map(
    (width, index) => (values[index + 1]! - values[index]!) / width,
  );
  const slopes = Array.from({ length: values.length }, () => 0);
  slopes[0] = intervalSlopes[0]!;
  for (let index = 1; index < values.length - 1; index += 1) {
    const previousSlope = intervalSlopes[index - 1]!;
    const nextSlope = intervalSlopes[index]!;
    if (previousSlope === 0 || nextSlope === 0 || previousSlope * nextSlope < 0)
      continue;

    const previousWidth = intervalWidths[index - 1]!;
    const nextWidth = intervalWidths[index]!;
    const previousWeight = 2 * nextWidth + previousWidth;
    const nextWeight = nextWidth + 2 * previousWidth;
    slopes[index] =
      (previousWeight + nextWeight) /
      (previousWeight / previousSlope + nextWeight / nextSlope);
  }
  slopes[values.length - 1] = intervalSlopes.at(-1)!;
  return slopes;
}

function cubicHermiteAtProgress(
  spline: ScalarSpline,
  progresses: readonly number[],
  endIndex: number,
  progress: number,
): number {
  const startIndex = endIndex - 1;
  const startProgress = progresses[startIndex]!;
  const width = progresses[endIndex]! - startProgress;
  const amount = (progress - startProgress) / width;
  const amountSquared = amount * amount;
  const amountCubed = amountSquared * amount;
  return (
    (2 * amountCubed - 3 * amountSquared + 1) * spline.values[startIndex]! +
    (amountCubed - 2 * amountSquared + amount) *
      width *
      spline.slopes[startIndex]! +
    (-2 * amountCubed + 3 * amountSquared) * spline.values[endIndex]! +
    (amountCubed - amountSquared) * width * spline.slopes[endIndex]!
  );
}

function smoothCurvePoint(
  curve: THREE.CatmullRomCurve3,
  progress: number,
  periodic: boolean,
  minimumY: number,
): THREE.Vector3 {
  if (!periodic && (progress <= 0 || progress >= 1)) {
    return constrainCurvePoint(
      curve,
      THREE.MathUtils.clamp(progress, 0, 1),
      minimumY,
    );
  }

  const point = new THREE.Vector3();
  POSITION_SMOOTHING_WEIGHTS.forEach((weight, index) => {
    const offset = index - Math.floor(POSITION_SMOOTHING_WEIGHTS.length / 2);
    point.addScaledVector(
      periodic
        ? constrainCurvePoint(
            curve,
            THREE.MathUtils.euclideanModulo(
              progress + offset * POSITION_SMOOTHING_STEP,
              1,
            ),
            minimumY,
          )
        : extendedCurvePoint(
            curve,
            progress + offset * POSITION_SMOOTHING_STEP,
            minimumY,
          ),
      weight / POSITION_SMOOTHING_WEIGHT_TOTAL,
    );
  });
  point.y = Math.max(minimumY, point.y);
  return point;
}

function extendedCurvePoint(
  curve: THREE.CatmullRomCurve3,
  progress: number,
  minimumY: number,
): THREE.Vector3 {
  if (progress < 0) {
    return constrainCurvePoint(curve, 0, minimumY)
      .multiplyScalar(2)
      .sub(constrainCurvePoint(curve, -progress, minimumY));
  }
  if (progress > 1) {
    return constrainCurvePoint(curve, 1, minimumY)
      .multiplyScalar(2)
      .sub(constrainCurvePoint(curve, 2 - progress, minimumY));
  }
  return constrainCurvePoint(curve, progress, minimumY);
}

function constrainCurvePoint(
  curve: THREE.CatmullRomCurve3,
  progress: number,
  minimumY: number,
): THREE.Vector3 {
  const point = curve.getPoint(progress);
  point.y = Math.max(minimumY, point.y);
  return point;
}

function constrainPosition(
  position: readonly [number, number, number],
  minimumY: number,
): TrajectoryPoint {
  return [position[0], Math.max(minimumY, position[1]), position[2]];
}

function cameraPositionAtProgress(
  views: readonly CameraView[],
  curve: THREE.CatmullRomCurve3,
  progress: number,
  closed: boolean,
  firstFrame: boolean,
  lastFrame: boolean,
  minimumY: number,
): THREE.Vector3 {
  if (!closed && firstFrame) {
    return new THREE.Vector3(
      ...constrainPosition(views[0]!.position, minimumY),
    );
  }
  if (!closed && lastFrame) {
    return new THREE.Vector3(
      ...constrainPosition(views.at(-1)!.position, minimumY),
    );
  }
  return smoothCurvePoint(curve, progress, closed, minimumY);
}

type CameraPresetOrientationFrame = {
  progresses: number[];
  quaternions: THREE.Quaternion[];
};

function cameraPresetQuaternion(
  curve: THREE.CatmullRomCurve3,
  progress: number,
  position: THREE.Vector3,
  directionMode: Exclude<CameraDirectionMode, "manual">,
  target: THREE.Vector3 | null,
  closed: boolean,
  fallback: THREE.Quaternion,
  frame: CameraPresetOrientationFrame,
  minimumY: number,
): THREE.Quaternion {
  const direction = cameraPresetDirection(
    curve,
    progress,
    position,
    directionMode,
    target,
    closed,
    fallback,
    minimumY,
  );
  if (directionMode === "look_at" || directionMode === "look_away") {
    // A fixed pole fallback keeps ignored per-camera angles from adding roll.
    return cameraQuaternionFacingDirection(direction, new THREE.Quaternion());
  }
  return alignCameraForward(
    quaternionAtPresetProgress(frame, progress),
    direction,
  );
}

function cameraPresetOverrideDeltas(
  views: readonly CameraView[],
  curve: THREE.CatmullRomCurve3,
  directionMode: Exclude<CameraDirectionMode, "manual">,
  target: THREE.Vector3 | null,
  closed: boolean,
  orientationKeys: CameraOrientationKeys,
  frame: CameraPresetOrientationFrame,
  minimumY: number,
): THREE.Quaternion[] | null {
  if (!views.some((view) => view.directionOverride)) return null;

  return views.map((view, index) => {
    if (!view.directionOverride) return new THREE.Quaternion();
    const progress = closed ? index / views.length : index / (views.length - 1);
    const position = cameraPositionAtProgress(
      views,
      curve,
      progress,
      closed,
      index === 0,
      index === views.length - 1,
      minimumY,
    );
    const fallback = quaternionAtProgress(orientationKeys, progress);
    const base = cameraPresetQuaternion(
      curve,
      progress,
      position,
      directionMode,
      target,
      closed,
      fallback,
      frame,
      minimumY,
    );
    return new THREE.Quaternion(...view.directionOverride)
      .normalize()
      .multiply(base.invert());
  });
}

function cameraPresetOrientationFrame(
  views: readonly CameraView[],
  curve: THREE.CatmullRomCurve3,
  directionMode: Exclude<CameraDirectionMode, "manual">,
  target: THREE.Vector3 | null,
  closed: boolean,
  orientationKeys: CameraOrientationKeys,
  minimumY: number,
): CameraPresetOrientationFrame {
  const pivotProgresses = views.map((_, index) =>
    closed ? index / views.length : index / (views.length - 1),
  );
  const progresses = [
    ...Array.from(
      { length: PRESET_ORIENTATION_REFERENCE_FRAMES + 1 },
      (_, index) => index / PRESET_ORIENTATION_REFERENCE_FRAMES,
    ),
    ...pivotProgresses,
  ]
    .sort((first, second) => first - second)
    .filter(
      (progress, index, values) =>
        index === 0 || Math.abs(progress - values[index - 1]!) > 1e-10,
    );
  const directions = progresses.map((progress) => {
    const position = cameraPositionAtProgress(
      views,
      curve,
      progress,
      closed,
      progress === 0,
      progress === 1,
      minimumY,
    );
    return cameraPresetDirection(
      curve,
      progress,
      position,
      directionMode,
      target,
      closed,
      quaternionAtProgress(orientationKeys, progress),
      minimumY,
    );
  });
  const quaternions = transportedCameraQuaternions(
    directions,
    progresses,
    quaternionAtProgress(orientationKeys, 0),
    closed,
  );
  return { progresses, quaternions };
}

function cameraPresetDirection(
  curve: THREE.CatmullRomCurve3,
  progress: number,
  position: THREE.Vector3,
  directionMode: Exclude<CameraDirectionMode, "manual">,
  target: THREE.Vector3 | null,
  closed: boolean,
  fallback: THREE.Quaternion,
  minimumY: number,
): THREE.Vector3 {
  const direction =
    directionMode === "forward"
      ? smoothCurveDirection(curve, progress, closed, minimumY)
      : target
        ? radialCameraDirection(position, target, directionMode)
        : new THREE.Vector3();
  if (direction.lengthSq() > 1e-10) return direction.normalize();
  return new THREE.Vector3(0, 0, -1).applyQuaternion(fallback).normalize();
}

function transportedCameraQuaternions(
  directions: readonly THREE.Vector3[],
  progresses: readonly number[],
  fallback: THREE.Quaternion,
  closed: boolean,
): THREE.Quaternion[] {
  const quaternions = [
    cameraQuaternionFacingDirection(directions[0]!, fallback),
  ];
  for (let index = 1; index < directions.length; index += 1) {
    const previous = quaternions[index - 1]!;
    const transported = directionRotation(
      directions[index - 1]!,
      directions[index]!,
      previous,
    ).multiply(previous.clone());
    if (previous.dot(transported) < 0) negateQuaternion(transported);
    quaternions.push(transported.normalize());
  }
  if (closed) {
    closeTransportedQuaternionLoop(quaternions, directions, progresses);
  }
  return quaternions;
}

function closeTransportedQuaternionLoop(
  quaternions: THREE.Quaternion[],
  directions: readonly THREE.Vector3[],
  progresses: readonly number[],
): void {
  const correction = quaternions[0]!
    .clone()
    .multiply(quaternions.at(-1)!.clone().invert())
    .normalize();
  if (correction.w < 0) negateQuaternion(correction);
  const signedHalfAngle = new THREE.Vector3(
    correction.x,
    correction.y,
    correction.z,
  ).dot(directions[0]!);
  const twist = 2 * Math.atan2(signedHalfAngle, correction.w);
  quaternions.forEach((quaternion, index) => {
    const roll = new THREE.Quaternion().setFromAxisAngle(
      directions[index]!,
      twist * progresses[index]!,
    );
    quaternion.premultiply(roll).normalize();
    if (index > 0 && quaternions[index - 1]!.dot(quaternion) < 0) {
      negateQuaternion(quaternion);
    }
  });
}

function quaternionAtPresetProgress(
  frame: CameraPresetOrientationFrame,
  progress: number,
): THREE.Quaternion {
  const clamped = THREE.MathUtils.clamp(progress, 0, 1);
  const endIndex = frame.progresses.findIndex((value) => value >= clamped);
  if (endIndex <= 0) return frame.quaternions[0]!.clone();
  if (Math.abs(frame.progresses[endIndex]! - clamped) < 1e-10) {
    return frame.quaternions[endIndex]!.clone();
  }
  const startProgress = frame.progresses[endIndex - 1]!;
  const amount =
    (clamped - startProgress) / (frame.progresses[endIndex]! - startProgress);
  return new THREE.Quaternion().slerpQuaternions(
    frame.quaternions[endIndex - 1]!,
    frame.quaternions[endIndex]!,
    amount,
  );
}

function presetDeltaAtProgress(
  deltas: readonly THREE.Quaternion[] | null,
  progress: number,
  viewCount: number,
  closed: boolean,
): THREE.Quaternion {
  if (!deltas) return new THREE.Quaternion();

  const segmentCount = closed ? viewCount : viewCount - 1;
  const viewProgress = THREE.MathUtils.clamp(progress, 0, 1) * segmentCount;
  const segment = Math.min(Math.floor(viewProgress), segmentCount - 1);
  const amount = THREE.MathUtils.clamp(viewProgress - segment, 0, 1);
  const easedAmount = amount * amount * (3 - 2 * amount);
  return new THREE.Quaternion().slerpQuaternions(
    deltas[segment]!,
    deltas[closed ? (segment + 1) % viewCount : segment + 1]!,
    easedAmount,
  );
}

function cameraDirectionTarget(
  views: readonly CameraView[],
  directionTarget?: TrajectoryPoint,
  minimumY = TRAJECTORY_FLOOR_Y,
): THREE.Vector3 {
  if (directionTarget) return new THREE.Vector3(...directionTarget);

  const target = views.reduce(
    (sum, view) =>
      sum.add(new THREE.Vector3(...constrainPosition(view.position, minimumY))),
    new THREE.Vector3(),
  );
  return target.multiplyScalar(1 / views.length);
}

function radialCameraDirection(
  position: THREE.Vector3,
  target: THREE.Vector3,
  directionMode: CameraDirectionMode,
): THREE.Vector3 {
  return directionMode === "outward" || directionMode === "look_away"
    ? position.clone().sub(target)
    : target.clone().sub(position);
}

function normalizedCameraPath(
  views: readonly CameraView[],
  closedLoop: boolean,
): { views: readonly CameraView[]; closed: boolean } {
  if (!closedLoop || views.length < 3) return { views, closed: false };
  if (!sameTrajectoryPoint(views[0]!.position, views.at(-1)!.position)) {
    return { views, closed: true };
  }

  const withoutDuplicateEndpoint = views.slice(0, -1);
  return withoutDuplicateEndpoint.length >= 3
    ? { views: withoutDuplicateEndpoint, closed: true }
    : { views, closed: false };
}

function cameraPathCurve(
  views: readonly CameraView[],
  closed: boolean,
  minimumY: number,
): THREE.CatmullRomCurve3 {
  return new THREE.CatmullRomCurve3(
    views.map(
      (view) =>
        new THREE.Vector3(...constrainPosition(view.position, minimumY)),
    ),
    closed,
    "centripetal",
  );
}

function smoothCurveDirection(
  curve: THREE.CatmullRomCurve3,
  progress: number,
  periodic: boolean,
  minimumY: number,
): THREE.Vector3 {
  const start = periodic
    ? progress - POSITION_SMOOTHING_STEP
    : Math.max(0, progress - POSITION_SMOOTHING_STEP);
  const end = periodic
    ? progress + POSITION_SMOOTHING_STEP
    : Math.min(1, progress + POSITION_SMOOTHING_STEP);
  const direction = smoothCurvePoint(curve, end, periodic, minimumY).sub(
    smoothCurvePoint(curve, start, periodic, minimumY),
  );
  return direction.lengthSq() > 1e-10
    ? direction
    : curve.getTangent(THREE.MathUtils.clamp(progress, 0, 1));
}

function cameraQuaternionFacingDirection(
  direction: THREE.Vector3,
  fallback: THREE.Quaternion,
): THREE.Quaternion {
  const forward = direction.clone().normalize();
  let up = new THREE.Vector3(0, 1, 0);
  if (Math.abs(up.dot(forward)) > 0.98) {
    up = new THREE.Vector3(0, 1, 0).applyQuaternion(fallback);
    up.addScaledVector(forward, -up.dot(forward));
    if (up.lengthSq() <= 1e-10) {
      up = new THREE.Vector3(1, 0, 0);
      up.addScaledVector(forward, -up.dot(forward));
    }
  }
  const camera = new THREE.PerspectiveCamera();
  camera.up.copy(up.normalize());
  camera.lookAt(forward);
  return camera.quaternion.normalize();
}

function alignCameraForward(
  quaternion: THREE.Quaternion,
  direction: THREE.Vector3,
): THREE.Quaternion {
  const currentDirection = new THREE.Vector3(0, 0, -1).applyQuaternion(
    quaternion,
  );
  return directionRotation(currentDirection, direction, quaternion)
    .multiply(quaternion)
    .normalize();
}

function directionRotation(
  from: THREE.Vector3,
  to: THREE.Vector3,
  orientation: THREE.Quaternion,
): THREE.Quaternion {
  const start = from.clone().normalize();
  const end = to.clone().normalize();
  if (start.dot(end) > -0.999999) {
    return new THREE.Quaternion().setFromUnitVectors(start, end);
  }

  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(orientation);
  up.addScaledVector(start, -up.dot(start));
  if (up.lengthSq() <= 1e-10) {
    up.set(1, 0, 0).addScaledVector(start, -start.x);
  }
  return new THREE.Quaternion().setFromAxisAngle(up.normalize(), Math.PI);
}

function negateQuaternion(quaternion: THREE.Quaternion): THREE.Quaternion {
  return quaternion.set(
    -quaternion.x,
    -quaternion.y,
    -quaternion.z,
    -quaternion.w,
  );
}

function cameraQuaternionLookingAt(
  position: readonly [number, number, number],
  target: THREE.Vector3 | readonly [number, number, number],
): THREE.Quaternion {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(...position);
  camera.lookAt(
    target instanceof THREE.Vector3 ? target : new THREE.Vector3(...target),
  );
  return camera.quaternion;
}

export function buildTargetCameras(
  views: readonly CameraView[],
  frameCount: number,
  width: number,
  height: number,
  options: CameraPathOptions = {},
): PinholeCamera[] {
  return sampleCameraPath(views, frameCount, options).map((view) => ({
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
