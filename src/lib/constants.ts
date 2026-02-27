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
};

export const USAGE_THRESHOLDS = {
  safe: 60,
  moderate: 85,
} as const;

export const REFRESH_INTERVALS = {
  usage: 60_000,
  billing: 300_000,
} as const;

export function getUsageLevel(percentage: number) {
  if (percentage < USAGE_THRESHOLDS.safe) return "safe" as const;
  if (percentage < USAGE_THRESHOLDS.moderate) return "moderate" as const;
  return "critical" as const;
}
