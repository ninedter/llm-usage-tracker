"use client";

import { useState } from "react";

type Preset = "today" | "7d" | "30d" | "all";

interface TimeRangePickerProps {
  preset: Preset;
  onPresetChange: (preset: Preset) => void;
  onCustomRange: (from: number, to: number) => void;
}

const PRESETS: { value: Preset; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
];

export function TimeRangePicker({ preset, onPresetChange, onCustomRange }: TimeRangePickerProps) {
  const [showCustom, setShowCustom] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const handleApplyCustom = () => {
    if (fromDate && toDate) {
      onCustomRange(
        new Date(fromDate).getTime(),
        new Date(toDate + "T23:59:59").getTime()
      );
      setShowCustom(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <div className="flex rounded-lg border border-zinc-700 bg-zinc-800 p-0.5">
        {PRESETS.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => onPresetChange(value)}
            className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${
              preset === value && !showCustom
                ? "bg-zinc-600 text-zinc-100"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="relative">
        <button
          onClick={() => setShowCustom(!showCustom)}
          className={`rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1 text-sm font-medium transition-colors ${
            showCustom ? "text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          Custom...
        </button>
        {showCustom && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setShowCustom(false)} />
            <div className="absolute right-0 top-full z-50 mt-1 rounded-lg border border-zinc-700 bg-zinc-800 p-3 shadow-xl">
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="rounded border border-zinc-600 bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
                />
                <span className="text-sm text-zinc-500">to</span>
                <input
                  type="date"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                  className="rounded border border-zinc-600 bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
                />
                <button
                  onClick={handleApplyCustom}
                  className="rounded bg-violet-600 px-3 py-1 text-sm font-medium text-white hover:bg-violet-500"
                >
                  Apply
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
