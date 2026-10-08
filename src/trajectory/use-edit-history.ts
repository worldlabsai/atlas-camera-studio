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
    // Keep the transaction open until the next input. A pointer-move render
    // can commit after pointer-up (even after its animation frame); clearing
    // the group on pointer-up would split that drag into two undo steps.
    const start = () => {
      gesture.current = ++nextGesture.current;
    };
    window.addEventListener("pointerdown", start, true);
    window.addEventListener("keydown", start, true);
    return () => {
      window.removeEventListener("pointerdown", start, true);
      window.removeEventListener("keydown", start, true);
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
