"use client";

import Link from "next/link";
import { useState } from "react";
import { useAnalytics } from "@/hooks/use-analytics";
import { TimeRangePicker } from "@/components/analytics/TimeRangePicker";
import { OverviewCards } from "@/components/analytics/OverviewCards";
import { TrendChart } from "@/components/analytics/TrendChart";
import { SessionsTable } from "@/components/analytics/SessionsTable";
import { ToolsPanel } from "@/components/analytics/ToolsPanel";
import { FilesPanel } from "@/components/analytics/FilesPanel";
import { ModelsPanel } from "@/components/analytics/ModelsPanel";

type DetailTab = "sessions" | "tools" | "files" | "models";

export default function AnalyticsPage() {
  const {
    preset, setPreset, setCustomRange,
    overview, trends, sessions,
    toolAnalytics, fileAnalytics, modelAnalytics,
    overviewLoading, trendsLoading, sessionsLoading,
    toolsLoading, filesLoading, modelsLoading,
    sessionSort, setSessionSort,
    sessionPage, setSessionPage,
  } = useAnalytics();

  const [activeTab, setActiveTab] = useState<DetailTab>("sessions");

  return (
    <div className="mx-auto flex w-full flex-1 flex-col px-4 pb-4">
      {/* Header */}
      <div className="titlebar-drag mb-4 flex items-center justify-between pt-2">
        <div>
          <h1 className="text-xl font-bold text-zinc-100">Analytics</h1>
          <p className="mt-0.5 text-xs text-zinc-500">Usage insights and cost breakdown</p>
        </div>
        <div className="titlebar-no-drag flex items-center gap-3">
          <TimeRangePicker
            preset={preset}
            onPresetChange={setPreset}
            onCustomRange={setCustomRange}
          />
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-700"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            Dashboard
          </Link>
        </div>
      </div>

      {/* Overview Section */}
      <div className="space-y-3 mb-4">
        <OverviewCards data={overview} loading={overviewLoading} />
        <TrendChart data={trends} loading={trendsLoading} />
      </div>

      {/* Detail Section */}
      <div className="flex-1 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
        {/* Tabs */}
        <div className="flex border-b border-zinc-800 px-1">
          {(["sessions", "tools", "files", "models"] as DetailTab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2.5 text-xs font-semibold transition-colors ${
                activeTab === tab
                  ? "text-zinc-100 border-b-2 border-violet-500 -mb-px"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="overflow-y-auto" style={{ maxHeight: "calc(100vh - 380px)" }}>
          {activeTab === "sessions" && (
            <SessionsTable
              data={sessions}
              loading={sessionsLoading}
              sort={sessionSort}
              onSort={setSessionSort}
              page={sessionPage}
              onPageChange={setSessionPage}
            />
          )}
          {activeTab === "tools" && (
            <ToolsPanel data={toolAnalytics} loading={toolsLoading} />
          )}
          {activeTab === "files" && (
            <FilesPanel data={fileAnalytics} loading={filesLoading} />
          )}
          {activeTab === "models" && (
            <ModelsPanel data={modelAnalytics} loading={modelsLoading} />
          )}
        </div>
      </div>
    </div>
  );
}
