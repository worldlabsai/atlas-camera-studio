import type { Camera } from "../types";
export type PinholeCamera = Camera;
export type PosedCamera = Omit<Camera, "extrinsics"> & {
  extrinsics: Omit<Camera["extrinsics"], "coordinateSystem">;
};
export function verticalFov(intrinsics: Camera["intrinsics"]) {
  return 2 * Math.atan(intrinsics.height / (2 * intrinsics.fy));
}
export function createIntrinsicsFromFov(
  degrees: number,
  width: number,
  height: number,
): Camera["intrinsics"] {
  const focal = height / (2 * Math.tan((degrees * Math.PI) / 360));
  return { width, height, fx: focal, fy: focal, cx: width / 2, cy: height / 2 };
}
