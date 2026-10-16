import * as THREE from "three";

/** Layers that keep the cloud out of the scene's regular overlay render. */
export const CLOUD_LAYER = 30;
export const GLOW_LAYER = 31;

// Pyramid levels below full resolution: 1/2, 1/4, ... 1/32 of the canvas.
const LEVELS = 5;
// The pull is a plain coverage-weighted average, so alpha at each level is
// the covered fraction of its footprint. The push turns coverage into fill
// confidence with a per-level ramp. On the two finest levels half coverage
// is enough: that closes pinholes between sparse sprites and dilates edges
// by about a pixel. Coarser levels need most of a texel covered. A straight
// edge covers about half of the texels it crosses, an enclosed gap far more,
// so coarse fill closes holes without haloing silhouettes.
const COVERAGE_RAMP: readonly [number, number][] = [
  [0, 0.5],
  [0, 0.5],
  [0.5, 0.9],
  [0.5, 0.9],
  [0.5, 0.9],
];
// Opacity each level's fill keeps when it is pushed into the next finer one.
// Products cap the fill: 1/2 and 1/4 levels close small gaps fully, while
// gaps only the 1/16 and 1/32 levels reach stay at ~0.7 and ~0.45 opacity.
const LEVEL_FADE = [1, 1, 0.9, 0.78, 0.62];
// The cloud writes overlay-occluding depth only where it is mostly opaque.
const DEPTH_COVERAGE = 0.3;

const quadVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Average a 4x4 block of the finer level with four bilinear taps. The first
// level lays the full-resolution cloud over the half-resolution glow.
const pullFragment = /* glsl */ `
  uniform sampler2D uSource;
  uniform sampler2D uGlow;
  uniform vec2 uSourceTexel;
  uniform bool uUseGlow;
  varying vec2 vUv;
  void main() {
    vec2 o = uSourceTexel;
    vec4 average = 0.25 * (texture2D(uSource, vUv + vec2(-o.x, -o.y))
      + texture2D(uSource, vUv + vec2(o.x, -o.y))
      + texture2D(uSource, vUv + vec2(-o.x, o.y))
      + texture2D(uSource, vUv + vec2(o.x, o.y)));
    if (uUseGlow) average += (1.0 - average.a) * texture2D(uGlow, vUv);
    gl_FragColor = average;
  }
`;

// Fill this level's gaps with the coarser fill under it.
const pushFragment = /* glsl */ `
  uniform sampler2D uPulled;
  uniform sampler2D uCoarse;
  uniform vec2 uRamp;
  uniform vec2 uCoarseRamp;
  uniform float uCoarseFade;
  uniform bool uCoarseIsPulled;
  varying vec2 vUv;
  vec4 confident(vec4 pulled, vec2 ramp) {
    float weight = smoothstep(ramp.x, ramp.y, pulled.a);
    return pulled.a > 1e-4 ? pulled * (weight / pulled.a) : vec4(0.0);
  }
  void main() {
    vec4 own = confident(texture2D(uPulled, vUv), uRamp);
    vec4 coarse = texture2D(uCoarse, vUv);
    if (uCoarseIsPulled) coarse = confident(coarse, uCoarseRamp);
    gl_FragColor = own + (1.0 - own.a) * uCoarseFade * coarse;
  }
`;

// Full-resolution composite onto the canvas. Converts to the output colour
// space on unpremultiplied colour and writes the cloud depth for overlays.
const compositeFragment = /* glsl */ `
  uniform sampler2D uCloud;
  uniform sampler2D uCloudDepth;
  uniform sampler2D uFill;
  uniform float uFillFade;
  varying vec2 vUv;
  void main() {
    vec4 cloud = texture2D(uCloud, vUv);
    vec4 result = cloud + (1.0 - cloud.a) * uFillFade * texture2D(uFill, vUv);
    gl_FragDepth = cloud.a > ${DEPTH_COVERAGE.toFixed(2)} ? texture2D(uCloudDepth, vUv).r : 1.0;
    if (result.a < 1.0 / 255.0) discard;
    vec4 colour = linearToOutputTexel(vec4(result.rgb / result.a, 1.0));
    gl_FragColor = vec4(colour.rgb * result.a, result.a);
  }
`;

const premultipliedBlend = {
  blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor,
  blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
} as const;

function target(
  type: THREE.TextureDataType,
  depthTexture?: THREE.DepthTexture,
): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(1, 1, {
    type,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer: Boolean(depthTexture),
    // RenderTarget's depthTexture setter rejects an explicit undefined.
    ...(depthTexture && { depthTexture }),
    colorSpace: THREE.LinearSRGBColorSpace,
  });
}

/** Offscreen cloud layer, its push-pull fill pyramid, and the composite. */
export class PreviewFill {
  readonly cloud: THREE.WebGLRenderTarget;
  readonly cloudDepth: THREE.DepthTexture;
  /** Half-resolution glow layer; it only feeds the fill. */
  readonly glow: THREE.WebGLRenderTarget;
  private readonly pulled: THREE.WebGLRenderTarget[];
  private readonly pushed: THREE.WebGLRenderTarget[];
  private readonly pull: THREE.ShaderMaterial;
  private readonly push: THREE.ShaderMaterial;
  private readonly composite: THREE.ShaderMaterial;
  private readonly quad: THREE.Mesh;
  private readonly quadCamera = new THREE.Camera();
  private readonly clearColor = new THREE.Color();
  private width = 0;
  private height = 0;

  constructor(renderer: THREE.WebGLRenderer) {
    // RGBA16F is renderable and filterable on WebGL2 with
    // EXT_color_buffer_float; 8-bit keeps working, with darker banding.
    const type = renderer.extensions.has("EXT_color_buffer_float")
      ? THREE.HalfFloatType
      : THREE.UnsignedByteType;
    this.cloudDepth = new THREE.DepthTexture(1, 1);
    this.cloudDepth.minFilter = this.cloudDepth.magFilter =
      THREE.NearestFilter;
    // Linear filtering serves the pull taps; the composite samples texel
    // centres, where it returns the exact pixel.
    this.cloud = target(type, this.cloudDepth);
    this.glow = target(type);
    this.pulled = Array.from({ length: LEVELS }, () => target(type));
    this.pushed = Array.from({ length: LEVELS - 1 }, () => target(type));

    const pass = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({
        vertexShader: quadVertex,
        fragmentShader,
        uniforms,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        blending: THREE.NoBlending,
      });
    this.pull = pass(pullFragment, {
      uSource: { value: null },
      uGlow: { value: this.glow.texture },
      uSourceTexel: { value: new THREE.Vector2() },
      uUseGlow: { value: false },
    });
    this.push = pass(pushFragment, {
      uPulled: { value: null },
      uCoarse: { value: null },
      uRamp: { value: new THREE.Vector2() },
      uCoarseRamp: { value: new THREE.Vector2() },
      uCoarseFade: { value: 1 },
      uCoarseIsPulled: { value: false },
    });
    this.composite = pass(compositeFragment, {
      uCloud: { value: this.cloud.texture },
      uCloudDepth: { value: this.cloudDepth },
      uFill: { value: this.pushed[0]!.texture },
      uFillFade: { value: LEVEL_FADE[0] },
    });
    Object.assign(this.composite, premultipliedBlend, {
      depthTest: true,
      depthWrite: true,
      depthFunc: THREE.AlwaysDepth,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.pull);
    this.quad.frustumCulled = false;
  }

  /** Match the drawing buffer; call every frame, it is a no-op when unchanged. */
  setSize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.cloud.setSize(width, height);
    let w = width,
      h = height;
    for (let level = 0; level < LEVELS; level++) {
      w = Math.max(1, Math.ceil(w / 2));
      h = Math.max(1, Math.ceil(h / 2));
      this.pulled[level]!.setSize(w, h);
      this.pushed[level]?.setSize(w, h);
      if (level === 0) this.glow.setSize(w, h);
    }
  }

  /**
   * Render the cloud and glow layers offscreen, build the fill, composite
   * it over a freshly cleared canvas, then render the rest of the scene.
   */
  render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ) {
    const mask = camera.layers.mask;
    const autoClear = renderer.autoClear;
    const alpha = renderer.getClearAlpha();
    renderer.getClearColor(this.clearColor);
    renderer.autoClear = false;
    renderer.setClearColor(0x000000, 0);

    camera.layers.set(CLOUD_LAYER);
    renderer.setRenderTarget(this.cloud);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);

    camera.layers.set(GLOW_LAYER);
    renderer.setRenderTarget(this.glow);
    renderer.clear(true, false, false);
    renderer.render(scene, camera);
    camera.layers.mask = mask;

    this.quad.material = this.pull;
    const pull = this.pull.uniforms;
    for (let level = 0; level < LEVELS; level++) {
      const source = level === 0 ? this.cloud : this.pulled[level - 1]!;
      pull.uSource!.value = source.texture;
      pull.uSourceTexel!.value.set(1 / source.width, 1 / source.height);
      pull.uUseGlow!.value = level === 0;
      this.draw(renderer, this.pulled[level]!);
    }

    this.quad.material = this.push;
    const push = this.push.uniforms;
    for (let level = LEVELS - 2; level >= 0; level--) {
      push.uPulled!.value = this.pulled[level]!.texture;
      const coarsePulled = level === LEVELS - 2;
      push.uCoarse!.value = coarsePulled
        ? this.pulled[level + 1]!.texture
        : this.pushed[level + 1]!.texture;
      push.uCoarseIsPulled!.value = coarsePulled;
      push.uCoarseFade!.value = LEVEL_FADE[level + 1];
      push.uRamp!.value.fromArray(COVERAGE_RAMP[level]!);
      push.uCoarseRamp!.value.fromArray(COVERAGE_RAMP[level + 1]!);
      this.draw(renderer, this.pushed[level]!);
    }

    // Restore the clear colour once the canvas is bound: three converts it
    // to the bound target's colour space when it is set.
    renderer.setRenderTarget(null);
    renderer.setClearColor(this.clearColor, alpha);
    renderer.clear(true, true, true);
    this.quad.material = this.composite;
    renderer.render(this.quad, this.quadCamera);
    // Overlays: everything outside the cloud layers, over the composite.
    renderer.render(scene, camera);
    renderer.autoClear = autoClear;
  }

  private draw(renderer: THREE.WebGLRenderer, output: THREE.WebGLRenderTarget) {
    renderer.setRenderTarget(output);
    renderer.render(this.quad, this.quadCamera);
  }

  dispose() {
    for (const renderTarget of [
      this.cloud,
      this.glow,
      ...this.pulled,
      ...this.pushed,
    ])
      renderTarget.dispose();
    this.cloudDepth.dispose();
    this.pull.dispose();
    this.push.dispose();
    this.composite.dispose();
    this.quad.geometry.dispose();
  }
}
