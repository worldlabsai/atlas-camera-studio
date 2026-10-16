import test from "node:test";
import assert from "node:assert/strict";
import { Quaternion, Vector3 } from "three";
import {
  createShotCurve,
  keyframesFromLegacySegments,
  retimeKeyframe,
  setKeyframeGap,
  shotHasMotion,
  spaceKeyframesEvenly,
  upsertKeyframe,
  type CameraKeyframe,
  type ShotOptions,
} from "../src/trajectory/keyframes";

const free: ShotOptions = {
  aimMode: "free",
  aimTarget: null,
  allowBelowFloor: false,
};

function key(
  frame: number,
  position: [number, number, number],
  extra: Partial<CameraKeyframe> = {},
): CameraKeyframe {
  return {
    id: `k${frame}`,
    frame,
    position,
    yaw: 0,
    pitch: 0,
    interpolation: "smooth",
    ease: null,
    ...extra,
  };
}

const close = (a: number, b: number, tolerance = 1e-6) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${a} is not close to ${b}`);

test("the camera passes through every key at its frame", () => {
  const keys = [
    key(0, [0, 1, 0]),
    key(20, [2, 1.5, -1], { yaw: 40 }),
    key(47, [3, 2, -4], { yaw: 90, pitch: -10 }),
  ];
  const curve = createShotCurve(keys, free);
  for (const k of keys) {
    const pose = curve.poseAt(k.frame);
    pose.position.forEach((value, axis) => close(value, k.position[axis]!));
    close(pose.yaw, k.yaw);
    close(pose.pitch, k.pitch);
  }
});

test("the first and last keys ease in and out, middle keys flow through", () => {
  const curve = createShotCurve(
    [key(0, [0, 1, 0]), key(24, [4, 1, 0]), key(47, [8, 1, 0])],
    free,
  );
  const speed = (frame: number) =>
    curve.positionAt(frame + 0.5)[0] - curve.positionAt(frame - 0.5)[0];
  assert.ok(speed(0.5) < 0.05, "starts nearly at rest");
  assert.ok(speed(46.5) < 0.05, "ends nearly at rest");
  assert.ok(speed(24) > 0.15, "keeps moving through the middle key");
});

test("ease 1 on a middle key brings the camera to rest there", () => {
  const curve = createShotCurve(
    [key(0, [0, 1, 0]), key(24, [4, 1, 0], { ease: 1 }), key(47, [8, 1, 0])],
    free,
  );
  close(curve.positionAt(24.25)[0] - curve.positionAt(23.75)[0], 0, 0.01);
});

test("smooth motion does not overshoot a turning point", () => {
  const curve = createShotCurve(
    [key(0, [0, 1, 0]), key(10, [4, 1, 0]), key(47, [0, 1, 0])],
    free,
  );
  for (let frame = 0; frame <= 47; frame += 0.25)
    assert.ok(curve.positionAt(frame)[0] <= 4 + 1e-9);
});

test("linear and hold interpolation", () => {
  const linear = createShotCurve(
    [key(0, [0, 1, 0], { interpolation: "linear" }), key(10, [10, 1, 0])],
    free,
  );
  close(linear.positionAt(3)[0], 3);
  const hold = createShotCurve(
    [key(0, [0, 1, 0], { interpolation: "hold" }), key(10, [10, 1, 0])],
    free,
  );
  close(hold.positionAt(9.9)[0], 0);
  close(hold.positionAt(10)[0], 10);
});

test("pan takes the short way around", () => {
  const curve = createShotCurve(
    [key(0, [0, 1, 0], { yaw: 170 }), key(10, [0, 1, 0], { yaw: -170 })],
    free,
  );
  const middle = curve.poseAt(5).yaw;
  assert.ok(Math.abs(Math.abs(middle) - 180) < 1, `${middle}`);
});

test("look-at aims every frame at the target", () => {
  const target: [number, number, number] = [0, 1, -5];
  const curve = createShotCurve(
    [key(0, [-3, 1, 0]), key(47, [3, 2, 0])],
    { aimMode: "look_at", aimTarget: target, allowBelowFloor: false },
  );
  for (const frame of [0, 13, 30, 47]) {
    const pose = curve.poseAt(frame);
    const forward = new Vector3(0, 0, -1).applyQuaternion(
      new Quaternion(...pose.quaternion),
    );
    const toTarget = new Vector3(...target)
      .sub(new Vector3(...pose.position))
      .normalize();
    assert.ok(forward.dot(toTarget) > 0.9999);
  }
});

test("the floor holds unless below-floor movement is allowed", () => {
  const keys = [key(0, [0, 0.2, 0]), key(10, [1, 0, 0]), key(20, [2, 0.2, 0])];
  const curve = createShotCurve(
    [...keys.slice(0, 1), key(10, [1, -1, 0]), keys[2]!],
    free,
  );
  assert.ok(curve.positionAt(10)[1] >= 0);
  const below = createShotCurve([key(0, [0, -1, 0])], {
    ...free,
    allowBelowFloor: true,
  });
  close(below.positionAt(0)[1], -1);
});

test("upsert updates a key in place or inserts a new one", () => {
  const keys = [key(0, [0, 1, 0]), key(47, [3, 1, 0])];
  const updated = upsertKeyframe(keys, 0, {
    position: [1, 1, 1],
    yaw: 5,
    pitch: 0,
  });
  assert.equal(updated.keyframes.length, 2);
  assert.deepEqual(updated.keyframes[0]!.position, [1, 1, 1]);
  const inserted = upsertKeyframe(keys, 20.4, {
    position: [2, 1, 0],
    yaw: 0,
    pitch: 0,
  });
  assert.deepEqual(
    inserted.keyframes.map((k) => k.frame),
    [0, 20, 47],
  );
});

test("retiming keeps keys in order and inside the shot", () => {
  const keys = [key(0, [0, 1, 0]), key(20, [1, 1, 0]), key(40, [2, 1, 0])];
  assert.equal(retimeKeyframe(keys, "k20", 45, 48)[1]!.frame, 39);
  assert.equal(retimeKeyframe(keys, "k20", -3, 48)[1]!.frame, 1);
  assert.equal(retimeKeyframe(keys, "k40", 99, 48)[2]!.frame, 47);
});

test("changing a gap moves the later keys and stays within the shot", () => {
  const keys = [key(0, [0, 1, 0]), key(12, [1, 1, 0]), key(24, [2, 1, 0])];
  assert.deepEqual(
    setKeyframeGap(keys, 0, 18, 48).map((k) => k.frame),
    [0, 18, 30],
  );
  assert.deepEqual(
    setKeyframeGap(keys, 0, 60, 48).map((k) => k.frame),
    [0, 35, 47],
  );
  assert.deepEqual(
    setKeyframeGap(keys, 1, 0, 48).map((k) => k.frame),
    [0, 12, 13],
  );
});

test("even spacing spans the shot by distance travelled", () => {
  const spaced = spaceKeyframesEvenly(
    [key(3, [0, 1, 0]), key(5, [1, 1, 0]), key(9, [4, 1, 0])],
    48,
  );
  assert.deepEqual(
    spaced.map((k) => k.frame),
    [0, 12, 47],
  );
});

test("a shot needs two keys that differ", () => {
  assert.equal(shotHasMotion([key(0, [0, 1, 0])]), false);
  assert.equal(
    shotHasMotion([key(0, [0, 1, 0]), key(47, [0, 1, 0])]),
    false,
  );
  assert.equal(
    shotHasMotion([key(0, [0, 1, 0]), key(47, [0, 1, 0], { yaw: 20 })]),
    true,
  );
});

test("legacy pivot paths become keys from the first to the last frame", () => {
  const converted = keyframesFromLegacySegments(
    [
      {
        id: "a",
        points: [
          [0, 1, 5],
          [1, 1, 4],
          [2, 1, 2],
        ],
      },
    ],
    { id: "ref", position: [0, 1, 5], quaternion: [0, 0, 0, 1], fovRadians: 1 },
    48,
    {
      directionMode: "look_at",
      directionTarget: [0, 1, 0],
      closedLoop: false,
      allowBelowFloor: false,
    },
  );
  assert.equal(converted.aimMode, "look_at");
  assert.equal(converted.keyframes.length, 3);
  assert.equal(converted.keyframes[0]!.frame, 0);
  assert.equal(converted.keyframes.at(-1)!.frame, 47);
  assert.ok(converted.keyframes[1]!.frame > 0);
  assert.ok(converted.keyframes[1]!.frame < 47);
  assert.deepEqual(converted.keyframes[1]!.position, [1, 1, 4]);
});
