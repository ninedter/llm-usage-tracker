"use client";

import { useCallback, useEffect, useState } from "react";
import { useDataManagement, type PurgeWindow } from "@/hooks/use-data-management";
import type { PurgeCounts, PurgeResult } from "@/types";

const WINDOWS: { label: string; value: PurgeWindow }[] = [
  { label: "7 days", value: 7 },
  { label: "30 days", value: 30 },
  { label: "90 days", value: 90 },
  { label: "180 days", value: 180 },
  { label: "Everything", value: "all" },
];

const RETENTION_DAYS = [7, 14, 30, 60, 90, 180];

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDay(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function DataManagement() {
  const { storage, retention, busy, preview, purge, setRetention } = useDataManagement();

  const [windowValue, setWindowValue] = useState<PurgeWindow>(30);
  const [counts, setCounts] = useState<PurgeCounts | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [result, setResult] = useState<PurgeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load a dry-run preview whenever the window changes.
  // Stale counts are cleared by the <select> onChange handler (a user-event
  // handler, not this effect) so the effect body only calls setState inside
  // the async .then/.catch callbacks — never synchronously in the effect body.
  useEffect(() => {
    let active = true;
    preview(windowValue)
      .then((c) => { if (active) setCounts(c); })
      .catch(() => { if (active) setCounts(null); });
    return () => { active = false; };
  }, [windowValue, preview]);

  const handlePurge = useCallback(async () => {
    setError(null);
    try {
      const res = await purge(windowValue);
      setResult(res);
      setShowConfirm(false);
      const fresh = await preview(windowValue);
      setCounts(fresh);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Purge failed");
    }
  }, [purge, preview, windowValue]);

  const isEverything = windowValue === "all";
  const nothingToPurge = counts != null && counts.sessions === 0 && counts.events === 0;

  return (
    <div className="mb-6 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <h3 className="mb-1 text-sm font-semibold text-zinc-800 dark:text-zinc-200">Data Management</h3>
      <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">
        Purge old monitor data to keep the local database small. Trend summaries are kept unless you purge everything.
      </p>

      {/* Storage summary */}
      <div className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800/50">
        {storage ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-300">
            <span className="font-semibold text-zinc-800 dark:text-zinc-100">{formatBytes(storage.db_bytes + storage.wal_bytes)}</span>
            <span>{storage.counts.sessions.toLocaleString()} sessions</span>
            <span>{storage.counts.agent_events.toLocaleString()} events</span>
            <span>{formatDay(storage.oldest_ms)} – {formatDay(storage.newest_ms)}</span>
          </div>
        ) : (
          <div className="text-xs text-zinc-400">Loading storage…</div>
        )}
      </div>

      {/* Manual purge */}
      <div className="mb-5 flex flex-col gap-2">
        <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Delete data older than</label>
        <div className="flex items-center gap-2">
          <select
            value={String(windowValue)}
            onChange={(e) => {
              const v = e.target.value;
              setWindowValue(v === "all" ? "all" : Number(v));
              setResult(null);
              setCounts(null);
            }}
            className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
          >
            {WINDOWS.map((w) => (
              <option key={String(w.value)} value={String(w.value)}>{w.label}</option>
            ))}
          </select>

          <div className="relative">
            <button
              onClick={() => setShowConfirm((s) => !s)}
              disabled={busy || nothingToPurge}
              className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-40"
            >
              {busy ? "Purging…" : "Purge now"}
            </button>
            {showConfirm && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowConfirm(false)} />
                <div className="absolute right-0 top-full z-50 mt-1 min-w-[240px] rounded-lg border border-zinc-200 bg-white p-3 shadow-xl dark:border-zinc-700 dark:bg-zinc-800">
                  <p className="mb-1 text-sm font-medium text-zinc-800 dark:text-zinc-100">
                    {isEverything ? "Delete ALL monitor data?" : `Delete data older than ${windowValue} days?`}
                  </p>
                  <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
                    {counts
                      ? `Removes ~${counts.sessions.toLocaleString()} sessions, ${counts.events.toLocaleString()} events.`
                      : "Calculating…"}{" "}
                    {isEverything ? "Summaries are cleared too. " : "Trend summaries are kept. "}This cannot be undone.
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handlePurge}
                      disabled={busy}
                      className="rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
                    >
                      {busy ? "Purging…" : "Confirm"}
                    </button>
                    <button
                      onClick={() => setShowConfirm(false)}
                      className="rounded-md px-3 py-1 text-xs font-medium text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Preview / result / error line */}
        <div className="min-h-[1rem] text-xs">
          {error ? (
            <span className="text-red-500">{error}</span>
          ) : result ? (
            <span className="text-emerald-600 dark:text-emerald-400">
              Removed {result.deleted.sessions.toLocaleString()} sessions, {result.deleted.events.toLocaleString()} events · freed {formatBytes(result.bytes_freed)}
            </span>
          ) : counts ? (
            nothingToPurge ? (
              <span className="text-zinc-400">Nothing to purge in this window.</span>
            ) : (
              <span className="text-zinc-500 dark:text-zinc-400">
                Removes ~{counts.sessions.toLocaleString()} sessions, {counts.events.toLocaleString()} events
              </span>
            )
          ) : (
            <span className="text-zinc-400">Calculating…</span>
          )}
        </div>
      </div>

      {/* Retention policy */}
      <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800/50">
        <label className="flex items-center gap-2 text-xs font-medium text-zinc-700 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={retention?.enabled ?? false}
            onChange={(e) => setRetention({ enabled: e.target.checked })}
            className="h-3.5 w-3.5 accent-red-600"
          />
          Automatically purge data older than
          <select
            value={retention?.days ?? 30}
            onChange={(e) => setRetention({ days: Number(e.target.value) })}
            disabled={!retention?.enabled}
            className="rounded border border-zinc-200 bg-white px-2 py-0.5 text-xs text-zinc-700 disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
          >
            {RETENTION_DAYS.map((d) => (
              <option key={d} value={d}>{d} days</option>
            ))}
          </select>
        </label>
        <p className="mt-1.5 text-xs text-zinc-400">Runs about once a day while the tracker is open.</p>
      </div>
    </div>
  );
}
