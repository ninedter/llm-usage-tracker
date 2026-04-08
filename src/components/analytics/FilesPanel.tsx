"use client";

import { useState } from "react";
import type { FileAnalytics, FileEntry } from "@/types";

interface FilesPanelProps {
  data: FileAnalytics | null;
  loading: boolean;
}

const TOOL_BADGE_COLORS: Record<string, string> = {
  Read: "text-blue-400 bg-blue-500/10",
  Edit: "text-violet-400 bg-violet-500/10",
  Write: "text-pink-400 bg-pink-500/10",
  Grep: "text-amber-400 bg-amber-500/10",
  Bash: "text-emerald-400 bg-emerald-500/10",
  Glob: "text-cyan-400 bg-cyan-500/10",
};

const TOOL_BAR_COLORS: Record<string, string> = {
  Read: "bg-blue-500",
  Edit: "bg-violet-500",
  Write: "bg-pink-500",
  Grep: "bg-amber-500",
  Bash: "bg-emerald-500",
  Glob: "bg-cyan-500",
};

function getHeatmapColor(count: number, max: number): string {
  const ratio = count / max;
  if (ratio > 0.75) return "bg-violet-600";
  if (ratio > 0.5) return "bg-violet-700";
  if (ratio > 0.25) return "bg-violet-800";
  return "bg-violet-900/60";
}

export function FilesPanel({ data, loading }: FilesPanelProps) {
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null);

  if (loading || !data) {
    return (
      <div className="animate-pulse space-y-3 p-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-8 rounded bg-zinc-800" />
        ))}
      </div>
    );
  }

  const { files, directories } = data;
  const maxMod = Math.max(...files.map((f) => f.modification_count), 1);
  const activeFile = selectedFile || files[0] || null;

  return (
    <div className="p-3 space-y-4">
      {directories.length > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
          <p className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">Modification Heatmap</p>
          <div className="space-y-2">
            {directories.slice(0, 10).map((dir) => {
              const dirFiles = files.filter((f) => f.directory === dir.directory);
              return (
                <div key={dir.directory}>
                  <p className="text-[8px] text-zinc-600 mb-1">{dir.directory}/</p>
                  <div className="flex gap-1 pl-2 flex-wrap">
                    {dirFiles.map((f) => (
                      <div
                        key={f.file_path}
                        className={`w-3.5 h-3.5 rounded cursor-pointer transition-all hover:ring-1 hover:ring-violet-400 ${getHeatmapColor(f.modification_count, maxMod)}`}
                        title={`${f.file_name} — ${f.modification_count} edits`}
                        onClick={() => setSelectedFile(f)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-1 mt-3 text-[7px] text-zinc-600">
            <span>Less</span>
            <div className="w-2.5 h-2.5 rounded bg-violet-900/60" />
            <div className="w-2.5 h-2.5 rounded bg-violet-800" />
            <div className="w-2.5 h-2.5 rounded bg-violet-700" />
            <div className="w-2.5 h-2.5 rounded bg-violet-600" />
            <span>More</span>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
        <p className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">Most Modified Files</p>
        <div className="space-y-1">
          {files.slice(0, 10).map((f, i) => (
            <button
              key={f.file_path}
              onClick={() => setSelectedFile(f)}
              className={`flex items-center gap-2 w-full rounded px-2 py-1.5 text-left transition-colors ${
                activeFile?.file_path === f.file_path ? "bg-zinc-800" : "hover:bg-zinc-800/50"
              }`}
            >
              <span className="text-[9px] text-violet-400 font-semibold w-4">{i + 1}</span>
              <span className="text-[9px] text-zinc-200 font-mono flex-1 truncate">{f.file_name}</span>
              <span className="text-[8px] text-zinc-600 font-mono">{f.modification_count}</span>
              <div className="flex gap-1">
                {f.tools_used.slice(0, 3).map((tool) => (
                  <span key={tool} className={`text-[7px] rounded px-1 py-0.5 ${TOOL_BADGE_COLORS[tool] || "text-zinc-400 bg-zinc-500/10"}`}>
                    {tool}
                  </span>
                ))}
              </div>
            </button>
          ))}
        </div>
      </div>

      {activeFile && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
          <p className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">Tool Breakdown</p>
          <p className="text-[8px] text-zinc-400 font-mono mb-2">{activeFile.file_name}</p>
          <div className="h-2.5 flex rounded-full overflow-hidden gap-px">
            {Object.entries(activeFile.tool_breakdown).map(([tool, count]) => {
              const pct = (count / activeFile.modification_count) * 100;
              return (
                <div
                  key={tool}
                  className={`${TOOL_BAR_COLORS[tool] || "bg-zinc-500"}`}
                  style={{ width: `${pct}%` }}
                  title={`${tool}: ${count} (${Math.round(pct)}%)`}
                />
              );
            })}
          </div>
          <div className="flex gap-2 mt-2 text-[7px] text-zinc-600 flex-wrap">
            {Object.entries(activeFile.tool_breakdown).map(([tool, count]) => (
              <span key={tool}>
                <span className={`inline-block w-1.5 h-1.5 rounded-sm mr-0.5 ${TOOL_BAR_COLORS[tool] || "bg-zinc-500"}`} />
                {tool} {Math.round((count / activeFile.modification_count) * 100)}%
              </span>
            ))}
          </div>
        </div>
      )}

      {files.length === 0 && (
        <p className="text-center text-xs text-zinc-600 py-8">No file modifications recorded in this period</p>
      )}
    </div>
  );
}
