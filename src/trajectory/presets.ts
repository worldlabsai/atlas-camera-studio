import { PerspectiveCamera, Quaternion, Vector3 } from "three";
import type {
  CameraView,
  TrajectoryPoint,
  TrajectorySegment,
} from "./camera-trajectory";

export const CAMERA_MOVE_PRESETS = [
  { id: "push", label: "Push in" },
  { id: "pull", label: "Pull back" },
  { id: "truck", label: "Truck right" },
  { id: "orbit", label: "Orbit left" },
  { id: "crane", label: "Crane up" },
  { id: "arc", label: "Arc reveal" },
] as const;
export type CameraMovePreset = (typeof CAMERA_MOVE_PRESETS)[number]["id"];

// Start from the source camera and scale motion to the scene's subject distance.
export function createCameraMove(
  preset: CameraMovePreset,
  reference: CameraView,
  target: TrajectoryPoint,
  amount: number,
  allowBelowFloor: boolean,
): TrajectorySegment {
  const start = new Vector3(...reference.position);
  const center = new Vector3(...target);
  const rotation = new Quaternion(...reference.quaternion);
  const forward = new Vector3(0, 0, -1).applyQuaternion(rotation);
  const right = new Vector3(1, 0, 0).applyQuaternion(rotation);
  const strength = Math.min(1, Math.max(0.05, amount));
  const distance = Math.max(start.distanceTo(center), 0.1);
  const points: TrajectoryPoint[] = [];
  const quaternions: TrajectorySegment["quaternions"] = [];
  const camera = new PerspectiveCamera();
  for (let i = 0; i < 5; i++) {
    const progress = i / 4;
    const point = start.clone();
    if (preset === "orbit" || preset === "arc") {
      point
        .sub(center)
        .applyAxisAngle(
          new Vector3(0, 1, 0),
          (-progress * strength * Math.PI) / (preset === "arc" ? 4 : 3),
        )
        .add(center);
      // An arc reveal closes in on the subject while it circles.
      if (preset === "arc")
        point.lerp(center, progress * Math.min(0.5, strength * 0.8));
    } else if (preset === "crane") {
      point.y += progress * distance * strength * 0.8;
      point.addScaledVector(forward, progress * distance * strength * 0.2);
    } else {
      point.addScaledVector(
        preset === "truck" ? right : forward,
        progress * distance * strength * (preset === "pull" ? -1 : 1),
      );
    }
    if (!allowBelowFloor) point.y = Math.max(0, point.y);
    points.push(point.toArray());
    if (preset === "orbit" || preset === "arc" || preset === "crane") {
      camera.position.copy(point);
      camera.lookAt(center);
      quaternions.push(camera.quaternion.toArray());
    } else quaternions.push([...reference.quaternion]);
  }
  return { id: crypto.randomUUID(), points, quaternions };
}
