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

// CSS class mappings for each font size tier
export const FONT_CLASSES: Record<MonitorFontSize, {
  /** 9px equivalent */
  tiny: string;
  /** 10px equivalent */
  micro: string;
  /** 11px equivalent */
  small: string;
  /** 12px / xs equivalent */
  base: string;
  /** 13-14px / sm equivalent */
  label: string;
  /** 14-16px heading */
  heading: string;
}> = {
  xs: {
    tiny: "text-[8px]",
    micro: "text-[9px]",
    small: "text-[10px]",
    base: "text-[11px]",
    label: "text-xs",
    heading: "text-sm",
  },
  sm: {
    tiny: "text-[9px]",
    micro: "text-[10px]",
    small: "text-[11px]",
    base: "text-xs",
    label: "text-sm",
    heading: "text-sm",
  },
  md: {
    tiny: "text-[10px]",
    micro: "text-[11px]",
    small: "text-xs",
    base: "text-sm",
    label: "text-sm",
    heading: "text-base",
  },
  lg: {
    tiny: "text-[11px]",
    micro: "text-xs",
    small: "text-sm",
    base: "text-sm",
    label: "text-base",
    heading: "text-lg",
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
