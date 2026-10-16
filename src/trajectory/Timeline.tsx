import { useMemo, useRef, type PointerEvent as ReactPointerEvent } from "react";
import {
  Diamond,
  Pause,
  Play,
  Repeat,
  SkipBack,
  SkipForward,
  StepBack,
  StepForward,
} from "lucide-react";
import { capturePointer } from "./pointer";
import type {
  CameraKeyframe,
  KeyInterpolation,
  ShotCurve,
} from "./keyframes";
import {
  usePlayheadFrame,
  usePlayheadLoop,
  usePlayheadPlaying,
  type Playhead,
} from "./playhead";

export type TimeUnit = "seconds" | "frames";

export const INTERPOLATION_LABELS: Record<KeyInterpolation, string> = {
  smooth: "Smooth",
  linear: "Linear",
  hold: "Hold",
};

export function formatTime(frame: number, fps: number, unit: TimeUnit) {
  return unit === "frames"
    ? `${Math.round(frame)}f`
    : `${(frame / fps).toFixed(2)}s`;
}

export function Timeline({
  playhead,
  curve,
  frameCount,
  fps,
  unit,
  selectedKeyId,
  autoKey,
  onUnitChange,
  onAutoKeyChange,
  onSelectKey,
  onRetimeKey,
  onToggleKey,
  onInterpolationChange,
}: {
  playhead: Playhead;
  curve: ShotCurve;
  frameCount: number;
  fps: number;
  unit: TimeUnit;
  selectedKeyId: string | null;
  autoKey: boolean;
  onUnitChange: (unit: TimeUnit) => void;
  onAutoKeyChange: (autoKey: boolean) => void;
  onSelectKey: (id: string) => void;
  onRetimeKey: (id: string, frame: number) => void;
  onToggleKey: () => void;
  onInterpolationChange: (id: string, interpolation: KeyInterpolation) => void;
}) {
  const keys = curve.keyframes;
  const frame = usePlayheadFrame(playhead);
  const playing = usePlayheadPlaying(playhead);
  const loop = usePlayheadLoop(playhead);
  const lastFrame = frameCount - 1;
  const wholeFrame = Math.round(frame);
  const keyHere = keys.find((key) => key.frame === wholeFrame && frame === wholeFrame);
  const selectedIndex = keys.findIndex((key) => key.id === selectedKeyId);
  const selected = selectedIndex >= 0 ? keys[selectedIndex]! : null;
  const percent = (value: number) => `${(value / lastFrame) * 100}%`;
  const track = useRef<HTMLDivElement>(null);

  const speeds = useMemo(() => {
    const values: number[] = [];
    for (let f = 0; f <= lastFrame; f += 0.5) {
      const a = curve.positionAt(Math.max(0, f - 0.25));
      const b = curve.positionAt(Math.min(lastFrame, f + 0.25));
      values.push(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
    }
    const peak = Math.max(...values, 1e-6);
    return values.map((value, index) => [
      (index * 0.5 * 1000) / lastFrame,
      28 - (value / peak) * 24,
    ]);
  }, [curve, lastFrame]);

  function frameFromPointer(event: { clientX: number }) {
    const rect = track.current!.getBoundingClientRect();
    return Math.round(
      Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1) *
        lastFrame,
    );
  }

  function scrub(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    if ((event.target as Element).closest("[data-key-id]")) return;
    playhead.pause();
    capturePointer(event.currentTarget, event.pointerId);
    playhead.setFrame(frameFromPointer(event));
  }

  function dragKey(event: ReactPointerEvent<HTMLButtonElement>, key: CameraKeyframe) {
    if (event.button !== 0) return;
    event.stopPropagation();
    playhead.pause();
    onSelectKey(key.id);
    playhead.setFrame(key.frame);
    const pointerId = event.pointerId;
    const element = event.currentTarget;
    capturePointer(element, pointerId);
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const next = frameFromPointer(moveEvent);
      onRetimeKey(key.id, next);
    };
    const end = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return;
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", end);
      element.removeEventListener("pointercancel", end);
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", end);
    element.addEventListener("pointercancel", end);
  }

  const jump = (direction: -1 | 1) => {
    playhead.pause();
    const target =
      direction < 0
        ? [...keys].reverse().find((key) => key.frame < frame - 0.01)
        : keys.find((key) => key.frame > frame + 0.01);
    if (target) {
      playhead.setFrame(target.frame);
      onSelectKey(target.id);
    }
  };

  const ticks = useMemo(() => {
    const items: { frame: number; major: boolean; label: string | null }[] = [];
    for (let f = 0; f <= lastFrame; f++) {
      const major = f % fps === 0;
      const label =
        unit === "seconds"
          ? major
            ? `${f / fps}s`
            : null
          : f % 6 === 0
            ? `${f}`
            : null;
      items.push({ frame: f, major, label });
    }
    return items;
  }, [fps, lastFrame, unit]);

  return (
    <section className="studio-timeline" aria-label="Timeline">
      <div className="studio-timeline-head">
        <div className="studio-transport">
          <button
            type="button"
            className="studio-icon-button hide-compact"
            title="Go to start (Home)"
            aria-label="Go to start"
            onClick={() => {
              playhead.pause();
              playhead.setFrame(0);
            }}
          >
            <SkipBack className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="studio-icon-button"
            title="Previous key (↓)"
            aria-label="Previous key"
            onClick={() => jump(-1)}
          >
            <StepBack className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="studio-play"
            title={playing ? "Pause (Space)" : "Play (Space)"}
            aria-label={playing ? "Pause" : "Play"}
            disabled={keys.length < 2}
            onClick={playhead.toggle}
          >
            {playing ? (
              <Pause className="h-4 w-4" fill="currentColor" />
            ) : (
              <Play className="h-4 w-4 translate-x-px" fill="currentColor" />
            )}
          </button>
          <button
            type="button"
            className="studio-icon-button"
            title="Next key (↑)"
            aria-label="Next key"
            onClick={() => jump(1)}
          >
            <StepForward className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="studio-icon-button hide-compact"
            title="Go to end (End)"
            aria-label="Go to end"
            onClick={() => {
              playhead.pause();
              playhead.setFrame(lastFrame);
            }}
          >
            <SkipForward className="h-4 w-4" />
          </button>
        </div>
        <div className="studio-timecode" aria-live="off">
          <span>{formatTime(frame, fps, unit)}</span>
          <small>/ {formatTime(unit === "frames" ? lastFrame : frameCount, fps, unit)}</small>
        </div>
        <div className="studio-seg is-small hide-compact" role="group" aria-label="Time unit">
          <button
            type="button"
            aria-pressed={unit === "seconds"}
            onClick={() => onUnitChange("seconds")}
          >
            Sec
          </button>
          <button
            type="button"
            aria-pressed={unit === "frames"}
            onClick={() => onUnitChange("frames")}
          >
            Frames
          </button>
        </div>
        <span className="studio-vsep hide-compact" />
        <button
          type="button"
          className="studio-autokey"
          aria-pressed={autoKey}
          title="Auto key: moving the camera records a key at the playhead"
          onClick={() => onAutoKeyChange(!autoKey)}
        >
          <i />
          Auto key
        </button>
        <button
          type="button"
          className="studio-button hide-compact"
          title={keyHere ? "Delete the key at the playhead" : "Key the camera at the playhead (I)"}
          onClick={onToggleKey}
        >
          <Diamond className="h-3.5 w-3.5" />
          {keyHere ? "Delete key" : "Insert key"}
        </button>
        <span className="flex-1" />
        {selected && selectedIndex < keys.length - 1 && (
          <label className="studio-select-chip hide-compact" title="Motion from the selected key to the next">
            <span>Motion</span>
            <select
              value={selected.interpolation}
              onChange={(event) =>
                onInterpolationChange(
                  selected.id,
                  event.target.value as KeyInterpolation,
                )
              }
            >
              {(Object.keys(INTERPOLATION_LABELS) as KeyInterpolation[]).map(
                (value) => (
                  <option key={value} value={value}>
                    {INTERPOLATION_LABELS[value]}
                  </option>
                ),
              )}
            </select>
          </label>
        )}
        <button
          type="button"
          className="studio-icon-button"
          aria-pressed={loop}
          title="Loop playback"
          aria-label="Loop playback"
          onClick={() => playhead.setLoop(!loop)}
        >
          <Repeat className="h-4 w-4" />
        </button>
      </div>
      <div className="studio-timeline-body">
        <div className="studio-timeline-labels" aria-hidden>
          <span className="is-main">
            <i />
            Camera
          </span>
          <span>Speed</span>
        </div>
        <div className="studio-timeline-tracks" onPointerDown={scrub} onPointerMove={(event) => {
          if (event.buttons !== 1 || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
          playhead.setFrame(frameFromPointer(event));
        }}>
          <div className="studio-timeline-inner" ref={track}>
            <div className="studio-ruler">
              {ticks.map((tick) => (
                <span
                  key={tick.frame}
                  className={tick.major ? "is-major" : undefined}
                  style={{ left: percent(tick.frame) }}
                >
                  {tick.label && <em>{tick.label}</em>}
                </span>
              ))}
            </div>
            <div className="studio-track is-keys">
              {keys.slice(0, -1).map((key, index) => (
                <span
                  key={key.id}
                  className={`studio-span is-${key.interpolation}`}
                  style={{
                    left: percent(key.frame),
                    width: percent(keys[index + 1]!.frame - key.frame),
                  }}
                />
              ))}
              {keys.map((key, index) => (
                <button
                  key={key.id}
                  type="button"
                  data-key-id={key.id}
                  className="studio-diamond"
                  aria-pressed={key.id === selectedKeyId}
                  aria-label={`Key ${index + 1} at ${formatTime(key.frame, fps, unit)}`}
                  title={`Key ${index + 1} · ${formatTime(key.frame, fps, unit)} · drag to retime`}
                  style={{ left: percent(key.frame) }}
                  onPointerDown={(event) => dragKey(event, key)}
                />
              ))}
            </div>
            <div className="studio-track is-speed">
              {keys.length >= 2 && (
                <svg viewBox="0 0 1000 30" preserveAspectRatio="none" aria-hidden>
                  <defs>
                    <linearGradient id="studio-speed" x1="0" x2="1">
                      <stop offset="0" stopColor="var(--path-start)" />
                      <stop offset="1" stopColor="var(--path-end)" />
                    </linearGradient>
                  </defs>
                  <polygon
                    points={`0,30 ${speeds.map(([x, y]) => `${x!.toFixed(1)},${y!.toFixed(2)}`).join(" ")} 1000,30`}
                    fill="url(#studio-speed)"
                    opacity="0.18"
                  />
                  <polyline
                    points={speeds.map(([x, y]) => `${x!.toFixed(1)},${y!.toFixed(2)}`).join(" ")}
                    fill="none"
                    stroke="url(#studio-speed)"
                    strokeWidth="1.6"
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
              )}
            </div>
            <div className="studio-playhead" style={{ left: percent(frame) }}>
              <span>{unit === "frames" ? wholeFrame : (frame / fps).toFixed(1)}</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
