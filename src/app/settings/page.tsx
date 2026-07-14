"use client";

import { useCredentials } from "@/hooks/use-credentials";
import { useMonitorSettings, type MonitorFontSize } from "@/hooks/use-monitor-settings";
import { NavLinks } from "@/components/ui/NavLinks";
import { CredentialForm } from "@/components/settings/CredentialForm";
import { ProviderStatus } from "@/components/settings/ProviderStatus";
import { DataManagement } from "@/components/settings/DataManagement";

// Mirrors the FONT_CLASSES "base" tier so the preview matches the real panel
const FONT_PREVIEW: Record<MonitorFontSize, string> = {
  xs: "text-sm",
  sm: "text-sm",
  md: "text-base",
  lg: "text-lg",
};

export default function SettingsPage() {
  const { credentials, saveCredentials, deleteProvider } = useCredentials();
  const { fontSize, setFontSize, fontSizeOptions } = useMonitorSettings();

  return (
    <div className="mx-auto max-w-3xl px-4 pb-8">
      {/* Header — draggable for Electron window movement */}
      <div className="titlebar-drag mb-6 flex items-center justify-between pt-2">
        <div>
          <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">
            Settings
          </h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Configure your API credentials and display preferences.
          </p>
        </div>
        <div className="titlebar-no-drag flex items-center gap-3">
          <NavLinks current="/settings" />
        </div>
      </div>

      {/* Agent Monitor Display Settings */}
      <div className="mb-6 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h3 className="mb-1 text-sm font-semibold text-zinc-800 dark:text-zinc-200">
          Agent Monitor Display
        </h3>
        <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">
          Adjust the font size used in the Agent Monitor panel.
        </p>

        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400 w-20 flex-shrink-0">
              Font Size
            </label>
            <div className="flex rounded-lg border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-700 dark:bg-zinc-800">
              {fontSizeOptions.map(({ value, label }) => (
                <button
                  key={value}
                  onClick={() => setFontSize(value)}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    fontSize === value
                      ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-600 dark:text-zinc-100"
                      : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Preview */}
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800/50">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
              Preview
            </p>
            <div className="rounded-md border border-zinc-700 bg-zinc-900 p-3">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                <span className={`${FONT_PREVIEW[fontSize]} font-medium text-zinc-100`}>
                  llm-usage-tracker
                </span>
                <span className={`rounded-full bg-zinc-800 px-1.5 py-0.5 ${fontSize === "xs" ? "text-[11px]" : fontSize === "lg" ? "text-sm" : "text-xs"} font-medium text-zinc-500`}>
                  main
                </span>
              </div>
              <p className={`mt-1 ${FONT_PREVIEW[fontSize]} text-zinc-500`}>
                <span className="text-blue-400">Read</span>
                <span className="text-zinc-600"> — src/components/monitor/AgentCard.tsx</span>
              </p>
            </div>
          </div>
        </div>
      </div>

      <DataManagement />

      <ProviderStatus />

      <div className="space-y-6">
        <CredentialForm
          provider="claude"
          onSave={saveCredentials}
          onDelete={(p) => deleteProvider(p as keyof import("@/types").CredentialStore)}
          existingMasked={
            credentials?.claude as Record<string, string | undefined>
          }
        />

        <div className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <div className="h-1" style={{ backgroundColor: "#10A37F" }} />
          <div className="p-5">
            <h3 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              OpenAI (ChatGPT/Codex)
            </h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              No configuration needed — usage is read automatically from your
              Codex CLI login (
              <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">
                ~/.codex/auth.json
              </code>
              ). If it shows as disconnected, run{" "}
              <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">
                codex login
              </code>{" "}
              in a terminal.
            </p>
          </div>
        </div>
      </div>

      <div className="mt-8 rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-800/50">
        <h3 className="mb-2 text-sm font-semibold text-zinc-700 dark:text-zinc-300">
          Security
        </h3>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          All credentials are encrypted with AES-256-GCM and stored locally in{" "}
          <code className="rounded bg-zinc-200 px-1 dark:bg-zinc-700">
            credentials.enc.json
          </code>
          . No data is sent to external servers beyond the provider APIs. The
          encryption key is stored in{" "}
          <code className="rounded bg-zinc-200 px-1 dark:bg-zinc-700">
            .env.local
          </code>
          .
        </p>
      </div>
    </div>
  );
}
