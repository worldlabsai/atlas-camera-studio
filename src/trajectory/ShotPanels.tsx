import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import {
  ArrowLeftRight,
  Crosshair,
  Diamond,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Sparkles,
  StepBack,
  StepForward,
  Trash2,
  Video,
  Waves,
} from "lucide-react";
import { scrubNumber } from "./numeric-scrub";
import type { TrajectoryPoint } from "./camera-trajectory";
import {
  effectiveEase,
  type CameraAimMode,
  type KeyInterpolation,
  type ShotCurve,
} from "./keyframes";
import { usePlayheadFrame, type Playhead } from "./playhead";
import { CAMERA_MOVE_PRESETS, type CameraMovePreset } from "./presets";
import { formatTime, INTERPOLATION_LABELS, type TimeUnit } from "./Timeline";
import type { PilotPose } from "./Canvas";

export function Section({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="studio-section">
      <header>
        <h3>{title}</h3>
        {meta !== undefined && <span>{meta}</span>}
      </header>
      {children}
    </section>
  );
}

export function Toggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="studio-row">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className="studio-toggle"
        onClick={() => onChange(!checked)}
      />
    </label>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: ReactNode; title?: string; disabled?: boolean }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="studio-seg is-fill" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          disabled={option.disabled}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A number field whose label scrubs the value when dragged. */
export function ScrubField({
  label,
  value,
  step,
  precision = 2,
  suffix,
  min,
  max,
  tone,
  state,
  onChange,
}: {
  label: string;
  value: number;
  step: number;
  precision?: number;
  suffix?: string;
  min?: number;
  max?: number;
  tone?: "x" | "y" | "z";
  state?: "keyed" | "animated" | "pending";
  onChange: (value: number) => void;
}) {
  const format = (next: number) => next.toFixed(precision);
  const [draft, setDraft] = useState(format(value));
  const editing = useRef(false);
  const drag = useRef<{ x: number; value: number; pointerId: number } | null>(
    null,
  );
  useEffect(() => {
    if (!editing.current) setDraft(value.toFixed(precision));
  }, [precision, value]);
  function commit() {
    editing.current = false;
    const parsed = Number(draft.replace(/[^\d.+-]/g, ""));
    if (!draft.trim() || !Number.isFinite(parsed)) {
      setDraft(format(value));
      return;
    }
    const next = THREE.MathUtils.clamp(parsed, min ?? -Infinity, max ?? Infinity);
    setDraft(format(next));
    if (Math.abs(next - value) > 10 ** -(precision + 1)) onChange(next);
  }
  return (
    <label className="studio-field" data-state={state}>
      <span
        className="studio-field-axis"
        data-tone={tone}
        title={`Drag to adjust ${label}; hold Shift for fine steps`}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, value, pointerId: event.pointerId };
        }}
        onPointerMove={(event) => {
          const active = drag.current;
          if (!active || active.pointerId !== event.pointerId) return;
          const next = scrubNumber(
            active.value,
            event.clientX - active.x,
            step,
            event.shiftKey,
            min,
            max,
          );
          active.x = event.clientX;
          active.value = next;
          onChange(Number(next.toFixed(precision + 1)));
        }}
        onPointerUp={() => (drag.current = null)}
        onLostPointerCapture={() => (drag.current = null)}
      >
        {label}
      </span>
      <input
        aria-label={label}
        inputMode="decimal"
        value={draft + (editing.current || !suffix ? "" : suffix)}
        onFocus={() => {
          editing.current = true;
          setDraft(format(value));
        }}
        onChange={(event) => {
          editing.current = true;
          setDraft(event.target.value);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            editing.current = false;
            setDraft(format(value));
            event.currentTarget.blur();
          }
        }}
      />
      {state && <i className="studio-field-key" aria-hidden />}
    </label>
  );
}

const PRESET_GLYPHS: Record<CameraMovePreset, string> = {
  push: "M12 26 L68 8",
  pull: "M68 8 L12 26",
  truck: "M8 17 L72 17",
  orbit: "M10 24 C 22 3, 58 3, 70 24",
  crane: "M14 28 C 30 28, 40 8, 66 6",
  arc: "M8 9 C 30 30, 50 30, 72 12",
};

export function PathPanel({
  map,
  imageUrl,
  fileName,
  keyCount,
  travel,
  allowBelowFloor,
  onReplaceImage,
  onPreset,
  onTravelChange,
  onEvenSpacing,
  onSmoothAll,
  onReset,
  onAllowBelowFloorChange,
}: {
  map: ReactNode;
  imageUrl: string;
  fileName: string;
  keyCount: number;
  travel: number;
  allowBelowFloor: boolean;
  onReplaceImage: () => void;
  onPreset: (preset: CameraMovePreset) => void;
  onTravelChange: (travel: number) => void;
  onEvenSpacing: () => void;
  onSmoothAll: () => void;
  onReset: () => void;
  onAllowBelowFloorChange: (allow: boolean) => void;
}) {
  return (
    <>
      <section className="studio-section is-first">
        <div className="studio-scene-card">
          <img src={imageUrl} alt="" />
          <div>
            <strong title={fileName}>{fileName}</strong>
            <span>
              <i />
              Depth ready
            </span>
          </div>
          <button
            type="button"
            className="studio-icon-button"
            title="Use a different image"
            aria-label="Use a different image"
            onClick={onReplaceImage}
          >
            <ArrowLeftRight className="h-4 w-4" />
          </button>
        </div>
      </section>
      <section className="studio-section">
        {map}
        <div className="studio-tool-row">
          <button
            type="button"
            className="studio-button"
            disabled={keyCount < 3}
            title="Retime keys so the camera moves at an even pace"
            onClick={onEvenSpacing}
          >
            <ArrowLeftRight className="h-3.5 w-3.5" />
            Even pace
          </button>
          <button
            type="button"
            className="studio-button"
            disabled={keyCount < 2}
            title="Smooth motion through every key"
            onClick={onSmoothAll}
          >
            <Waves className="h-3.5 w-3.5" />
            Smooth
          </button>
          <button
            type="button"
            className="studio-button"
            title="Start over from the source camera"
            onClick={onReset}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset
          </button>
        </div>
      </section>
      <Section title="Camera moves" meta="Replaces the shot">
        <div className="studio-presets">
          {CAMERA_MOVE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="studio-preset"
              title={`${preset.label}. Undo restores your shot.`}
              onClick={() => onPreset(preset.id)}
            >
              <svg viewBox="0 0 80 34" aria-hidden>
                <path d={PRESET_GLYPHS[preset.id]} />
              </svg>
              {preset.label.replace(/ (left|right)$/, "")}
            </button>
          ))}
        </div>
        <label className="studio-row">
          <span>Travel</span>
          <input
            type="range"
            className="studio-range"
            min="0.1"
            max="0.6"
            step="0.05"
            value={travel}
            style={{ "--fill": `${((travel - 0.1) / 0.5) * 100}%` } as React.CSSProperties}
            onChange={(event) => onTravelChange(Number(event.target.value))}
            aria-label="Camera move amount"
          />
          <span className="studio-value">{Math.round(travel * 100)}%</span>
        </label>
      </Section>
      <Section title="Limits">
        <Toggle
          label="Keep camera above the floor"
          checked={!allowBelowFloor}
          onChange={(keep) => onAllowBelowFloorChange(!keep)}
        />
      </Section>
    </>
  );
}

export function CameraPanel({
  playhead,
  curve,
  selectedKeyId,
  pendingPose,
  aimMode,
  aimTarget,
  fovDegrees,
  minFov,
  maxFov,
  fps,
  frameCount,
  unit,
  allowBelowFloor,
  onPilot,
  onToggleKey,
  onSetPending,
  onJumpKey,
  onSelectKey,
  onPoseChange,
  onAimModeChange,
  onPickTarget,
  onCenterTarget,
  onInterpolationChange,
  onEaseChange,
  onGapChange,
  onDeleteKey,
  onFovChange,
  onGoToEnd,
}: {
  playhead: Playhead;
  curve: ShotCurve;
  selectedKeyId: string | null;
  pendingPose: PilotPose | null;
  aimMode: CameraAimMode;
  aimTarget: TrajectoryPoint | null;
  fovDegrees: number;
  minFov: number;
  maxFov: number;
  fps: number;
  frameCount: number;
  unit: TimeUnit;
  allowBelowFloor: boolean;
  onPilot: () => void;
  onToggleKey: () => void;
  onSetPending: () => void;
  onJumpKey: (direction: -1 | 1) => void;
  onSelectKey: (id: string) => void;
  onPoseChange: (pose: PilotPose) => void;
  onAimModeChange: (mode: CameraAimMode) => void;
  onPickTarget: () => void;
  onCenterTarget: () => void;
  onInterpolationChange: (id: string, interpolation: KeyInterpolation) => void;
  onEaseChange: (id: string, ease: number | null) => void;
  onGapChange: (index: number, frames: number) => void;
  onDeleteKey: (id: string) => void;
  onFovChange: (degrees: number) => void;
  onGoToEnd: () => void;
}) {
  const frame = usePlayheadFrame(playhead);
  const keys = curve.keyframes;
  const whole = Math.round(frame);
  const keyHere = frame === whole ? keys.find((key) => key.frame === whole) : undefined;
  const keyIndex = keyHere ? keys.indexOf(keyHere) : -1;
  const pose = pendingPose ?? (keys.length ? curve.poseAt(frame) : null);
  const selectedIndex = keys.findIndex((key) => key.id === selectedKeyId);
  const selected = selectedIndex >= 0 ? keys[selectedIndex]! : null;
  const fieldState = pendingPose ? "pending" : keyHere ? "keyed" : "animated";
  const edit = (patch: Partial<PilotPose>) => {
    if (!pose) return;
    onPoseChange({
      position: [...pose.position],
      yaw: pose.yaw,
      pitch: pose.pitch,
      ...patch,
    });
  };

  return (
    <>
      <section className="studio-section is-first">
        <div className="studio-keybar" data-state={pendingPose ? "pending" : keyHere ? "keyed" : "between"}>
          <span className="studio-keybar-diamond" aria-hidden />
          <div>
            <strong>
              {pendingPose
                ? "Unkeyed change"
                : keyHere
                  ? `Key ${keyIndex + 1}`
                  : "Between keys"}
            </strong>
            <span>
              {formatTime(frame, fps, unit)}
              {pendingPose ? " · press Set key to keep it" : ""}
            </span>
          </div>
          <span className="flex-1" />
          <button
            type="button"
            className="studio-icon-button"
            title="Previous key"
            aria-label="Previous key"
            onClick={() => onJumpKey(-1)}
          >
            <StepBack className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="studio-icon-button"
            title="Next key"
            aria-label="Next key"
            onClick={() => onJumpKey(1)}
          >
            <StepForward className="h-4 w-4" />
          </button>
        </div>
        <div className="studio-pilot-row">
          <button type="button" className="studio-button is-primary" onClick={onPilot}>
            <Video className="h-4 w-4" />
            Pilot camera
            <kbd>C</kbd>
          </button>
          <button
            type="button"
            className={`studio-button ${pendingPose ? "is-accent" : ""}`}
            onClick={pendingPose ? onSetPending : onToggleKey}
            title={keyHere && !pendingPose ? "Delete this key" : "Key the camera at the playhead (I)"}
          >
            {keyHere && !pendingPose ? (
              <Trash2 className="h-3.5 w-3.5" />
            ) : (
              <Diamond className="h-3.5 w-3.5" />
            )}
            {pendingPose ? "Set key" : keyHere ? "Delete key" : "Set key"}
          </button>
        </div>
        {keys.length < 2 && (
          <div className="studio-guide">
            <strong>Build the shot in two steps</strong>
            <ol>
              <li>Key 1 starts at the source camera.</li>
              <li>
                Jump to the end, pilot the camera to where the shot should
                finish, and set a key. Atlas animates everything in between.
              </li>
            </ol>
            <button type="button" className="studio-button is-small" onClick={onGoToEnd}>
              <StepForward className="h-3.5 w-3.5" />
              Go to end
            </button>
          </div>
        )}
      </section>

      {pose && (
        <Section title="Position" meta="meters">
          <div className="studio-fields">
            {(["X", "Y", "Z"] as const).map((axis, index) => (
              <ScrubField
                key={axis}
                label={axis}
                tone={axis.toLowerCase() as "x" | "y" | "z"}
                value={pose.position[index]!}
                step={0.01}
                min={index === 1 && !allowBelowFloor ? 0 : undefined}
                state={fieldState}
                onChange={(value) => {
                  const position = [...pose.position] as TrajectoryPoint;
                  position[index] = value;
                  edit({ position });
                }}
              />
            ))}
          </div>
        </Section>
      )}

      <Section title="Aim">
        <Segmented
          label="Aim"
          value={aimMode}
          onChange={onAimModeChange}
          options={[
            { value: "free", label: "Free", title: "Each key keeps its own pan and tilt" },
            { value: "look_at", label: "Look at", title: "Always face one point" },
            { value: "forward", label: "Ahead", title: "Face the direction of travel" },
          ]}
        />
        {aimMode === "free" && pose && (
          <div className="studio-fields is-two">
            <ScrubField
              label="Pan"
              value={pose.yaw}
              step={0.5}
              precision={1}
              suffix="°"
              state={fieldState}
              onChange={(yaw) => edit({ yaw })}
            />
            <ScrubField
              label="Tilt"
              value={pose.pitch}
              step={0.5}
              precision={1}
              suffix="°"
              min={-85}
              max={85}
              state={fieldState}
              onChange={(pitch) => edit({ pitch })}
            />
          </div>
        )}
        {aimMode === "look_at" && (
          <div className="studio-target-row">
            <Crosshair className="h-3.5 w-3.5" />
            <span className="studio-mono">
              {aimTarget ? aimTarget.map((value) => value.toFixed(2)).join(", ") : "Scene center"}
            </span>
            <span className="flex-1" />
            <button type="button" className="studio-button is-small is-ghost" onClick={onCenterTarget}>
              Center
            </button>
            <button type="button" className="studio-button is-small" onClick={onPickTarget}>
              Pick
            </button>
          </div>
        )}
        {aimMode === "forward" && (
          <p className="studio-note">The camera faces where it is heading.</p>
        )}
      </Section>

      {selected && (
        <Section
          title={`Key ${selectedIndex + 1}`}
          meta={selectedIndex < keys.length - 1 ? `to key ${selectedIndex + 2}` : "last key"}
        >
          {selectedIndex < keys.length - 1 && (
            <div className="studio-interp" role="group" aria-label="Motion to the next key">
              {(["smooth", "linear", "hold"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={selected.interpolation === value}
                  onClick={() => onInterpolationChange(selected.id, value)}
                >
                  <svg viewBox="0 0 44 20" aria-hidden>
                    <path
                      d={
                        value === "smooth"
                          ? "M3 17 C 20 17, 24 3, 41 3"
                          : value === "linear"
                            ? "M3 17 L41 3"
                            : "M3 17 H 38 V 3 H 41"
                      }
                    />
                  </svg>
                  {INTERPOLATION_LABELS[value]}
                </button>
              ))}
            </div>
          )}
          <label className="studio-row" title="How fully the camera slows to a stop at this key">
            <span>Settle</span>
            <input
              type="range"
              className="studio-range"
              min="0"
              max="1"
              step="0.05"
              value={effectiveEase(keys, selectedIndex)}
              style={{ "--fill": `${effectiveEase(keys, selectedIndex) * 100}%` } as React.CSSProperties}
              onChange={(event) => onEaseChange(selected.id, Number(event.target.value))}
              aria-label="Settle at this key"
            />
            <span className="studio-value">
              {selected.ease === null ? "Auto" : `${Math.round(effectiveEase(keys, selectedIndex) * 100)}%`}
            </span>
          </label>
          {selected.ease !== null && (
            <button
              type="button"
              className="studio-link"
              onClick={() => onEaseChange(selected.id, null)}
            >
              <RefreshCw className="h-3 w-3" />
              Back to automatic
            </button>
          )}
        </Section>
      )}

      <Section title="Keys" meta={`${keys.length}`}>
        <ol className="studio-keys">
          {keys.map((key, index) => (
            <li key={key.id}>
              <div className="studio-key-row" data-selected={key.id === selectedKeyId || undefined}>
                <button
                  type="button"
                  className="studio-key-select"
                  onClick={() => onSelectKey(key.id)}
                >
                  <i aria-hidden />
                  <strong>Key {index + 1}</strong>
                  <span className="studio-mono">{formatTime(key.frame, fps, unit)}</span>
                </button>
                <span className="studio-key-motion">
                  {index < keys.length - 1 ? INTERPOLATION_LABELS[key.interpolation] : "End"}
                </span>
                <button
                  type="button"
                  className="studio-icon-button is-small"
                  title={`Delete key ${index + 1}`}
                  aria-label={`Delete key ${index + 1}`}
                  disabled={keys.length <= 1}
                  onClick={() => onDeleteKey(key.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              {index < keys.length - 1 && (
                <GapField
                  frames={keys[index + 1]!.frame - key.frame}
                  fps={fps}
                  unit={unit}
                  max={frameCount - 1}
                  onChange={(frames) => onGapChange(index, frames)}
                />
              )}
            </li>
          ))}
        </ol>
      </Section>

      <Section title="Lens" meta="whole shot">
        <label className="studio-row">
          <span>Field of view</span>
          <input
            type="range"
            className="studio-range"
            min={minFov}
            max={Math.min(maxFov, 120)}
            step="1"
            value={fovDegrees}
            style={{ "--fill": `${((fovDegrees - minFov) / (Math.min(maxFov, 120) - minFov)) * 100}%` } as React.CSSProperties}
            onChange={(event) => onFovChange(Number(event.target.value))}
            aria-label="Vertical field of view"
          />
          <span className="studio-value">{fovDegrees}°</span>
        </label>
      </Section>
    </>
  );
}

function GapField({
  frames,
  fps,
  unit,
  max,
  onChange,
}: {
  frames: number;
  fps: number;
  unit: TimeUnit;
  max: number;
  onChange: (frames: number) => void;
}) {
  const shown = unit === "frames" ? String(frames) : (frames / fps).toFixed(2);
  const [draft, setDraft] = useState(shown);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(shown);
  }, [shown]);
  function commit() {
    editing.current = false;
    const parsed = Number(draft);
    if (!Number.isFinite(parsed) || parsed <= 0) return setDraft(shown);
    const next = THREE.MathUtils.clamp(
      Math.round(unit === "frames" ? parsed : parsed * fps),
      1,
      max,
    );
    if (next !== frames) onChange(next);
    else setDraft(shown);
  }
  return (
    <label className="studio-gap">
      <span aria-hidden className="studio-gap-line" />
      <input
        aria-label="Time to the next key"
        inputMode="decimal"
        value={draft}
        onFocus={() => (editing.current = true)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            editing.current = false;
            setDraft(shown);
            event.currentTarget.blur();
          }
        }}
      />
      <span>{unit === "frames" ? "frames" : "sec"} to next key</span>
    </label>
  );
}

const PROMPT_IDEAS = [
  "Slow, cinematic motion",
  "Soft natural light",
  "Gentle ambient movement",
  "Steady, no camera shake",
];

export function VideoPanel({
  prompt,
  seedCount,
  minSeeds,
  maxSeeds,
  firstSeed,
  aspectRatio,
  portraitEnabled,
  frameCount,
  fps,
  frameWidth,
  frameHeight,
  keyCount,
  generateLabel,
  canGenerate,
  submitting,
  savingDraft,
  onPromptChange,
  onSeedCountChange,
  onAspectRatioChange,
  onGenerate,
  onSaveDraft,
}: {
  prompt: string;
  seedCount: number;
  minSeeds: number;
  maxSeeds: number;
  firstSeed: number;
  aspectRatio: "16:9" | "9:16";
  portraitEnabled: boolean;
  frameCount: number;
  fps: number;
  frameWidth: number;
  frameHeight: number;
  keyCount: number;
  generateLabel: string;
  canGenerate: boolean;
  submitting: boolean;
  savingDraft: boolean;
  onPromptChange: (prompt: string) => void;
  onSeedCountChange: (count: number) => void;
  onAspectRatioChange: (ratio: "16:9" | "9:16") => void;
  onGenerate: () => void;
  onSaveDraft: () => void;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(260, Math.max(108, element.scrollHeight + 2))}px`;
  }, [prompt]);
  return (
    <>
      <Section title="Prompt" meta={prompt.trim() ? undefined : "Required"}>
        <div className="studio-prompt">
          <textarea
            ref={textarea}
            aria-label="Video prompt"
            value={prompt}
            maxLength={1000}
            rows={4}
            placeholder="Describe what happens during the shot — e.g. firelight flickers as snow drifts past the window"
            onChange={(event) => onPromptChange(event.target.value)}
          />
          <div className="studio-prompt-foot">
            {prompt && (
              <button
                type="button"
                className="studio-button is-small is-ghost"
                onClick={() => onPromptChange("")}
              >
                Clear
              </button>
            )}
            <span className="flex-1" />
            <span className="studio-mono">{prompt.length} / 1000</span>
          </div>
        </div>
        <div className="studio-chips">
          {PROMPT_IDEAS.map((idea) => (
            <button
              key={idea}
              type="button"
              className="studio-chip"
              onClick={() => {
                const trimmed = prompt.trim().replace(/[.,;\s]+$/, "");
                onPromptChange(
                  trimmed ? `${trimmed}. ${idea}.` : `${idea}.`,
                );
              }}
            >
              <Plus className="h-3 w-3" />
              {idea}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Format">
        <Segmented
          label="Aspect ratio"
          value={aspectRatio}
          onChange={onAspectRatioChange}
          options={[
            { value: "16:9", label: "16:9 Landscape" },
            {
              value: "9:16",
              label: (
                <>
                  9:16 {!portraitEnabled && <span className="studio-soon">Soon</span>}
                </>
              ),
              disabled: !portraitEnabled,
            },
          ]}
        />
        <div className="studio-stats">
          <div>
            <strong>{(frameCount / fps).toFixed(1)}s</strong>
            <span>Length</span>
          </div>
          <div>
            <strong>{frameCount}</strong>
            <span>Frames</span>
          </div>
          <div>
            <strong>{fps}</strong>
            <span>FPS</span>
          </div>
          <div>
            <strong>{frameHeight}p</strong>
            <span>{frameWidth}×{frameHeight}</span>
          </div>
        </div>
      </Section>

      <Section
        title="Takes"
        meta={seedCount === 1 ? `Seed ${firstSeed}` : `Seeds ${firstSeed}–${firstSeed + seedCount - 1}`}
      >
        <div className="studio-row">
          <span>Versions to generate</span>
          <div className="studio-stepper">
            <button
              type="button"
              aria-label="Fewer versions"
              disabled={seedCount <= minSeeds}
              onClick={() => onSeedCountChange(seedCount - 1)}
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <strong>{seedCount}</strong>
            <button
              type="button"
              aria-label="More versions"
              disabled={seedCount >= maxSeeds}
              onClick={() => onSeedCountChange(seedCount + 1)}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </Section>

      <section className="studio-section">
        <div className="studio-summary">
          <dl>
            <dt>Camera</dt>
            <dd>
              {keyCount} key{keyCount === 1 ? "" : "s"} · {(frameCount / fps).toFixed(1)}s
            </dd>
            <dt>Videos</dt>
            <dd>
              {seedCount} × 1 generation
            </dd>
          </dl>
          <button
            type="button"
            className="studio-cta is-wide"
            disabled={!canGenerate}
            onClick={onGenerate}
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {generateLabel}
          </button>
          <button
            type="button"
            className="studio-button is-wide is-ghost"
            disabled={savingDraft || submitting}
            onClick={onSaveDraft}
          >
            {savingDraft ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            {savingDraft ? "Saving…" : "Save draft"}
          </button>
        </div>
      </section>
    </>
  );
}
