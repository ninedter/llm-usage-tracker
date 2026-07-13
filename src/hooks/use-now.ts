"use client";

import { useSyncExternalStore } from "react";

// Module-level tick store: all subscribers share ONE interval, so any number
// of components can call useNow() without spawning per-component timers.
const listeners = new Set<() => void>();
let intervalId: ReturnType<typeof setInterval> | null = null;

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  if (intervalId === null) {
    intervalId = setInterval(() => {
      for (const listener of listeners) listener();
    }, 1000);
  }
  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0 && intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };
}

// Quantized to the second so the snapshot stays stable between ticks.
function getSnapshot(): number {
  return Math.floor(Date.now() / 1000) * 1000;
}

// Live elapsed displays are never server-rendered (agent data arrives via
// SWR/SSE on the client), so the server snapshot value is inconsequential.
function getServerSnapshot(): number {
  return 0;
}

/** Current timestamp in ms, updated once per second via a single shared interval. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
