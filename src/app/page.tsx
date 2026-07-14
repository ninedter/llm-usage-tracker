"use client";

import { DashboardGrid } from "@/components/dashboard/DashboardGrid";
import { RefreshControl } from "@/components/dashboard/RefreshControl";
import { NavLinks } from "@/components/ui/NavLinks";

export default function Home() {
  // The Agent Monitor lives on its own page (/monitor) — it was squeezed here
  // at low resolution. With it gone the cards are content-sized, so this page
  // needs no viewport cap.
  return (
    <div className="mx-auto w-full px-4 pb-8">
      {/* Header — draggable for Electron window movement */}
      <div className="titlebar-drag mb-4 flex items-center justify-between pt-2">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-white">
            LLM Usage Tracker
          </h1>
          <p className="mt-1 text-base text-zinc-500 dark:text-zinc-400">
            Monitor your AI usage and agent activity.
          </p>
        </div>
        <div className="titlebar-no-drag flex items-center gap-3">
          <RefreshControl />
          <NavLinks current="/" />
        </div>
      </div>

      {/* Usage cards — Claude left, OpenAI right */}
      <DashboardGrid />
    </div>
  );
}
