import test from "node:test";
import assert from "node:assert/strict";
import { Quaternion, Vector3 } from "three";
import { createCameraMove } from "../src/trajectory/presets";
import type { CameraView } from "../src/trajectory/camera-trajectory";
const reference: CameraView = {
  id: "source",
  position: [0, 2, 8],
  quaternion: [0, 0, 0, 1],
  fovRadians: 1,
};
const target: [number, number, number] = [0, 2, 0];
test("camera moves begin at the reference camera and use camera-local axes", () => {
  for (const preset of ["push", "pull", "truck", "orbit"] as const) {
    const move = createCameraMove(preset, reference, target, 0.25, false);
    assert.deepEqual(move.points[0], reference.position);
    assert.equal(move.points.length, 5);
  }
  assert.equal(
    createCameraMove("push", reference, target, 0.25, false).points.at(-1)![2],
    6,
  );
  assert.equal(
    createCameraMove("pull", reference, target, 0.25, false).points.at(-1)![2],
    10,
  );
  const rotated = {
    ...reference,
    quaternion: new Quaternion()
      .setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2)
      .toArray(),
  };
  assert.ok(
    createCameraMove("truck", rotated, target, 0.25, false).points.at(-1)![2] <
      6.01,
  );
});
test("orbit keeps subject distance and aims cameras at subject", () => {
  const move = createCameraMove("orbit", reference, target, 0.5, false);
  for (let i = 0; i < move.points.length; i++) {
    const position = new Vector3(...move.points[i]);
    assert.ok(Math.abs(position.distanceTo(new Vector3(...target)) - 8) < 1e-8);
    const forward = new Vector3(0, 0, -1).applyQuaternion(
      new Quaternion(...move.quaternions![i]!),
    );
    assert.ok(
      forward.dot(new Vector3(...target).sub(position).normalize()) > 0.999,
    );
  }
});
test("presets respect the floor unless below-floor movement is allowed", () => {
  const underground = {
    ...reference,
    position: [0, -2, 8] as [number, number, number],
  };
  assert.ok(
    createCameraMove("pull", underground, target, 0.3, false).points.every(
      (p) => p[1] >= 0,
    ),
  );
  assert.equal(
    createCameraMove("pull", underground, target, 0.3, true).points[0][1],
    -2,
  );
});
