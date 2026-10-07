import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { EditHistory } from "./edit-history";

export function useEditHistory<T>(
  snapshot: T,
  scope: string | null,
  restore: (snapshot: T) => void,
) {
  const history = useRef(
    new EditHistory(
      snapshot,
      (a, b) => JSON.stringify(a) === JSON.stringify(b),
    ),
  );
  const currentScope = useRef(scope);
  const gesture = useRef<number | null>(null);
  const nextGesture = useRef(0);
  const frame = useRef(0);
  const [, refresh] = useState(0);
  useLayoutEffect(() => {
    if (currentScope.current !== scope) {
      currentScope.current = scope;
      history.current = new EditHistory(
        snapshot,
        (a, b) => JSON.stringify(a) === JSON.stringify(b),
      );
      refresh((value) => value + 1);
    } else if (scope && history.current.record(snapshot, gesture.current)) {
      refresh((value) => value + 1);
    }
  }, [snapshot, scope]);
  useEffect(() => {
    const start = () => {
      cancelAnimationFrame(frame.current);
      gesture.current = ++nextGesture.current;
    };
    // Keep pointer-up/click updates in the same transaction as the drag.
    const end = () => {
      frame.current = requestAnimationFrame(() => {
        gesture.current = null;
      });
    };
    window.addEventListener("pointerdown", start, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    window.addEventListener("blur", end);
    return () => {
      cancelAnimationFrame(frame.current);
      window.removeEventListener("pointerdown", start, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      window.removeEventListener("blur", end);
    };
  }, []);
  const travel = (direction: "undo" | "redo") => {
    const value = history.current[direction]();
    if (value !== null) {
      gesture.current = null;
      restore(value);
      refresh((current) => current + 1);
    }
  };
  return {
    canUndo: history.current.canUndo,
    canRedo: history.current.canRedo,
    undo: () => travel("undo"),
    redo: () => travel("redo"),
  };
}
