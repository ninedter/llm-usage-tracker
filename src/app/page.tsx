"use client";

import Link from "next/link";
import { DashboardGrid } from "@/components/dashboard/DashboardGrid";
import { AgentMonitorPanel } from "@/components/monitor/AgentMonitorPanel";
import { RefreshControl } from "@/components/dashboard/RefreshControl";

export default function Home() {
  // h-[calc(100vh-2rem)] (viewport minus the h-8 titlebar) caps the page so the
  // activity feed scrolls internally instead of stretching the usage cards
  return (
    <div className="mx-auto flex h-[calc(100vh-2rem)] w-full flex-col px-4 pb-4">
      {/* Header — draggable for Electron window movement */}
      <div className="titlebar-drag mb-4 flex items-center justify-between pt-2">
        <div>
          <h1 className="text-2xl font-bold text-white">
            LLM Usage Tracker
          </h1>
          <p className="mt-1 text-base text-zinc-500 dark:text-zinc-400">
            Monitor your AI usage and agent activity.
          </p>
        </div>
        <div className="titlebar-no-drag flex items-center gap-3">
          <RefreshControl />
          <Link
            href="/analytics"
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-base font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
              />
            </svg>
            Analytics
          </Link>
          <Link
            href="/settings"
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-base font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
            Settings
          </Link>
        </div>
      </div>

      {/* Main content — usage cards on top (Claude left, OpenAI right), agent monitor below */}
      <div className="mb-4 flex-shrink-0">
        <DashboardGrid />
      </div>

      {/* Agent monitor — min-h-0 lets it shrink below its content so the feed scrolls internally */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <AgentMonitorPanel />
      </div>
    </div>
  );
}
