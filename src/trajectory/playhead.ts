import { useSyncExternalStore } from "react";

/**
 * One clock for the whole editor. The overview, the camera monitor, and the
 * timeline all read this store, so playback cannot drift between views, and
 * frame updates do not re-render the editor itself.
 */
export type Playhead = {
  /** Fractional frame in [0, lastFrame]. */
  readonly frame: number;
  readonly playing: boolean;
  readonly loop: boolean;
  setFrame(frame: number): void;
  play(): void;
  pause(): void;
  toggle(): void;
  setLoop(loop: boolean): void;
  configure(lastFrame: number, fps: number): void;
  subscribe(listener: () => void): () => void;
};

export function createPlayhead(lastFrame: number, fps: number): Playhead {
  let frame = 0;
  let playing = false;
  let loop = false;
  let raf = 0;
  let previousTime: number | null = null;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());

  const tick = (time: number) => {
    if (!playing) return;
    const elapsed = previousTime === null ? 0 : (time - previousTime) / 1000;
    previousTime = time;
    // A backgrounded tab resumes without jumping the whole shot.
    frame += Math.min(elapsed, 0.25) * fps;
    if (frame >= lastFrame) {
      if (loop && lastFrame > 0) frame %= lastFrame;
      else {
        frame = lastFrame;
        playing = false;
      }
    }
    emit();
    if (playing) raf = requestAnimationFrame(tick);
  };

  const store: Playhead = {
    get frame() {
      return frame;
    },
    get playing() {
      return playing;
    },
    get loop() {
      return loop;
    },
    setFrame(next) {
      const clamped = Math.min(Math.max(next, 0), lastFrame);
      if (clamped === frame) return;
      frame = clamped;
      emit();
    },
    play() {
      if (playing || lastFrame <= 0) return;
      if (frame >= lastFrame) frame = 0;
      playing = true;
      previousTime = null;
      raf = requestAnimationFrame(tick);
      emit();
    },
    pause() {
      if (!playing) return;
      playing = false;
      cancelAnimationFrame(raf);
      emit();
    },
    toggle() {
      if (playing) store.pause();
      else store.play();
    },
    setLoop(next) {
      loop = next;
      emit();
    },
    configure(nextLastFrame, nextFps) {
      lastFrame = nextLastFrame;
      fps = nextFps;
      if (frame > lastFrame) store.setFrame(lastFrame);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return store;
}

export function usePlayheadFrame(playhead: Playhead): number {
  return useSyncExternalStore(playhead.subscribe, () => playhead.frame);
}

export function usePlayheadPlaying(playhead: Playhead): boolean {
  return useSyncExternalStore(playhead.subscribe, () => playhead.playing);
}

export function usePlayheadLoop(playhead: Playhead): boolean {
  return useSyncExternalStore(playhead.subscribe, () => playhead.loop);
}

/** Whole frame, re-rendering only when it changes. */
export function usePlayheadWholeFrame(playhead: Playhead): number {
  return useSyncExternalStore(playhead.subscribe, () =>
    Math.round(playhead.frame),
  );
}
