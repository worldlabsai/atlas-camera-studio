import { useEffect, useMemo } from "react";
import * as THREE from "three";
import type { PosedCamera } from "./common";

const FRUSTUM_COLOR = "#2383E2";

/** Draws after the scene, and so over it, for anything asking to stay visible. */
export const OVERLAY_RENDER_ORDER = 10;

/** How much of the way to the subject a camera reaches when it is not the one being looked at. */
const IDLE_DEPTH_FRACTION = 0.1;

/** Marker sizes as fractions of the far face's width, so they follow the frustum. */
const APEX_RADIUS = 0.1;
const UP_MARKER_RADIUS = 0.18;

/**
 * A frustum for a camera standing `distance` from the subject: short enough to
 * read as a marker rather than as the shot, and floored so a camera sitting
 * almost on top of the subject still has something to draw.
 */
export function idleFrustumDepth(distance: number): number {
  return IDLE_DEPTH_FRACTION * Math.max(0.2, distance);
}

export type FrustumObjectProps = {
  camera: PosedCamera;
  color?: THREE.ColorRepresentation;
  /** How far down the view axis the far face sits. */
  depth: number;
  /** Draw over the scene instead of letting the subject occlude it. */
  overlay?: boolean;
  /**
   * Draw the solid blobs that carry the colour: one at the camera itself and
   * one over the top edge of the frame, which points the way the camera is
   * rolled. Wireframe alone is too thin to read a colour off.
   */
  markers?: boolean;
};

/** Where a photo was taken from, at the field of view its intrinsics describe. */
export function FrustumObject({
  camera,
  color = FRUSTUM_COLOR,
  depth,
  overlay = false,
  markers = true,
}: FrustumObjectProps) {
  const geometry = useMemo(
    () => buildFrustumGeometry(camera, depth),
    [camera, depth],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);

  const { fx, fy, cx, cy, width } = camera.intrinsics;
  const farWidth = (width / fx) * depth;
  const upMarkerRadius = farWidth * UP_MARKER_RADIUS;
  // Standing on the top edge: the triangle's own base sits half a radius below
  // its centre, so lifting the centre by that much rests it on the frame.
  const upMarkerY = (cy / fy) * depth + upMarkerRadius / 2;

  return (
    <group
      position={camera.extrinsics.position}
      quaternion={camera.extrinsics.quaternion}
    >
      <lineSegments
        raycast={() => undefined}
        geometry={geometry}
        renderOrder={overlay ? OVERLAY_RENDER_ORDER : 0}
      >
        <lineBasicMaterial color={color} depthTest={!overlay} />
      </lineSegments>

      {markers && (
        <>
          <mesh>
            <sphereGeometry args={[farWidth * APEX_RADIUS, 10, 8]} />
            <meshBasicMaterial color={color} />
          </mesh>

          {/* A three-segment circle is a triangle; 90 degrees about z points it
              up, which leaves its base parallel to the top edge. */}
          <mesh
            position={[((width / 2 - cx) / fx) * depth, upMarkerY, -depth]}
            rotation={[0, 0, Math.PI / 2]}
          >
            <circleGeometry args={[upMarkerRadius, 3]} />
            <meshBasicMaterial color={color} side={THREE.DoubleSide} />
          </mesh>
        </>
      )}
    </group>
  );
}

/** Frustum lines in camera-local space (-z forward). */
function buildFrustumGeometry(
  camera: PosedCamera,
  depth: number,
): THREE.BufferGeometry {
  const { fx, fy, cx, cy, width, height } = camera.intrinsics;

  const corners = (
    [
      [0, 0],
      [width, 0],
      [width, height],
      [0, height],
    ] as const
  ).map(([u, v]) => [
    ((u - cx) / fx) * depth,
    -(((v - cy) / fy) * depth),
    -depth,
  ]);

  const vertices: number[] = [];
  for (const corner of corners) vertices.push(0, 0, 0, ...corner);
  for (let i = 0; i < corners.length; i++) {
    vertices.push(...corners[i], ...corners[(i + 1) % corners.length]);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(vertices, 3),
  );
  return geometry;
}
