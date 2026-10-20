import type { ProviderId } from "@/types";

export const PROVIDER_INFO: Record<
  ProviderId,
  {
    displayName: string;
    color: string;
    bgColor: string;
    consoleUrl: string;
  }
> = {
  claude: {
    displayName: "Claude (Anthropic)",
    color: "#D4A574",
    bgColor: "bg-orange-50 dark:bg-orange-950/20",
    consoleUrl: "https://console.anthropic.com/",
  },
  openai: {
    displayName: "OpenAI (ChatGPT/Codex)",
    color: "#10A37F",
    bgColor: "bg-emerald-50 dark:bg-emerald-950/20",
    consoleUrl: "https://chatgpt.com/",
  },
};

export const USAGE_THRESHOLDS = {
  safe: 60,
  moderate: 85,
} as const;

export const REFRESH_INTERVALS = {
  usage: 60_000,
  billing: 300_000,
} as const;

// Hard cap on every upstream (claude.ai / api.anthropic.com / chatgpt.com) request
export const UPSTREAM_TIMEOUT_MS = 10_000;

// Shown on the Claude card and in Settings when usage works (via OAuth) but
// claude.ai rejects the saved session key the credit endpoints need
export const CLAUDE_SESSION_KEY_EXPIRED_HINT =
  "claude.ai session key expired: prepaid balance unavailable. Update it in Settings.";

export const ARCHIVE_AFTER_MS = 30 * 60 * 1000; // 30 minutes

export function getUsageLevel(percentage: number) {
  if (percentage < USAGE_THRESHOLDS.safe) return "safe" as const;
  if (percentage < USAGE_THRESHOLDS.moderate) return "moderate" as const;
  return "critical" as const;
}
