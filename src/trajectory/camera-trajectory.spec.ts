import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  appendDrawnTrajectory,
  buildTargetCameras,
  cameraAimDegrees,
  cameraDrawingView,
  cameraPathProgressAtFrame,
  cameraPathTarget,
  cameraQuaternionAtView,
  cameraQuaternionFromAim,
  cameraTargetIsClearOfPath,
  cameraViewLookingAt,
  cameraViewsFromSegments,
  cameraViewsFromTrajectory,
  deleteTrajectoryPivot,
  frameTrajectorySpaceAboveFloor,
  insertTrajectoryPivot,
  materializeTrajectorySmoothing,
  MAX_PIVOTS_PER_PART,
  moveTrajectoryPoint,
  partLookAtTargetIsClearOfPath,
  projectTrajectoryPoint,
  projectCameraPreviewPoints,
  reshapeTrajectorySegments,
  sampleCameraPivot,
  sampleCameraPath,
  setTrajectoryPointDirectionOverride,
  setTrajectoryPointQuaternion,
  smoothTrajectorySegments,
  trajectoryFloorBoundary,
  trajectoryPathFromSegments,
  trajectoryPivotsFromSegments,
  unprojectTrajectoryPoint,
  type CameraView,
  type TrajectoryDrawingView,
  type TrajectorySegment,
  type TrajectorySpace,
} from "./camera-trajectory";

const START: CameraView = {
  id: "start",
  position: [0, 1, 4],
  quaternion: [0, 0, 0, 1],
  fovRadians: Math.PI / 3,
};

const END: CameraView = {
  id: "end",
  position: [4, 2, 0],
  quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
  fovRadians: Math.PI / 2,
};

describe("sampleCameraPath", () => {
  it("keeps endpoint positions and manual endpoint angles", () => {
    const samples = sampleCameraPath([START, END], 9);

    expect(samples).toHaveLength(9);
    expect(samples[0]?.position).toEqual(START.position);
    expect(samples[0]?.fovRadians).toBe(START.fovRadians);
    expect(samples.at(-1)?.position).toEqual(END.position);
    expect(samples.at(-1)?.fovRadians).toBe(END.fovRadians);
    expect(
      Math.abs(
        new THREE.Quaternion(...samples[0]!.quaternion).dot(
          new THREE.Quaternion(...START.quaternion),
        ),
      ),
    ).toBeCloseTo(1);
    expect(
      Math.abs(
        new THREE.Quaternion(...samples.at(-1)!.quaternion).dot(
          new THREE.Quaternion(...END.quaternion),
        ),
      ),
    ).toBeCloseTo(1);
  });

  it("returns no path until two views have been captured", () => {
    expect(sampleCameraPath([START], 16)).toEqual([]);
  });

  it("smoothly rotates between views captured at the same position", () => {
    const turnInPlace: CameraView = {
      ...END,
      position: START.position,
    };

    const samples = sampleCameraPath([START, turnInPlace], 5);

    expect(samples.map((sample) => sample.position)).toEqual(
      Array.from({ length: 5 }, () => START.position),
    );
    expect(samples[1]?.quaternion[1]).toBeCloseTo(Math.sin(Math.PI / 16));
    expect(samples[2]?.quaternion[1]).toBeCloseTo(Math.sin(Math.PI / 8));
    expect(samples[3]?.quaternion[1]).toBeCloseTo(Math.sin((3 * Math.PI) / 16));
  });

  it("smoothly reverses pitch at a manual angle without overshooting", () => {
    const views = [0, 30, 0].map((pitch, index): CameraView => ({
      ...START,
      id: `pitch-${index + 1}`,
      position: [index, 1, 0],
      quaternion: cameraQuaternionFromAim(0, pitch),
      angleKey: true,
    }));

    const pitches = sampleCameraPath(views, 49).map(
      (sample) => cameraAimDegrees(sample.quaternion).pitch,
    );
    const incomingStep = pitches[24]! - pitches[23]!;
    const outgoingStep = pitches[25]! - pitches[24]!;

    expect(pitches[24]).toBeCloseTo(30);
    expect(Math.max(...pitches)).toBeLessThanOrEqual(30 + 1e-8);
    expect(Math.abs(outgoingStep - incomingStep)).toBeLessThan(0.3);
  });

  it("takes the short yaw path through the wraparound boundary", () => {
    const views = [170, -170, 170].map((yaw, index): CameraView => ({
      ...START,
      id: `yaw-${index + 1}`,
      position: [index, 1, 0],
      quaternion: cameraQuaternionFromAim(yaw, 0),
      angleKey: true,
    }));

    const samples = sampleCameraPath(views, 49);
    const largestStep = Math.max(
      ...samples
        .slice(1)
        .map((sample, index) =>
          THREE.MathUtils.radToDeg(
            new THREE.Quaternion(...samples[index]!.quaternion).angleTo(
              new THREE.Quaternion(...sample.quaternion),
            ),
          ),
        ),
    );

    expect(largestStep).toBeLessThan(2);
    expect(cameraAimDegrees(samples[24]!.quaternion).yaw).toBeCloseTo(-170);
  });

  it("eases into and out of interior manual angle keys", () => {
    const views = [0, 1, 2, 3, 4].map((x, index): CameraView => ({
      ...START,
      id: `interior-angle-${index + 1}`,
      position: [x, 1, 0],
      quaternion:
        index === 3 ? cameraQuaternionFromAim(0, 30) : START.quaternion,
      angleKey: index === 1 || index === 3,
    }));

    const pitches = sampleCameraPath(views, 49).map(
      (sample) => cameraAimDegrees(sample.quaternion).pitch,
    );

    expect(pitches[11]).toBeCloseTo(0);
    expect(pitches[12]).toBeCloseTo(0);
    expect(pitches[13]! - pitches[12]!).toBeLessThan(0.2);
    expect(pitches[36]).toBeCloseTo(30);
    expect(pitches[36]! - pitches[35]!).toBeLessThan(0.2);
    expect(pitches[37]).toBeCloseTo(30);
  });

  it("does not let path curvature change a manual camera angle", () => {
    const views = cameraViewsFromTrajectory(
      [
        [0, 1, 0],
        [0.2, 1.5, -3],
        [7, 2, -2],
        [8, 4, 5],
      ],
      START,
    );
    const samples = sampleCameraPath(views, 51);

    for (const sample of samples) {
      expect(
        Math.abs(
          new THREE.Quaternion(...sample.quaternion).dot(
            new THREE.Quaternion(...START.quaternion),
          ),
        ),
      ).toBeCloseTo(1);
    }
  });

  it("does not spin between equivalent quaternion signs", () => {
    const equivalentEnd = {
      ...END,
      quaternion: START.quaternion.map((value) => -value) as [
        number,
        number,
        number,
        number,
      ],
    };
    const samples = sampleCameraPath([START, equivalentEnd], 51);

    for (const sample of samples) {
      expect(
        Math.abs(
          new THREE.Quaternion(...sample.quaternion).dot(
            new THREE.Quaternion(...START.quaternion),
          ),
        ),
      ).toBeCloseTo(1);
    }
  });

  it("gives equal time to short and long control-point intervals", () => {
    const middleQuaternion = new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
      .toArray();
    const views: CameraView[] = [
      { ...START, position: [0, 1, 0], angleKey: true },
      {
        ...START,
        id: "middle",
        position: [1, 1, 0],
        quaternion: middleQuaternion,
        angleKey: true,
      },
      { ...END, position: [101, 1, 0], angleKey: true },
    ];

    const samples = sampleCameraPath(views, 5);

    expect(
      new THREE.Quaternion(...samples[2]!.quaternion).angleTo(
        new THREE.Quaternion(...middleQuaternion),
      ),
    ).toBeCloseTo(0);
  });

  it("moves smoothly through uneven approximate camera positions", () => {
    const [segment] = smoothTrajectorySegments([
      {
        id: "rough-position-part",
        points: [0, 1, 11].map((x): [number, number, number] => [x, 1, 0]),
      },
    ]);
    const views = cameraViewsFromSegments([segment], START);

    const samples = sampleCameraPath(views, 49);
    const incomingVelocity = new THREE.Vector3(...samples[24]!.position).sub(
      new THREE.Vector3(...samples[23]!.position),
    );
    const outgoingVelocity = new THREE.Vector3(...samples[25]!.position).sub(
      new THREE.Vector3(...samples[24]!.position),
    );

    expect(samples[24]!.position[0]).toBeGreaterThan(3);
    expect(samples[24]!.position[0]).toBeLessThan(4.5);
    expect(outgoingVelocity.sub(incomingVelocity).length()).toBeLessThan(0.1);
  });

  it("softens a rough multi-part flight without hiding its editable positions", () => {
    const positions: [number, number, number][] = [
      [21.65, 55.23, 23.28],
      [-7.13, 15.91, -23.6],
      [-3.39, 51.27, -33.56],
      [-2.49, 74.46, -38.74],
      [1.72, 87.63, -82.32],
      [11.49, 84.94, -99.16],
      [12.75, 77.23, -112.77],
      [15.82, 68.46, -121.23],
    ];
    const partIndices = [
      [0, 1, 2],
      [2, 3],
      [3, 4],
      [4, 5, 6],
      [6, 7],
    ];
    const segments = smoothTrajectorySegments(
      partIndices.map((indices, partIndex) => ({
        id: `rough-flight-part-${partIndex + 1}`,
        points: indices.map((index) => positions[index]!),
      })),
    );
    const views = cameraViewsFromSegments(segments, START);
    const samples = sampleCameraPath(views, 96);
    const velocities = samples
      .slice(1)
      .map((sample, index) =>
        new THREE.Vector3(...sample.position).sub(
          new THREE.Vector3(...samples[index]!.position),
        ),
      );
    const accelerations = velocities
      .slice(1)
      .map((velocity, index) => velocity.clone().sub(velocities[index]!));
    const jerks = accelerations
      .slice(1)
      .map((acceleration, index) =>
        acceleration.clone().sub(accelerations[index]!),
      );
    const secondPivot = sampleCameraPivot(views, 1);

    expect(segments[0]!.points[0]).toEqual(positions[0]);
    expect(segments.at(-1)!.points.at(-1)).toEqual(positions.at(-1));
    expect(segments[0]!.points.at(-1)).toEqual(segments[1]!.points[0]);
    expect(segments[0]!.points[1]![1]).toBeGreaterThan(35);
    expect(
      new THREE.Vector3(...secondPivot.position).distanceTo(
        new THREE.Vector3(...views[1]!.position),
      ),
    ).toBeLessThan(1);
    expect(
      Math.min(...samples.map((sample) => sample.position[1])),
    ).toBeGreaterThan(35);
    expect(
      Math.max(...accelerations.map((value) => value.length())),
    ).toBeLessThan(0.5);
    expect(Math.max(...jerks.map((value) => value.length()))).toBeLessThan(0.2);
  });

  it("materializes path smoothing only once across preview and save", () => {
    const preview = materializeTrajectorySmoothing(
      [
        {
          id: "drawn-part",
          points: [
            [0, 1, 0],
            [1, 8, 0],
            [2, 1, 0],
          ],
        },
      ],
      0,
    );
    const saved = materializeTrajectorySmoothing(
      preview.segments,
      preview.version,
    );

    expect(saved.segments).toEqual(preview.segments);
  });

  it("does not move corrected points when the path is extended", () => {
    const materialized = materializeTrajectorySmoothing(
      [
        {
          id: "first-part",
          points: [
            [0, 1, 0],
            [1, 8, 0],
            [2, 1, 0],
          ],
        },
      ],
      0,
    );
    const lastPoint = materialized.segments[0]!.points.at(-1)!;
    const extended = [
      ...materialized.segments,
      {
        id: "second-part",
        points: [lastPoint, [3, 3, 0] as [number, number, number]],
      },
    ];
    const replayed = materializeTrajectorySmoothing(
      extended,
      materialized.version,
    );

    expect(replayed.segments[0]).toEqual(materialized.segments[0]);
  });

  it("keeps camera keys exact while smoothing indivisible frame timing", () => {
    const progresses = Array.from({ length: 96 }, (_, index) =>
      cameraPathProgressAtFrame(index, 96, 8),
    );
    const steps = progresses
      .slice(1)
      .map((progress, index) => progress - progresses[index]!);
    const stepChanges = steps
      .slice(1)
      .map((step, index) => Math.abs(step - steps[index]!));

    for (let keyIndex = 0; keyIndex < 8; keyIndex += 1) {
      const frameIndex = Math.round((keyIndex * 95) / 7);
      expect(progresses[frameIndex]).toBeCloseTo(keyIndex / 7);
    }
    expect(Math.max(...stepChanges)).toBeLessThan(0.0002);
    expect(progresses.at(-1)).toBe(1);
  });

  it("moves periodically around a closed loop while facing inward", () => {
    const center = new THREE.Vector3(0, 1, 0);
    const views = cameraViewsFromTrajectory(
      [
        [4, 1, 0],
        [0, 1, 4],
        [-4, 1, 0],
        [0, 1, -4],
      ],
      START,
    );
    const samples = sampleCameraPath(views, 97, {
      directionMode: "inward",
      directionTarget: [0, 1, 0],
      closedLoop: true,
    });
    const velocities = samples
      .slice(1)
      .map((sample, index) =>
        new THREE.Vector3(...sample.position)
          .sub(new THREE.Vector3(...samples[index]!.position))
          .normalize(),
      );
    const interiorVelocityDots = velocities
      .slice(1)
      .map((velocity, index) => velocity.dot(velocities[index]!));
    const seamVelocityDot = velocities.at(-1)!.dot(velocities[0]!);

    expect(
      new THREE.Vector3(...samples[0]!.position).distanceTo(
        new THREE.Vector3(...samples.at(-1)!.position),
      ),
    ).toBeLessThan(1e-8);
    expect(seamVelocityDot).toBeGreaterThanOrEqual(
      Math.min(...interiorVelocityDots) - 1e-8,
    );
    for (const sample of samples) {
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(
        new THREE.Quaternion(...sample.quaternion),
      );
      const inward = center
        .clone()
        .sub(new THREE.Vector3(...sample.position))
        .normalize();
      expect(forward.dot(inward)).toBeGreaterThan(0.999);
    }
  });

  it("keeps camera roll continuous through vertical loop poles", () => {
    const views = cameraViewsFromTrajectory(
      [
        [4, 5, 0],
        [0, 9, 0],
        [-4, 5, 0],
        [0, 1, 0],
      ],
      START,
    );
    const samples = sampleCameraPath(views, 129, {
      directionMode: "inward",
      directionTarget: [0, 5, 0],
      closedLoop: true,
    });
    const angularSteps = samples
      .slice(1)
      .map((sample, index) =>
        new THREE.Quaternion(...samples[index]!.quaternion).angleTo(
          new THREE.Quaternion(...sample.quaternion),
        ),
      );

    expect(Math.max(...angularSteps)).toBeLessThan(0.2);
    expect(
      new THREE.Quaternion(...samples[0]!.quaternion).angleTo(
        new THREE.Quaternion(...samples.at(-1)!.quaternion),
      ),
    ).toBeLessThan(1e-7);
  });

  it("normalizes a duplicated endpoint before sampling a closed loop", () => {
    const uniqueViews = cameraViewsFromTrajectory(
      [
        [4, 1, 0],
        [0, 1, 4],
        [-4, 1, 0],
        [0, 1, -4],
      ],
      START,
    );
    const duplicatedViews = [
      ...uniqueViews,
      { ...uniqueViews[0]!, id: "duplicate-end" },
    ];
    const options = { directionMode: "forward" as const, closedLoop: true };

    expect(sampleCameraPath(duplicatedViews, 97, options)).toEqual(
      sampleCameraPath(uniqueViews, 97, options),
    );
  });

  it("keeps manual camera directions on a closed loop", () => {
    const views = cameraViewsFromTrajectory(
      [
        [4, 1, 0],
        [0, 1, 4],
        [-4, 1, 0],
        [0, 1, -4],
      ],
      START,
    ).map((view, index) => ({ ...view, angleKey: index === 0 }));

    for (const sample of sampleCameraPath(views, 49, { closedLoop: true })) {
      expect(
        Math.abs(
          new THREE.Quaternion(...sample.quaternion).dot(
            new THREE.Quaternion(...START.quaternion),
          ),
        ),
      ).toBeCloseTo(1);
    }
  });

  it("interpolates partial manual angle keys periodically across a loop seam", () => {
    const views = cameraViewsFromTrajectory(
      [
        [4, 1, 0],
        [0, 1, 4],
        [-4, 1, 0],
        [0, 1, -4],
      ],
      START,
    ).map((view, index) => ({
      ...view,
      quaternion:
        index === 1
          ? cameraQuaternionFromAim(-45, 5)
          : index === 2
            ? cameraQuaternionFromAim(70, -10)
            : view.quaternion,
      angleKey: index === 1 || index === 2,
    }));
    const samples = sampleCameraPath(views, 97, { closedLoop: true });
    const angularSteps = samples
      .slice(1)
      .map((sample, index) =>
        new THREE.Quaternion(...samples[index]!.quaternion).angleTo(
          new THREE.Quaternion(...sample.quaternion),
        ),
      );

    expect(
      new THREE.Quaternion(...samples[0]!.quaternion).angleTo(
        new THREE.Quaternion(...samples.at(-1)!.quaternion),
      ),
    ).toBeLessThan(1e-7);
    expect(
      Math.max(angularSteps[0]!, angularSteps.at(-1)!),
    ).toBeLessThanOrEqual(Math.max(...angularSteps.slice(1, -1)) + 1e-7);
  });

  it("offers forward and outward camera direction presets", () => {
    const views = cameraViewsFromTrajectory(
      [
        [3, 1, -2],
        [3, 1, 0],
        [3, 1, 2],
      ],
      START,
    );
    const forward = sampleCameraPath(views, 17, {
      directionMode: "forward",
    })[8]!;
    const outward = sampleCameraPath(views, 17, {
      directionMode: "outward",
      directionTarget: [0, 1, 0],
    })[8]!;
    const forwardDirection = new THREE.Vector3(0, 0, -1).applyQuaternion(
      new THREE.Quaternion(...forward.quaternion),
    );
    const outwardDirection = new THREE.Vector3(0, 0, -1).applyQuaternion(
      new THREE.Quaternion(...outward.quaternion),
    );

    expect(forwardDirection.z).toBeGreaterThan(0.999);
    expect(outwardDirection.x).toBeGreaterThan(0.999);
  });

  it("keeps a preset automatic except around an overridden camera", () => {
    const views = cameraViewsFromTrajectory(
      [
        [-5, 1, -2],
        [-2, 3, 0],
        [1, 2, 3],
        [4, 1, 1],
        [7, 2, -1],
      ],
      START,
    );
    const desired = cameraQuaternionFromAim(-110, 12);
    const overridden = views.map((view, index) => ({
      ...view,
      directionOverride: index === 3 ? desired : undefined,
    }));
    const options = { directionMode: "forward" as const };
    const basePivotSamples = sampleCameraPath(views, views.length, options);
    const overriddenPivotSamples = sampleCameraPath(
      overridden,
      overridden.length,
      options,
    );
    const baseDenseSamples = sampleCameraPath(views, 9, options);
    const overriddenDenseSamples = sampleCameraPath(overridden, 9, options);

    expect(
      new THREE.Quaternion(...overriddenPivotSamples[3]!.quaternion).angleTo(
        new THREE.Quaternion(...desired),
      ),
    ).toBeLessThan(1e-7);
    for (const index of [0, 1, 2, 4]) {
      expect(
        new THREE.Quaternion(
          ...overriddenPivotSamples[index]!.quaternion,
        ).angleTo(new THREE.Quaternion(...basePivotSamples[index]!.quaternion)),
      ).toBeLessThan(1e-7);
    }
    expect(
      new THREE.Quaternion(...overriddenDenseSamples[1]!.quaternion).angleTo(
        new THREE.Quaternion(...baseDenseSamples[1]!.quaternion),
      ),
    ).toBeLessThan(1e-7);
  });

  it("applies an override exactly at the inward target", () => {
    const first = cameraQuaternionFromAim(0, 0);
    const last = cameraQuaternionFromAim(30, 0);
    const desired = cameraQuaternionFromAim(90, -10);
    const views = cameraViewsFromTrajectory(
      [
        [-2, 1, 0],
        [0, 1, 0],
        [2, 1, 0],
      ],
      START,
    ).map((view, index) => ({
      ...view,
      quaternion: index === 0 ? first : index === 2 ? last : view.quaternion,
      angleKey: index === 0 || index === 2,
      directionOverride: index === 1 ? desired : undefined,
    }));
    const middle = sampleCameraPath(views, 3, {
      directionMode: "inward",
      directionTarget: [0, 1, 0],
    })[1]!;

    expect(
      new THREE.Quaternion(...middle.quaternion).angleTo(
        new THREE.Quaternion(...desired),
      ),
    ).toBeLessThan(1e-7);
  });

  it("points every point-target camera at or away from the chosen target", () => {
    const target: [number, number, number] = [2, 4, -8];
    const views = cameraViewsFromTrajectory(
      [
        [-3, 1, 1],
        [0, 2, 0],
        [4, 1, 2],
      ],
      START,
    ).map((view, index) => ({
      ...view,
      directionOverride:
        index === 1 ? cameraQuaternionFromAim(160, -20) : undefined,
    }));

    for (const directionMode of ["look_at", "look_away"] as const) {
      for (const sample of sampleCameraPath(views, 25, {
        directionMode,
        directionTarget: target,
      })) {
        const quaternion = new THREE.Quaternion(...sample.quaternion);
        const actual = new THREE.Vector3(0, 0, -1)
          .applyQuaternion(quaternion)
          .normalize();
        const expected = new THREE.Vector3(...target)
          .sub(new THREE.Vector3(...sample.position))
          .normalize()
          .multiplyScalar(directionMode === "look_at" ? 1 : -1);
        const expectedUp = new THREE.Vector3(0, 1, 0)
          .addScaledVector(actual, -actual.y)
          .normalize();
        const actualUp = new THREE.Vector3(0, 1, 0)
          .applyQuaternion(quaternion)
          .normalize();
        expect(actual.dot(expected)).toBeGreaterThan(0.999999);
        expect(actualUp.dot(expectedUp)).toBeGreaterThan(0.999999);
      }
    }
  });

  it("aims one path part at a point and eases its neighboring parts", () => {
    const target: [number, number, number] = [0, 1, 4];
    const segments: TrajectorySegment[] = [
      {
        id: "before",
        points: [
          [-4, 1, 0],
          [-2, 1, 0],
        ],
      },
      {
        id: "targeted",
        points: [
          [-2, 1, 0],
          [0, 1, 0],
          [2, 1, 0],
        ],
        look_at_target: target,
      },
      {
        id: "after",
        points: [
          [2, 1, 0],
          [4, 1, 0],
        ],
      },
    ];
    const views = cameraViewsFromSegments(segments, START);
    const samples = sampleCameraPath(views, 129);

    for (const index of [32, 48, 64, 80, 96]) {
      const sample = samples[index]!;
      const actual = new THREE.Vector3(0, 0, -1)
        .applyQuaternion(new THREE.Quaternion(...sample.quaternion))
        .normalize();
      const expected = new THREE.Vector3(...target)
        .sub(new THREE.Vector3(...sample.position))
        .normalize();
      expect(actual.dot(expected)).toBeGreaterThan(0.999999);
    }

    for (const index of [0, 16, 112, 128]) {
      expect(
        new THREE.Quaternion(...samples[index]!.quaternion).angleTo(
          new THREE.Quaternion(...START.quaternion),
        ),
      ).toBeLessThan(1e-7);
    }

    const angularSteps = samples
      .slice(1)
      .map((sample, index) =>
        new THREE.Quaternion(...samples[index]!.quaternion).angleTo(
          new THREE.Quaternion(...sample.quaternion),
        ),
      );
    expect(Math.max(...angularSteps)).toBeLessThan(0.5);
    const closed = sampleCameraPath(views, 161, { closedLoop: true });
    const closedBaseline = sampleCameraPath(
      views.map(({ lookAtTarget: _lookAtTarget, ...view }) => view),
      161,
      { closedLoop: true },
    );
    expect(
      new THREE.Quaternion(...closed[144]!.quaternion).angleTo(
        new THREE.Quaternion(...closedBaseline[144]!.quaternion),
      ),
    ).toBeLessThan(1e-7);
    expect(views.map((view) => view.lookAtTarget)).toEqual([
      undefined,
      target,
      target,
      undefined,
      undefined,
    ]);
    expect(
      trajectoryPivotsFromSegments(segments).map(
        (pivot) => pivot.hasLookAtTarget,
      ),
    ).toEqual([false, true, true, true, false]);
  });

  it("checks a part target only where that target affects the camera", () => {
    const segments: TrajectorySegment[] = [
      {
        id: "crossing",
        points: [
          [-2, 1, 0],
          [2, 1, 0],
        ],
      },
      {
        id: "gap",
        points: [
          [2, 1, 0],
          [2, 1, -2],
        ],
      },
      {
        id: "targeted",
        points: [
          [2, 1, -2],
          [3, 1, -3],
          [4, 1, -4],
        ],
      },
    ];
    const baselineViews = cameraViewsFromSegments(segments, START);
    const target = sampleCameraPath(baselineViews, 1000)[100]!.position;
    const views = cameraViewsFromSegments(
      segments.map((segment) =>
        segment.id === "targeted"
          ? { ...segment, look_at_target: target }
          : segment,
      ),
      START,
    );

    expect(cameraTargetIsClearOfPath(views, target, false, 0.05)).toBe(false);
    expect(partLookAtTargetIsClearOfPath(views, target, false, 0.05)).toBe(
      true,
    );
  });

  it("keeps a level point-target horizon near vertical shots", () => {
    const target: [number, number, number] = [0, 10, 0];
    const aims: [number, number][] = [
      [0, 0],
      [100, 70],
      [-80, -60],
    ];
    const views = cameraViewsFromTrajectory(
      [
        [0.05, 0, 0],
        [0.03, 1, 0.04],
        [-0.04, 2, 0.02],
      ],
      START,
    ).map((view, index) => ({
      ...view,
      quaternion: cameraQuaternionFromAim(...aims[index]!),
      angleKey: true,
    }));

    for (const sample of sampleCameraPath(views, 9, {
      directionMode: "look_at",
      directionTarget: target,
    })) {
      const quaternion = new THREE.Quaternion(...sample.quaternion);
      const forward = new THREE.Vector3(0, 0, -1)
        .applyQuaternion(quaternion)
        .normalize();
      const expectedUp = new THREE.Vector3(0, 1, 0)
        .addScaledVector(forward, -forward.y)
        .normalize();
      const actualUp = new THREE.Vector3(0, 1, 0)
        .applyQuaternion(quaternion)
        .normalize();
      expect(actualUp.dot(expectedUp)).toBeGreaterThan(0.999999);
    }
  });

  it("rejects a look target that the camera path crosses", () => {
    const views = cameraViewsFromTrajectory(
      [
        [-2, 1, 0],
        [0, 1, 0],
        [2, 1, 0],
      ],
      START,
    );

    expect(cameraTargetIsClearOfPath(views, [0, 1, 0], false, 0.05)).toBe(
      false,
    );
    expect(cameraTargetIsClearOfPath(views, [0, 3, 0], false, 0.05)).toBe(true);

    const offGridTarget = sampleCameraPath(views, 1000)[333]!.position;
    expect(cameraTargetIsClearOfPath(views, offGridTarget, false, 0.001)).toBe(
      false,
    );
  });

  it("uses the exact sampled pose for an uneven preset camera pivot", () => {
    const views = cameraViewsFromTrajectory(
      [
        [5, 1, 0],
        [1, 4, 2],
        [-2, 1, 5],
        [-6, 2, -1],
      ],
      START,
    );
    const options = {
      directionMode: "inward" as const,
      directionTarget: [0, 1, 0] as [number, number, number],
      closedLoop: true,
    };
    const expected = sampleCameraPath(views, views.length + 1, options)[2]!;

    expect(sampleCameraPivot(views, 2, options)).toEqual(expected);
  });
});

describe("buildTargetCameras", () => {
  it("uses 720p output intrinsics and Three.js camera coordinates", () => {
    const cameras = buildTargetCameras([START, END], 2, 1280, 720);

    expect(cameras[0]?.intrinsics).toMatchObject({ width: 1280, height: 720 });
    expect(cameras[0]?.extrinsics.coordinateSystem).toBe("rub");
    expect(cameras[1]?.extrinsics.position).toEqual(END.position);
  });

  it("uses the manually chosen angles in generated cameras", () => {
    const cameras = buildTargetCameras([START, END], 9, 1280, 720);

    expect(cameras[0]?.extrinsics.quaternion).toEqual(START.quaternion);
    expect(
      Math.abs(
        new THREE.Quaternion(...cameras.at(-1)!.extrinsics.quaternion).dot(
          new THREE.Quaternion(...END.quaternion),
        ),
      ),
    ).toBeCloseTo(1);
  });

  it("uses one field of view for every frame in a trajectory", () => {
    const pathViews = cameraViewsFromTrajectory(
      [
        [0, 1, 4],
        [2, 2, 1],
        [4, 2, 0],
      ],
      { ...START, fovRadians: THREE.MathUtils.degToRad(95) },
    );
    const cameras = buildTargetCameras(pathViews, 17, 1280, 720);

    expect(new Set(cameras.map((camera) => camera.intrinsics.fy)).size).toBe(1);
  });

  it("uses the model portrait raster without changing vertical field of view", () => {
    const landscape = buildTargetCameras([START, END], 2, 1280, 720);
    const portrait = buildTargetCameras([START, END], 2, 400, 720);

    expect(portrait[0]?.intrinsics).toMatchObject({ width: 400, height: 720 });
    expect(portrait[0]?.intrinsics.fy).toBeCloseTo(landscape[0]!.intrinsics.fy);
  });
});

describe("click-to-place camera points", () => {
  it("aims a placed camera at the subject", () => {
    const view = cameraViewLookingAt(
      "point-2",
      [4, 1, 0],
      [0, 1, 0],
      Math.PI / 3,
    );
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(
      new THREE.Quaternion(...view.quaternion),
    );

    expect(forward.x).toBeCloseTo(-1);
    expect(forward.y).toBeCloseTo(0);
    expect(forward.z).toBeCloseTo(0);
  });

  it("keeps the initial camera pitch when choosing the shared subject target", () => {
    const pitchedStart: CameraView = {
      ...START,
      quaternion: new THREE.Quaternion()
        .setFromEuler(new THREE.Euler(Math.PI / 4, 0, 0))
        .toArray(),
    };

    expect(cameraPathTarget(pitchedStart, [0, 0, 0])[1]).toBeCloseTo(5);
  });
});

describe("camera direction preview", () => {
  it("projects points through the selected camera", () => {
    const projected = projectCameraPreviewPoints(
      [
        [0, 0, -2],
        [0, 0, 2],
        [1, 1, -2],
      ],
      { ...START, position: [0, 0, 0] },
    );

    expect(projected).toHaveLength(2);
    expect(projected[0]).toEqual({
      x: 0.5,
      y: 0.5,
      depth: 2,
      pointIndex: 0,
    });
    expect(projected[1]?.pointIndex).toBe(2);
    expect(projected[1]!.x).toBeGreaterThan(0.5);
    expect(projected[1]!.y).toBeLessThan(0.5);
  });

  it("shows the world direction chosen by yaw", () => {
    const projected = projectCameraPreviewPoints([[2, 0, 0]], {
      ...START,
      position: [0, 0, 0],
      quaternion: cameraQuaternionFromAim(90, 0),
    });

    expect(projected[0]?.x).toBeCloseTo(0.5);
    expect(projected[0]?.y).toBeCloseTo(0.5);
  });

  it("uses the selected aspect when clipping the approximate view", () => {
    const view = { ...START, position: [0, 0, 0] as [number, number, number] };

    expect(projectCameraPreviewPoints([[1, 0, -2]], view, 16 / 9)).toHaveLength(
      1,
    );
    expect(projectCameraPreviewPoints([[1, 0, -2]], view, 400 / 720)).toEqual(
      [],
    );
  });
});

const SPACE: TrajectorySpace = {
  center: [0, 0, 0],
  radius: 10,
};
const FRONT_VIEW = cameraDrawingView([0, 0, 0, 1]);
const TURNED_VIEW = cameraDrawingView(
  new THREE.Quaternion()
    .setFromEuler(new THREE.Euler(-Math.PI / 6, Math.PI / 4, 0))
    .toArray(),
);

describe("3D drawn camera paths", () => {
  it("straightens one part without changing its joins or camera angles", () => {
    const forward: [number, number, number, number] = [0, 0, 0, 1];
    const parts: TrajectorySegment[] = [
      {
        id: "one",
        points: [
          [-2, 1, 0],
          [0, 1, 0],
        ],
      },
      {
        id: "two",
        points: [
          [0, 1, 0],
          [1, 4, 3],
          [2, 2, -2],
          [4, 1, 0],
        ],
        quaternions: [forward, null, null, forward],
      },
      {
        id: "three",
        points: [
          [4, 1, 0],
          [6, 1, 0],
        ],
      },
    ];

    const shaped = reshapeTrajectorySegments(
      parts,
      "straighten",
      FRONT_VIEW,
      "two",
      false,
    )!;

    expect(shaped[0]).toBe(parts[0]);
    expect(shaped[2]).toBe(parts[2]);
    expect(shaped[1]?.points).toEqual([
      [0, 1, 0],
      [4 / 3, 1, 0],
      [8 / 3, 1, 0],
      [4, 1, 0],
    ]);
    expect(shaped[1]?.quaternions).toBe(parts[1]?.quaternions);
  });

  it("reshapes a whole closed path into an evenly spaced circle", () => {
    const parts: TrajectorySegment[] = [
      {
        id: "one",
        points: [
          [4, 2, 0],
          [1, 2, 2],
          [-3, 2, 1],
        ],
      },
      {
        id: "two",
        points: [
          [-3, 2, 1],
          [-1, 2, -4],
          [3, 2, -2],
          [4, 2, 0],
        ],
      },
    ];

    const shaped = reshapeTrajectorySegments(
      parts,
      "circular",
      cameraDrawingView(
        new THREE.Quaternion()
          .setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2)
          .toArray(),
      ),
      null,
      true,
    )!;
    const path = trajectoryPathFromSegments(shaped);
    const logicalPath = path.slice(0, -1);
    const center = logicalPath
      .reduce(
        (sum, point) => sum.add(new THREE.Vector3(...point)),
        new THREE.Vector3(),
      )
      .multiplyScalar(1 / logicalPath.length);
    const radii = logicalPath.map((point) =>
      new THREE.Vector3(...point).distanceTo(center),
    );

    expect(path).toHaveLength(6);
    expect(path.at(-1)).toEqual(path[0]);
    expect(shaped[0]?.points.at(-1)).toEqual(shaped[1]?.points[0]);
    expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(1e-6);
  });

  it("keeps a closed underwater shape below the floor when allowed", () => {
    const parts: TrajectorySegment[] = [
      {
        id: "underwater",
        points: [
          [3, -3, 0],
          [0, -3, 3],
          [-3, -3, 0],
          [0, -3, -3],
        ],
      },
    ];
    const overheadView = cameraDrawingView(
      new THREE.Quaternion()
        .setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2)
        .toArray(),
    );

    const locked = reshapeTrajectorySegments(
      parts,
      "circular",
      overheadView,
      null,
      true,
    )!;
    const underwater = reshapeTrajectorySegments(
      parts,
      "circular",
      overheadView,
      null,
      true,
      true,
    )!;

    expect(
      Math.min(...trajectoryPathFromSegments(locked).map((point) => point[1])),
    ).toBeGreaterThanOrEqual(0);
    expect(
      Math.max(
        ...trajectoryPathFromSegments(underwater).map((point) => point[1]),
      ),
    ).toBeLessThan(0);
  });

  it("flattens a selected part onto the current view plane", () => {
    const parts: TrajectorySegment[] = [
      {
        id: "one",
        points: [
          [0, 2, 0],
          [1, 3, 4],
          [3, 4, -2],
          [5, 2, 0],
        ],
      },
    ];
    const shaped = reshapeTrajectorySegments(
      parts,
      "flatten",
      FRONT_VIEW,
      "one",
      false,
    )!;

    expect(shaped[0]?.points[0]).toEqual(parts[0]?.points[0]);
    expect(shaped[0]?.points.at(-1)).toEqual(parts[0]?.points.at(-1));
    expect(shaped[0]?.points.map((point) => point[2])).toEqual([0, 0, 0, 0]);
  });

  it("adds a pivot on the virtual closing span without duplicating camera 1", () => {
    const parts: TrajectorySegment[] = [
      {
        id: "one",
        points: [
          [3, 1, 0],
          [0, 1, 3],
          [-3, 1, 0],
        ],
      },
    ];

    const inserted = insertTrajectoryPivot(parts, [0, 1, -3], 0.9, true)!;
    const path = trajectoryPathFromSegments(inserted.segments);

    expect(path).toEqual([
      [3, 1, 0],
      [0, 1, 3],
      [-3, 1, 0],
      [0, 1, -3],
    ]);
    expect(inserted.pivotNumber).toBe(4);
  });

  it("removes a duplicated loop endpoint before adding a closing-span pivot", () => {
    const parts: TrajectorySegment[] = [
      {
        id: "one",
        points: [
          [3, 1, 0],
          [0, 1, 3],
          [-3, 1, 0],
          [0, 1, -3],
          [3, 1, 0],
        ],
      },
    ];

    const inserted = insertTrajectoryPivot(parts, [2, 1, -2], 0.9, true)!;

    expect(trajectoryPathFromSegments(inserted.segments)).toEqual([
      [3, 1, 0],
      [0, 1, 3],
      [-3, 1, 0],
      [0, 1, -3],
      [2, 1, -2],
    ]);
    expect(inserted.pivotNumber).toBe(5);
  });

  it("stores a preset override on both copies of a shared path point", () => {
    const left: [number, number, number, number] = [
      0,
      Math.SQRT1_2,
      0,
      Math.SQRT1_2,
    ];
    const parts: TrajectorySegment[] = [
      {
        id: "one",
        points: [
          [0, 1, 0],
          [1, 1, 0],
        ],
      },
      {
        id: "two",
        points: [
          [1, 1, 0],
          [2, 1, 0],
        ],
      },
    ];

    const updated = setTrajectoryPointDirectionOverride(parts, "one", 1, left);

    expect(updated[0]?.direction_overrides).toEqual([null, left]);
    expect(updated[1]?.direction_overrides).toEqual([left, null]);
  });

  it("deletes an interior camera position and its facing key", () => {
    const forward: [number, number, number, number] = [0, 0, 0, 1];
    const left: [number, number, number, number] = [
      0,
      Math.SQRT1_2,
      0,
      Math.SQRT1_2,
    ];
    const parts: TrajectorySegment[] = [
      {
        id: "one",
        points: [
          [0, 1, 0],
          [1, 1, 0],
          [2, 1, 0],
        ],
        quaternions: [forward, left, forward],
        direction_overrides: [left, forward, left],
      },
    ];

    const deleted = deleteTrajectoryPivot(parts, "one", 1);

    expect(deleted).toEqual([
      {
        id: "one",
        points: [
          [0, 1, 0],
          [2, 1, 0],
        ],
        quaternions: [forward, forward],
        direction_overrides: [left, left],
      },
    ]);
    expect(parts[0]?.points).toHaveLength(3);
  });

  it("deletes every consecutive stored copy of one camera point", () => {
    const parts: TrajectorySegment[] = [
      {
        id: "one",
        points: [
          [0, 1, 0],
          [1, 1, 0],
          [1, 1, 0],
        ],
      },
      {
        id: "two",
        points: [
          [1, 1, 0],
          [2, 1, 0],
          [3, 1, 0],
        ],
      },
    ];

    const deleted = deleteTrajectoryPivot(parts, "one", 1)!;

    expect(deleted[0]?.points).toEqual([[0, 1, 0]]);
    expect(deleted[1]?.points).toEqual([
      [2, 1, 0],
      [3, 1, 0],
    ]);
    expect(trajectoryPathFromSegments(deleted)).toEqual([
      [0, 1, 0],
      [2, 1, 0],
      [3, 1, 0],
    ]);
  });

  it("keeps the minimum two camera points", () => {
    const parts: TrajectorySegment[] = [
      {
        id: "one",
        points: [
          [0, 1, 0],
          [1, 1, 0],
        ],
      },
    ];

    expect(deleteTrajectoryPivot(parts, "one", 0)).toBeNull();
  });

  it("inserts a draggable pivot into the nearest path span", () => {
    const forward: [number, number, number, number] = [0, 0, 0, 1];
    const left: [number, number, number, number] = [
      0,
      Math.SQRT1_2,
      0,
      Math.SQRT1_2,
    ];
    const parts: TrajectorySegment[] = [
      {
        id: "one",
        points: [
          [0, 1, 0],
          [10, 1, 0],
        ],
        quaternions: [forward, left],
        direction_overrides: [left, forward],
      },
      {
        id: "two",
        points: [
          [10, 1, 0],
          [20, 1, 0],
        ],
      },
    ];

    const inserted = insertTrajectoryPivot(parts, [7, 3, 1], 0.35);

    expect(inserted).toMatchObject({
      segmentId: "one",
      pointIndex: 1,
      pivotNumber: 2,
    });
    expect(inserted?.segments[0]?.points).toEqual([
      [0, 1, 0],
      [7, 3, 1],
      [10, 1, 0],
    ]);
    expect(inserted?.segments[1]).toBe(parts[1]);
    expect(inserted?.segments[0]?.quaternions).toEqual([forward, null, left]);
    expect(inserted?.segments[0]?.direction_overrides).toEqual([
      left,
      null,
      forward,
    ]);
    expect(parts[0]?.points).toHaveLength(2);
  });

  it("uses control-point timing when inserting on unequal path spans", () => {
    const parts: TrajectorySegment[] = [
      {
        id: "one",
        points: [
          [0, 1, 0],
          [1, 1, 0],
          [101, 1, 0],
        ],
      },
    ];

    const inserted = insertTrajectoryPivot(parts, [0.8, 2, 0], 0.45);

    expect(inserted).toMatchObject({
      segmentId: "one",
      pointIndex: 1,
      pivotNumber: 2,
    });
    expect(inserted?.segments[0]?.points[1]).toEqual([0.8, 2, 0]);
  });

  it("adds an underwater pivot only when below-floor editing is allowed", () => {
    const parts: TrajectorySegment[] = [
      {
        id: "one",
        points: [
          [0, 1, 0],
          [2, 1, 0],
        ],
      },
    ];

    const locked = insertTrajectoryPivot(parts, [1, -2, 0], 0.5)!;
    const underwater = insertTrajectoryPivot(
      parts,
      [1, -2, 0],
      0.5,
      false,
      true,
    )!;

    expect(locked.segments[0]?.points[1]?.[1]).toBe(0);
    expect(underwater.segments[0]?.points[1]?.[1]).toBe(-2);
  });

  it("does not add more than the manual pivot limit", () => {
    const points = Array.from(
      { length: MAX_PIVOTS_PER_PART },
      (_, index): [number, number, number] => [index, 1, 0],
    );

    expect(
      insertTrajectoryPivot([{ id: "one", points }], [4.5, 2, 0], 0.5),
    ).toBeNull();
  });

  it("moves a shared part endpoint without splitting the path", () => {
    const parts = [
      {
        id: "one",
        points: [
          [0, 1, 0],
          [1, 1, 0],
        ],
      },
      {
        id: "two",
        points: [
          [1, 1, 0],
          [2, 1, 0],
        ],
      },
    ] satisfies { id: string; points: [number, number, number][] }[];

    const moved = moveTrajectoryPoint(parts, "one", 1, [1, 3, -2]);

    expect(moved[0]?.points.at(-1)).toEqual([1, 3, -2]);
    expect(moved[1]?.points[0]).toEqual([1, 3, -2]);
    expect(trajectoryPathFromSegments(moved)).toEqual([
      [0, 1, 0],
      [1, 3, -2],
      [2, 1, 0],
    ]);
    expect(parts[0]?.points.at(-1)).toEqual([1, 1, 0]);
  });

  it("numbers shared pivots once for the viewer and camera picker", () => {
    const pivots = trajectoryPivotsFromSegments([
      {
        id: "one",
        points: [
          [0, 1, 0],
          [1, 1, 0],
        ],
      },
      {
        id: "two",
        points: [
          [1, 1, 0],
          [2, 1, 0],
        ],
        quaternions: [[0, 0, 0, 1], null],
      },
    ]);

    expect(pivots.map((pivot) => pivot.pivotNumber)).toEqual([1, 2, 3]);
    expect(pivots[1]).toMatchObject({
      segmentId: "one",
      pointIndex: 1,
      position: [1, 1, 0],
      hasCameraAngle: true,
    });
  });

  it("sets the same manual angle on both copies of a shared pivot", () => {
    const parts: TrajectorySegment[] = [
      {
        id: "one",
        points: [
          [0, 1, 0],
          [1, 1, 0],
        ],
      },
      {
        id: "two",
        points: [
          [1, 1, 0],
          [2, 1, 0],
        ],
      },
    ];
    const angle = new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(-0.2, 0.8, 0))
      .toArray();

    const updated = setTrajectoryPointQuaternion(parts, "one", 1, angle);

    expect(
      Math.abs(
        new THREE.Quaternion(...updated[0]!.quaternions![1]!).dot(
          new THREE.Quaternion(...angle),
        ),
      ),
    ).toBeCloseTo(1);
    expect(updated[1]?.quaternions?.[0]).toEqual(updated[0]?.quaternions?.[1]);
    expect(updated[0]?.quaternions?.[0]).toBeNull();
    expect(parts[0]?.quaternions).toBeUndefined();
  });

  it("interpolates only the manual angle keys across path pivots", () => {
    const forward: [number, number, number, number] = [0, 0, 0, 1];
    const left = new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
      .toArray();
    const views = cameraViewsFromSegments(
      [
        {
          id: "one",
          points: [
            [0, 1, 0],
            [1, 1, 0],
            [2, 1, 0],
          ],
          quaternions: [forward, null, left],
        },
      ],
      START,
    );

    const samples = sampleCameraPath(views, 3);
    const middle = new THREE.Quaternion(...samples[1]!.quaternion);
    expect(middle.angleTo(new THREE.Quaternion(...forward))).toBeCloseTo(
      Math.PI / 4,
    );
    expect(samples[0]?.quaternion).toEqual(forward);
    expect(samples[2]?.quaternion).toEqual(left);
  });

  it("starts an unset pivot camera at its interpolated angle", () => {
    const forward: [number, number, number, number] = [0, 0, 0, 1];
    const left = new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
      .toArray();
    const views = cameraViewsFromSegments(
      [
        {
          id: "one",
          points: [
            [0, 1, 0],
            [1, 1, 0],
            [2, 1, 0],
          ],
          quaternions: [forward, null, left],
        },
      ],
      START,
    );

    expect(
      new THREE.Quaternion(...cameraQuaternionAtView(views, 1)).angleTo(
        new THREE.Quaternion(...forward),
      ),
    ).toBeCloseTo(Math.PI / 4);
  });

  it("uses positive yaw to look right without adding roll", () => {
    const quaternion = cameraQuaternionFromAim(45, 0);
    const rotated = new THREE.Quaternion(...quaternion);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(rotated);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(rotated);

    expect(forward.x).toBeCloseTo(Math.SQRT1_2);
    expect(right.y).toBeCloseTo(0);
    const aim = cameraAimDegrees(quaternion);
    expect(aim.yaw).toBeCloseTo(45);
    expect(aim.pitch).toBeCloseTo(0);
  });

  it("clamps pitch before the camera flips", () => {
    const quaternion = cameraQuaternionFromAim(0, 10_000);
    const rotated = new THREE.Quaternion(...quaternion);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(rotated);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(rotated);

    expect(forward.y).toBeGreaterThan(0.999);
    expect(forward.z).toBeLessThan(0);
    expect(right.y).toBeCloseTo(0);
    expect(cameraAimDegrees(quaternion).pitch).toBeCloseTo(89);
  });

  it("holds one manual angle across the full path", () => {
    const angle = new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(-0.3, 1.1, 0))
      .toArray();
    const views = cameraViewsFromSegments(
      [
        {
          id: "one",
          points: [
            [0, 1, 0],
            [2, 4, -3],
            [5, 2, 1],
          ],
          quaternions: [null, angle, null],
        },
      ],
      START,
    );

    for (const view of sampleCameraPath(views, 17)) {
      expect(
        Math.abs(
          new THREE.Quaternion(...view.quaternion).dot(
            new THREE.Quaternion(...angle),
          ),
        ),
      ).toBeCloseTo(1);
    }
  });

  it("does not turn an unset pivot into an angle key", () => {
    const forward: [number, number, number, number] = [0, 0, 0, 1];
    const left = new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
      .toArray();
    const direct = cameraViewsFromSegments(
      [
        {
          id: "direct",
          points: [
            [0, 1, 0],
            [10, 1, 0],
          ],
          quaternions: [forward, left],
        },
      ],
      START,
    );
    const withUnsetPivot = cameraViewsFromSegments(
      [
        {
          id: "with-pivot",
          points: [
            [0, 1, 0],
            [0.1, 1, 0],
            [10, 1, 0],
          ],
          quaternions: [forward, null, left],
        },
      ],
      START,
    );
    const directSamples = sampleCameraPath(direct, 21);
    const pivotSamples = sampleCameraPath(withUnsetPivot, 21);

    directSamples.forEach((sample, index) => {
      expect(
        new THREE.Quaternion(...sample.quaternion).angleTo(
          new THREE.Quaternion(...pivotSamples[index]!.quaternion),
        ),
      ).toBeCloseTo(0);
    });
  });

  it("does not move an unrelated part across a deleted-path gap", () => {
    const parts = [
      {
        id: "one",
        points: [
          [0, 1, 0],
          [1, 1, 0],
        ],
      },
      {
        id: "three",
        points: [
          [2, 1, 0],
          [3, 1, 0],
        ],
      },
    ] satisfies { id: string; points: [number, number, number][] }[];

    const moved = moveTrajectoryPoint(parts, "one", 1, [1, 3, -2]);

    expect(moved[0]?.points.at(-1)).toEqual([1, 3, -2]);
    expect(moved[1]?.points[0]).toEqual([2, 1, 0]);
  });

  it("keeps downstream anchors when an earlier path part is deleted", () => {
    const parts = [
      {
        id: "one",
        points: [
          [0, 1, 0],
          [1, 1, 0],
        ],
      },
      {
        id: "two",
        points: [
          [1, 1, 0],
          [2, 1, 0],
        ],
      },
      {
        id: "three",
        points: [
          [2, 1, 0],
          [3, 1, 0],
        ],
      },
    ] satisfies { id: string; points: [number, number, number][] }[];

    expect(trajectoryPathFromSegments(parts.slice(1))).toEqual([
      [1, 1, 0],
      [2, 1, 0],
      [3, 1, 0],
    ]);
    expect(
      trajectoryPathFromSegments(parts.filter((part) => part.id !== "two")),
    ).toEqual([
      [0, 1, 0],
      [1, 1, 0],
      [2, 1, 0],
      [3, 1, 0],
    ]);
  });

  it("projects a point using the main camera angle", () => {
    const point: [number, number, number] = [5, 4, -2];

    expect(projectTrajectoryPoint(point, FRONT_VIEW, SPACE)).toEqual([
      0.75, 0.3,
    ]);
    expect(projectTrajectoryPoint(point, TURNED_VIEW, SPACE)).not.toEqual([
      0.75, 0.3,
    ]);
  });

  it("round-trips a point through an arbitrary drawing angle", () => {
    const point: [number, number, number] = [5, 4, -2];
    const roundTrip = unprojectTrajectoryPoint(
      projectTrajectoryPoint(point, TURNED_VIEW, SPACE),
      TURNED_VIEW,
      SPACE,
      point,
    );

    expect(roundTrip[0]).toBeCloseTo(point[0]);
    expect(roundTrip[1]).toBeCloseTo(point[1]);
    expect(roundTrip[2]).toBeCloseTo(point[2]);
  });

  it("frames the floor near the bottom without changing world scale", () => {
    const frontSpace = frameTrajectorySpaceAboveFloor(
      SPACE,
      FRONT_VIEW,
      START.position,
    );
    const frontBoundary = trajectoryFloorBoundary(
      FRONT_VIEW,
      frontSpace,
      START.position,
    )!;
    const turnedSpace = frameTrajectorySpaceAboveFloor(
      SPACE,
      TURNED_VIEW,
      START.position,
    );
    const turnedBoundary = trajectoryFloorBoundary(
      TURNED_VIEW,
      turnedSpace,
      START.position,
    )!;

    expect(frontSpace.radius).toBe(SPACE.radius);
    expect(Math.max(frontBoundary[0][1], frontBoundary[1][1])).toBeCloseTo(
      0.94,
    );
    expect(Math.max(turnedBoundary[0][1], turnedBoundary[1][1])).toBeCloseTo(
      0.94,
    );
    expect(
      frameTrajectorySpaceAboveFloor(SPACE, FRONT_VIEW, START.position, true),
    ).toBe(SPACE);
  });

  it("recenters a far path endpoint before framing the floor", () => {
    const anchor: [number, number, number] = [20, 0, 0];
    const framedSpace = frameTrajectorySpaceAboveFloor(
      SPACE,
      FRONT_VIEW,
      anchor,
    );
    const projectedAnchor = projectTrajectoryPoint(
      anchor,
      FRONT_VIEW,
      framedSpace,
    );

    expect(projectedAnchor[0]).toBeCloseTo(0.5);
    expect(projectedAnchor[1]).toBeCloseTo(0.94);
  });

  it("keeps a high path endpoint visible when the floor cannot fit", () => {
    const anchor: [number, number, number] = [0, 19, 0];
    const framedSpace = frameTrajectorySpaceAboveFloor(
      SPACE,
      FRONT_VIEW,
      anchor,
    );
    const projectedAnchor = projectTrajectoryPoint(
      anchor,
      FRONT_VIEW,
      framedSpace,
    );
    const floorBoundary = trajectoryFloorBoundary(
      FRONT_VIEW,
      framedSpace,
      anchor,
    )!;

    expect(framedSpace.radius).toBe(SPACE.radius);
    expect(projectedAnchor[1]).toBeCloseTo(0.06);
    expect(Math.max(floorBoundary[0][1], floorBoundary[1][1])).toBeGreaterThan(
      0.94,
    );
  });

  it("leaves the drawing space unchanged when the floor is nearly edge-on", () => {
    const nearOverheadView: TrajectoryDrawingView = {
      right: [1, 0, 0],
      up: [0, 0.05, -Math.sqrt(1 - 0.05 ** 2)],
      forward: [0, Math.sqrt(1 - 0.05 ** 2), 0.05],
    };

    expect(
      frameTrajectorySpaceAboveFloor(SPACE, nearOverheadView, START.position),
    ).toBe(SPACE);
    expect(
      trajectoryFloorBoundary(nearOverheadView, SPACE, START.position),
    ).toBeNull();
  });

  it("preserves depth when a stroke continues from a rotated main view", () => {
    const existing: [number, number, number][] = [[4, 2, -6]];
    const continued = appendDrawnTrajectory(
      existing,
      [projectTrajectoryPoint(existing[0]!, TURNED_VIEW, SPACE), [0.8, 0.2]],
      TURNED_VIEW,
      SPACE,
      START.position,
    );
    const forward = new THREE.Vector3(...TURNED_VIEW.forward);

    expect(new THREE.Vector3(...continued.at(-1)!).dot(forward)).toBeCloseTo(
      new THREE.Vector3(...existing[0]!).dot(forward),
    );
  });

  it("lets the first drawn point differ from the reference camera", () => {
    const path = appendDrawnTrajectory(
      [],
      [
        [0, 0],
        [1, 1],
      ],
      FRONT_VIEW,
      SPACE,
      START.position,
    );

    expect(path[0]).toEqual([-10, 10, 4]);
    expect(path[0]).not.toEqual(START.position);
  });

  it("keeps earlier points when the main camera rotates between strokes", () => {
    const firstPath = appendDrawnTrajectory(
      [],
      [
        [0.5, 0.5],
        [0.6, 0.4],
      ],
      FRONT_VIEW,
      SPACE,
      START.position,
    );
    const finalPath = appendDrawnTrajectory(
      firstPath,
      [
        projectTrajectoryPoint(firstPath.at(-1)!, TURNED_VIEW, SPACE),
        [0.7, 0.3],
      ],
      TURNED_VIEW,
      SPACE,
      START.position,
    );

    expect(finalPath.slice(0, firstPath.length)).toEqual(firstPath);
  });

  it("reduces a dense drawn stroke to a few spline controls", () => {
    const stroke = Array.from({ length: 101 }, (_, index) => {
      const progress = index / 100;
      return [progress, 0.5 - Math.sin(progress * Math.PI) * 0.2] as [
        number,
        number,
      ];
    });

    const path = appendDrawnTrajectory(
      [],
      stroke,
      FRONT_VIEW,
      SPACE,
      START.position,
    );

    expect(path).toHaveLength(5);
    expect(path[0]).toEqual([-10, 0, 4]);
    expect(path.at(-1)).toEqual([10, 0, 4]);
  });

  it("clamps vertical drawing and spline output to the floor", () => {
    expect(
      unprojectTrajectoryPoint([0.5, 1], FRONT_VIEW, SPACE, START.position)[1],
    ).toBe(0);
    expect(trajectoryFloorBoundary(FRONT_VIEW, SPACE, START.position)).toEqual([
      [0, 0.5],
      [1, 0.5],
    ]);
    const turnedBoundary = trajectoryFloorBoundary(
      TURNED_VIEW,
      SPACE,
      START.position,
    )!;
    for (const point of turnedBoundary) {
      expect(
        unprojectTrajectoryPoint(point, TURNED_VIEW, SPACE, START.position)[1],
      ).toBeCloseTo(0);
    }
    const samples = sampleCameraPath(
      [
        { ...START, position: [0, 1, 0] },
        { ...START, position: [1, 0, 0] },
        { ...START, position: [2, 0, 0] },
        { ...END, position: [3, 1, 0] },
      ],
      101,
    );
    expect(samples.every((sample) => sample.position[1] >= 0)).toBe(true);
  });

  it("preserves an underwater stroke through preview and generation", () => {
    const path = appendDrawnTrajectory(
      [],
      [
        [0.5, 0.4],
        [0.5, 0.8],
      ],
      FRONT_VIEW,
      SPACE,
      START.position,
      true,
    );
    const views = cameraViewsFromTrajectory(path, START, true);
    const samples = sampleCameraPath(views, 9, { allowBelowFloor: true });
    const cameras = buildTargetCameras(views, 9, 1280, 720, {
      allowBelowFloor: true,
    });

    expect(path.at(-1)?.[1]).toBeLessThan(0);
    expect(samples.at(-1)?.position[1]).toBe(path.at(-1)?.[1]);
    expect(cameras.at(-1)?.extrinsics.position[1]).toBe(path.at(-1)?.[1]);
    expect(cameraViewsFromTrajectory(path, START).at(-1)?.position[1]).toBe(0);
  });

  it("checks look targets against the underwater path", () => {
    const views = [
      { ...START, position: [-1, -2, 0] as [number, number, number] },
      { ...END, position: [1, -2, 0] as [number, number, number] },
    ];
    const target: [number, number, number] = [0, -2, 0];

    expect(cameraTargetIsClearOfPath(views, target, false, 0.05)).toBe(true);
    expect(
      cameraTargetIsClearOfPath(views, target, false, 0.05, undefined, true),
    ).toBe(false);
  });

  it("keeps the reference angle until manual pivot angles are set", () => {
    const path: [number, number, number][] = [
      [-10, 2, -10],
      [0, 5, 0],
      [10, 3, 10],
    ];
    const views = cameraViewsFromTrajectory(path, START);

    expect(views).toHaveLength(3);
    expect(views[0]?.position).toEqual([-10, 2, -10]);
    expect(views.at(-1)?.position).toEqual([10, 3, 10]);
    for (const view of views) {
      expect(view.quaternion).toEqual(START.quaternion);
    }
  });

  it("derives the drawing plane from the main camera quaternion", () => {
    const drawingView = cameraDrawingView(START.quaternion);

    expect(drawingView).toEqual({
      right: [1, 0, 0],
      up: [0, 1, 0],
      forward: [0, 0, -1],
    });
  });

  it("ignores a trajectory with only one point", () => {
    expect(cameraViewsFromTrajectory([[0, 1, 0]], START)).toEqual([]);
  });
});
