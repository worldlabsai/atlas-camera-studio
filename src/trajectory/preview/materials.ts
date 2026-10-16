import * as THREE from "three";

// Shaders for the filled preview cloud. Every vertex is a sample seen along a
// ray from the source camera. The cloud's group sits at that camera, so the
// object origin (modelMatrix[3]) is the ray origin and `world - origin` is the
// source ray. Comparing it with the current view ray says how far the view
// has moved from what the photo saw. All outputs are premultiplied linear
// colour for the offscreen cloud layer.

/** Degrees of view-ray deviation where softening begins and is complete. */
export const DEVIATION_START_DEGREES = 3;
export const DEVIATION_END_DEGREES = 65;

const deviationChunk = /* glsl */ `
float viewDeviation(vec3 sourceRay, vec3 viewRay) {
  float cosine = dot(normalize(sourceRay), normalize(viewRay));
  float angle = degrees(acos(clamp(cosine, -1.0, 1.0)));
  return smoothstep(${DEVIATION_START_DEGREES.toFixed(1)}, ${DEVIATION_END_DEGREES.toFixed(1)}, angle);
}
`;

// Points: on-axis they are today's square sprites. Deviated sprites grow to
// cover the gaps their neighbours leave, turn into gaussian discs, and fade so
// the fill pass blends them into one soft surface.
const POINT_GROWTH = 2.2;
const POINT_MIN_ALPHA = 0.5;

export function createPointMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: "PreviewCloudPoints",
    uniforms: {
      uSize: { value: 0.01 },
      uScale: { value: 1 },
    },
    vertexColors: true,
    toneMapped: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    vertexShader: /* glsl */ `
      uniform float uSize;
      uniform float uScale;
      varying vec3 vColor;
      varying float vDeviation;
      ${deviationChunk}
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vec4 mvPosition = viewMatrix * world;
        gl_Position = projectionMatrix * mvPosition;
        vDeviation = viewDeviation(world.xyz - modelMatrix[3].xyz, world.xyz - cameraPosition);
        vColor = color;
        // Same attenuation as PointsMaterial with sizeAttenuation.
        gl_PointSize = uSize * (uScale / -mvPosition.z) * (1.0 + ${POINT_GROWTH.toFixed(2)} * vDeviation);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying float vDeviation;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot(p, p);
        float disc = r2 < 1.0 ? exp(-2.5 * r2) : 0.0;
        float alpha = mix(1.0, disc, vDeviation) * mix(1.0, ${POINT_MIN_ALPHA.toFixed(2)}, vDeviation);
        if (alpha < 0.04) discard;
        gl_FragColor = vec4(vColor * alpha, alpha);
      }
    `,
  });
}

// Textured surface: crisp near the source view. It fades with deviation, and
// where the current view sees it much more edge-on than the photo did, since
// that texture is then compressed or smeared. The fill pass takes over there.
const SURFACE_DEVIATION_FADE = 0.4;

export function createSurfaceMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: "PreviewCloudSurface",
    uniforms: { map: { value: null } },
    side: THREE.DoubleSide,
    toneMapped: false,
    // Coincident points win the depth test, as in the raw preview.
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorld;
      varying vec3 vSourceRay;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vSourceRay = world.xyz - modelMatrix[3].xyz;
        vUv = uv;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      varying vec2 vUv;
      varying vec3 vWorld;
      varying vec3 vSourceRay;
      ${deviationChunk}
      void main() {
        vec3 viewRay = vWorld - cameraPosition;
        vec3 normal = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
        float seenNow = abs(dot(normal, normalize(viewRay)));
        float seenThen = abs(dot(normal, normalize(vSourceRay)));
        // 1 when this view is no more edge-on than the photo was.
        float foreshortening = smoothstep(0.12, 0.5, seenNow / max(seenThen, 1e-3));
        float alpha = (1.0 - ${SURFACE_DEVIATION_FADE.toFixed(2)} * viewDeviation(vSourceRay, viewRay)) * foreshortening;
        if (alpha < 0.04) discard;
        vec4 texel = texture2D(map, vUv);
        gl_FragColor = vec4(texel.rgb * alpha, alpha);
      }
    `,
  });
}

// Stretch glow: rejected triangles across depth gaps, drawn untextured. Large
// depth ratios carry less confidence, so alpha falls off with the
// far-to-near ratio. A slow, faint shimmer marks the glow as provisional.
// It is drawn at reduced resolution into the fill pass only, which blurs it.
const GLOW_ALPHA = 0.75;
const GLOW_RATIO_FALLOFF = 2.5;
const SHIMMER_AMPLITUDE = 0.12;

export function createGlowMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: "PreviewCloudGlow",
    uniforms: {
      uTime: { value: 0 },
      uNoiseFrequency: { value: 1 },
      uCloudDepth: { value: null },
      uInverseSize: { value: new THREE.Vector2(1, 1) },
      uNear: { value: 0.01 },
      uFar: { value: 1000 },
    },
    vertexColors: true,
    toneMapped: false,
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    vertexShader: /* glsl */ `
      attribute float stretch;
      varying vec3 vColor;
      varying vec3 vLocal;
      varying float vStretch;
      varying float vViewZ;
      varying float vDeviation;
      ${deviationChunk}
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vec4 mvPosition = viewMatrix * world;
        gl_Position = projectionMatrix * mvPosition;
        vViewZ = mvPosition.z;
        vColor = color;
        vLocal = position;
        vStretch = stretch;
        vDeviation = viewDeviation(world.xyz - modelMatrix[3].xyz, world.xyz - cameraPosition);
      }
    `,
    fragmentShader: /* glsl */ `
      #include <packing>
      uniform float uTime;
      uniform float uNoiseFrequency;
      uniform sampler2D uCloudDepth;
      uniform vec2 uInverseSize;
      uniform float uNear;
      uniform float uFar;
      varying vec3 vColor;
      varying vec3 vLocal;
      varying float vStretch;
      varying float vViewZ;
      varying float vDeviation;

      float hash(vec3 p) {
        p = fract(p * 0.3183099 + 0.1);
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }
      float valueNoise(vec3 p) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x),
              mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
          mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x),
              mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
          f.z);
      }

      void main() {
        // The real cloud occludes the glow. Compare view depths with a small
        // tolerance because this pass runs at a lower resolution.
        float cloudDepth = texture2D(uCloudDepth, gl_FragCoord.xy * uInverseSize).r;
        if (cloudDepth < 1.0 &&
            -vViewZ > -perspectiveDepthToViewZ(cloudDepth, uNear, uFar) * 1.003) discard;
        float shimmer = 1.0 + ${SHIMMER_AMPLITUDE.toFixed(2)} *
          (2.0 * valueNoise(vLocal * uNoiseFrequency + vec3(0.0, 0.0, uTime * 0.25)) - 1.0);
        // Curtains are edge-on from the source view; show them only once
        // the view has moved enough to open the gap they bridge.
        float opened = smoothstep(0.0, 0.08, vDeviation);
        float alpha = ${GLOW_ALPHA.toFixed(2)} * opened * shimmer /
          (1.0 + ${GLOW_RATIO_FALLOFF.toFixed(1)} * (vStretch - 1.0));
        gl_FragColor = vec4(vColor * alpha, alpha);
      }
    `,
  });
}

/** One unshared vertex per stretched-triangle corner, carrying the
 * triangle's far-to-near source depth ratio. Positions are camera-local,
 * so depth along the source view is -z. */
export function buildGlowGeometry(
  positions: Float32Array,
  colors: Float32Array,
  stretchIndices: Uint32Array,
): THREE.BufferGeometry | null {
  const count = stretchIndices.length;
  if (!count) return null;
  const glowPositions = new Float32Array(count * 3);
  const glowColors = new Float32Array(count * 3);
  const stretch = new Float32Array(count);
  for (let t = 0; t < count; t += 3) {
    let near = Infinity,
      far = 0;
    for (let k = 0; k < 3; k++) {
      const source = stretchIndices[t + k]! * 3,
        target = (t + k) * 3;
      for (let axis = 0; axis < 3; axis++) {
        glowPositions[target + axis] = positions[source + axis]!;
        glowColors[target + axis] = colors[source + axis]!;
      }
      const depth = -positions[source + 2]!;
      near = Math.min(near, depth);
      far = Math.max(far, depth);
    }
    const ratio = near > 0 ? far / near : 1;
    stretch[t] = stretch[t + 1] = stretch[t + 2] = ratio;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(glowPositions, 3),
  );
  geometry.setAttribute("color", new THREE.BufferAttribute(glowColors, 3));
  geometry.setAttribute("stretch", new THREE.BufferAttribute(stretch, 1));
  return geometry;
}
