import {
  memo,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Maximize, MousePointer2, PenLine } from "lucide-react";
import { capturePointer } from "./pointer";
import type { CameraView, TrajectoryPoint } from "./camera-trajectory";
import type { CameraKeyframe, ShotCurve } from "./keyframes";
import { usePlayheadFrame, type Playhead } from "./playhead";
import { formatTime, type TimeUnit } from "./Timeline";

type Bounds = { minX: number; minZ: number; width: number; height: number };
const MAP_ASPECT = 4 / 3;

export type PlanMapProps = {
  points: readonly TrajectoryPoint[];
  colors: readonly string[];
  source: CameraView;
  curve: ShotCurve;
  playhead: Playhead;
  selectedKeyId: string | null;
  aimTarget: TrajectoryPoint | null;
  fovRadians: number;
  frameAspect: number;
  frameCount: number;
  fps: number;
  unit: TimeUnit;
  allowBelowFloor: boolean;
  onSelectKey: (id: string) => void;
  onMoveKey: (id: string, position: TrajectoryPoint) => void;
  /** A sketched route, in world x/z, to turn into keys. */
  onSketch: (route: [number, number][]) => void;
};

function fitBounds(xz: [number, number][]): Bounds {
  const xs = xz.map((p) => p[0]).sort((a, b) => a - b);
  const zs = xz.map((p) => p[1]).sort((a, b) => a - b);
  const pick = (values: number[], q: number) =>
    values[Math.min(values.length - 1, Math.max(0, Math.floor(values.length * q)))] ?? 0;
  let minX = pick(xs, 0.06);
  let maxX = pick(xs, 0.94);
  let minZ = pick(zs, 0.06);
  let maxZ = pick(zs, 0.94);
  const pad = Math.max(maxX - minX, maxZ - minZ, 1) * 0.14;
  minX -= pad;
  maxX += pad;
  minZ -= pad;
  maxZ += pad;
  let width = maxX - minX;
  let height = maxZ - minZ;
  if (width / height < MAP_ASPECT) {
    const grow = height * MAP_ASPECT - width;
    minX -= grow / 2;
    width += grow;
  } else {
    const grow = width / MAP_ASPECT - height;
    minZ -= grow / 2;
    height += grow;
  }
  return { minX, minZ, width, height };
}

export function PlanMap(props: PlanMapProps) {
  const [view, setView] = useState<"top" | "height">("top");
  const [tool, setTool] = useState<"select" | "sketch">("select");
  const [fitVersion, setFitVersion] = useState(0);
  const keyCount = props.curve.keyframes.length;
  const bounds = useMemo(() => {
    const extra: [number, number][] = props.curve.keyframes.map((key) => [
      key.position[0],
      key.position[2],
    ]);
    extra.push([props.source.position[0], props.source.position[2]]);
    // Keys and the source camera always fit, so repeat them past the trim.
    const weighted = [
      ...props.points.map((p) => [p[0], p[2]] as [number, number]),
      ...Array.from({ length: Math.ceil(props.points.length / 20) }, () => extra).flat(),
    ];
    return fitBounds(weighted);
    // Refit on demand and when keys are added or removed, not while dragging.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.points, props.source, fitVersion, keyCount]);
  return (
    <div className="studio-map">
      <div className="studio-map-head">
        <span className="studio-map-title">Plan</span>
        <span className="flex-1" />
        <div className="studio-seg is-small" role="group" aria-label="Map view">
          <button type="button" aria-pressed={view === "top"} onClick={() => setView("top")}>
            Top
          </button>
          <button type="button" aria-pressed={view === "height"} onClick={() => setView("height")}>
            Height
          </button>
        </div>
      </div>
      <div className="studio-map-canvas">
        {view === "top" ? (
          <TopView {...props} bounds={bounds} tool={tool} onToolDone={() => setTool("select")} />
        ) : (
          <HeightView {...props} />
        )}
        {view === "top" && (
          <div className="studio-map-tools">
            <button
              type="button"
              className="studio-icon-button is-small"
              aria-pressed={tool === "select"}
              title="Select and drag keys"
              aria-label="Select and drag keys"
              onClick={() => setTool("select")}
            >
              <MousePointer2 className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className="studio-icon-button is-small"
              aria-pressed={tool === "sketch"}
              title="Sketch a new route; it becomes evenly timed keys"
              aria-label="Sketch a route"
              onClick={() => setTool(tool === "sketch" ? "select" : "sketch")}
            >
              <PenLine className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className="studio-icon-button is-small"
              title="Fit the map"
              aria-label="Fit the map"
              onClick={() => setFitVersion((version) => version + 1)}
            >
              <Maximize className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {tool === "sketch" && view === "top" && (
          <p className="studio-map-hint">Draw the route from start to end</p>
        )}
      </div>
    </div>
  );
}

function TopView({
  points,
  colors,
  source,
  curve,
  playhead,
  selectedKeyId,
  aimTarget,
  fovRadians,
  frameAspect,
  fps,
  unit,
  bounds,
  tool,
  onToolDone,
  onSelectKey,
  onMoveKey,
  onSketch,
}: PlanMapProps & {
  bounds: Bounds;
  tool: "select" | "sketch";
  onToolDone: () => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [sketch, setSketch] = useState<[number, number][] | null>(null);
  const unitSize = bounds.width / 320;
  const keys = curve.keyframes;
  const path = useMemo(() => {
    if (keys.length < 2) return [];
    const first = keys[0]!.frame;
    const last = keys.at(-1)!.frame;
    return Array.from({ length: 121 }, (_, i) => {
      const p = curve.positionAt(first + ((last - first) * i) / 120);
      return [p[0], p[2]] as const;
    });
  }, [curve, keys]);

  function toWorld(event: { clientX: number; clientY: number }): [number, number] {
    const element = svg.current!;
    const point = element.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const local = point.matrixTransform(element.getScreenCTM()!.inverse());
    return [local.x, local.y];
  }

  function startKeyDrag(event: ReactPointerEvent<SVGGElement>, key: CameraKeyframe) {
    if (tool !== "select" || event.button !== 0) return;
    event.stopPropagation();
    onSelectKey(key.id);
    playhead.pause();
    playhead.setFrame(key.frame);
    const target = event.currentTarget;
    capturePointer(target, event.pointerId);
    const [startX, startZ] = toWorld(event);
    const origin = key.position;
    const move = (moveEvent: PointerEvent) => {
      const [x, z] = toWorld(moveEvent);
      onMoveKey(key.id, [origin[0] + x - startX, origin[1], origin[2] + z - startZ]);
    };
    const end = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  }

  const half = Math.atan(Math.tan(fovRadians / 2) * frameAspect);
  // Time tags only where they have room; the selected key always shows one.
  const tagVisible = (() => {
    const shown: [number, number][] = [];
    const room = unitSize * 46;
    const order = keys
      .map((key, index) => ({ key, index }))
      .sort((a, b) =>
        a.key.id === selectedKeyId ? -1 : b.key.id === selectedKeyId ? 1 : 0,
      );
    const visible = new Array<boolean>(keys.length).fill(false);
    for (const { key, index } of order) {
      const at: [number, number] = [key.position[0], key.position[2]];
      if (shown.every((p) => Math.hypot(p[0] - at[0], (p[1] - at[1]) * 2.6) > room)) {
        visible[index] = true;
        shown.push(at);
      }
    }
    return visible;
  })();
  const sourceYaw = Math.atan2(
    ...(() => {
      const [x, y, z, w] = source.quaternion;
      // Forward (-z) rotated by the quaternion, projected to x/z.
      const fx = -2 * (x * z + w * y);
      const fz = -(1 - 2 * (x * x + y * y));
      return [fz, fx] as [number, number];
    })(),
  );

  return (
    <svg
      ref={svg}
      viewBox={`${bounds.minX} ${bounds.minZ} ${bounds.width} ${bounds.height}`}
      className={`studio-map-svg ${tool === "sketch" ? "is-sketching" : ""}`}
      onPointerDown={(event) => {
        if (tool !== "sketch" || event.button !== 0) return;
        capturePointer(event.currentTarget, event.pointerId);
        setSketch([toWorld(event)]);
      }}
      onPointerMove={(event) => {
        if (!sketch) return;
        const next = toWorld(event);
        const last = sketch.at(-1)!;
        if (Math.hypot(next[0] - last[0], next[1] - last[1]) > unitSize * 4)
          setSketch([...sketch, next]);
      }}
      onPointerUp={() => {
        if (!sketch) return;
        if (sketch.length > 3) onSketch(sketch);
        setSketch(null);
        onToolDone();
      }}
      onPointerCancel={() => setSketch(null)}
    >
      <defs>
        <filter id="studio-map-soft" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation={unitSize * 5} />
        </filter>
        <pattern
          id="studio-map-dots"
          width={unitSize * 12}
          height={unitSize * 12}
          patternUnits="userSpaceOnUse"
          x={bounds.minX}
          y={bounds.minZ}
        >
          <circle cx={unitSize} cy={unitSize} r={unitSize * 0.9} className="studio-map-dot" />
        </pattern>
        <linearGradient id="studio-map-wedge" x1="0" x2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0.32" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect
        x={bounds.minX}
        y={bounds.minZ}
        width={bounds.width}
        height={bounds.height}
        fill="url(#studio-map-dots)"
      />
      <SceneFootprint points={points} colors={colors} size={unitSize} />
      <Wedge
        position={[source.position[0], source.position[2]]}
        angle={sourceYaw}
        half={half}
        length={unitSize * 46}
        className="studio-map-source-wedge"
      />
      <g transform={`translate(${source.position[0]} ${source.position[2]})`}>
        <rect
          x={-unitSize * 6}
          y={-unitSize * 4}
          width={unitSize * 12}
          height={unitSize * 8}
          rx={unitSize * 2}
          className="studio-map-source"
        />
        <text y={unitSize * 15} fontSize={unitSize * 8} className="studio-map-label is-muted" textAnchor="middle">
          SOURCE
        </text>
      </g>
      {path.length > 1 && (
        <>
          <polyline
            points={path.map((p) => p.join(",")).join(" ")}
            className="studio-map-path-casing"
            strokeWidth={unitSize * 8}
          />
          {path.slice(1).map((p, i) => (
            <line
              key={i}
              x1={path[i]![0]}
              y1={path[i]![1]}
              x2={p[0]}
              y2={p[1]}
              strokeWidth={unitSize * 4}
              strokeLinecap="round"
              style={{
                stroke: `color-mix(in oklab, var(--path-start), var(--path-end) ${(i / (path.length - 2)) * 100}%)`,
              }}
            />
          ))}
          {[0.2, 0.4, 0.6, 0.8].map((t) => {
            const i = Math.round(t * (path.length - 2));
            const a = path[i]!;
            const b = path[i + 1]!;
            const angle = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
            return (
              <path
                key={t}
                d={`M${-unitSize * 2.5} ${-unitSize * 3} L${unitSize * 1.5} 0 L${-unitSize * 2.5} ${unitSize * 3}`}
                transform={`translate(${a[0]} ${a[1]}) rotate(${angle})`}
                className="studio-map-chevron"
                strokeWidth={unitSize * 1.6}
              />
            );
          })}
        </>
      )}
      {aimTarget && (
        <g transform={`translate(${aimTarget[0]} ${aimTarget[2]})`} className="studio-map-target">
          <circle r={unitSize * 6} strokeWidth={unitSize * 1.4} />
          <path
            d={`M0 ${-unitSize * 10}v${unitSize * 4}M0 ${unitSize * 6}v${unitSize * 4}M${-unitSize * 10} 0h${unitSize * 4}M${unitSize * 6} 0h${unitSize * 4}`}
            strokeWidth={unitSize * 1.4}
          />
        </g>
      )}
      <LiveWedge curve={curve} playhead={playhead} half={half} size={unitSize} />
      {keys.map((key, index) => {
        const flip = key.position[0] > bounds.minX + bounds.width * 0.78;
        const showTag = tagVisible[index];
        return (
          <g
            key={key.id}
            transform={`translate(${key.position[0]} ${key.position[2]})`}
            className="studio-map-key"
            data-selected={key.id === selectedKeyId || undefined}
            onPointerDown={(event) => startKeyDrag(event, key)}
          >
            <circle r={unitSize * 12} fill="transparent" />
            <rect
              x={-unitSize * 5.5}
              y={-unitSize * 5.5}
              width={unitSize * 11}
              height={unitSize * 11}
              rx={unitSize * 2}
              transform="rotate(45)"
              strokeWidth={unitSize * 1.8}
            />
            <g
              transform={`translate(${flip ? -unitSize * 52 : unitSize * 10} ${-unitSize * 17})`}
              display={showTag ? undefined : "none"}
            >
              <rect width={unitSize * 42} height={unitSize * 15} rx={unitSize * 7.5} className="studio-map-tag" strokeWidth={unitSize} />
              <text x={unitSize * 6} y={unitSize * 10.8} fontSize={unitSize * 9.5} className="studio-map-label">
                <tspan fontWeight={700}>{index + 1}</tspan>
                <tspan className="is-muted"> {formatTime(key.frame, fps, unit)}</tspan>
              </text>
            </g>
          </g>
        );
      })}
      {sketch && sketch.length > 1 && (
        <polyline
          points={sketch.map((p) => p.join(",")).join(" ")}
          className="studio-map-sketch"
          strokeWidth={unitSize * 3}
        />
      )}
      <g transform={`translate(${bounds.minX + bounds.width - unitSize * 52} ${bounds.minZ + bounds.height - unitSize * 12})`}>
        <path
          d={`M0 ${-unitSize * 3}v${unitSize * 6}M0 0h1M1 ${-unitSize * 3}v${unitSize * 6}`}
          className="studio-map-scale"
          strokeWidth={unitSize * 1.4}
        />
        <text x={1 + unitSize * 5} y={unitSize * 3.5} fontSize={unitSize * 9} className="studio-map-label is-muted">
          1 m
        </text>
      </g>
    </svg>
  );
}

const SceneFootprint = memo(function SceneFootprint({
  points,
  colors,
  size,
}: {
  points: readonly TrajectoryPoint[];
  colors: readonly string[];
  size: number;
}) {
  return (
    <g filter="url(#studio-map-soft)" opacity={0.85}>
      {points.map((point, index) => (
        <circle
          key={index}
          cx={point[0]}
          cy={point[2]}
          r={size * 5}
          fill={colors[index]}
        />
      ))}
    </g>
  );
});

function Wedge({
  position,
  angle,
  half,
  length,
  className,
  fill,
}: {
  position: [number, number];
  angle: number;
  half: number;
  length: number;
  className?: string;
  fill?: string;
}) {
  const [x, z] = position;
  const a = [x + Math.cos(angle - half) * length, z + Math.sin(angle - half) * length];
  const b = [x + Math.cos(angle + half) * length, z + Math.sin(angle + half) * length];
  return (
    <polygon
      points={`${x},${z} ${a.join(",")} ${b.join(",")}`}
      className={className}
      fill={fill}
    />
  );
}

function LiveWedge({
  curve,
  playhead,
  half,
  size,
}: {
  curve: ShotCurve;
  playhead: Playhead;
  half: number;
  size: number;
}) {
  const frame = usePlayheadFrame(playhead);
  if (curve.keyframes.length === 0) return null;
  const pose = curve.poseAt(frame);
  const [x, y, z, w] = pose.quaternion;
  const fx = -2 * (x * z + w * y);
  const fz = -(1 - 2 * (x * x + y * y));
  const angle = Math.atan2(fz, fx);
  const position: [number, number] = [pose.position[0], pose.position[2]];
  return (
    <g className="studio-map-live">
      <Wedge position={position} angle={angle} half={half} length={size * 60} fill="url(#studio-map-wedge)" />
      <circle cx={position[0]} cy={position[1]} r={size * 7} className="studio-map-live-halo" />
      <circle cx={position[0]} cy={position[1]} r={size * 4.5} className="studio-map-live-dot" strokeWidth={size * 1.5} />
    </g>
  );
}

function HeightView({
  curve,
  playhead,
  selectedKeyId,
  frameCount,
  allowBelowFloor,
  onSelectKey,
  onMoveKey,
}: PlanMapProps) {
  const svg = useRef<SVGSVGElement>(null);
  const keys = curve.keyframes;
  const lastFrame = frameCount - 1;
  const heights = useMemo(
    () => Array.from({ length: 97 }, (_, i) => curve.positionAt((i / 96) * lastFrame)[1]),
    [curve, lastFrame],
  );
  const top = Math.max(2, ...heights, ...keys.map((key) => key.position[1])) * 1.2;
  const bottom = allowBelowFloor ? Math.min(0, ...heights) * 1.2 : 0;
  const x = (frame: number) => 34 + (frame / lastFrame) * 272;
  const y = (height: number) => 214 - ((height - bottom) / (top - bottom)) * 190;
  const frame = usePlayheadFrame(playhead);
  const playheadHeight = curve.keyframes.length ? curve.positionAt(frame)[1] : 0;

  function startDrag(event: ReactPointerEvent<SVGGElement>, key: CameraKeyframe) {
    if (event.button !== 0) return;
    event.stopPropagation();
    onSelectKey(key.id);
    playhead.pause();
    playhead.setFrame(key.frame);
    const target = event.currentTarget;
    capturePointer(target, event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const element = svg.current!;
      const point = element.createSVGPoint();
      point.x = moveEvent.clientX;
      point.y = moveEvent.clientY;
      const local = point.matrixTransform(element.getScreenCTM()!.inverse());
      let height = bottom + ((214 - local.y) / 190) * (top - bottom);
      if (!allowBelowFloor) height = Math.max(0, height);
      onMoveKey(key.id, [key.position[0], height, key.position[2]]);
    };
    const end = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  }

  const steps = Math.max(1, Math.round((top - bottom) / 4));
  const gridLines = [];
  for (let h = Math.ceil(bottom); h <= top; h += steps) gridLines.push(h);
  const line = heights.map((h, i) => `${x((i / 96) * lastFrame).toFixed(1)},${y(h).toFixed(1)}`);

  return (
    <svg ref={svg} viewBox="0 0 320 240" className="studio-map-svg">
      {gridLines.map((h) => (
        <g key={h}>
          <line x1={34} x2={306} y1={y(h)} y2={y(h)} className={h === 0 ? "studio-map-floor" : "studio-map-gridline"} />
          <text x={28} y={y(h) + 3} textAnchor="end" fontSize={9} className="studio-map-label is-muted">
            {h === 0 ? "floor" : `${h} m`}
          </text>
        </g>
      ))}
      <defs>
        <linearGradient id="studio-height-stroke" x1="0" x2="1">
          <stop offset="0" stopColor="var(--path-start)" />
          <stop offset="1" stopColor="var(--path-end)" />
        </linearGradient>
      </defs>
      {keys.length >= 2 && (
        <>
          <polygon
            points={`${x(0)},${y(bottom)} ${line.join(" ")} ${x(lastFrame)},${y(bottom)}`}
            fill="url(#studio-height-stroke)"
            opacity={0.12}
          />
          <polyline points={line.join(" ")} fill="none" stroke="url(#studio-height-stroke)" strokeWidth={3} strokeLinecap="round" />
        </>
      )}
      <line x1={x(frame)} x2={x(frame)} y1={18} y2={y(bottom)} className="studio-map-playhead" />
      <circle cx={x(frame)} cy={y(playheadHeight)} r={4.5} className="studio-map-live-dot" strokeWidth={1.5} />
      {keys.map((key, index) => (
        <g
          key={key.id}
          className="studio-map-key"
          data-selected={key.id === selectedKeyId || undefined}
          transform={`translate(${x(key.frame)} ${y(key.position[1])})`}
          onPointerDown={(event) => startDrag(event, key)}
        >
          <circle r={11} fill="transparent" />
          <rect x={-5.5} y={-5.5} width={11} height={11} rx={2} transform="rotate(45)" strokeWidth={1.8} />
          <text y={-11} textAnchor="middle" fontSize={9.5} fontWeight={700} className="studio-map-label">
            {index + 1}
          </text>
        </g>
      ))}
      <text x={34} y={232} fontSize={9.5} className="studio-map-label is-muted">
        start
      </text>
      <text x={306} y={232} fontSize={9.5} textAnchor="end" className="studio-map-label is-muted">
        end · drag keys up or down
      </text>
    </svg>
  );
}
