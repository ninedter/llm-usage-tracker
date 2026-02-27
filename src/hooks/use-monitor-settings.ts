"use client";

import { useState, useEffect, useCallback } from "react";

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

export function useMonitorSettings() {
  const [fontSize, setFontSizeState] = useState<MonitorFontSize>(DEFAULT_SIZE);
  const [mounted, setMounted] = useState(false);

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored && stored in FONT_CLASSES) {
        setFontSizeState(stored as MonitorFontSize);
      }
    } catch {
      // localStorage not available
    }
    setMounted(true);
  }, []);

  const setFontSize = useCallback((size: MonitorFontSize) => {
    setFontSizeState(size);
    try {
      localStorage.setItem(STORAGE_KEY, size);
    } catch {
      // localStorage not available
    }
  }, []);

  const fontClasses = FONT_CLASSES[fontSize];

  return {
    fontSize,
    setFontSize,
    fontClasses,
    mounted,
    fontSizeOptions: (Object.keys(FONT_SIZE_LABELS) as MonitorFontSize[]).map((key) => ({
      value: key,
      label: FONT_SIZE_LABELS[key],
    })),
  };
}
