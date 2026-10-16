/**
 * Point-cloud preview of the source image.
 *
 * Points mode (`fill={false}`) draws the measured points and textured depth
 * surface directly, as before.
 *
 * Filled mode treats the cloud as a soft layer that the video model will
 * complete. It takes over the frame with a positive-priority useFrame:
 *   1. Points and the textured surface (layer CLOUD_LAYER) render into a
 *      full-resolution offscreen target with depth: premultiplied linear
 *      RGBA. Their shaders fade and soften what the current view sees from
 *      far off the source camera's rays.
 *   2. Stretched triangles across rejected depth gaps (GLOW_LAYER) render at
 *      half resolution, occluded by the cloud depth texture.
 *   3. A five-level push-pull pyramid fills low-coverage pixels from coarser
 *      levels, with the glow under the cloud at its base. Fill opacity is
 *      capped per level, so small gaps close and large voids fade out.
 *   4. A full-screen pass clears the canvas, composites the result over the
 *      clear colour, and writes the cloud's depth where it is mostly opaque.
 *   5. The rest of the scene renders on top without clearing. Grid, frusta
 *      and markers depth-test against the cloud; paths keep drawing on top.
 * No environment is drawn behind the cloud; uncovered pixels stay clear.
 */
import { Suspense, useEffect, useLayoutEffect, useMemo } from "react";
import { useTexture } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { PosedView } from "./pose";
import {
  buildGlowGeometry,
  createGlowMaterial,
  createPointMaterial,
  createSurfaceMaterial,
} from "./preview/materials";
import { CLOUD_LAYER, GLOW_LAYER, PreviewFill } from "./preview/push-pull";

export function PosedPointCloud({
  pose,
  scaleMultiplier,
  fill = true,
}: {
  pose: PosedView;
  scaleMultiplier: number;
  fill?: boolean;
}) {
  const { pointGeometry, surfaceGeometry } = useMemo(() => {
    // Both geometries reference the same position/color buffers; nothing
    // large is copied.
    const position = new THREE.BufferAttribute(pose.points.positions, 3);
    const color = new THREE.BufferAttribute(pose.points.colors, 3);
    const pointGeometry = new THREE.BufferGeometry();
    pointGeometry.setAttribute("position", position);
    pointGeometry.setAttribute("color", color);

    const surface = pose.points;
    let surfaceGeometry: THREE.BufferGeometry | null = null;
    if (surface.indices.length) {
      surfaceGeometry = new THREE.BufferGeometry();
      surfaceGeometry.setAttribute("position", position);
      surfaceGeometry.setAttribute(
        "uv",
        new THREE.BufferAttribute(surface.uvs, 2),
      );
      surfaceGeometry.setIndex(new THREE.BufferAttribute(surface.indices, 1));
    }
    return { pointGeometry, surfaceGeometry };
  }, [pose]);

  useEffect(
    () => () => {
      pointGeometry.dispose();
      surfaceGeometry?.dispose();
    },
    [pointGeometry, surfaceGeometry],
  );

  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => invalidate(), [fill, invalidate]);

  return (
    <group
      position={pose.camera.extrinsics.position}
      quaternion={pose.camera.extrinsics.quaternion}
    >
      {fill ? (
        <FilledCloud
          pose={pose}
          scaleMultiplier={scaleMultiplier}
          pointGeometry={pointGeometry}
          surfaceGeometry={surfaceGeometry}
        />
      ) : (
        <>
          {/* Colored points stay visible for mesh edges and unmeshed areas; the
              surface is biased back so coincident points win the depth test. */}
          <points geometry={pointGeometry}>
            <pointsMaterial
              vertexColors
              size={pose.points.pointSize * scaleMultiplier}
              sizeAttenuation
              toneMapped={false}
            />
          </points>
          {surfaceGeometry && (
            <Suspense fallback={null}>
              <PosedSurface
                geometry={surfaceGeometry}
                imageUrl={pose.imageUrl}
              />
            </Suspense>
          )}
        </>
      )}
    </group>
  );
}

function PosedSurface({
  geometry,
  imageUrl,
}: {
  geometry: THREE.BufferGeometry;
  imageUrl: string;
}) {
  const texture = useTexture(imageUrl);
  texture.colorSpace = THREE.SRGBColorSpace;
  return (
    <mesh geometry={geometry} raycast={() => null}>
      <meshBasicMaterial
        map={texture}
        side={THREE.DoubleSide}
        toneMapped={false}
        polygonOffset
        polygonOffsetFactor={1}
        polygonOffsetUnits={1}
      />
    </mesh>
  );
}

const CLOUD_MASK = 1 << CLOUD_LAYER;
const GLOW_MASK = 1 << GLOW_LAYER;

function FilledCloud({
  pose,
  scaleMultiplier,
  pointGeometry,
  surfaceGeometry,
}: {
  pose: PosedView;
  scaleMultiplier: number;
  pointGeometry: THREE.BufferGeometry;
  surfaceGeometry: THREE.BufferGeometry | null;
}) {
  const gl = useThree((state) => state.gl);
  const materials = useMemo(
    () => ({
      point: createPointMaterial(),
      surface: createSurfaceMaterial(),
      glow: createGlowMaterial(),
    }),
    [],
  );
  const glowGeometry = useMemo(
    () =>
      buildGlowGeometry(
        pose.points.positions,
        pose.points.colors,
        pose.points.stretchIndices,
      ),
    [pose],
  );
  const fill = useMemo(() => new PreviewFill(gl), [gl]);

  useEffect(
    () => () => {
      materials.point.dispose();
      materials.surface.dispose();
      materials.glow.dispose();
    },
    [materials],
  );
  useEffect(() => () => glowGeometry?.dispose(), [glowGeometry]);
  useEffect(() => () => fill.dispose(), [fill]);

  const pointSize = pose.points.pointSize;
  useEffect(() => {
    materials.point.uniforms.uSize!.value = pointSize * scaleMultiplier;
    // Shimmer cells of about 25 point spacings, whatever the scene scale.
    materials.glow.uniforms.uNoiseFrequency!.value = 1 / (pointSize * 25);
  }, [materials, pointSize, scaleMultiplier]);

  const drawingBuffer = useMemo(() => new THREE.Vector2(), []);
  // Priority 1 runs after camera updates and replaces R3F's own render.
  useFrame(({ gl: renderer, scene, camera, clock }) => {
    renderer.getDrawingBufferSize(drawingBuffer);
    fill.setSize(drawingBuffer.x, drawingBuffer.y);
    materials.point.uniforms.uScale!.value = drawingBuffer.y * 0.5;
    const glow = materials.glow.uniforms;
    glow.uTime!.value = clock.elapsedTime;
    glow.uCloudDepth!.value = fill.cloudDepth;
    glow.uInverseSize!.value.set(1 / fill.glow.width, 1 / fill.glow.height);
    if (camera instanceof THREE.PerspectiveCamera) {
      glow.uNear!.value = camera.near;
      glow.uFar!.value = camera.far;
    }
    fill.render(renderer, scene, camera);
  }, 1);

  return (
    <>
      {surfaceGeometry && (
        <Suspense fallback={null}>
          <FilledSurface
            geometry={surfaceGeometry}
            imageUrl={pose.imageUrl}
            material={materials.surface}
          />
        </Suspense>
      )}
      {/* Drawn after the surface so translucent sprite edges blend over it. */}
      <points
        geometry={pointGeometry}
        material={materials.point}
        layers-mask={CLOUD_MASK}
        renderOrder={1}
      />
      {glowGeometry && (
        <mesh
          geometry={glowGeometry}
          material={materials.glow}
          layers-mask={GLOW_MASK}
          raycast={() => null}
        />
      )}
    </>
  );
}

function FilledSurface({
  geometry,
  imageUrl,
  material,
}: {
  geometry: THREE.BufferGeometry;
  imageUrl: string;
  material: THREE.ShaderMaterial;
}) {
  const texture = useTexture(imageUrl);
  texture.colorSpace = THREE.SRGBColorSpace;
  const invalidate = useThree((state) => state.invalidate);
  useLayoutEffect(() => {
    material.uniforms.map!.value = texture;
    invalidate();
  }, [material, texture, invalidate]);
  return (
    <mesh
      geometry={geometry}
      material={material}
      layers-mask={CLOUD_MASK}
      raycast={() => null}
    />
  );
}
