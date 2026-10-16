import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import {
  Grid,
  Html,
  Line,
  OrbitControls,
} from "@react-three/drei";
import {
  Canvas,
  useFrame,
  useThree,
  type ThreeEvent,
} from "@react-three/fiber";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronsDown,
  ChevronsUp,
  Diamond,
  Focus,
  Video,
  X,
} from "lucide-react";
import { createIntrinsicsFromFov } from "./common";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { FrustumObject } from "./FrustumObject";
import { PosedPointCloud } from "./PreviewCloud";
import type { PosedView } from "./pose";
import {
  cameraAimDegrees,
  cameraPathTarget,
  cameraQuaternionFromAim,
  TRAJECTORY_FLOOR_Y,
  type CameraView,
  type TrajectoryPoint,
  type TrajectoryQuaternion,
} from "./camera-trajectory";
import { layoutCameraLabels } from "./camera-labels";
import type { CameraAimMode, CameraKeyframe, ShotCurve } from "./keyframes";
import { usePlayheadWholeFrame, type Playhead } from "./playhead";
import {
  isometricViewDirection,
  shouldHandleViewerKey,
  viewerKeyStep,
  viewerMovementFromKeys,
  VIEWER_NAVIGATION_KEYS,
  VIEWER_RESET_KEY,
} from "./view-navigation";
import {
  ACCENT,
  PATH_END,
  PATH_START,
  SCENE_PALETTE,
  type StudioTheme,
} from "../theme";

const OVERVIEW_FOV = 35;
const CAMERA_MARKER_PIXELS = 38;
const PATH_SAMPLES = 160;
/** Degrees of pan or tilt per pixel of pointer movement while piloting. */
const PILOT_LOOK_SENSITIVITY = 0.14;
/** Degrees per second for the arrow keys while piloting. */
const PILOT_TURN_SPEED = 55;
const PILOT_KEYS = new Set([
  "w",
  "a",
  "s",
  "d",
  "q",
  "e",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
]);

export type PilotPose = {
  position: TrajectoryPoint;
  yaw: number;
  pitch: number;
};

type PilotInput = {
  keys: Set<string>;
  lookX: number;
  lookY: number;
  pointerDown: boolean;
  slow: boolean;
};

type ViewportProps = {
  pose: PosedView;
  referenceView: CameraView;
  curve: ShotCurve;
  playhead: Playhead;
  selectedKeyId: string | null;
  fovRadians: number;
  frameWidth: number;
  frameHeight: number;
  aimMode: CameraAimMode;
  aimTarget: TrajectoryPoint | null;
  allowBelowFloor: boolean;
  theme: StudioTheme;
  fill: boolean;
  /** Scene size, so movement speeds suit small and large scenes alike. */
  sceneRadius: number;
  piloting: boolean;
  /** An unkeyed pilot pose waiting for Set key. */
  pendingPose: PilotPose | null;
  targetCandidates: readonly TrajectoryPoint[];
  placingTarget: boolean;
  onKeySelect: (id: string) => void;
  onKeyMove: (id: string, position: TrajectoryPoint) => void;
  onLiveCameraMove: (position: TrajectoryPoint) => void;
  /** Reported once each pilot gesture ends. */
  onPilotPose: (pose: PilotPose) => void;
  onPilotStart: () => void;
  onPilotExit: () => void;
  onSetKey: () => void;
  onTargetPick: (position: TrajectoryPoint) => void;
  onTargetCancel: () => void;
  onTargetMiss: () => void;
};

export function CameraTrajectoryCanvas(props: ViewportProps) {
  const { pose, referenceView, curve, piloting } = props;
  const viewer = useRef<HTMLDivElement>(null);
  const gizmo = useRef<SVGSVGElement>(null);
  const navigationKeys = useRef(new Set<string>());
  const pilotInput = useRef<PilotInput>({
    keys: new Set(),
    lookX: 0,
    lookY: 0,
    pointerDown: false,
    slow: false,
  });
  const look = useRef<{ pointerId: number; x: number; y: number } | null>(
    null,
  );
  const target = useMemo(
    () => cameraPathTarget(referenceView, pose.centroidWorld),
    [pose.centroidWorld, referenceView],
  );
  const keyPositions = curve.keyframes.map((key) => key.position);
  const keyPositionsRef = useRef(keyPositions);
  keyPositionsRef.current = keyPositions;
  const [overviewHome, setOverviewHome] = useState(() => ({
    position: buildOverviewPosition(
      referenceView.position,
      target,
      keyPositions,
    ),
  }));
  const [resetVersion, setResetVersion] = useState(0);
  const resetView = useCallback(() => {
    navigationKeys.current.clear();
    setOverviewHome({
      position: buildOverviewPosition(
        referenceView.position,
        target,
        keyPositionsRef.current,
      ),
    });
    setResetVersion((version) => version + 1);
  }, [referenceView.position, target]);

  const clearInput = useCallback(() => {
    navigationKeys.current.clear();
    pilotInput.current.keys.clear();
    pilotInput.current.pointerDown = false;
    look.current = null;
  }, []);

  useEffect(() => {
    window.addEventListener("blur", clearInput);
    return () => window.removeEventListener("blur", clearInput);
  }, [clearInput]);

  useEffect(() => {
    clearInput();
    if (piloting || props.placingTarget)
      viewer.current?.focus({ preventScroll: true });
  }, [clearInput, piloting, props.placingTarget]);

  useEffect(() => {
    if (!props.placingTarget) return;
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      props.onTargetCancel();
    };
    window.addEventListener("keydown", cancelOnEscape);
    return () => window.removeEventListener("keydown", cancelOnEscape);
  }, [props.onTargetCancel, props.placingTarget]);

  function updateKey(event: ReactKeyboardEvent<HTMLDivElement>, pressed: boolean) {
    const key = event.key.toLowerCase();
    pilotInput.current.slow = event.shiftKey;
    if (!pressed) {
      navigationKeys.current.delete(key);
      pilotInput.current.keys.delete(key);
      return;
    }
    if (!shouldHandleViewerKey(event)) return;
    if (piloting) {
      if (!PILOT_KEYS.has(key)) return;
      event.preventDefault();
      pilotInput.current.keys.add(key);
      return;
    }
    if (key === VIEWER_RESET_KEY) {
      if (!event.repeat && !props.placingTarget) resetView();
      return;
    }
    if (props.placingTarget || !VIEWER_NAVIGATION_KEYS.has(key)) return;
    event.preventDefault();
    navigationKeys.current.add(key);
  }

  function startLook(event: ReactPointerEvent<HTMLDivElement>) {
    if (!piloting || event.button !== 0) return;
    if ((event.target as Element).closest("button, [data-pilot-ui]")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    look.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    pilotInput.current.pointerDown = true;
  }

  function moveLook(event: ReactPointerEvent<HTMLDivElement>) {
    const active = look.current;
    if (!active || active.pointerId !== event.pointerId) return;
    pilotInput.current.lookX += event.clientX - active.x;
    pilotInput.current.lookY += event.clientY - active.y;
    active.x = event.clientX;
    active.y = event.clientY;
  }

  function endLook(event: ReactPointerEvent<HTMLDivElement>) {
    if (look.current?.pointerId !== event.pointerId) return;
    look.current = null;
    pilotInput.current.pointerDown = false;
  }

  const palette = SCENE_PALETTE[props.theme];
  const shotAspect = props.frameWidth / props.frameHeight;

  return (
    <div
      ref={viewer}
      role="application"
      tabIndex={0}
      aria-label={
        piloting
          ? "Camera pilot. W A S D move, Q and E move down and up, drag or use the arrow keys to look, hold Shift for fine moves. I sets a key, Escape exits."
          : "3D shot viewer. Drag a camera to move it; drag empty space to orbit. W A S D move the view, Q and E move down and up, R resets the view."
      }
      data-piloting={piloting || undefined}
      className={`studio-viewer ${props.placingTarget ? "is-picking" : ""}`}
      style={{ "--shot-aspect": shotAspect } as React.CSSProperties}
      onPointerDown={(event) => {
        event.currentTarget.focus({ preventScroll: true });
        startLook(event);
      }}
      onPointerMove={moveLook}
      onPointerUp={endLook}
      onPointerCancel={endLook}
      onLostPointerCapture={endLook}
      onKeyDown={(event) => updateKey(event, true)}
      onKeyUp={(event) => updateKey(event, false)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          clearInput();
      }}
    >
      <Canvas
        className="studio-viewer-canvas"
        camera={{
          position: overviewHome.position,
          fov: OVERVIEW_FOV,
          near: 0.01,
          far: 1000,
        }}
        dpr={[1, 1.5]}
        gl={{ antialias: true }}
      >
        <ClearColor color={palette.background} />
        <ShotScene
          {...props}
          target={target}
          overviewHome={overviewHome}
          resetVersion={resetVersion}
          navigationKeys={navigationKeys}
          pilotInput={pilotInput}
          gizmo={gizmo}
        />
      </Canvas>

      {!piloting && !props.placingTarget && (
        <nav aria-label="View" className="studio-float studio-view-tools">
          <svg ref={gizmo} className="studio-gizmo" viewBox="-30 -30 60 60" aria-hidden>
            <circle r="28" className="studio-gizmo-disc" />
            {(["x", "y", "z"] as const).map((axis) => (
              <g key={axis} data-axis={axis}>
                <line x1="0" y1="0" x2="0" y2="0" />
                <circle r="6.5" />
                <text dy="3.2">{axis.toUpperCase()}</text>
              </g>
            ))}
          </svg>
          <button
            type="button"
            className="studio-icon-button"
            title="Pilot the shot camera (C)"
            aria-label="Pilot the shot camera"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={props.onPilotStart}
          >
            <Video className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="studio-icon-button"
            title="Frame scene and path (R)"
            aria-label="Frame scene and path"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={resetView}
          >
            <Focus className="h-4 w-4" />
          </button>
        </nav>
      )}

      {props.placingTarget && (
        <div className="studio-float studio-picker-banner">
          <span id="look-at-picker-instruction">Click the point to look at</span>
          <button
            type="button"
            className="studio-button is-small"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={props.onTargetCancel}
          >
            Cancel
          </button>
        </div>
      )}

      {piloting && (
        <PilotHud
          playhead={props.playhead}
          pending={props.pendingPose !== null}
          aimMode={props.aimMode}
          input={pilotInput}
          onSetKey={props.onSetKey}
          onExit={props.onPilotExit}
        />
      )}
    </div>
  );
}

function ClearColor({ color }: { color: string }) {
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => {
    gl.setClearColor(color);
    invalidate();
  }, [color, gl, invalidate]);
  return null;
}

function PilotHud({
  playhead,
  pending,
  aimMode,
  input,
  onSetKey,
  onExit,
}: {
  playhead: Playhead;
  pending: boolean;
  aimMode: CameraAimMode;
  input: RefObject<PilotInput>;
  onSetKey: () => void;
  onExit: () => void;
}) {
  const frame = usePlayheadWholeFrame(playhead);
  const hold = (key: string) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      input.current.keys.add(key);
    },
    onPointerUp: () => input.current.keys.delete(key),
    onPointerCancel: () => input.current.keys.delete(key),
    onLostPointerCapture: () => input.current.keys.delete(key),
  });
  return (
    <div className="pilot-hud">
      <div className="pilot-frame" aria-hidden>
        <span />
        <span />
        <span />
        <span />
        <i />
      </div>
      <div className="pilot-bar studio-float" data-pilot-ui>
        <span className="pilot-badge">
          <i />
          Piloting
        </span>
        <span className="pilot-time">F{frame}</span>
        <button
          type="button"
          className={`studio-button is-small ${pending ? "is-accent" : ""}`}
          onClick={onSetKey}
          title="Set a key at this frame (I)"
        >
          <Diamond className="h-3.5 w-3.5" />
          {pending ? "Set key" : "Key"}
        </button>
        <button
          type="button"
          className="studio-icon-button is-small"
          onClick={onExit}
          title="Finish piloting (Esc)"
          aria-label="Finish piloting"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="pilot-hints studio-float" data-pilot-ui>
        <span>
          <kbd>W</kbd>
          <kbd>A</kbd>
          <kbd>S</kbd>
          <kbd>D</kbd> move
        </span>
        <span>
          <kbd>Q</kbd>
          <kbd>E</kbd> down / up
        </span>
        <span>{aimMode === "free" ? "Drag to look" : "Aim follows the shot's aim"}</span>
        <span>
          <kbd>Shift</kbd> fine
        </span>
        <span>
          <kbd>I</kbd> set key
        </span>
      </div>
      <div className="pilot-pad" data-pilot-ui>
        <button type="button" aria-label="Move forward" {...hold("w")}>
          <ArrowUp className="h-4 w-4" />
        </button>
        <button type="button" aria-label="Move left" {...hold("a")}>
          <ArrowLeft className="h-4 w-4" />
        </button>
        <button type="button" aria-label="Move back" {...hold("s")}>
          <ArrowDown className="h-4 w-4" />
        </button>
        <button type="button" aria-label="Move right" {...hold("d")}>
          <ArrowRight className="h-4 w-4" />
        </button>
        <button type="button" aria-label="Move up" {...hold("e")}>
          <ChevronsUp className="h-4 w-4" />
        </button>
        <button type="button" aria-label="Move down" {...hold("q")}>
          <ChevronsDown className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function ShotScene({
  pose,
  referenceView,
  curve,
  playhead,
  selectedKeyId,
  fovRadians,
  frameWidth,
  frameHeight,
  aimMode,
  aimTarget,
  allowBelowFloor,
  theme,
  fill,
  sceneRadius,
  piloting,
  pendingPose,
  targetCandidates,
  placingTarget,
  onKeySelect,
  onKeyMove,
  onLiveCameraMove,
  onPilotPose,
  onTargetPick,
  onTargetMiss,
  target,
  overviewHome,
  resetVersion,
  navigationKeys,
  pilotInput,
  gizmo,
}: ViewportProps & {
  target: TrajectoryPoint;
  overviewHome: { position: TrajectoryPoint };
  resetVersion: number;
  navigationKeys: RefObject<Set<string>>;
  pilotInput: RefObject<PilotInput>;
  gizmo: RefObject<SVGSVGElement | null>;
}) {
  const palette = SCENE_PALETTE[theme];
  const overviewCamera = useThree((state) => state.camera);
  const controls = useRef<OrbitControlsImpl>(null);
  const [dragging, setDragging] = useState(false);
  const movement = useRef(new THREE.Vector3()).current;
  const markerDepth = Math.max(
    0.12,
    new THREE.Vector3(...referenceView.position).distanceTo(
      new THREE.Vector3(...target),
    ) * 0.12,
  );

  useEffect(() => {
    if (dragging || placingTarget) navigationKeys.current.clear();
  }, [dragging, navigationKeys, placingTarget]);

  useFrame((_, delta) => {
    const active = controls.current;
    if (!active || piloting || dragging || placingTarget) return;
    const keys = navigationKeys.current;
    if (keys.size === 0) return;
    const step = viewerMovementFromKeys(keys, overviewCamera.quaternion, movement);
    if (step.lengthSq() === 0) return;
    step.multiplyScalar(viewerKeyStep(active.getDistance(), delta));
    overviewCamera.position.add(step);
    active.target.add(step);
    active.update();
  });

  return (
    <>
      <OverviewCamera home={overviewHome} target={target} controls={controls} />
      <ViewGizmo svg={gizmo} />
      {piloting && (
        <PilotController
          curve={curve}
          playhead={playhead}
          pendingPose={pendingPose}
          aimMode={aimMode}
          aimTarget={aimTarget}
          allowBelowFloor={allowBelowFloor}
          fovRadians={fovRadians}
          shotAspect={frameWidth / frameHeight}
          speed={Math.max(0.6, sceneRadius * 0.45)}
          input={pilotInput}
          onPose={onPilotPose}
        />
      )}

      <Grid
        args={[100, 100]}
        position={[0, -0.002, 0]}
        cellSize={1}
        cellThickness={0.6}
        cellColor={palette.gridCell}
        sectionSize={5}
        sectionThickness={1}
        sectionColor={palette.gridSection}
        infiniteGrid
        fadeDistance={40}
        fadeStrength={2}
      />

      <PosedPointCloud pose={pose} scaleMultiplier={1} fill={fill} />

      {aimMode === "look_at" && aimTarget && (
        <DirectionTargetMarker
          hidden={piloting}
          position={aimTarget}
          label="Look target"
        />
      )}

      {placingTarget && (
        <DirectionTargetPicker
          candidates={targetCandidates}
          onChange={onTargetPick}
          onMiss={onTargetMiss}
        />
      )}

      <ShotPath curve={curve} casing={palette.casing} tick={palette.key} />

      {/* Hidden rather than unmounted: drei's Html labels do not survive
          unmounting mid-render. */}
      <KeyframeHandles
          hidden={piloting || placingTarget}
          curve={curve}
          markerDepth={markerDepth}
          fovRadians={fovRadians}
          frameWidth={frameWidth}
          frameHeight={frameHeight}
          selectedKeyId={selectedKeyId}
          idleColor={palette.keyIdle}
          allowBelowFloor={allowBelowFloor}
          onMove={onKeyMove}
          onSelect={onKeySelect}
          onDraggingChange={setDragging}
        />

      {!piloting && (
        <LiveCamera
          curve={curve}
          playhead={playhead}
          markerDepth={markerDepth}
          fovRadians={fovRadians}
          frameWidth={frameWidth}
          frameHeight={frameHeight}
          allowBelowFloor={allowBelowFloor}
          disabled={placingTarget}
          onMove={onLiveCameraMove}
          onDraggingChange={setDragging}
        />
      )}

      <SourceCameraMarker
        hidden={piloting}
        view={referenceView}
        depth={markerDepth}
        color={palette.source}
        frameWidth={frameWidth}
        frameHeight={frameHeight}
      />

      <OrbitControls
        key={resetVersion}
        ref={controls}
        makeDefault
        enabled={!piloting && !dragging && !placingTarget}
        target={target}
        enablePan
        screenSpacePanning
        enableDamping={false}
        maxPolarAngle={Math.PI - 0.01}
      />
    </>
  );
}

/** Points the corner axis widget the way the view camera faces. */
function ViewGizmo({ svg }: { svg: RefObject<SVGSVGElement | null> }) {
  const inverse = useRef(new THREE.Quaternion()).current;
  const axis = useRef(new THREE.Vector3()).current;
  useFrame(({ camera }) => {
    const root = svg.current;
    if (!root) return;
    inverse.copy(camera.quaternion).invert();
    const groups = root.querySelectorAll<SVGGElement>("g[data-axis]");
    groups.forEach((group) => {
      const name = group.dataset.axis;
      axis
        .set(name === "x" ? 1 : 0, name === "y" ? 1 : 0, name === "z" ? 1 : 0)
        .applyQuaternion(inverse);
      const x = (axis.x * 19).toFixed(2);
      const y = (-axis.y * 19).toFixed(2);
      const line = group.querySelector("line");
      line?.setAttribute("x2", x);
      line?.setAttribute("y2", y);
      group.querySelector("circle")?.setAttribute("cx", x);
      group.querySelector("circle")?.setAttribute("cy", y);
      group.querySelector("text")?.setAttribute("x", x);
      group.querySelector("text")?.setAttribute("y", y);
      group.style.opacity = axis.z < -0.2 ? "0.45" : "1";
    });
  });
  return null;
}

function PilotController({
  curve,
  playhead,
  pendingPose,
  aimMode,
  aimTarget,
  allowBelowFloor,
  fovRadians,
  shotAspect,
  speed,
  input,
  onPose,
}: {
  curve: ShotCurve;
  playhead: Playhead;
  pendingPose: PilotPose | null;
  aimMode: CameraAimMode;
  aimTarget: TrajectoryPoint | null;
  allowBelowFloor: boolean;
  fovRadians: number;
  shotAspect: number;
  speed: number;
  input: RefObject<PilotInput>;
  onPose: (pose: PilotPose) => void;
}) {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const live = useRef<PilotPose | null>(null);
  const moving = useRef(false);
  // After a gesture, keep the pose we reported until the editor echoes it.
  const awaitingEcho = useRef(false);
  const movement = useRef(new THREE.Vector3()).current;
  const rotation = useRef(new THREE.Quaternion()).current;
  const looker = useRef(new THREE.Object3D()).current;

  useEffect(() => {
    const saved = {
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
      fov: camera.fov,
    };
    return () => {
      camera.position.copy(saved.position);
      camera.quaternion.copy(saved.quaternion);
      camera.fov = saved.fov;
      camera.updateProjectionMatrix();
    };
  }, [camera]);

  useEffect(() => {
    awaitingEcho.current = false;
  }, [pendingPose, curve]);

  function aimAt(pose: PilotPose, frame: number): THREE.Quaternion {
    if (aimMode === "look_at" && aimTarget) {
      looker.position.set(...pose.position);
      looker.up.set(0, 1, 0);
      // Object3D.lookAt points +z at the target; cameras look down -z.
      looker.lookAt(
        2 * pose.position[0] - aimTarget[0],
        2 * pose.position[1] - aimTarget[1],
        2 * pose.position[2] - aimTarget[2],
      );
      return rotation.copy(looker.quaternion);
    }
    if (aimMode === "forward")
      return rotation.set(...curve.poseAt(frame).quaternion);
    return rotation.set(...cameraQuaternionFromAim(pose.yaw, pose.pitch));
  }

  useFrame(({ size }, delta) => {
    const state = input.current;
    const frame = playhead.frame;
    const hasInput =
      state.keys.size > 0 ||
      state.pointerDown ||
      state.lookX !== 0 ||
      state.lookY !== 0;
    if (hasInput && playhead.playing) playhead.pause();

    if (!hasInput && !moving.current && !awaitingEcho.current) {
      const source = pendingPose ?? curve.poseAt(frame);
      live.current = {
        position: [...source.position],
        yaw: source.yaw,
        pitch: source.pitch,
      };
    }
    if (!live.current) {
      const source = curve.poseAt(frame);
      live.current = {
        position: [...source.position],
        yaw: source.yaw,
        pitch: source.pitch,
      };
    }
    const pose = live.current;

    if (hasInput) {
      moving.current = true;
      const dt = Math.min(Math.max(delta, 0), 0.1);
      if (aimMode === "free") {
        const turnX =
          (state.keys.has("arrowright") ? 1 : 0) -
          (state.keys.has("arrowleft") ? 1 : 0);
        const turnY =
          (state.keys.has("arrowup") ? 1 : 0) -
          (state.keys.has("arrowdown") ? 1 : 0);
        const fine = state.slow ? 0.35 : 1;
        pose.yaw +=
          (state.lookX * PILOT_LOOK_SENSITIVITY +
            turnX * PILOT_TURN_SPEED * dt) *
          fine;
        pose.pitch = THREE.MathUtils.clamp(
          pose.pitch +
            (-state.lookY * PILOT_LOOK_SENSITIVITY +
              turnY * PILOT_TURN_SPEED * dt) *
              fine,
          -85,
          85,
        );
      }
      state.lookX = 0;
      state.lookY = 0;
      const step = viewerMovementFromKeys(
        state.keys,
        aimAt(pose, frame),
        movement,
      );
      if (step.lengthSq() > 0) {
        step.multiplyScalar(speed * dt * (state.slow ? 0.25 : 1));
        pose.position = [
          pose.position[0] + step.x,
          allowBelowFloor
            ? pose.position[1] + step.y
            : Math.max(TRAJECTORY_FLOOR_Y, pose.position[1] + step.y),
          pose.position[2] + step.z,
        ];
      }
    } else if (moving.current) {
      moving.current = false;
      awaitingEcho.current = true;
      const quaternion = aimAt(pose, frame);
      const aim =
        aimMode === "free"
          ? { yaw: pose.yaw, pitch: pose.pitch }
          : cameraAimDegrees(quaternion.toArray() as TrajectoryQuaternion);
      onPose({ position: [...pose.position], ...aim });
    }

    camera.position.set(...pose.position);
    camera.quaternion.copy(aimAt(pose, frame));
    // Keep the whole shot frame on screen in narrow viewports.
    const viewAspect = size.width / Math.max(1, size.height);
    const vertical =
      viewAspect >= shotAspect
        ? fovRadians
        : 2 * Math.atan((Math.tan(fovRadians / 2) * shotAspect) / viewAspect);
    const fov = THREE.MathUtils.radToDeg(vertical);
    if (Math.abs(camera.fov - fov) > 1e-4) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
  });

  return null;
}

function ShotPath({
  curve,
  casing,
  tick,
}: {
  curve: ShotCurve;
  casing: string;
  tick: string;
}) {
  const keys = curve.keyframes;
  const { points, colors, ticks } = useMemo(() => {
    if (keys.length < 2)
      return { points: [], colors: [], ticks: new Float32Array() };
    const first = keys[0]!.frame;
    const last = keys.at(-1)!.frame;
    const start = new THREE.Color(PATH_START);
    const end = new THREE.Color(PATH_END);
    const points: TrajectoryPoint[] = [];
    const colors: [number, number, number][] = [];
    for (let i = 0; i <= PATH_SAMPLES; i++) {
      const t = i / PATH_SAMPLES;
      points.push(curve.positionAt(first + (last - first) * t));
      const color = start.clone().lerp(end, t);
      colors.push([color.r, color.g, color.b]);
    }
    const ticks: number[] = [];
    for (let frame = Math.ceil(first); frame <= last; frame++)
      ticks.push(...curve.positionAt(frame));
    return { points, colors, ticks: new Float32Array(ticks) };
  }, [curve, keys]);
  const tickGeometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(ticks, 3));
    return geometry;
  }, [ticks]);
  useEffect(() => () => tickGeometry.dispose(), [tickGeometry]);
  if (points.length < 2) return null;
  return (
    <group>
      {/* Drawn over the scene, like a motion path, so it never gets lost
          behind the cloud. */}
      <Line
        points={points}
        color={casing}
        lineWidth={7}
        transparent
        opacity={0.85}
        depthTest={false}
        depthWrite={false}
        renderOrder={4}
        raycast={() => undefined}
      />
      <Line
        points={points}
        color="#ffffff"
        vertexColors={colors}
        lineWidth={3.5}
        transparent
        depthTest={false}
        depthWrite={false}
        renderOrder={5}
        raycast={() => undefined}
      />
      {/* One dot per frame: spacing shows where the camera speeds up. */}
      <points geometry={tickGeometry} renderOrder={6} raycast={() => undefined}>
        <pointsMaterial
          color={tick}
          size={3.5}
          sizeAttenuation={false}
          transparent
          opacity={0.6}
          depthTest={false}
          depthWrite={false}
          toneMapped={false}
        />
      </points>
    </group>
  );
}

function OverviewCamera({
  home,
  target,
  controls,
}: {
  home: { position: TrajectoryPoint };
  target: TrajectoryPoint;
  controls: RefObject<OrbitControlsImpl | null>;
}) {
  const camera = useRef(useThree((state) => state.camera)).current;

  useEffect(() => {
    camera.position.set(...home.position);
    camera.lookAt(...target);
    if (controls.current) {
      controls.current.target.set(...target);
      controls.current.update();
    }
    camera.updateMatrixWorld();
  }, [camera, controls, home, target]);

  return null;
}

/** Drag a camera marker on the plane facing the view. */
function useMarkerDrag({
  getPosition,
  allowBelowFloor,
  disabled,
  onStart,
  onChange,
  onDraggingChange,
}: {
  getPosition: () => TrajectoryPoint;
  allowBelowFloor: boolean;
  disabled: boolean;
  onStart?: () => void;
  onChange: (position: TrajectoryPoint) => void;
  onDraggingChange: (dragging: boolean) => void;
}) {
  const orbitControls = useThree(
    (state) => state.controls,
  ) as OrbitControlsImpl | null;
  const canvas = useThree((state) => state.gl.domElement);
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{
    pointerId: number;
    plane: THREE.Plane;
    grabOffset: THREE.Vector3;
    startPosition: TrajectoryPoint;
  } | null>(null);

  useEffect(
    () => () => {
      if (drag.current) onDraggingChange(false);
      canvas.style.cursor = "";
    },
    [canvas, onDraggingChange],
  );

  function finish(event: ThreeEvent<PointerEvent>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.stopPropagation();
    drag.current = null;
    setDragging(false);
    onDraggingChange(false);
    if (orbitControls) orbitControls.enabled = true;
    canvas.style.cursor = hovered ? "grab" : "";
    const target = event.target as Element;
    if (target.hasPointerCapture(event.pointerId))
      target.releasePointerCapture(event.pointerId);
  }

  return {
    hovered,
    dragging,
    handlers: {
      onPointerDown(event: ThreeEvent<PointerEvent>) {
        if (disabled || event.button !== 0 || drag.current) return;
        event.stopPropagation();
        event.nativeEvent.stopImmediatePropagation();
        const position = getPosition();
        const worldPosition = new THREE.Vector3(...position);
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
          event.camera.getWorldDirection(new THREE.Vector3()),
          worldPosition,
        );
        const intersection = event.ray.intersectPlane(plane, new THREE.Vector3());
        if (!intersection) return;
        if (orbitControls) orbitControls.enabled = false;
        onStart?.();
        (event.target as Element).setPointerCapture(event.pointerId);
        drag.current = {
          pointerId: event.pointerId,
          plane,
          grabOffset: intersection.sub(worldPosition),
          startPosition: [...position],
        };
        canvas.style.cursor = "grabbing";
        setDragging(true);
        onDraggingChange(true);
      },
      onPointerMove(event: ThreeEvent<PointerEvent>) {
        const active = drag.current;
        if (!active || active.pointerId !== event.pointerId) return;
        event.stopPropagation();
        const intersection = event.ray.intersectPlane(
          active.plane,
          new THREE.Vector3(),
        );
        if (!intersection) return;
        intersection.sub(active.grabOffset);
        if (!allowBelowFloor)
          intersection.y = Math.max(TRAJECTORY_FLOOR_Y, intersection.y);
        onChange(intersection.toArray());
      },
      onPointerUp: finish,
      onPointerCancel(event: ThreeEvent<PointerEvent>) {
        const active = drag.current;
        if (!active || active.pointerId !== event.pointerId) return;
        onChange(active.startPosition);
        finish(event);
      },
      onLostPointerCapture(event: ThreeEvent<PointerEvent>) {
        finish(event);
      },
      onPointerOver(event: ThreeEvent<PointerEvent>) {
        event.stopPropagation();
        setHovered(true);
        if (!drag.current && !disabled) canvas.style.cursor = "grab";
      },
      onPointerOut() {
        setHovered(false);
        if (!drag.current) canvas.style.cursor = "";
      },
    },
  };
}

function useScreenConstantScale(
  group: RefObject<THREE.Group | null>,
  markerDepth: number,
) {
  useFrame(({ camera, size }) => {
    if (!group.current || !(camera instanceof THREE.PerspectiveCamera)) return;
    const distance = camera.position.distanceTo(group.current.position);
    const worldHeight =
      2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    group.current.scale.setScalar(
      (worldHeight * CAMERA_MARKER_PIXELS) / (size.height * markerDepth),
    );
  });
}

function KeyframeHandles({
  hidden,
  curve,
  markerDepth,
  fovRadians,
  frameWidth,
  frameHeight,
  selectedKeyId,
  idleColor,
  allowBelowFloor,
  onMove,
  onSelect,
  onDraggingChange,
}: {
  hidden: boolean;
  curve: ShotCurve;
  markerDepth: number;
  fovRadians: number;
  frameWidth: number;
  frameHeight: number;
  selectedKeyId: string | null;
  idleColor: string;
  allowBelowFloor: boolean;
  onMove: (id: string, position: TrajectoryPoint) => void;
  onSelect: (id: string) => void;
  onDraggingChange: (dragging: boolean) => void;
}) {
  const keys = curve.keyframes;
  const labels = useRef(new Map<string, HTMLElement>());
  const projected = useRef(new THREE.Vector3()).current;
  useFrame(({ camera, size }) => {
    const points = keys.map((key) => {
      projected.set(...key.position).project(camera);
      const x = (projected.x * 0.5 + 0.5) * size.width;
      const y = (0.5 - projected.y * 0.5) * size.height;
      return {
        x,
        y,
        visible:
          projected.z > -1 &&
          projected.z < 1 &&
          x >= 0 &&
          x <= size.width - 70 &&
          y >= 0 &&
          y <= size.height - 40,
      };
    });
    const visible = points.flatMap((point, index) =>
      point.visible ? [index] : [],
    );
    const positions = layoutCameraLabels(
      visible.map((index) => points[index]!),
      Math.max(40, size.width - 70),
      Math.max(40, size.height - 40),
    );
    keys.forEach((key, index) => {
      const label = labels.current.get(key.id);
      if (label)
        label.style.visibility = points[index]!.visible ? "visible" : "hidden";
    });
    visible.forEach((index, slot) => {
      const label = labels.current.get(keys[index]!.id);
      if (label)
        label.style.translate = `${positions[slot]!.x - points[index]!.x}px ${positions[slot]!.y - points[index]!.y}px`;
    });
  });

  return keys.map((key, index) => (
    <KeyframeHandle
      key={key.id}
      hidden={hidden}
      keyframe={key}
      number={index + 1}
      quaternion={curve.poseAt(key.frame).quaternion}
      markerDepth={markerDepth}
      fovRadians={fovRadians}
      frameWidth={frameWidth}
      frameHeight={frameHeight}
      selected={key.id === selectedKeyId}
      idleColor={idleColor}
      allowBelowFloor={allowBelowFloor}
      onLabelReady={(node) => {
        if (node) labels.current.set(key.id, node);
        else labels.current.delete(key.id);
      }}
      onMove={(position) => onMove(key.id, position)}
      onSelect={() => onSelect(key.id)}
      onDraggingChange={onDraggingChange}
    />
  ));
}

function KeyframeHandle({
  hidden,
  keyframe,
  number,
  quaternion,
  markerDepth,
  fovRadians,
  frameWidth,
  frameHeight,
  selected,
  idleColor,
  allowBelowFloor,
  onLabelReady,
  onMove,
  onSelect,
  onDraggingChange,
}: {
  hidden: boolean;
  keyframe: CameraKeyframe;
  number: number;
  quaternion: TrajectoryQuaternion;
  markerDepth: number;
  fovRadians: number;
  frameWidth: number;
  frameHeight: number;
  selected: boolean;
  idleColor: string;
  allowBelowFloor: boolean;
  onLabelReady: (node: HTMLElement | null) => void;
  onMove: (position: TrajectoryPoint) => void;
  onSelect: () => void;
  onDraggingChange: (dragging: boolean) => void;
}) {
  const group = useRef<THREE.Group>(null);
  useScreenConstantScale(group, markerDepth);
  const { hovered, dragging, handlers } = useMarkerDrag({
    getPosition: () => keyframe.position,
    allowBelowFloor,
    disabled: hidden,
    onStart: onSelect,
    onChange: onMove,
    onDraggingChange,
  });
  const hitHeight = 2 * Math.tan(fovRadians / 2) * markerDepth;
  const intrinsics = useMemo(
    () => frameIntrinsics(fovRadians, frameWidth, frameHeight),
    [fovRadians, frameHeight, frameWidth],
  );
  const frustumCamera = useMemo(
    () => ({
      intrinsics,
      extrinsics: {
        position: [0, 0, 0] as TrajectoryPoint,
        quaternion: [0, 0, 0, 1] as TrajectoryQuaternion,
      },
    }),
    [intrinsics],
  );
  return (
    <group
      ref={group}
      visible={!hidden}
      position={keyframe.position}
      renderOrder={100}
      userData={{ cameraMarker: true, keyframe: keyframe.id }}
      {...handlers}
    >
      <group quaternion={quaternion}>
        <FrustumObject
          camera={frustumCamera}
          color={selected || dragging ? ACCENT : idleColor}
          depth={markerDepth}
          overlay
          markers={false}
          body
        />
        <mesh position={[0, 0, -markerDepth * 0.375]}>
          <boxGeometry
            args={[
              Math.max((hitHeight * frameWidth) / frameHeight, markerDepth * 0.7),
              hitHeight,
              markerDepth * 1.25,
            ]}
          />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      </group>
      <Html center zIndexRange={[5, 0]} className="pointer-events-none">
        <span
          ref={onLabelReady}
          data-keyframe-label={number}
          data-selected={selected || undefined}
          data-active={hovered || dragging || undefined}
          hidden={hidden}
          className="studio-key-label"
        >
          {number}
        </span>
      </Html>
    </group>
  );
}

/** The shot camera at the playhead; dragging it records a key there. */
function LiveCamera({
  curve,
  playhead,
  markerDepth,
  fovRadians,
  frameWidth,
  frameHeight,
  allowBelowFloor,
  disabled,
  onMove,
  onDraggingChange,
}: {
  curve: ShotCurve;
  playhead: Playhead;
  markerDepth: number;
  fovRadians: number;
  frameWidth: number;
  frameHeight: number;
  allowBelowFloor: boolean;
  disabled: boolean;
  onMove: (position: TrajectoryPoint) => void;
  onDraggingChange: (dragging: boolean) => void;
}) {
  const group = useRef<THREE.Group>(null);
  const aim = useRef<THREE.Group>(null);
  useScreenConstantScale(group, markerDepth);
  const { dragging, handlers } = useMarkerDrag({
    getPosition: () => curve.positionAt(playhead.frame),
    allowBelowFloor,
    disabled,
    onChange: onMove,
    onDraggingChange,
  });
  const keyFrames = useMemo(
    () => new Set(curve.keyframes.map((key) => key.frame)),
    [curve],
  );
  useFrame(() => {
    if (!group.current || !aim.current) return;
    const frame = playhead.frame;
    const pose = curve.poseAt(frame);
    group.current.position.set(...pose.position);
    aim.current.quaternion.set(...pose.quaternion);
    // A key's own marker already stands here.
    group.current.visible =
      dragging ||
      playhead.playing ||
      !(Number.isInteger(frame) && keyFrames.has(frame));
  });
  const intrinsics = useMemo(
    () => frameIntrinsics(fovRadians, frameWidth, frameHeight),
    [fovRadians, frameHeight, frameWidth],
  );
  const frustumCamera = useMemo(
    () => ({
      intrinsics,
      extrinsics: {
        position: [0, 0, 0] as TrajectoryPoint,
        quaternion: [0, 0, 0, 1] as TrajectoryQuaternion,
      },
    }),
    [intrinsics],
  );
  if (curve.keyframes.length === 0) return null;
  const hitHeight = 2 * Math.tan(fovRadians / 2) * markerDepth;
  return (
    <group ref={group} renderOrder={110} {...handlers}>
      <group ref={aim}>
        <FrustumObject
          camera={frustumCamera}
          color={ACCENT}
          depth={markerDepth * 1.1}
          overlay
          markers
          body
          renderOrder={12}
        />
        <mesh position={[0, 0, -markerDepth * 0.4]}>
          <boxGeometry
            args={[
              Math.max((hitHeight * frameWidth) / frameHeight, markerDepth * 0.7),
              hitHeight,
              markerDepth * 1.3,
            ]}
          />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      </group>
    </group>
  );
}

function SourceCameraMarker({
  hidden,
  view,
  depth,
  color,
  frameWidth,
  frameHeight,
}: {
  hidden: boolean;
  view: CameraView;
  depth: number;
  color: string;
  frameWidth: number;
  frameHeight: number;
}) {
  const group = useRef<THREE.Group>(null);
  useScreenConstantScale(group, depth);
  const camera = useMemo(
    () => ({
      intrinsics: frameIntrinsics(view.fovRadians, frameWidth, frameHeight),
      extrinsics: {
        position: [0, 0, 0] as TrajectoryPoint,
        quaternion: view.quaternion,
      },
    }),
    [frameHeight, frameWidth, view.fovRadians, view.quaternion],
  );
  return (
    <group
      ref={group}
      visible={!hidden}
      position={view.position}
      userData={{ sourceCameraMarker: true }}
    >
      <FrustumObject
        camera={camera}
        color={color}
        depth={depth}
        overlay
        markers={false}
        body
        renderOrder={9}
        dashed
      />
      <Html center zIndexRange={[4, 0]} className="pointer-events-none">
        <span
          data-source-camera-label
          hidden={hidden}
          className="studio-source-label"
        >
          Source
        </span>
      </Html>
    </group>
  );
}

function DirectionTargetPicker({
  candidates,
  onChange,
  onMiss,
}: {
  candidates: readonly TrajectoryPoint[];
  onChange: (position: TrajectoryPoint) => void;
  onMiss: () => void;
}) {
  const plane = useRef<THREE.Mesh>(null);
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const forward = useRef(new THREE.Vector3()).current;

  useEffect(() => {
    const chooseCenterTarget = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (
        !(event.target instanceof HTMLElement) ||
        !event.target.classList.contains("is-picking")
      )
        return;
      event.preventDefault();
      camera.getWorldDirection(forward);
      const closest = closestDirectionTarget(
        candidates,
        new THREE.Ray(camera.position.clone(), forward.clone()),
      );
      if (closest) onChange(closest);
      else onMiss();
    };
    window.addEventListener("keydown", chooseCenterTarget);
    return () => window.removeEventListener("keydown", chooseCenterTarget);
  }, [camera, candidates, forward, onChange, onMiss]);

  useFrame(() => {
    if (!plane.current || !(camera instanceof THREE.PerspectiveCamera)) return;
    const distance = Math.max(camera.near * 4, 0.1);
    camera.getWorldDirection(forward);
    plane.current.position.copy(camera.position).addScaledVector(forward, distance);
    plane.current.quaternion.copy(camera.quaternion);
    const height =
      2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    plane.current.scale.set(
      height * (size.width / size.height) * 1.1,
      height * 1.1,
      1,
    );
  });

  function chooseTarget(event: ThreeEvent<PointerEvent>) {
    if (event.button !== 0) return;
    event.stopPropagation();
    const closest = closestDirectionTarget(candidates, event.ray);
    if (!closest) {
      onMiss();
      return;
    }
    onChange(closest);
  }

  return (
    <mesh ref={plane} renderOrder={1000} onPointerDown={chooseTarget}>
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial
        transparent
        opacity={0}
        depthTest={false}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  );
}

function closestDirectionTarget(
  candidates: readonly TrajectoryPoint[],
  ray: THREE.Ray,
): TrajectoryPoint | null {
  let closest: TrajectoryPoint | null = null;
  let closestAngle = Infinity;
  let closestDepth = Infinity;
  const candidateVector = new THREE.Vector3();
  const offset = new THREE.Vector3();
  for (const candidate of candidates) {
    candidateVector.set(...candidate);
    const depth = offset.copy(candidateVector).sub(ray.origin).dot(ray.direction);
    if (depth <= 0) continue;
    const angle = Math.sqrt(ray.distanceSqToPoint(candidateVector)) / depth;
    if (
      angle < closestAngle - 0.002 ||
      (Math.abs(angle - closestAngle) <= 0.002 && depth < closestDepth)
    ) {
      closest = candidate;
      closestAngle = angle;
      closestDepth = depth;
    }
  }
  return closest && closestAngle <= 0.075
    ? ([...closest] as TrajectoryPoint)
    : null;
}

function DirectionTargetMarker({
  hidden,
  position,
  label,
}: {
  hidden: boolean;
  position: TrajectoryPoint;
  label: string;
}) {
  const group = useRef<THREE.Group>(null);
  const camera = useThree((state) => state.camera);
  const viewportHeight = useThree((state) => state.size.height);

  useFrame(() => {
    if (!group.current || !(camera instanceof THREE.PerspectiveCamera)) return;
    const distance = camera.position.distanceTo(group.current.position);
    const worldHeight =
      2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    group.current.scale.setScalar((worldHeight * 15) / viewportHeight);
    group.current.quaternion.copy(camera.quaternion);
  });

  return (
    <group
      ref={group}
      visible={!hidden}
      position={position}
      renderOrder={95}
      userData={{ cameraLookTarget: true }}
    >
      <mesh raycast={() => undefined}>
        <ringGeometry args={[0.3, 0.45, 32]} />
        <meshBasicMaterial
          color={ACCENT}
          transparent
          opacity={0.95}
          side={THREE.DoubleSide}
          depthTest={false}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      {(
        [
          [
            [-0.75, 0, 0],
            [-0.5, 0, 0],
          ],
          [
            [0.5, 0, 0],
            [0.75, 0, 0],
          ],
          [
            [0, -0.75, 0],
            [0, -0.5, 0],
          ],
          [
            [0, 0.5, 0],
            [0, 0.75, 0],
          ],
        ] as [TrajectoryPoint, TrajectoryPoint][]
      ).map((points, index) => (
        <Line
          key={index}
          points={points}
          color={ACCENT}
          lineWidth={3}
          depthTest={false}
          raycast={() => undefined}
        />
      ))}
      <Html position={[0, 1, 0]} center zIndexRange={[5, 0]} className="pointer-events-none">
        <div
          data-camera-look-target="set"
          hidden={hidden}
          className="studio-target-label"
        >
          {label}
        </div>
      </Html>
    </group>
  );
}

/** The view through the shot camera at the playhead. */
export function ShotCameraView({
  pose,
  curve,
  playhead,
  fovRadians,
  theme,
  fill,
}: {
  pose: PosedView;
  curve: ShotCurve;
  playhead: Playhead;
  fovRadians: number;
  theme: StudioTheme;
  fill: boolean;
}) {
  return (
    <Canvas
      className="pointer-events-none h-full w-full"
      camera={{ fov: 50, near: 0.01, far: 1000 }}
      dpr={[1, 1.5]}
      frameloop="demand"
      gl={{ antialias: true }}
    >
      <ClearColor color={SCENE_PALETTE[theme].background} />
      <PosedPointCloud pose={pose} scaleMultiplier={0.7} fill={fill} />
      <ShotCameraController
        curve={curve}
        playhead={playhead}
        fovRadians={fovRadians}
      />
    </Canvas>
  );
}

function ShotCameraController({
  curve,
  playhead,
  fovRadians,
}: {
  curve: ShotCurve;
  playhead: Playhead;
  fovRadians: number;
}) {
  const camera = useThree((state) => state.camera);
  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => playhead.subscribe(() => invalidate()), [invalidate, playhead]);
  useEffect(() => invalidate(), [curve, fovRadians, invalidate]);
  useFrame(() => {
    if (!(camera instanceof THREE.PerspectiveCamera)) return;
    const pose = curve.poseAt(playhead.frame);
    camera.position.set(...pose.position);
    camera.quaternion.set(...pose.quaternion);
    const fov = THREE.MathUtils.radToDeg(fovRadians);
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
  });
  return null;
}

function frameIntrinsics(
  fovRadians: number,
  frameWidth: number,
  frameHeight: number,
) {
  return createIntrinsicsFromFov(
    THREE.MathUtils.radToDeg(fovRadians),
    frameWidth,
    frameHeight,
  );
}

function buildOverviewPosition(
  referencePosition: TrajectoryPoint,
  targetPosition: TrajectoryPoint,
  pathPoints: readonly TrajectoryPoint[],
): TrajectoryPoint {
  const target = new THREE.Vector3(...targetPosition);
  const radial = new THREE.Vector3(...referencePosition).sub(target);
  const referenceDistance = Math.max(radial.length(), 1);
  const pathRadius = Math.max(
    0,
    ...pathPoints.map((point) => new THREE.Vector3(...point).distanceTo(target)),
  );
  const direction = isometricViewDirection(
    referencePosition,
    targetPosition,
    new THREE.Vector3(),
  );
  // Preserve the overview framing with a narrower lens for flatter depth.
  const lensScale =
    Math.tan(THREE.MathUtils.degToRad(25)) /
    Math.tan(THREE.MathUtils.degToRad(OVERVIEW_FOV / 2));
  return target
    .addScaledVector(
      direction,
      Math.max(referenceDistance * 1.15, pathRadius * 2.5) * lensScale,
    )
    .toArray() as TrajectoryPoint;
}
