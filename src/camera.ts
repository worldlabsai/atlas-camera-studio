import { Euler, Quaternion, Vector3 } from "three";
import type { Camera } from "./types";
export type Pose = { position: Vector3; quaternion: Quaternion };
const finite = (v: number, fallback = 0) => (Number.isFinite(v) ? v : fallback);
export function cameraPose(camera: Camera): Pose {
  const e = camera.extrinsics;
  const position = new Vector3(
    ...(e.position.map((v) => finite(v)) as [number, number, number]),
  );
  const qv = e.quaternion.map((v) => finite(v));
  const quaternion = new Quaternion(qv[0], qv[1], qv[2], qv[3]);
  if (quaternion.lengthSq() < 1e-10) quaternion.identity();
  else quaternion.normalize();
  if (e.coordinateSystem === "rdf")
    quaternion.multiply(
      new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI),
    );
  return { position, quaternion };
}
export function toCamera(
  pose: Pose,
  intrinsics?: Camera["intrinsics"],
): Camera {
  const q = pose.quaternion.clone();
  if (q.lengthSq() < 1e-10) q.identity();
  else q.normalize();
  const validIntrinsics =
    intrinsics &&
    [
      intrinsics.width,
      intrinsics.height,
      intrinsics.fx,
      intrinsics.fy,
      intrinsics.cx,
      intrinsics.cy,
    ].every(Number.isFinite) &&
    intrinsics.width > 0 &&
    intrinsics.height > 0 &&
    intrinsics.fx > 0 &&
    intrinsics.fy > 0
      ? { ...intrinsics }
      : { width: 1280, height: 720, fx: 1152, fy: 1152, cx: 640, cy: 360 };
  return {
    intrinsics: validIntrinsics,
    extrinsics: {
      position: [
        finite(pose.position.x),
        finite(pose.position.y),
        finite(pose.position.z),
      ],
      quaternion: [q.x, q.y, q.z, q.w],
      coordinateSystem: "rub",
    },
  };
}
export function interpolateCameras(
  poses: Pose[],
  frames = 48,
  intrinsics?: Camera["intrinsics"],
): Camera[] {
  const safe = poses.length
    ? poses
    : [{ position: new Vector3(0, 0, 4), quaternion: new Quaternion() }];
  const count = Math.max(1, Math.floor(frames));
  return Array.from({ length: count }, (_, i) => {
    if (safe.length === 1) return toCamera(safe[0], intrinsics);
    const t = count === 1 ? 0 : i / (count - 1),
      scaled = t * (safe.length - 1),
      seg = Math.min(safe.length - 2, Math.floor(scaled)),
      local = scaled - seg;
    const a = safe[seg],
      b = safe[seg + 1];
    return toCamera(
      {
        position: a.position.clone().lerp(b.position, local),
        quaternion: a.quaternion.clone().slerp(b.quaternion, local),
      },
      intrinsics,
    );
  });
}
export function aimAt(
  position: Vector3,
  target: Vector3,
  yaw = 0,
  pitch = 0,
): Quaternion {
  const dir = target.clone().sub(position).normalize();
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), dir);
  if (yaw || pitch)
    q.multiply(new Quaternion().setFromEuler(new Euler(pitch, yaw, 0, "YXZ")));
  return q.normalize();
}
