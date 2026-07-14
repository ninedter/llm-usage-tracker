"use client";

import { useSyncExternalStore } from "react";

// Module-level tick store: all subscribers share ONE interval, so any number
// of components can call useNow() without spawning per-component timers.
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function notify() {
  for (const listener of listeners) listener();
}

function startTicking() {
  if (timer !== null) return;
  timer = setInterval(notify, 1000);
}

function stopTicking() {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

// Hidden tabs get throttled/suspended timers anyway, but every AgentCard
// still re-renders on whatever ticks do land — pausing on document.hidden
// stops that re-render storm outright instead of relying on the browser.
function handleVisibility() {
  if (document.hidden) {
    stopTicking();
  } else {
    notify(); // immediate catch-up tick so "Xs ago" text is right on return
    startTicking();
  }
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  if (listeners.size === 1) {
    document.addEventListener("visibilitychange", handleVisibility);
    if (!document.hidden) {
      startTicking();
    }
  }
  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0) {
      document.removeEventListener("visibilitychange", handleVisibility);
      stopTicking();
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
