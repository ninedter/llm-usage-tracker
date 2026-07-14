"use client";

import { useCallback, useSyncExternalStore } from "react";

export type MonitorFontSize = "xs" | "sm" | "md" | "lg";

const STORAGE_KEY = "monitor-font-size";
const DEFAULT_SIZE: MonitorFontSize = "sm";

const FONT_SIZE_LABELS: Record<MonitorFontSize, string> = {
  xs: "Extra Small",
  sm: "Small",
  md: "Medium",
  lg: "Large",
};

// CSS class mappings for each font size tier. Readability floor: even the
// "xs" tier bottoms out at 11px, and the default "sm" tier never goes below
// 12px (text-xs) with feed body text at 14px (text-sm).
export const FONT_CLASSES: Record<MonitorFontSize, {
  /** 11-14px equivalent — smallest labels/badges */
  tiny: string;
  /** 12-14px equivalent — timestamps, event labels */
  micro: string;
  /** 12-16px equivalent — summaries, secondary lines */
  small: string;
  /** 14-18px equivalent — primary body text */
  base: string;
  /** 14-20px label */
  label: string;
  /** 16-24px heading */
  heading: string;
}> = {
  xs: {
    tiny: "text-[11px]",
    micro: "text-xs",
    small: "text-xs",
    base: "text-sm",
    label: "text-sm",
    heading: "text-base",
  },
  sm: {
    tiny: "text-xs",
    micro: "text-xs",
    small: "text-sm",
    base: "text-sm",
    label: "text-base",
    heading: "text-lg",
  },
  md: {
    tiny: "text-xs",
    micro: "text-sm",
    small: "text-sm",
    base: "text-base",
    label: "text-lg",
    heading: "text-xl",
  },
  lg: {
    tiny: "text-sm",
    micro: "text-sm",
    small: "text-base",
    base: "text-lg",
    label: "text-xl",
    heading: "text-2xl",
  },
};

// localStorage is the source of truth, exposed to React as an external store.
// The custom event keeps every useMonitorSettings() instance in this window in
// sync; the native "storage" event covers changes from other windows/tabs.
const FONT_SIZE_CHANGE_EVENT = "monitor-font-size-change";

function subscribeToFontSize(onStoreChange: () => void) {
  window.addEventListener(FONT_SIZE_CHANGE_EVENT, onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    window.removeEventListener(FONT_SIZE_CHANGE_EVENT, onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

function getFontSizeSnapshot(): MonitorFontSize {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && stored in FONT_CLASSES) {
      return stored as MonitorFontSize;
    }
  } catch {
    // localStorage not available
  }
  return DEFAULT_SIZE;
}

function getServerFontSizeSnapshot(): MonitorFontSize {
  return DEFAULT_SIZE;
}

export function useMonitorSettings() {
  const fontSize = useSyncExternalStore(
    subscribeToFontSize,
    getFontSizeSnapshot,
    getServerFontSizeSnapshot
  );

  const setFontSize = useCallback((size: MonitorFontSize) => {
    try {
      localStorage.setItem(STORAGE_KEY, size);
    } catch {
      // localStorage not available
    }
    window.dispatchEvent(new Event(FONT_SIZE_CHANGE_EVENT));
  }, []);

  const fontClasses = FONT_CLASSES[fontSize];

  return {
    fontSize,
    setFontSize,
    fontClasses,
    fontSizeOptions: (Object.keys(FONT_SIZE_LABELS) as MonitorFontSize[]).map((key) => ({
      value: key,
      label: FONT_SIZE_LABELS[key],
    })),
  };
}
