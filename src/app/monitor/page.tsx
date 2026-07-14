"use client";

import { AgentMonitorPanel } from "@/components/monitor/AgentMonitorPanel";
import { ProviderUsageStrip } from "@/components/monitor/ProviderUsageStrip";
import { NavLinks } from "@/components/ui/NavLinks";

export default function MonitorPage() {
  // h-[calc(100vh-2rem)] (viewport minus the h-8 titlebar) caps the page so the
  // activity feed scrolls inside the panel instead of growing the document
  return (
    <div className="mx-auto flex h-[calc(100vh-2rem)] w-full flex-col px-4 pb-4">
      {/* Header — draggable for Electron window movement */}
      <div className="titlebar-drag mb-4 flex flex-shrink-0 items-center justify-between pt-2">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Agent Monitor</h1>
          <p className="mt-1 text-base text-zinc-500 dark:text-zinc-400">
            Real-time Claude Code and Codex agent activity.
          </p>
        </div>
        <div className="titlebar-no-drag flex items-center gap-3">
          <NavLinks current="/monitor" />
        </div>
      </div>

      {/* Live quota — each provider's shortest reset window */}
      <ProviderUsageStrip />

      {/* Monitor gets the full width and all remaining height. min-h-0 lets it
          shrink below its content so overflow actually clips. */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <AgentMonitorPanel />
      </div>
    </div>
  );
}
