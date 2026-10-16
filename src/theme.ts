import { useCallback, useEffect, useSyncExternalStore } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type StudioTheme = "light" | "dark";

const STORAGE_KEY = "atlas-camera-studio-theme";
const media = () => window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    /* Storage can be unavailable; follow the device. */
  }
  return "system";
}

function resolve(preference: ThemePreference): StudioTheme {
  if (preference !== "system") return preference;
  return media().matches ? "dark" : "light";
}

/** index.html applies the same rule before first paint. */
function apply() {
  document.documentElement.dataset.theme = resolve(readPreference());
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useStudioTheme() {
  const preference = useSyncExternalStore(subscribe, readPreference);
  const theme = useSyncExternalStore(
    subscribe,
    () => (document.documentElement.dataset.theme as StudioTheme) ?? "light",
  );
  useEffect(() => {
    const query = media();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
  const setPreference = useCallback((next: ThemePreference) => {
    try {
      if (next === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* The choice still applies for this page. */
    }
    apply();
  }, []);
  return { preference, theme, setPreference };
}

/** Colours the 3D views use, matched to the CSS tokens. */
export const SCENE_PALETTE = {
  light: {
    background: "#f4f5f8",
    gridCell: "#e1e5ec",
    gridSection: "#c9d0db",
    casing: "#ffffff",
    key: "#1b2232",
    keyIdle: "#7c8798",
    source: "#a7b0bf",
    target: "#ff5b2e",
  },
  dark: {
    background: "#0b0e14",
    gridCell: "#1a202b",
    gridSection: "#283041",
    casing: "#0b0e14",
    key: "#edf0f6",
    keyIdle: "#8a94a8",
    source: "#5d6679",
    target: "#ff6a3d",
  },
} as const;

export const ACCENT = "#ff5b2e";
export const PATH_START = "#2f6bff";
export const PATH_END = "#9a5bff";
