"use client";

import type { SessionAnalyticRow } from "@/types";

interface SessionsTableProps {
  data: SessionAnalyticRow[];
  loading: boolean;
  sort: { sort: string; order: string };
  onSort: (sort: { sort: string; order: string }) => void;
  page: number;
  onPageChange: (page: number) => void;
}

function formatDuration(ms: number): string {
  const m = Math.floor(ms / 60000);
  const h = Math.floor(ms / 3600000);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(ms / 1000)}s`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

const STATUS_STYLES: Record<string, string> = {
  active: "text-emerald-400 bg-emerald-500/10",
  completed: "text-zinc-400 bg-zinc-500/10",
  error: "text-red-400 bg-red-500/10",
  abandoned: "text-amber-400 bg-amber-500/10",
};

const COLUMNS: { key: string; label: string; sortable: boolean }[] = [
  { key: "project", label: "Project", sortable: false },
  { key: "duration", label: "Duration", sortable: true },
  { key: "tokens", label: "Tokens", sortable: true },
  { key: "cost", label: "Cost", sortable: true },
  { key: "tools", label: "Tools", sortable: false },
  { key: "status", label: "Status", sortable: false },
];

export function SessionsTable({ data, loading, sort, onSort, page, onPageChange }: SessionsTableProps) {
  const handleSort = (key: string) => {
    if (sort.sort === key) {
      onSort({ sort: key, order: sort.order === "asc" ? "desc" : "asc" });
    } else {
      onSort({ sort: key, order: "desc" });
    }
  };

  if (loading) {
    return (
      <div className="animate-pulse space-y-2 p-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-8 rounded bg-zinc-800" />
        ))}
      </div>
    );
  }

  return (
    <div>
      <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr_80px] gap-2 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-500 border-b border-zinc-800">
        {COLUMNS.map((col) => (
          <button
            key={col.key}
            onClick={() => col.sortable && handleSort(col.key)}
            className={`text-left ${col.sortable ? "cursor-pointer hover:text-zinc-300" : "cursor-default"}`}
          >
            {col.label}
            {col.sortable && sort.sort === col.key && (
              <span className="ml-1">{sort.order === "asc" ? "\u2191" : "\u2193"}</span>
            )}
          </button>
        ))}
      </div>

      {data.length === 0 ? (
        <p className="text-center text-sm text-zinc-600 py-8">No sessions in this period</p>
      ) : (
        data.map((session) => {
          const entryLabel = session.entrypoint === "claude-desktop" ? "Desktop"
            : session.entrypoint === "cli" ? "Terminal"
            : session.entrypoint || "Agent";

          return (
            <div
              key={session.session_id}
              className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr_80px] gap-2 px-3 py-2 text-sm border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors items-center"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-zinc-200 font-medium truncate">{session.project || session.session_id.slice(0, 8)}</span>
                <span className="flex-shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-500">{entryLabel}</span>
              </div>
              <div className="text-zinc-400 font-mono text-sm">{formatDuration(session.duration_ms)}</div>
              <div className="text-zinc-400 font-mono text-sm">{formatTokens(session.total_tokens)}</div>
              <div className="text-emerald-400 font-mono text-sm font-semibold">${session.cost.toFixed(2)}</div>
              <div className="text-zinc-400 font-mono text-sm">{session.tool_count}</div>
              <div>
                <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[session.status] || STATUS_STYLES.completed}`}>
                  {session.status}
                </span>
              </div>
            </div>
          );
        })
      )}

      <div className="flex items-center justify-between px-3 py-2">
        <button
          onClick={() => onPageChange(Math.max(0, page - 1))}
          disabled={page === 0}
          className="rounded px-2 py-1 text-sm text-zinc-400 hover:text-zinc-200 disabled:text-zinc-700 disabled:cursor-not-allowed"
        >
          Previous
        </button>
        <span className="text-sm text-zinc-600">Page {page + 1}</span>
        <button
          onClick={() => onPageChange(page + 1)}
          disabled={data.length < 20}
          className="rounded px-2 py-1 text-sm text-zinc-400 hover:text-zinc-200 disabled:text-zinc-700 disabled:cursor-not-allowed"
        >
          Next
        </button>
      </div>
    </div>
  );
}
